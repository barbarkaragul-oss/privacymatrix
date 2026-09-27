/**
 * The reading page: a local page on which the maintainer reads, in their own browser, the blocked
 * pages that the residential re-check could not read (see src/manual.ts).
 *
 *   npm run manual -- --state <folder> [--check] [--minutes N] [--dry-run]
 *
 * The residential task runs it after every run with --check, which only counts the pages due for a
 * reading by hand, writes that number to the task's log and exits: nothing opens on its own.
 * `residential-launch.cmd --read` opens the reading page whenever the maintainer wants, in the
 * default browser, with the pages due (or, when none is due, every page the last run could not
 * read), for --minutes. The pages come from the last run's check report, which the residential run
 * copies into the state folder.
 *
 * On the page, "Open all" opens the pages in the browser, the maintainer pastes each page's text
 * into its box, and the quotes are matched at once. "Save" dates the cells whose quotes were found
 * (verified_via 'manual'), rebuilds, runs the tests, and pushes the commit to main from the task's
 * own checkout, as the residential run pushes its date refreshes. Readings not saved when the time
 * runs out are saved then. It never fetches a vendor's page itself, and it listens on 127.0.0.1 only,
 * answering requests that carry the token in the page's address.
 */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReadings, checkPastedPage, duePages, MANUAL_EVERY_DAYS, unreachablePages, type PageCheck, type ReportCell } from '../src/manual.js';
import type { Cell } from '../src/types.js';
import { commitIdentityArgs, runCommand } from './residential.js';

const DATA_PATHS = ['data/matrix.json', 'data/changes.json', 'data/changes.md', 'README.md', 'docs'];
const FIRST_PORT = 47813;

interface Options {
  state: string | null;
  /** Count the pages due, log the number and exit; no server, no browser. */
  check: boolean;
  minutes: number;
  dryRun: boolean;
  /** Do not open the browser; print the page's full address instead (for testing). */
  noOpen: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { state: null, check: false, minutes: 120, dryRun: false, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') opts.state = argv[++i] ?? null;
    else if (a === '--check') opts.check = true;
    else if (a === '--minutes') opts.minutes = Math.max(1, Number(argv[++i]) || 120);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-open') opts.noOpen = true;
  }
  return opts;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} reading page: ${message}`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}

/** Only web addresses: the browser opener would start any path or protocol handler it is given. */
function isWebAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => { unref(): void; on(event: 'error', listener: (err: Error) => void): unknown };

/**
 * Hands a web address to the default browser, without a shell. On Windows that is the URL protocol
 * handler (rundll32 url.dll,FileProtocolHandler): explorer.exe opened the Documents folder instead,
 * and cmd's start expands %VARIABLE% inside the address. The address goes in its normalised form,
 * percent-encoded ASCII, as one argument that Node quotes. spawn and platform are parameters for
 * the tests.
 */
export function openInBrowser(url: string, deps: { spawn?: Spawn; platform?: NodeJS.Platform } = {}): void {
  if (!isWebAddress(url)) return;
  const href = new URL(url).href;
  const run: Spawn = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const child =
    platform === 'win32'
      ? run('rundll32.exe', ['url.dll,FileProtocolHandler', href], { stdio: 'ignore', detached: true, windowsHide: true })
      : run(platform === 'darwin' ? 'open' : 'xdg-open', [href], { stdio: 'ignore', detached: true });
  // Without a listener, an opener that cannot start (no xdg-open) would end the reading page and
  // lose the readings not yet saved.
  child.on('error', (err) => log(`could not open the browser: ${err.message}`));
  child.unref();
}

/**
 * After a push was rejected because main moved: drops this save's own commit and moves the checkout
 * to the new main (FETCH_HEAD, just fetched), returning it as the new base. Only when the checkout
 * is exactly the old base plus that one commit; anything else (commits of someone else's, a main
 * that was rewritten) is left for a person.
 */
export function retryBaseReset(git: (...args: string[]) => string, base: string): string {
  if (git('rev-parse', 'HEAD~1') !== base || git('rev-list', '--count', 'FETCH_HEAD..HEAD') !== '1') {
    throw new Error('the checkout is not main plus this save\'s own commit; not starting again');
  }
  git('reset', '--quiet', '--hard', 'FETCH_HEAD');
  return git('rev-parse', 'HEAD');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

interface PageInfo {
  url: string;
  app: string;
  quotes: number;
}

function renderPage(pages: PageInfo[], appName: Map<string, string>, token: string, minutes: number, nonce: string, reportDate: string): string {
  const byApp = new Map<string, PageInfo[]>();
  for (const p of pages) byApp.set(p.app, [...(byApp.get(p.app) ?? []), p]);
  const sections = [...byApp.entries()]
    .map(([app, list]) => {
      const items = list
        .map(
          (p) => `<div class="page" data-url="${esc(p.url)}">
  <div class="head"><a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(p.url)}</a><span class="status" role="status" aria-live="polite">not read</span></div>
  <div class="meta">${p.quotes} quote${p.quotes === 1 ? '' : 's'} cited on this page</div>
  <textarea aria-label="Text of ${esc(p.url)}" placeholder="Open the page, press Ctrl+A then Ctrl+C there, and paste it here (Ctrl+V)"></textarea>
  <div class="result" aria-live="polite"></div>
</div>`,
        )
        .join('\n');
      return `<h2>${esc(appName.get(app) ?? app)}</h2>\n${items}`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PrivacyMatrix reading</title>
<style>
:root { --bg: #fafaf7; --fg: #1d1d1b; --muted: #6b6b66; --line: #deded8; --ok: #1f7a3a; --bad: #b3261e; --warn: #8a5a00; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecece6; --muted: #a0a09a; --line: #34342f; --ok: #6fcf8a; --bad: #ff8a80; --warn: #e0b060; --card: #1e1e1c; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 860px; padding: 24px 16px 80px; }
h1 { font-size: 22px; margin: 0 0 8px; } h2 { font-size: 17px; margin: 28px 0 8px; }
p { color: var(--muted); margin: 0 0 12px; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
button:disabled { opacity: .5; cursor: default; }
.page { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 10px 0; }
.head { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
.head a { color: var(--fg); overflow-wrap: anywhere; }
.status { font-size: 13px; color: var(--muted); white-space: nowrap; }
.status.ok { color: var(--ok); } .status.bad { color: var(--bad); } .status.warn { color: var(--warn); }
.meta { font-size: 13px; color: var(--muted); margin: 2px 0 8px; }
textarea { width: 100%; box-sizing: border-box; height: 64px; font: 13px/1.4 ui-monospace, monospace; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.result { font-size: 13px; margin-top: 6px; } .result li { margin: 2px 0; }
.bar { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 12px 0; margin-top: 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
#saved { font-size: 14px; }
</style></head><body>
<h1>Pages to read by hand</h1>
<p>These ${pages.length} page${pages.length === 1 ? '' : 's'} block automatic reading${reportDate ? ` (found in the check of ${reportDate})` : ''}, so their quotes are checked from what you paste. Open each page in this browser, pass any check it shows, select all its text (Ctrl+A), copy it (Ctrl+C) and paste it into its box.</p>
<p>What you paste goes only to a small program on this computer (127.0.0.1), which looks for the quotes in it. The text is not stored and does not leave this computer. Save sends only the new dates to the repository on GitHub (main).</p>
<p>This page is open for ${minutes} minutes. When the time is up, it saves whatever you have read and closes.</p>
<button id="open">Open all ${pages.length} page${pages.length === 1 ? '' : 's'}</button>
${sections}
<div class="bar"><button id="save" class="primary" disabled>Save</button><span id="saved" role="status" aria-live="polite"></span></div>
<script nonce="${nonce}">
const TOKEN = ${JSON.stringify(token)};
const CLOSED = 'The reading page has closed. Open it again with: residential-launch.cmd --read';
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch(() => ({ error: CLOSED }));
const save = document.getElementById('save');
const readCount = () => document.querySelectorAll('.status.ok, .status.bad').length;
document.getElementById('open').onclick = async (e) => { e.target.disabled = true; const r = await post('/open'); e.target.textContent = r.error ? r.error : 'Opening ' + r.opened + ' pages…'; };
for (const page of document.querySelectorAll('.page')) {
  const box = page.querySelector('textarea'), status = page.querySelector('.status'), result = page.querySelector('.result');
  let timer;
  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!box.value.trim()) { status.textContent = 'not read'; status.className = 'status'; result.innerHTML = ''; save.disabled = readCount() === 0; return; }
      const r = await post('/check', { url: page.dataset.url, text: box.value });
      result.innerHTML = '';
      if (r.error || r.unusable) { status.textContent = 'not usable'; status.className = 'status warn'; result.textContent = r.error || r.unusable; save.disabled = readCount() === 0; return; }
      const found = r.results.filter((q) => q.found).length;
      status.textContent = found + ' of ' + r.results.length + ' quotes found';
      status.className = 'status ' + (found === r.results.length ? 'ok' : 'bad');
      const missing = r.results.filter((q) => !q.found);
      if (missing.length) {
        const ul = document.createElement('ul');
        for (const q of missing) { const li = document.createElement('li'); li.textContent = 'Not found (' + q.app + ' / ' + q.question + '): ' + q.quote + (q.note ? ' (' + q.note + ')' : ''); ul.appendChild(li); }
        const note = document.createElement('div'); note.textContent = 'Search the page for these with Ctrl+F. Save records the quotes that were found and leaves these cells as they are. If a quote is really gone, open an issue or give the cell a new quote in data/matrix.json.';
        result.appendChild(ul); result.appendChild(note);
      }
      save.disabled = readCount() === 0;
    }, 400);
  });
}
save.onclick = async () => {
  save.disabled = true;
  document.getElementById('saved').textContent = 'Saving: rebuilding and running the tests…';
  const r = await post('/save');
  document.getElementById('saved').textContent = r.error ? 'Not saved: ' + r.error : r.message;
  if (r.error && r.error !== CLOSED) save.disabled = false;
};
</script>
</body></html>`;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(repoRoot);
  if (!opts.state) {
    log('refused: --state <folder> is required (the residential task passes its state folder)');
    return 2;
  }
  const state = opts.state;
  const cells = readJson<{ cells: Cell[] }>('data/matrix.json', { cells: [] }).cells;
  const apps = readJson<{ apps: Array<{ id: string; name: string; blocked_from_cloud?: boolean }> }>('data/apps.json', { apps: [] }).apps;
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const blocked = new Set(apps.filter((a) => a.blocked_from_cloud).map((a) => a.id));
  // The residential run keeps a copy of its check report in the state folder (last-report.json).
  const report = readJson<{ run_at?: string; cells?: ReportCell[] }>(path.join(state, 'last-report.json'), {});
  const reportDate = (report.run_at ?? '').slice(0, 10);
  const unreachable = unreachablePages(report, blocked).filter((u) => {
    if (isWebAddress(u) && u.startsWith('https:')) return true;
    log(`left out ${u}: not an https address`);
    return false;
  });
  if (reportDate) log(`pages from the check of ${reportDate}`);
  const readsFile = path.join(state, 'manual-reads.json');
  const reads = readJson<Record<string, string>>(readsFile, {});

  const due = duePages(unreachable, reads, cells, today());
  if (opts.check) {
    if (due.length) log(`${due.length} page(s) could be read by hand: residential-launch.cmd --read (${unreachable.length - due.length} more read by hand in the last ${MANUAL_EVERY_DAYS} days)`);
    else if (!reportDate) log('nothing to read by hand: no residential run has been recorded yet');
    else if (unreachable.length === 0) log('nothing to read by hand: the last run read every page');
    else log(`nothing to read by hand (${unreachable.length} page(s) the last run could not read, all read by hand in the last ${MANUAL_EVERY_DAYS} days)`);
    return 0;
  }
  const urls = due.length ? due : unreachable;
  if (urls.length === 0) {
    log(reportDate ? 'nothing to read: the last residential run read every page' : 'nothing to read: no residential run has been recorded yet');
    return 0;
  }
  const pages: PageInfo[] = urls.map((url) => {
    const onPage = cells.filter((c) => c.evidence_url === url && c.value !== 'unknown' && c.quote.trim());
    return { url, app: onPage[0]?.app ?? '', quotes: onPage.length };
  });
  const allowed = new Set(urls);

  const token = randomBytes(16).toString('hex');
  const checks = new Map<string, PageCheck>();
  let saving = false;
  let saved = false;

  const save = async (): Promise<string> => {
    const usable = [...checks.entries()].filter(([, c]) => !c.unusable);
    if (usable.length === 0) throw new Error('no page has been read yet');
    const found = usable.flatMap(([, c]) => c.results.filter((r) => r.found));
    const readUrls = usable.map(([u]) => u);
    let skipped = 0;
    const apply = (): number => {
      const file = readJson<{ cells: Cell[] }>('data/matrix.json', { cells: [] });
      const result = applyReadings(file.cells, found, today());
      skipped = result.skipped;
      writeFileSync('data/matrix.json', JSON.stringify({ ...file, cells: result.cells }, null, 2) + '\n', 'utf8');
      return result.dated;
    };
    // Short limits, so that a save made when the time is up finishes within residential.ts's SAVE_MARGIN_MINUTES.
    const buildAndTest = async (): Promise<void> => {
      for (const cmd of ['npm run build', 'npm test']) {
        log(`$ ${cmd}`);
        const r = await runCommand(cmd, 180_000);
        if (r.timedOut || r.code !== 0) throw new Error(`${cmd} failed`);
      }
    };
    // Starts from origin/main. Refuses a checkout with uncommitted changes or with commits main does
    // not have (a date refresh the residential run could not push), rather than throwing them away.
    const fromMain = (): string => {
      git('fetch', '--quiet', 'origin', 'main');
      if (!opts.dryRun) {
        if (Number(git('rev-list', '--count', 'FETCH_HEAD..HEAD')) > 0) throw new Error('the checkout has commits that main does not have');
        git('reset', '--quiet', '--hard', 'FETCH_HEAD');
      }
      return git('rev-parse', 'HEAD');
    };
    let identity: string[] = [];
    const commit = (dated: number): boolean => {
      git('add', '--', ...DATA_PATHS);
      if (!git('diff', '--cached', '--name-only')) return false;
      git(...identity, 'commit', '--quiet', '-m', `matrix: read by hand in a browser: ${dated} quote(s) present on ${readUrls.length} page(s)`);
      return true;
    };
    if (git('status', '--porcelain')) throw new Error('the checkout has uncommitted changes');
    let base = fromMain();
    let dated = 0;
    let pushed = false;
    let ok = false;
    try {
      dated = apply();
      await buildAndTest();
      if (opts.dryRun) {
        ok = true;
        return `Dry run: ${dated} quote(s) present on ${readUrls.length} page(s); nothing committed.`;
      }
      // The commit carries the pushing account's GitHub noreply identity, never the machine's own.
      identity = await commitIdentityArgs();
      if (commit(dated)) {
        try {
          git('push', '--quiet', 'origin', 'HEAD:main');
          pushed = true;
        } catch (err) {
          const stderr = String((err as { stderr?: unknown }).stderr ?? (err as Error).message);
          const mine = git('rev-parse', 'HEAD');
          git('fetch', '--quiet', 'origin', 'main');
          if (git('rev-parse', 'FETCH_HEAD') === mine) {
            pushed = true; // the push reached main after all (for example it timed out on the way back)
          } else if (!/rejected|non-fast-forward|fetch first/.test(stderr)) {
            throw err;
          } else {
            // main moved while the pages were being read: start again from it, once.
            log('push rejected because main moved; applying the readings to the new main');
            base = retryBaseReset(git, base);
            dated = apply();
            await buildAndTest();
            if (commit(dated)) {
              git('push', '--quiet', 'origin', 'HEAD:main');
              pushed = true;
            }
          }
        }
      }
      ok = true;
    } finally {
      // Leave the checkout as it started: generated files as committed in a dry run, and in a real
      // run no half-made commit, so a second Save can run from a clean state.
      if (opts.dryRun) git('checkout', 'HEAD', '--', ...DATA_PATHS);
      else if (!ok) git('reset', '--quiet', '--hard', base);
    }
    const skippedNote = skipped ? `; ${skipped} reading(s) skipped: the cell changed on main since the page opened` : '';
    const what = `${dated} quote(s) present on ${readUrls.length} page(s)${skippedNote}`;
    const newReads = { ...reads };
    for (const u of readUrls) newReads[u] = today();
    writeFileSync(readsFile, JSON.stringify(newReads, null, 2) + '\n', 'utf8');
    return pushed ? `Saved and pushed: ${what}. You can close this tab.` : `Nothing to push: the dates on main were already current (${what}). You can close this tab.`;
  };

  const finish = async (why: string): Promise<void> => {
    // A save in progress (the button was pressed just before the time ran out) finishes first.
    while (saving) await new Promise((r) => setTimeout(r, 1000));
    let code = 0;
    if (!saved && [...checks.values()].some((c) => !c.unusable)) {
      saving = true;
      try {
        log(`${why}: saving the readings made so far`);
        log(await save());
      } catch (err) {
        log(`not saved: ${(err as Error).message}`);
        code = 1;
      }
    }
    log(`closed (${why})`);
    // A moment for the log line to reach the task's log before the process ends.
    setTimeout(() => process.exit(code), 500);
  };

  const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        data += chunk;
        if (data.length > 5_000_000) req.destroy(new Error('too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  const nonce = randomBytes(16).toString('base64');
  const send = (res: ServerResponse, status: number, value: unknown, type = 'application/json'): void => {
    res.writeHead(status, {
      'content-type': `${type}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(type === 'application/json' ? JSON.stringify(value) : String(value));
  };

  let port = FIRST_PORT;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      // Only requests addressed to 127.0.0.1 itself: a site that rebinds its own name to this
      // address would send its own name here.
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, 'forbidden', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) return send(res, 403, 'Open the address the reading page printed.', 'text/plain');
        return send(res, 200, renderPage(pages, appName, token, opts.minutes, nonce, reportDate), 'text/html');
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      // Only this page may use the endpoints: the token is in its address, and a browser tab on
      // another site cannot read it or send it as a header without the page's own origin.
      const origin = req.headers.origin;
      if (req.headers['x-token'] !== token || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, { error: 'forbidden' });
      if (url.pathname === '/open') {
        urls.forEach((u, i) => setTimeout(() => openInBrowser(u), i * 1500));
        return send(res, 200, { opened: urls.length });
      }
      if (url.pathname === '/check') {
        const { url: page, text } = (await body(req)) as { url?: string; text?: string };
        if (typeof page !== 'string' || !allowed.has(page) || typeof text !== 'string') return send(res, 400, { error: 'unknown page' });
        const result = checkPastedPage(cells, page, text);
        checks.set(page, result);
        return send(res, 200, result);
      }
      if (url.pathname === '/save') {
        if (saving || saved) return send(res, 409, { error: saved ? 'already saved' : 'saving already' });
        saving = true;
        try {
          const message = await save();
          saved = true;
          log(message);
          send(res, 200, { message });
          setTimeout(() => void finish('saved'), 3000);
        } catch (err) {
          send(res, 200, { error: (err as Error).message });
        } finally {
          saving = false;
        }
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const tryListen = (): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port < FIRST_PORT + 10) {
          port++;
          tryListen();
        } else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve());
    };
    tryListen();
  });
  const address = `http://127.0.0.1:${port}/?t=${token}`;
  log(`${urls.length} page(s) to read, open for ${opts.minutes} minutes at http://127.0.0.1:${port}/`);
  if (opts.noOpen) console.log(address);
  else openInBrowser(address);
  setTimeout(() => void finish('time is up'), opts.minutes * 60_000);
  return new Promise<number>(() => undefined);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'manual.ts'));
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      log(`crashed: ${(err as Error).stack ?? err}`);
      process.exitCode = 2;
    },
  );
}
