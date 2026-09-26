/**
 * Residential re-check of the apps whose sources refuse cloud IP ranges or serve them a page without
 * its text (blocked_from_cloud in data/apps.json). GitHub's runners cannot rely on those pages, so
 * this runs on a machine whose connection the vendors do not block.
 *
 * A real run happens only in the task's own checkout, which scripts/residential-launch.cmd resets
 * to origin/main before starting this file. That keeps two promises: only code merged to main runs
 * on the machine, and the run can never touch a checkout someone is working in. Set it up with
 * scripts/install-residential-task.ps1.
 *
 *   node --experimental-strip-types scripts/residential.ts --dry-run
 *       In any clean checkout: check, build and test, print what a real run would do, then put the
 *       generated files back. No pull, no commit, push or GitHub call.
 *   (from the launcher) ... residential.ts [--force]
 *       A real run, if due: the last success is MAX_AGE_DAYS or more old, or --force.
 *
 * It runs under plain node, not tsx, because it may run `npm ci`, which on Windows cannot replace
 * files that a running tsx holds open.
 *
 * What a real run does, mirroring .github/workflows/weekly.yml:
 *   - dates refreshed, first misses flagged -> commit to main and push. The flags must reach main,
 *                                               or the grace period would restart every week.
 *   - a cell demoted (a value changed)       -> the same commit to main without the demotions, then
 *                                               the demotions on top, pushed to
 *                                               bot/residential-verification as a pull request
 *   - any quote flagged missing              -> an issue labelled residential-recheck, opened or updated
 *   - nothing flagged, every page read       -> that issue closed; a demotion PR no longer needed, closed
 * data/changes.json and changes.md stay as the weekly cloud run wrote them: this run checks three
 * apps, and its record would replace the record of all 28. Its own report goes into the issue and PR.
 *
 * The GitHub token comes from git's credential helper and is never printed.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_AGE_DAYS = 6;
export const BOT_BRANCH = 'bot/residential-verification';
export const ISSUE_LABEL = 'residential-recheck';
// Everything a check and build may rewrite, and nothing else.
const DATA_PATHS = ['data/matrix.json', 'data/changes.json', 'data/changes.md', 'README.md', 'docs'];
const RUN_RECORD = ['data/changes.json', 'data/changes.md'];

// ---------------------------------------------------------------------------------------------
// Pure decisions (tested in tests/residential.test.ts)

/** True when there has been no successful run yet, or the last one is at least maxAgeDays old. */
export function isDue(lastSuccess: string | null, today: string, maxAgeDays: number): boolean {
  if (!lastSuccess) return true;
  const days = (Date.parse(today) - Date.parse(lastSuccess)) / 86_400_000;
  return !Number.isFinite(days) || days >= maxAgeDays;
}

export interface RunOutcome {
  /** Cells whose value changed (demotions). */
  valueChanges: number;
  /** Quotes found missing from their live page this run. */
  pending: number;
  /** Cells of the blocked apps that carry quote_missing_since after the run, whatever run set it. */
  flagged: number;
  /** Cells whose page could not be read this run. */
  unreachable: number;
  /** Whether the check and build changed any tracked file. */
  dirty: boolean;
}

export interface Plan {
  commit: 'none' | 'main' | 'main+pr';
  /** 'keep' when pages were unreachable: it cannot be said that every quote was found. */
  issue: 'open' | 'close' | 'keep';
  pr: 'open' | 'close';
}

export function decide(o: RunOutcome): Plan {
  return {
    commit: !o.dirty ? 'none' : o.valueChanges > 0 ? 'main+pr' : 'main',
    issue: o.valueChanges > 0 || o.flagged > 0 ? 'open' : o.unreachable > 0 ? 'keep' : 'close',
    pr: o.valueChanges > 0 ? 'open' : 'close',
  };
}

export function summarize(report: { ok: number; errors: number }, o: RunOutcome): string {
  return `${o.valueChanges} value change${o.valueChanges === 1 ? '' : 's'}, ${report.ok} quotes present, ${o.pending} newly missing, ${report.errors} cells on unreachable pages`;
}

/** owner/repo from an https or ssh GitHub remote URL. */
export function repoSlug(remoteUrl: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

interface MatrixCell {
  app: string;
  question: string;
  quote_missing_since?: string;
  [key: string]: unknown;
}
interface MatrixFile {
  cells: MatrixCell[];
  [key: string]: unknown;
}

/**
 * The matrix that goes to main when a run also demotes cells: the run's result, except that every
 * demoted cell keeps its version from before the run (still flagged, so the next run demotes it
 * again until the pull request is merged or the quote is fixed).
 */
export function withoutDemotions(result: MatrixFile, before: MatrixFile, demoted: Array<{ app: string; question: string }>): MatrixFile {
  const key = (c: { app: string; question: string }): string => `${c.app}|${c.question}`;
  const demotedKeys = new Set(demoted.map(key));
  const beforeByKey = new Map(before.cells.map((c) => [key(c), c]));
  return { ...result, cells: result.cells.map((c) => (demotedKeys.has(key(c)) ? (beforeByKey.get(key(c)) ?? c) : c)) };
}

// ---------------------------------------------------------------------------------------------
// Side effects

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
}

/** How long one npm command may run before it and every process it started are stopped. */
export const NPM_TIMEOUT_MS = 1_800_000;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    // 128: the process had already exited.
    if (r.error || (r.status !== 0 && r.status !== 128)) {
      log(`taskkill could not stop process tree ${child.pid} (${r.error?.message ?? `exit ${r.status}`}); stopping the shell alone`);
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group has already gone
    }
  }
}

// Signals that would end this process while the command runs. Elsewhere than on Windows the command
// runs in a session of its own, which the terminal's signals no longer reach.
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs a shell command with its output passed through to the log. When it takes longer than
 * timeoutMs, the whole process tree is stopped, not only the shell: stopping the shell alone left
 * npm and the check running, and the check went on writing into a checkout that had been reset.
 * On Windows taskkill /T stops the tree. Elsewhere the command gets a process group (and session)
 * of its own and the group is killed; as that group no longer receives the terminal's Ctrl-C or
 * hangup, on SIGINT, SIGTERM or SIGHUP the group is killed and the signal raised again on this
 * process.
 */
export function runCommand(command: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(command, { stdio: 'inherit', shell: true, detached: !windows });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onSignal = (signal: NodeJS.Signals): void => {
      killTree(child);
      process.kill(process.pid, signal);
    };
    if (!windows) for (const s of STOP_SIGNALS) process.once(s, onSignal);
    const done = (): void => {
      clearTimeout(timer);
      for (const s of STOP_SIGNALS) process.off(s, onSignal);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('exit', (code) => {
      done();
      resolve({ code, timedOut });
    });
  });
}

/** Runs an npm command with its output passed through to the log; throws if it fails or times out. */
async function npm(...args: string[]): Promise<void> {
  // One command line for the shell, which resolves npm.cmd on Windows; every argument is a constant of this file.
  const command = `npm ${args.join(' ')}`;
  log(`$ ${command}`);
  const { code, timedOut } = await runCommand(command, NPM_TIMEOUT_MS);
  if (timedOut) throw new Error(`${command} ran longer than ${NPM_TIMEOUT_MS / 60_000} minutes and was stopped`);
  if (code !== 0) throw new Error(`${command} exited with ${code}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function githubToken(): string {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 60_000 });
  const token = /^password=(.+)$/m.exec(out)?.[1]?.trim();
  if (!token) throw new Error('git credential fill returned no GitHub token');
  return token;
}

async function api(token: string, method: string, url: string, body?: unknown, allow422 = false): Promise<any> {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'privacymatrix-residential',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok && !(allow422 && res.status === 422)) throw new Error(`GitHub API ${method} ${url} answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const NOTE =
  "These apps' pages refuse requests from cloud IP ranges, so this was checked by the residential re-check (scripts/residential.ts) and can only be re-quoted from a residential connection.";

async function syncPullRequest(token: string, slug: string, action: 'open' | 'close', title: string, body: string): Promise<void> {
  const owner = slug.split('/')[0];
  const open = await api(token, 'GET', `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${BOT_BRANCH}`)}`);
  const existing = Array.isArray(open) && open.length ? open[0] : null;
  if (action === 'open') {
    if (existing) {
      await api(token, 'PATCH', `/repos/${slug}/pulls/${existing.number}`, { title, body });
      log(`updated pull request #${existing.number}`);
    } else {
      const pr = await api(token, 'POST', `/repos/${slug}/pulls`, { head: BOT_BRANCH, base: 'main', title, body });
      log(`opened pull request #${pr.number}`);
    }
  } else if (existing) {
    // The quotes it would demote were found again, or fixed: merging it now would be wrong.
    await api(token, 'POST', `/repos/${slug}/issues/${existing.number}/comments`, { body: `The residential re-check of ${today()} no longer demotes any cell, so this pull request is out of date. Closing.` });
    await api(token, 'PATCH', `/repos/${slug}/pulls/${existing.number}`, { state: 'closed' });
    log(`closed pull request #${existing.number}`);
  }
}

async function syncIssue(token: string, slug: string, action: 'open' | 'close' | 'keep', title: string, body: string): Promise<void> {
  if (action === 'keep') return;
  const open = await api(token, 'GET', `/repos/${slug}/issues?state=open&labels=${ISSUE_LABEL}`);
  const existing = Array.isArray(open) ? open.find((i: { pull_request?: unknown }) => !i.pull_request) : undefined;
  if (action === 'open') {
    if (existing) {
      await api(token, 'PATCH', `/repos/${slug}/issues/${existing.number}`, { title, body });
      log(`updated issue #${existing.number}`);
    } else {
      // Creating the label answers 422 when it already exists; that is the only 422 expected.
      await api(token, 'POST', `/repos/${slug}/labels`, { name: ISSUE_LABEL, color: 'd4c5f9', description: 'Found missing by the residential re-check' }, true);
      const issue = await api(token, 'POST', `/repos/${slug}/issues`, { title, body, labels: [ISSUE_LABEL] });
      log(`opened issue #${issue.number}`);
    }
  } else if (existing) {
    await api(token, 'POST', `/repos/${slug}/issues/${existing.number}/comments`, { body: `The residential re-check of ${today()} read every page and found no quote missing. Closing.` });
    await api(token, 'PATCH', `/repos/${slug}/issues/${existing.number}`, { state: 'closed' });
    log(`closed issue #${existing.number}`);
  }
}

/** npm ci when main's lockfile differs from the one last installed, or the last install did not finish. */
async function ensureDependencies(stateDir: string): Promise<void> {
  const marker = path.join(stateDir, 'installed-lock');
  const lock = git('rev-parse', 'HEAD:package-lock.json');
  const installed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
  if (installed === lock && existsSync('node_modules')) return;
  if (existsSync(marker)) writeFileSync(marker, '', 'utf8'); // a failed install must be retried next time
  await npm('ci', '--no-audit', '--no-fund');
  writeFileSync(marker, `${lock}\n`, 'utf8');
}

export interface Options {
  force: boolean;
  dryRun: boolean;
}

export async function run(opts: Options): Promise<number> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(repoRoot);
  // A scheduled task has nobody to answer a credential prompt; fail instead of hanging.
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GCM_INTERACTIVE = 'never';
  log(`residential re-check${opts.dryRun ? ' (dry run)' : ''}${opts.force ? ' (forced)' : ''} in ${repoRoot}`);

  if (git('status', '--porcelain')) {
    log('skipped: the working tree has uncommitted changes');
    return 0;
  }
  const stateDir = process.env.RESIDENTIAL_STATE_DIR;
  if (!opts.dryRun) {
    if (!stateDir) {
      log("refused: a real run happens only in the task's own checkout (see scripts/install-residential-task.ps1); use --dry-run here");
      return 0;
    }
    const stamp = path.join(stateDir, 'last-success');
    const last = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
    if (!opts.force && !isDue(last, today(), MAX_AGE_DAYS)) {
      log(`skipped: last success ${last}, not due until ${MAX_AGE_DAYS} days after it`);
      return 0;
    }
    // The launcher reset this checkout to origin/main a moment ago; anything else is not the task's checkout.
    git('fetch', '--quiet', 'origin', 'main');
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'FETCH_HEAD')) {
      log('skipped: this checkout is not at origin/main; the launcher resets it before every run');
      return 0;
    }
  }
  // In the task's own checkout (real run or a dry run started by the launcher) dependencies are this
  // script's job; in someone's checkout they are theirs.
  if (stateDir) await ensureDependencies(stateDir);

  const start = git('rev-parse', 'HEAD');
  // A dry run may be in someone's checkout: put back only what the check and build wrote.
  const restore = (to = start): void => {
    if (opts.dryRun) git('checkout', 'HEAD', '--', ...DATA_PATHS);
    else git('reset', '--hard', to);
  };

  let pushedMain = false;
  try {
    await npm('run', 'check', '--', '--fix', '--soft', '--residential', '--only-blocked');
    const report = readJson<{ ok: number; errors: number }>('data/check-report.json');
    if (report.ok === 0) throw new Error('every page failed to load; not publishing a run that verified nothing');
    const changes = readJson<{ changes: Array<{ app: string; question: string }>; pending: unknown[] }>('data/changes.json');
    const changesMd = readFileSync('data/changes.md', 'utf8');
    // Keep the weekly cloud run's record of all apps; this run's report goes to the issue and PR.
    git('checkout', 'HEAD', '--', ...RUN_RECORD);

    const blocked = new Set(readJson<{ apps: Array<{ id: string; blocked_from_cloud?: boolean }> }>('data/apps.json').apps.filter((a) => a.blocked_from_cloud).map((a) => a.id));
    const result = readJson<MatrixFile>('data/matrix.json');
    await npm('run', 'build');
    await npm('run', 'typecheck');
    await npm('test');

    const outcome: RunOutcome = {
      valueChanges: changes.changes.length,
      pending: changes.pending.length,
      flagged: result.cells.filter((c) => blocked.has(c.app) && c.quote_missing_since).length,
      unreachable: report.errors,
      dirty: git('status', '--porcelain', '--', ...DATA_PATHS) !== '',
    };
    const plan = decide(outcome);
    const summary = summarize(report, outcome);
    log(`result: ${summary}; ${outcome.flagged} flagged; plan: commit ${plan.commit}, issue ${plan.issue}, pull request ${plan.pr}`);

    if (opts.dryRun) {
      restore();
      log('dry run: generated files restored; nothing committed, pushed or sent');
      return 0;
    }

    let mainCommit = start;
    if (plan.commit !== 'none') {
      if (plan.commit === 'main+pr') {
        // main gets every date and flag; the demoted cells stay as they were until a human merges the PR.
        const before = JSON.parse(git('show', 'HEAD:data/matrix.json')) as MatrixFile;
        writeJson('data/matrix.json', withoutDemotions(result, before, changes.changes));
        await npm('run', 'build');
        await npm('test');
      }
      if (git('status', '--porcelain', '--', ...DATA_PATHS)) {
        git('add', '--', ...DATA_PATHS);
        const what = plan.commit === 'main+pr' ? 'dates and flags; the demotions are in a pull request' : summary;
        git('commit', '--quiet', '-m', `matrix: residential re-verification: ${what}`);
        try {
          git('push', '--quiet', 'origin', 'HEAD:main');
        } catch (err) {
          // Most likely the weekly cloud run pushed while this one was checking. Start over next time.
          throw new Error(`push to main rejected; the next run starts from the new main (${(err as Error).message.split('\n')[0]})`);
        }
        pushedMain = true;
        mainCommit = git('rev-parse', 'HEAD');
        log('pushed to main');
      }
      if (plan.commit === 'main+pr') {
        writeJson('data/matrix.json', result);
        await npm('run', 'build');
        git('add', '--', ...DATA_PATHS);
        git('commit', '--quiet', '-m', `matrix: residential re-verification demotes ${outcome.valueChanges} cell(s)`);
        // The bot owns this branch: it is rebuilt from main on every run that demotes something.
        git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${BOT_BRANCH}`);
        restore(mainCommit);
        log(`pushed the demotions to ${BOT_BRANCH}`);
      }
    }

    const slug = repoSlug(git('remote', 'get-url', 'origin'));
    if (!slug) throw new Error('origin is not a GitHub remote; the pull request and issue were not updated');
    const token = githubToken();
    await syncPullRequest(token, slug, plan.pr, `matrix: residential re-verification (${summary})`, `${NOTE}\n\n${changesMd}`);
    const issueTitle = `Residential check: ${outcome.valueChanges} cell(s) demoted, ${outcome.flagged} quote(s) flagged missing`;
    await syncIssue(token, slug, plan.issue, issueTitle, `${NOTE}\n\n${changesMd}`);

    writeFileSync(path.join(stateDir as string, 'last-success'), `${today()}\n`, 'utf8');
    log('done');
    return 0;
  } catch (err) {
    restore();
    const note = pushedMain ? ' (the data commit had already reached main)' : '';
    log(`failed${note}, checkout reset: ${(err as Error).message}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'residential.ts'));
if (isMain) {
  const args = new Set(process.argv.slice(2));
  run({ force: args.has('--force'), dryRun: args.has('--dry-run') }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      log(`crashed: ${(err as Error).stack ?? err}`);
      process.exitCode = 2;
    },
  );
}
