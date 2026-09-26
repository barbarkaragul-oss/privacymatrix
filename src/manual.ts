/**
 * Reading the blocked pages by hand.
 *
 * Some vendors answer every automated client with a bot challenge, even from a residential
 * connection, so the residential re-check cannot read their pages. A person can: they open the page
 * in their own browser, pass the challenge the ordinary way, and paste the page's text into a local
 * reading page (scripts/manual.ts). The pasted text goes through the same quote matching as a live
 * fetch, and a quote found there dates its cell verified_via 'manual'. Nothing here fetches a
 * vendor's page: the pages are opened in the person's browser and read by the person.
 *
 * The residential run records which blocked pages it could not read (unreachable.json in its state
 * folder); the reading page shows those that have not been read by hand for MANUAL_EVERY_DAYS.
 */
import { BOT_CHALLENGE, unusablePage } from './check.js';
import { findQuote, prepareText, type MatchMethod } from './quotes.js';
import type { Cell } from './types.js';

/** How long a page read by hand counts as read before it is due again. */
export const MANUAL_EVERY_DAYS = 28;

export interface ReportCell {
  app: string;
  evidence_url: string;
  status: string;
}

/** The pages of blocked apps on which the residential run could not read a quote, sorted. */
export function unreachablePages(report: { cells?: ReportCell[] }, blocked: Set<string>): string[] {
  const urls = new Set<string>();
  for (const c of report.cells ?? []) if (blocked.has(c.app) && c.status === 'error' && c.evidence_url) urls.add(c.evidence_url);
  return [...urls].sort();
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10));
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/**
 * The date a page was last read by hand: the newer of the reading page's own record and the newest
 * verified_at of a cell on that page with verified_via 'manual' (readings made before the reading
 * page existed, or saved from another checkout, are in the data only; an archive capture may have
 * re-dated a cell since, which is why the record is kept too).
 */
export function lastReadByHand(url: string, reads: Record<string, string>, cells: Cell[]): string | null {
  const dates = cells.filter((c) => c.evidence_url === url && c.verified_via === 'manual').map((c) => c.verified_at);
  const all = [reads[url], ...dates].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  return all.length ? (all[all.length - 1] as string) : null;
}

/** The unreachable pages not read by hand in the last `everyDays` days. */
export function duePages(unreachable: string[], reads: Record<string, string>, cells: Cell[], today: string, everyDays = MANUAL_EVERY_DAYS): string[] {
  return unreachable.filter((url) => {
    const last = lastReadByHand(url, reads, cells);
    return !last || daysBetween(last, today) >= everyDays;
  });
}

export interface QuoteResult {
  app: string;
  question: string;
  quote: string;
  found: boolean;
  method: MatchMethod;
}

export interface PageCheck {
  /** Why the pasted text is not the page (too short, a bot challenge); null when it can be used. */
  unusable: string | null;
  results: QuoteResult[];
}

/**
 * Matches every quoted cell cited on url against text pasted from that page. A bot challenge or a
 * scrap of text is refused, so it can neither confirm nor seem to lack a quote.
 */
export function checkPastedPage(cells: Cell[], url: string, text: string): PageCheck {
  const unusable = unusablePage(text, false);
  const onPage = cells.filter((c) => c.evidence_url === url && c.value !== 'unknown' && c.quote.trim());
  if (unusable) return { unusable: unusable === BOT_CHALLENGE ? 'this is a bot challenge page, not the page itself' : unusable, results: [] };
  const prepared = prepareText(text);
  return {
    unusable: null,
    results: onPage.map((c) => {
      const m = findQuote(prepared, c.quote);
      return { app: c.app, question: c.question, quote: c.quote, found: m.found, method: m.method };
    }),
  };
}

/**
 * Dates the cells whose quotes a person found on the live page: verified today, verified_via
 * 'manual', any archive provenance and any missing-quote flag cleared (the quote is on the page).
 * Cells whose quotes were not found are left as they are: a reading by hand never demotes a cell.
 */
export function applyReadings(cells: Cell[], found: Array<{ app: string; question: string }>, today: string): { cells: Cell[]; dated: number } {
  const keys = new Set(found.map((f) => `${f.app}|${f.question}`));
  let dated = 0;
  const out = cells.map((c) => {
    if (!keys.has(`${c.app}|${c.question}`)) return c;
    dated++;
    const copy: Cell = { ...c, verified: true, verified_at: today, verified_via: 'manual' };
    delete copy.archive_timestamp;
    delete copy.quote_missing_since;
    return copy;
  });
  return { cells: out, dated };
}
