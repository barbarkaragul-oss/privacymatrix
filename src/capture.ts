/**
 * Fresh Wayback Machine captures of the pages the checker cannot read.
 *
 *   npm run capture -- --out captures.json [--app <id>]
 *
 * Asks the Wayback Machine's Save Page Now to capture the evidence pages of the apps marked
 * blocked_from_cloud, with the maintainer's archive.org keys (IA_ACCESS_KEY and IA_SECRET_KEY,
 * GitHub secrets in the workflows; never printed). archive.org's own crawler fetches each page, and
 * a page that answers it with an error (a 403 included) is not captured. The file maps each captured
 * page to its capture's timestamp; `check --captures <file>` reads those captures directly instead of
 * searching the archive's index, whose lookups often fail. A capture only ever confirms a quote, as
 * any capture does (src/archive.ts); it never demotes a cell.
 *
 * Gentle by design: one request every ten seconds (the documented limit for an account is seven a
 * minute), a new capture only if the page has none from the last day, no outlinks, no screenshot.
 * Without keys, or when archive.org fails, it writes what it has and exits 0: the check then falls
 * back to the archive's index as before.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureDate } from './archive.js';
import { loadApps, loadMatrix, type App, type Cell } from './types.js';

const SAVE = 'https://web.archive.org/save';
const USER_AGENT = 'privacymatrix-bot/0.1 (+https://github.com/barbarkaragul-oss/privacymatrix)';

export interface CaptureResult {
  url: string;
  /** Wayback timestamp (YYYYMMDDhhmmss) of the capture, when there is one. */
  timestamp?: string;
  error?: string;
}

export interface CapturesFile {
  run_at: string;
  /** Page -> timestamp of the capture made (or found from the last day) this run. */
  captures: Record<string, string>;
  /** Page -> why no capture came back. */
  errors: Record<string, string>;
}

/** The evidence pages of the quoted cells of the apps marked blocked_from_cloud, once each, sorted. */
export function captureTargets(cells: Cell[], apps: App[], app: string | null = null): string[] {
  const blocked = new Set(apps.filter((a) => a.blocked_from_cloud).map((a) => a.id));
  const urls = new Set<string>();
  for (const c of cells) {
    if (!blocked.has(c.app) || (app && c.app !== app)) continue;
    if (c.value !== 'unknown' && c.quote.trim() && c.evidence_url.trim()) urls.add(c.evidence_url);
  }
  return [...urls].sort();
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CaptureDeps {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Between two capture requests. */
  spacingMs?: number;
  /** Between two status checks of the pending captures. */
  pollMs?: number;
  /** How long a capture may stay pending before it is given up. */
  timeoutMs?: number;
}

interface Job {
  url: string;
  jobId?: string;
  result?: CaptureResult;
  deadline: number;
}

/** An archive.org answer as a short reason, without anything from the request (the keys are in its headers). */
function spnError(json: unknown): string | null {
  const j = json as { status?: unknown; status_ext?: unknown; message?: unknown } | null;
  if (!j || typeof j !== 'object') return 'archive.org answered with something that is not JSON';
  if (j.status !== 'error' && !j.status_ext) return null;
  const ext = typeof j.status_ext === 'string' ? j.status_ext : 'error';
  const message = typeof j.message === 'string' ? j.message.trim() : '';
  return message ? `${ext}: ${message}` : ext;
}

/** Captures urls one request at a time; every page ends with a timestamp or an error, never a throw. */
export async function captureAll(urls: string[], keys: { access: string; secret: string }, deps: CaptureDeps = {}): Promise<CaptureResult[]> {
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m: string) => console.log(m));
  const spacingMs = deps.spacingMs ?? 10_000;
  const pollMs = deps.pollMs ?? 10_000;
  const timeoutMs = deps.timeoutMs ?? 240_000;
  const headers = { Accept: 'application/json', Authorization: `LOW ${keys.access}:${keys.secret}`, 'User-Agent': USER_AGENT };
  const call = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ json?: unknown; error?: string }> => {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.status === 401 || res.status === 403) return { error: `archive.org refused the keys (HTTP ${res.status})` };
      if (res.status === 429) return { error: 'archive.org is limiting requests (HTTP 429)' };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { error: `archive.org answered HTTP ${res.status} with something that is not JSON` };
      }
      if (!res.ok) return { error: spnError(json) ?? `archive.org answered HTTP ${res.status}` };
      return { json };
    } catch (err) {
      return { error: err instanceof Error ? (err.name === 'TimeoutError' ? 'archive.org did not answer in time' : err.message) : String(err) };
    }
  };

  let clock = 0;
  const now = (): number => clock;
  const wait = async (ms: number): Promise<void> => {
    await sleep(ms);
    clock += ms;
  };

  const jobs: Job[] = [];
  for (const [i, url] of urls.entries()) {
    if (i > 0) await wait(spacingMs);
    const body = new URLSearchParams({ url, if_not_archived_within: '1d', skip_first_archive: '1' }).toString();
    const submitted = await call(SAVE, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const job: Job = { url, deadline: now() + timeoutMs };
    const jobId = (submitted.json as { job_id?: unknown } | undefined)?.job_id;
    if (submitted.error) job.result = { url, error: submitted.error };
    else if (typeof jobId === 'string' && jobId) job.jobId = jobId;
    else job.result = { url, error: spnError(submitted.json) ?? 'archive.org did not start a capture' };
    jobs.push(job);
    // A key that is refused will be refused for every page: stop asking.
    if (job.result?.error?.startsWith('archive.org refused the keys')) {
      for (const rest of urls.slice(i + 1)) jobs.push({ url: rest, deadline: 0, result: { url: rest, error: job.result.error } });
      break;
    }
  }

  while (jobs.some((j) => !j.result)) {
    await wait(pollMs);
    for (const job of jobs.filter((j) => !j.result)) {
      const status = await call(`${SAVE}/status/${encodeURIComponent(job.jobId as string)}`, { method: 'GET', headers });
      const s = status.json as { status?: unknown; timestamp?: unknown } | undefined;
      if (status.error) {
        if (now() >= job.deadline) job.result = { url: job.url, error: `status check failed: ${status.error}` };
      } else if (s?.status === 'success') {
        const ts = typeof s.timestamp === 'string' ? s.timestamp : '';
        job.result = captureDate(ts) ? { url: job.url, timestamp: ts } : { url: job.url, error: 'archive.org reported success without a valid timestamp' };
      } else if (s?.status === 'pending') {
        if (now() >= job.deadline) job.result = { url: job.url, error: `capture still pending after ${Math.round(timeoutMs / 1000)} s` };
      } else {
        job.result = { url: job.url, error: spnError(s) ?? 'archive.org reported an unknown capture status' };
      }
    }
  }

  const results = jobs.map((j) => j.result as CaptureResult);
  for (const r of results) log(r.timestamp ? `  CAPTURED ${r.url} (${r.timestamp})` : `  NOT CAPTURED ${r.url} (${r.error})`);
  return results;
}

export function capturesFile(results: CaptureResult[], runAt: string): CapturesFile {
  const file: CapturesFile = { run_at: runAt, captures: {}, errors: {} };
  for (const r of results) {
    if (r.timestamp) file.captures[r.url] = r.timestamp;
    else file.errors[r.url] = r.error ?? 'no capture';
  }
  return file;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'capture.ts'));
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const out = arg('--out');
  const app = arg('--app');
  const main = async (): Promise<void> => {
    if (!out) throw new Error('usage: npm run capture -- --out <file> [--app <id>]');
    const access = process.env.IA_ACCESS_KEY?.trim();
    const secret = process.env.IA_SECRET_KEY?.trim();
    const urls = captureTargets(loadMatrix().cells, loadApps(), app);
    let results: CaptureResult[];
    if (!access || !secret) {
      console.log('No archive.org keys (IA_ACCESS_KEY, IA_SECRET_KEY): no captures made; the check will use the archive as it is.');
      results = urls.map((url) => ({ url, error: 'no archive.org keys' }));
    } else {
      console.log(`Asking the Wayback Machine to capture ${urls.length} page(s) of the apps marked blocked_from_cloud, one request every 10 s`);
      results = await captureAll(urls, { access, secret });
    }
    const file = capturesFile(results, new Date().toISOString());
    writeFileSync(out, JSON.stringify(file, null, 2) + '\n', 'utf8');
    console.log(`Captured ${Object.keys(file.captures).length} of ${urls.length} page(s); wrote ${out}`);
  };
  main().catch((err) => {
    // Never fails the run that called it: without captures the check reads the archive as before.
    console.error(`capture: ${err instanceof Error ? err.message : err}`);
    if (!out) process.exitCode = 2;
  });
}
