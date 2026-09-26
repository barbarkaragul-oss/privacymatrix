/**
 * Offline verification of the matrix: does every quote really appear at its evidence URL?
 *
 *   npm run check                 report; exit 1 if any quote is missing from a fetched page
 *   npm run check -- --soft       report; always exit 0
 *   npm run check -- --fix        rewrite data/matrix.json: quotes found -> verified today;
 *                                 quotes missing from a fetched page -> the cell is kept but flagged
 *                                 (quote_missing_since); still missing GRACE_DAYS later -> value
 *                                 "unknown" (the old quote, URL and value are kept in the notes for
 *                                 a human to fix); also writes data/changes.json and data/changes.md
 *   npm run check -- --app id     limit to one app
 *   npm run check -- --dump dir   also write the text of every fetched page into dir (debugging
 *                                 what a runner in another network actually receives)
 *   npm run check -- --url u      with --dump: also fetch and dump this URL (repeatable), to test
 *                                 candidate source pages from that network before citing them
 *   npm run check -- --residential   running from a connection vendors do not block (the
 *                                 residential task): read blocked_from_cloud apps live, retry a
 *                                 403 a few times, one request at a time, no archive fallback. A
 *                                 host that refuses a page through every retry gets one attempt
 *                                 per page after that, until it answers one. A host that answers
 *                                 with a bot challenge is not asked again in that run.
 *   npm run check -- --only-blocked  limit to apps marked blocked_from_cloud in data/apps.json
 *
 * A page that cannot be fetched (timeout, 5xx, bot block) is reported as an error and never
 * demotes a cell: only a successfully fetched page that no longer contains the quote does, and
 * only on the second run in a row. No API key needed. This is the free weekly re-verification,
 * and the same check CI runs on pull requests that edit the data.
 *
 * When a vendor blocks the checker (HTTP 401/403/429 or a bot challenge) and this is not a
 * residential run, the most recent Internet Archive capture of the page is read instead. A capture
 * can confirm a quote, and dates the cell to the capture when that is newer than its last
 * verification; it can never demote a cell or touch the missing-quote clock (see src/archive.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureDate, fetchCapture, latestCapture } from './archive.js';
import { diffMatrices, renderChangesMarkdown, type PendingQuote } from './diff.js';
import { Fetcher, type FetchResult } from './fetch.js';
import { findQuote, prepareText, quoteProblems, type MatchMethod, type PreparedText } from './quotes.js';
import {
  DATA_DIR,
  cellKey,
  loadApps,
  loadQuestions,
  loadMatrix,
  saveJson,
  sortCells,
  todayIso,
  type App,
  type Question,
  type Cell,
  type ChangesFile,
} from './types.js';

export type CellStatus = 'ok' | 'fail' | 'error' | 'skipped';

export interface CellReport {
  app: string;
  question: string;
  value: string;
  status: CellStatus;
  method: MatchMethod;
  evidence_url: string;
  problems: string[];
  /** Set when the quote was confirmed in an Internet Archive capture rather than on the live page. */
  via?: 'archive';
  archive_timestamp?: string;
}

/** A page read from an Internet Archive capture because the live page blocked the checker. */
export type ArchivedPage = PreparedText & { via: 'archive'; archiveTimestamp: string };

export type PageResult = PreparedText | ArchivedPage | { error: string };

function isArchived(page: PageResult): page is ArchivedPage {
  return 'via' in page && page.via === 'archive';
}

/** Minimum amount of text a fetched page must contain before a missing quote counts as evidence (a client-rendered shell has almost none; a short LICENSE file has more). */
export const MIN_PAGE_CHARS = 40;
export const BOT_CHALLENGE = 'page looks like a bot challenge or consent wall';
const CHALLENGE_MARKERS = [
  /just a moment/i,
  /enable javascript/i,
  /access denied/i,
  /attention required/i,
  /verify you are human/i,
  /checking your browser/i,
  // the Wayback Machine's own "not archived" page, which it can serve with status 200
  /wayback machine (has not archived|doesn.t have that page)/i,
];

/**
 * A 200 response is not always the page: bot challenges, consent walls and client-rendered
 * shells return status 200 with no documentation in them. Such pages must never demote a cell,
 * so they are reported as fetch errors instead. Returns the reason, or null when the page is usable.
 */
export function unusablePage(text: string, truncated: boolean): string | null {
  if (truncated) return 'page larger than the download limit';
  if (text.trim().length < MIN_PAGE_CHARS) return `page has only ${text.trim().length} characters of text`;
  const head = text.slice(0, 2000);
  for (const re of CHALLENGE_MARKERS) if (re.test(head)) return BOT_CHALLENGE;
  return null;
}

export interface CheckOptions {
  soft: boolean;
  fix: boolean;
  app: string | null;
  dump: string | null;
  /** Extra URLs to fetch and dump alongside the evidence pages (candidates for new sources); they never affect cells. */
  extraUrls: string[];
  /** Running from a connection vendors do not block: read blocked_from_cloud apps live, gently, without the archive fallback. */
  residential: boolean;
  /** Only check apps marked blocked_from_cloud. */
  onlyBlocked: boolean;
}

function parseArgs(argv: string[]): CheckOptions {
  const out: CheckOptions = { soft: false, fix: false, app: null, dump: null, extraUrls: [], residential: false, onlyBlocked: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--soft') out.soft = true;
    else if (a === '--fix') out.fix = true;
    else if (a === '--app') out.app = argv[++i] ?? null;
    else if (a === '--dump') out.dump = argv[++i] ?? null;
    else if (a === '--url') out.extraUrls.push(argv[++i] ?? '');
    else if (a === '--residential') out.residential = true;
    else if (a === '--only-blocked') out.onlyBlocked = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: check [--soft] [--fix] [--app <id>] [--dump <dir>] [--url <url>]... [--residential] [--only-blocked]');
      process.exit(0);
    }
  }
  out.extraUrls = out.extraUrls.filter(Boolean);
  return out;
}

/** Writes the text the checker saw for one URL, so a failure on another network can be inspected. */
function dumpPage(dir: string, url: string, res: FetchResult): void {
  mkdirSync(dir, { recursive: true });
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const header = [
    `# ${url}`,
    `# final: ${res.finalUrl}`,
    `# status: ${res.status}${res.error ? ` error: ${res.error}` : ''}`,
    `# content-type: ${res.contentType}`,
    `# chars: ${res.text.length} truncated: ${res.truncated}`,
    '',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, `${slug}.txt`), header + res.text, 'utf8');
}

/** One line per app instead of one per cell, so a blocked host does not flood the run summary. */
export function groupFetchErrors(errors: CellReport[], apps: App[]): string[] {
  const name = new Map(apps.map((a) => [a.id, a.name]));
  const byApp = new Map<string, CellReport[]>();
  for (const e of errors) {
    const list = byApp.get(e.app) ?? [];
    list.push(e);
    byApp.set(e.app, list);
  }
  return [...byApp.entries()].map(([app, list]) => {
    const pages = new Set(list.map((e) => e.evidence_url)).size;
    const reasons = [...new Set(list.map((e) => e.problems.join('; ')))].join(' / ');
    return `${name.get(app) ?? app}: ${list.length} cell${list.length === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'} (${reasons})`;
  });
}

/** Statuses that mean "the server refused this client", as opposed to an outage: worth trying the archive. */
const BLOCK_STATUSES = new Set([401, 403, 429]);

/** Runs fn over items with at most `limit` in flight. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Whole days from ISO date a to ISO date b; infinite when either date is unreadable, so a bad flag never blocks a demotion. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/** A quote must be missing from its page on two runs at least this many days apart before the cell is demoted. */
export const GRACE_DAYS = 6;

export function classifyCell(cell: Cell, page: PageResult | undefined): CellReport {
  const base = { app: cell.app, question: cell.question, value: cell.value, evidence_url: cell.evidence_url };
  if (!cell.quote.trim() || !cell.evidence_url.trim()) return { ...base, status: 'skipped', method: 'none', problems: [] };
  const problems = quoteProblems(cell.quote);
  if (!page) return { ...base, status: 'error', method: 'none', problems: [...problems, 'page not fetched'] };
  if ('error' in page) return { ...base, status: 'error', method: 'none', problems: [...problems, `fetch failed: ${page.error}`] };
  const m = findQuote(page, cell.quote);
  if (isArchived(page)) {
    // A malformed quote is a data error, but a capture never demotes a cell, so here it is only
    // reported. structuralProblems flags it on every run, whatever the network.
    if (problems.length) {
      return { ...base, status: 'error', method: m.method, problems: [...problems, `read only from Internet Archive capture ${page.archiveTimestamp}, which never demotes a cell`] };
    }
    // An archived copy can show a sentence was there; it cannot show the live page lacks it, since
    // the capture may predate the sentence. So a miss here is an unreadable page, not a failure.
    if (!m.found) {
      return { ...base, status: 'error', method: 'none', problems: [`quote not found in Internet Archive capture ${page.archiveTimestamp}, which cannot show the live page lacks it`] };
    }
    // The compact pass ignores punctuation, so it also matches a quote that was cut where the vendor
    // later added a qualifier. Acceptable against the live page, where a real rewrite breaks the
    // match soon enough; not as the only confirmation a capture gives.
    if (m.method === 'compact') {
      return { ...base, status: 'error', method: m.method, problems: [`quote only matches Internet Archive capture ${page.archiveTimestamp} when punctuation is ignored, which is too weak to confirm it from a capture`] };
    }
    return { ...base, status: 'ok', method: m.method, problems, via: 'archive', archive_timestamp: page.archiveTimestamp };
  }
  if (!m.found) problems.push('quote not found on page');
  return { ...base, status: problems.length ? 'fail' : 'ok', method: m.method, problems };
}

export function structuralProblems(cells: Cell[], apps: App[], questions: Question[]): { problems: string[]; missing: string[] } {
  const appIds = new Set(apps.map((a) => a.id));
  const questionIds = new Set(questions.map((c) => c.id));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    const key = cellKey(cell.app, cell.question);
    if (seen.has(key)) problems.push(`duplicate cell ${key}`);
    seen.add(key);
    if (!appIds.has(cell.app)) problems.push(`unknown app ${cell.app}`);
    if (!questionIds.has(cell.question)) problems.push(`unknown question ${cell.question}`);
    if (cell.value !== 'unknown' && (!cell.quote.trim() || !cell.evidence_url.trim())) problems.push(`${key}: value ${cell.value} requires quote and evidence_url`);
    // Checked here as well as against the page, so a malformed quote on a page the checker cannot
    // read live (unreachable, or read only from an archive capture) still fails a pull request.
    if (cell.value !== 'unknown' && cell.quote.trim()) for (const p of quoteProblems(cell.quote)) problems.push(`${key}: ${p}`);
    if (cell.value === 'unknown' && cell.verified) problems.push(`${key}: unknown cells cannot be verified`);
  }
  const missing: string[] = [];
  for (const a of apps) for (const c of questions) if (!seen.has(cellKey(a.id, c.id))) missing.push(cellKey(a.id, c.id));
  return { problems, missing };
}

function withoutFlag(cell: Cell): Cell {
  const copy = { ...cell };
  delete copy.quote_missing_since;
  return copy;
}

/**
 * Drops the missing-quote flag and any archive or manual provenance. Used whenever a cell's
 * verification changes hands: a live read supersedes provenance (absent verified_via means live),
 * and a cell that stops being verified must not keep saying how it was verified.
 */
function withoutProvenance(cell: Cell): Cell {
  const copy = withoutFlag(cell);
  delete copy.verified_via;
  delete copy.archive_timestamp;
  return copy;
}

function verifiedLive(cell: Cell, today: string): Cell {
  return { ...withoutProvenance(cell), verified: true, verified_at: today };
}

/**
 * A quote confirmed in an archive capture dates the cell to the capture, but only when that is
 * newer than what the cell already has: an old capture must not roll back a live or manual read.
 * It leaves quote_missing_since alone, because only a live read can start or stop that clock.
 */
function verifiedFromArchive(cell: Cell, timestamp: string | undefined): Cell {
  const date = captureDate(timestamp ?? '');
  if (!date || date <= cell.verified_at) return cell;
  return { ...cell, verified: true, verified_at: date, verified_via: 'archive', archive_timestamp: timestamp };
}

/**
 * Applies check results to the cells.
 *   ok                      -> verified today, any missing-quote flag cleared
 *   fail, quote not found   -> first time: cell kept, flagged quote_missing_since = today (pending);
 *                              still missing GRACE_DAYS or more later: unknown, old data kept in notes
 *   fail, malformed quote   -> unknown at once (a data error, not a page change)
 *   error / skipped         -> untouched
 * The grace period exists because a page can differ between two networks (regional variants,
 * interstitials served to cloud IP ranges); one bad fetch must not erase a verified cell.
 */
export function applyFix(cells: Cell[], reports: CellReport[], missing: string[], today: string): { cells: Cell[]; demoted: number; pending: PendingQuote[] } {
  const byKey = new Map(reports.map((r) => [cellKey(r.app, r.question), r]));
  let demoted = 0;
  const pending: PendingQuote[] = [];
  const demote = (cell: Cell, reason: string): Cell => {
    demoted++;
    const tail = cell.notes.trim() ? ` | ${cell.notes.trim()}` : '';
    return {
      ...withoutProvenance(cell),
      value: 'unknown',
      quote: '',
      evidence_url: '',
      confidence: 'low',
      verified: false,
      verified_at: '',
      notes: `UNVERIFIED on ${today} (${reason}; was ${cell.value}): "${cell.quote.trim()}" at ${cell.evidence_url}${tail}`,
    };
  };
  const out: Cell[] = cells.map((cell) => {
    const r = byKey.get(cellKey(cell.app, cell.question));
    if (!r) return cell;
    if (r.status === 'fail') {
      const onlyMissing = r.problems.length === 1 && r.problems[0] === 'quote not found on page';
      if (!onlyMissing) return demote(cell, r.problems.join('; '));
      const since = cell.quote_missing_since ?? today;
      if (!cell.quote_missing_since || daysBetween(since, today) < GRACE_DAYS) {
        pending.push({ app: cell.app, question: cell.question, evidence_url: cell.evidence_url, since });
        return { ...cell, quote_missing_since: since };
      }
      return demote(cell, `quote not found on page since ${since}`);
    }
    if (r.status === 'ok' && cell.value !== 'unknown') return r.via === 'archive' ? verifiedFromArchive(cell, r.archive_timestamp) : verifiedLive(cell, today);
    if (cell.value === 'unknown' && cell.verified) return { ...withoutProvenance(cell), verified: false, verified_at: '' };
    return cell;
  });
  for (const key of missing) {
    const [app, question] = key.split('|') as [string, string];
    out.push({ app, question, value: 'unknown', quote: '', evidence_url: '', notes: '', confidence: 'low', verified: false, verified_at: '' });
  }
  return { cells: out, demoted, pending };
}

export async function runCheck(opts: CheckOptions): Promise<number> {
  const apps = loadApps();
  const qs = loadQuestions();
  const matrix = loadMatrix();
  const { problems: structural, missing } = structuralProblems(matrix.cells, apps, qs.questions);

  const blockedApps = new Set(apps.filter((a) => a.blocked_from_cloud).map((a) => a.id));
  const inScope = (c: Cell): boolean => (!opts.app || c.app === opts.app) && (!opts.onlyBlocked || blockedApps.has(c.app));
  const targets = matrix.cells.filter(inScope);
  // From a residential connection: one request at a time, at least 1.2 s apart (help.openai.com's
  // robots.txt asks for Crawl-delay: 1), and a 403 is retried, because there it comes and goes.
  const fetcher = opts.residential ? new Fetcher({ retryForbidden: true, retryBaseMs: 1200 }, 1, 1200) : new Fetcher({}, 4);
  const cellsToCheck = targets.filter((c) => c.quote.trim() && c.evidence_url.trim());
  const urls = [...new Set(cellsToCheck.map((c) => c.evidence_url))];
  console.log(
    `Checking ${cellsToCheck.length} quoted cells across ${urls.length} URLs (${targets.length - cellsToCheck.length} cells without a quote skipped)${opts.residential ? ', from a residential connection' : ''}`,
  );

  const pages = new Map<string, PageResult>();
  const toArchive: Array<{ url: string; reason: string }> = [];
  await Promise.all(
    urls.map(async (url) => {
      // Always try the live page first, even for apps marked blocked_from_cloud: blocking is per
      // page (one Genspark page is blocked, its others are not), and a vendor that lifts the block
      // is then read live again without anyone editing the data.
      const res = await fetcher.get(url);
      if (opts.dump) dumpPage(opts.dump, url, res);
      const problem = !res.ok ? (res.error ?? `HTTP ${res.status}`) : unusablePage(res.text, res.truncated);
      if (!problem) {
        pages.set(url, prepareText(res.text));
        return;
      }
      if (!opts.residential && (BLOCK_STATUSES.has(res.status) || problem === BOT_CHALLENGE)) {
        toArchive.push({ url, reason: problem });
        return;
      }
      pages.set(url, { error: problem });
      console.log(`  FETCH ERROR ${url} (${problem})`);
    }),
  );
  if (fetcher.challengingHosts.length) {
    console.log(`  CHALLENGED ${fetcher.challengingHosts.join(', ')}: answered with a bot challenge (cf-mitigated: challenge), which this checker cannot pass; any later page from them was not asked this run`);
  }
  if (fetcher.refusingHosts.length) {
    console.log(`  REFUSED ${fetcher.refusingHosts.join(', ')}: refused a page through every retry and returned no successful page after it; any later page from them was asked once`);
  }

  // Internet Archive fallback, two at a time to be gentle with archive.org. Sorted so the log is stable.
  toArchive.sort((a, b) => a.url.localeCompare(b.url));
  await eachLimited(toArchive, 2, async ({ url, reason }) => {
    const capture = await latestCapture(url);
    if (!capture || 'error' in capture) {
      const error = capture ? `${reason}; Internet Archive lookup failed: ${capture.error}` : `${reason}; no Internet Archive capture`;
      pages.set(url, { error });
      console.log(`  FETCH ERROR ${url} (${error})`);
      return;
    }
    const res = await fetchCapture(capture);
    if (opts.dump) dumpPage(opts.dump, capture.rawUrl, res);
    const problem = !res.ok ? (res.error ?? `HTTP ${res.status}`) : unusablePage(res.text, res.truncated);
    if (problem) {
      const error = `${reason}; Internet Archive capture ${capture.timestamp} unusable: ${problem}`;
      pages.set(url, { error });
      console.log(`  FETCH ERROR ${url} (${error})`);
      return;
    }
    pages.set(url, { ...prepareText(res.text), via: 'archive', archiveTimestamp: capture.timestamp });
    console.log(`  ARCHIVE ${url} (${reason}; capture of ${captureDate(capture.timestamp)})`);
  });

  if (opts.dump && opts.extraUrls.length) {
    await Promise.all(
      opts.extraUrls.map(async (url) => {
        const res = await fetcher.get(url);
        dumpPage(opts.dump as string, url, res);
        console.log(`  DUMPED ${url} (status ${res.status}, ${res.text.length} chars${res.error ? `, ${res.error}` : ''})`);
      }),
    );
  }

  const reports = targets.map((cell) => classifyCell(cell, pages.get(cell.evidence_url)));
  const failures = reports.filter((r) => r.status === 'fail');
  const errors = reports.filter((r) => r.status === 'error');
  const okCount = reports.filter((r) => r.status === 'ok').length;
  const skipped = reports.filter((r) => r.status === 'skipped').length;
  for (const f of failures) console.log(`  FAIL ${f.app}/${f.question} [${f.value}] ${f.problems.join('; ')} <${f.evidence_url}>`);
  for (const s of structural) console.log(`  STRUCTURE ${s}`);
  if (missing.length) console.log(`  MISSING ${missing.length} cells (app x question pairs without an entry)`);

  const byMethod: Record<string, number> = {};
  for (const r of reports) if (r.status === 'ok') byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  const okViaArchive = reports.filter((r) => r.status === 'ok' && r.via === 'archive');
  const archiveNote = okViaArchive.length ? ` (${okViaArchive.length} of them confirmed from Internet Archive captures)` : '';
  console.log(`Result: ${okCount} ok${archiveNote}, ${failures.length} failed, ${errors.length} fetch errors (cells untouched), ${skipped} skipped, ${structural.length} structural problems, ${missing.length} missing. Match methods: ${JSON.stringify(byMethod)}`);

  const report = {
    run_at: new Date().toISOString(),
    ok: okCount,
    ok_via_archive: okViaArchive.length,
    failed: failures.length,
    errors: errors.length,
    skipped,
    structural,
    missing,
    demoted: 0,
    pending: [] as PendingQuote[],
    cells: reports,
  };

  if (opts.fix) {
    const today = todayIso();
    const { cells, demoted, pending } = applyFix(matrix.cells, reports, missing, today);
    report.demoted = demoted;
    report.pending = pending;
    for (const p of pending) console.log(`  PENDING ${p.app}/${p.question} quote missing since ${p.since}; kept, demoted if still missing after ${GRACE_DAYS} days`);
    const sorted = sortCells(cells, apps, qs.questions);
    const runAt = new Date().toISOString();
    const checked = sorted.filter(inScope);
    const scope = [opts.residential ? 'residential runner' : '', opts.onlyBlocked ? 'blocked apps only' : '', opts.app ? `app ${opts.app} only` : ''].filter(Boolean);
    const changes: ChangesFile = {
      run_at: runAt,
      model: `none (mechanical quote re-check${scope.length ? `, ${scope.join(', ')}` : ''})`,
      changes: diffMatrices(matrix.cells, sorted),
      pending,
      stats: {
        apps_checked: new Set(checked.map((c) => c.app)).size,
        apps_failed: [],
        cells_total: checked.length,
        cells_verified: checked.filter((c) => c.verified).length,
        cells_unknown: checked.filter((c) => c.value === 'unknown').length,
        cells_verified_via_archive: checked.filter((c) => c.verified_via === 'archive').length,
      },
    };
    // Cells a capture actually re-dated this run (a capture older than the cell leaves it alone).
    const before = new Map(matrix.cells.map((c) => [cellKey(c.app, c.question), c]));
    const dated = sorted.filter((c) => {
      const old = before.get(cellKey(c.app, c.question));
      return c.verified_via === 'archive' && (old?.archive_timestamp !== c.archive_timestamp || old?.verified_at !== c.verified_at);
    });
    const oldestDated = dated.map((c) => c.verified_at).sort()[0] ?? null;
    saveJson(path.join(DATA_DIR, 'matrix.json'), { version: 1, generated_at: runAt, cells: sorted });
    saveJson(path.join(DATA_DIR, 'changes.json'), changes);
    writeFileSync(
      path.join(DATA_DIR, 'changes.md'),
      renderChangesMarkdown(changes, apps, qs.questions, groupFetchErrors(errors, apps), pending, { confirmed: okViaArchive.length, dated: dated.length, oldestDated }),
      'utf8',
    );
    console.log(`Wrote data/matrix.json (${demoted} cells demoted to unknown, ${pending.length} quotes pending, ${missing.length} missing cells added), data/changes.json, data/changes.md`);
  }
  saveJson(path.join(DATA_DIR, 'check-report.json'), report);

  const bad = failures.length + structural.length + (opts.fix ? 0 : missing.length);
  return bad > 0 && !opts.soft ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'check.ts'));
if (isMain) {
  runCheck(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 2;
    });
}
