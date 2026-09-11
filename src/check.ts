/**
 * Offline verification of the matrix: does every quote really appear at its evidence URL?
 *
 *   npm run check                 report; exit 1 if any quote is missing from a fetched page
 *   npm run check -- --soft       report; always exit 0
 *   npm run check -- --fix        rewrite data/matrix.json: quotes found -> verified today;
 *                                 quotes missing from a fetched page -> value "unknown" (the old
 *                                 quote, URL and value are kept in the notes for a human to fix);
 *                                 also writes data/changes.json and data/changes.md
 *   npm run check -- --app id   limit to one app
 *
 * A page that cannot be fetched (timeout, 5xx, bot block) is reported as an error and never
 * demotes a cell: only a successfully fetched page that no longer contains the quote does.
 * No API key needed. This is the free weekly re-verification, and the same check CI runs on
 * pull requests that edit the data.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { diffMatrices, renderChangesMarkdown } from './diff.js';
import { Fetcher } from './fetch.js';
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
}

export type PageResult = PreparedText | { error: string };

/** Minimum amount of text a fetched page must contain before a missing quote counts as evidence (a client-rendered shell has almost none; a short LICENSE file has more). */
export const MIN_PAGE_CHARS = 40;
const CHALLENGE_MARKERS = [/just a moment/i, /enable javascript/i, /access denied/i, /attention required/i, /verify you are human/i, /checking your browser/i];

/**
 * A 200 response is not always the page: bot challenges, consent walls and client-rendered
 * shells return status 200 with no documentation in them. Such pages must never demote a cell,
 * so they are reported as fetch errors instead. Returns the reason, or null when the page is usable.
 */
export function unusablePage(text: string, truncated: boolean): string | null {
  if (truncated) return 'page larger than the download limit';
  if (text.trim().length < MIN_PAGE_CHARS) return `page has only ${text.trim().length} characters of text`;
  const head = text.slice(0, 2000);
  for (const re of CHALLENGE_MARKERS) if (re.test(head)) return 'page looks like a bot challenge or consent wall';
  return null;
}

export interface CheckOptions {
  soft: boolean;
  fix: boolean;
  app: string | null;
}

function parseArgs(argv: string[]): CheckOptions {
  const out: CheckOptions = { soft: false, fix: false, app: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--soft') out.soft = true;
    else if (a === '--fix') out.fix = true;
    else if (a === '--app') out.app = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log('usage: check [--soft] [--fix] [--app <id>]');
      process.exit(0);
    }
  }
  return out;
}

export function classifyCell(cell: Cell, page: PageResult | undefined): CellReport {
  const base = { app: cell.app, question: cell.question, value: cell.value, evidence_url: cell.evidence_url };
  if (!cell.quote.trim() || !cell.evidence_url.trim()) return { ...base, status: 'skipped', method: 'none', problems: [] };
  const problems = quoteProblems(cell.quote);
  if (!page) return { ...base, status: 'error', method: 'none', problems: [...problems, 'page not fetched'] };
  if ('error' in page) return { ...base, status: 'error', method: 'none', problems: [...problems, `fetch failed: ${page.error}`] };
  const m = findQuote(page, cell.quote);
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
    if (cell.value === 'unknown' && cell.verified) problems.push(`${key}: unknown cells cannot be verified`);
  }
  const missing: string[] = [];
  for (const a of apps) for (const c of questions) if (!seen.has(cellKey(a.id, c.id))) missing.push(cellKey(a.id, c.id));
  return { problems, missing };
}

/** Applies check results to the cells: ok -> verified today; fail -> unknown (old data kept in notes); error/skipped -> untouched. */
export function applyFix(cells: Cell[], reports: CellReport[], missing: string[], today: string): { cells: Cell[]; demoted: number } {
  const byKey = new Map(reports.map((r) => [cellKey(r.app, r.question), r]));
  let demoted = 0;
  const out: Cell[] = cells.map((cell) => {
    const r = byKey.get(cellKey(cell.app, cell.question));
    if (!r) return cell;
    if (r.status === 'fail') {
      demoted++;
      const tail = cell.notes.trim() ? ` | ${cell.notes.trim()}` : '';
      return {
        ...cell,
        value: 'unknown',
        quote: '',
        evidence_url: '',
        confidence: 'low',
        verified: false,
        verified_at: '',
        notes: `UNVERIFIED on ${today} (${r.problems.join('; ')}; was ${cell.value}): "${cell.quote.trim()}" at ${cell.evidence_url}${tail}`,
      };
    }
    if (r.status === 'ok' && cell.value !== 'unknown') return { ...cell, verified: true, verified_at: today };
    if (cell.value === 'unknown' && cell.verified) return { ...cell, verified: false, verified_at: '' };
    return cell;
  });
  for (const key of missing) {
    const [app, question] = key.split('|') as [string, string];
    out.push({ app, question, value: 'unknown', quote: '', evidence_url: '', notes: '', confidence: 'low', verified: false, verified_at: '' });
  }
  return { cells: out, demoted };
}

export async function runCheck(opts: CheckOptions): Promise<number> {
  const apps = loadApps();
  const qs = loadQuestions();
  const matrix = loadMatrix();
  const { problems: structural, missing } = structuralProblems(matrix.cells, apps, qs.questions);

  const targets = matrix.cells.filter((c) => !opts.app || c.app === opts.app);
  const fetcher = new Fetcher({}, 4);
  const cellsToCheck = targets.filter((c) => c.quote.trim() && c.evidence_url.trim());
  const urls = [...new Set(cellsToCheck.map((c) => c.evidence_url))];
  console.log(`Checking ${cellsToCheck.length} quoted cells across ${urls.length} URLs (${targets.length - cellsToCheck.length} cells without a quote skipped)`);

  const pages = new Map<string, PageResult>();
  await Promise.all(
    urls.map(async (url) => {
      const res = await fetcher.get(url);
      const problem = !res.ok ? (res.error ?? `HTTP ${res.status}`) : unusablePage(res.text, res.truncated);
      if (problem) {
        pages.set(url, { error: problem });
        console.log(`  FETCH ERROR ${url} (${problem})`);
      } else {
        pages.set(url, prepareText(res.text));
      }
    }),
  );

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
  console.log(`Result: ${okCount} ok, ${failures.length} failed, ${errors.length} fetch errors (cells untouched), ${skipped} skipped, ${structural.length} structural problems, ${missing.length} missing. Match methods: ${JSON.stringify(byMethod)}`);

  saveJson(path.join(DATA_DIR, 'check-report.json'), {
    run_at: new Date().toISOString(),
    ok: okCount,
    failed: failures.length,
    errors: errors.length,
    skipped,
    structural,
    missing,
    cells: reports,
  });

  if (opts.fix) {
    const today = todayIso();
    const { cells, demoted } = applyFix(matrix.cells, reports, missing, today);
    const sorted = sortCells(cells, apps, qs.questions);
    const runAt = new Date().toISOString();
    const checked = opts.app ? sorted.filter((c) => c.app === opts.app) : sorted;
    const changes: ChangesFile = {
      run_at: runAt,
      model: opts.app ? `none (mechanical quote re-check, app ${opts.app} only)` : 'none (mechanical quote re-check)',
      changes: diffMatrices(matrix.cells, sorted),
      stats: {
        apps_checked: new Set(checked.map((c) => c.app)).size,
        apps_failed: [],
        cells_total: checked.length,
        cells_verified: checked.filter((c) => c.verified).length,
        cells_unknown: checked.filter((c) => c.value === 'unknown').length,
      },
    };
    saveJson(path.join(DATA_DIR, 'matrix.json'), { version: 1, generated_at: runAt, cells: sorted });
    saveJson(path.join(DATA_DIR, 'changes.json'), changes);
    writeFileSync(path.join(DATA_DIR, 'changes.md'), renderChangesMarkdown(changes, apps, qs.questions, errors.map((e) => `${e.app}/${e.question}: ${e.problems.join('; ')}`)), 'utf8');
    console.log(`Wrote data/matrix.json (${demoted} cells demoted to unknown, ${missing.length} missing cells added), data/changes.json, data/changes.md`);
  }

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
