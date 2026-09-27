/**
 * Records a maintainer's reading of a page the checker cannot read.
 *
 *   npm run attest -- <app> <question>
 *
 * Run it after reading the cell's page in a browser and finding its quote there, exactly. It marks
 * the cell verified today (UTC), verified_via 'manual', and writes manual_fingerprint, which binds
 * the reading to this value, quote, URL and date (src/fingerprint.ts). The pull-request gate accepts
 * the reading only while that still matches, and only in a pull request a maintainer opened (see
 * unverifiedChanges in src/check.ts); running this is you vouching for having read the page.
 *
 * Only for apps marked blocked_from_cloud: for any other app the checker reads the page itself.
 * The reading page (scripts/manual.ts) does the same for the pages it matches from pasted text.
 */
import path from 'node:path';
import { fingerprint } from './fingerprint.js';
import { quoteProblems } from './quotes.js';
import { DATA_DIR, loadApps, loadMatrix, saveJson, todayIso, type App, type Cell } from './types.js';

/** The cells with app/question attested as read today; throws when the cell cannot rest on a reading. */
export function attestCell(cells: Cell[], apps: App[], app: string, question: string, today: string): { cells: Cell[]; cell: Cell } {
  const target = cells.find((c) => c.app === app && c.question === question);
  if (!target) throw new Error(`no cell ${app}/${question}`);
  if (!apps.find((a) => a.id === app)?.blocked_from_cloud) throw new Error(`${app} is not marked blocked_from_cloud: the checker reads its pages itself, and the gate accepts no reading for it`);
  if (target.value === 'unknown' || !target.quote.trim() || !target.evidence_url.trim()) throw new Error(`${app}/${question} has no value, quote or evidence URL to vouch for`);
  const problems = quoteProblems(target.quote);
  if (problems.length) throw new Error(`${app}/${question}: ${problems.join('; ')}; fix the quote first`);
  const read: Cell = { ...target, verified: true, verified_at: today, verified_via: 'manual' };
  delete read.archive_timestamp;
  delete read.quote_missing_since;
  read.manual_fingerprint = fingerprint(read);
  return { cells: cells.map((c) => (c === target ? read : c)), cell: read };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'attest.ts'));
if (isMain) {
  const [app, question] = process.argv.slice(2);
  try {
    if (!app || !question) throw new Error('usage: npm run attest -- <app> <question>');
    const matrix = loadMatrix();
    const { cells, cell } = attestCell(matrix.cells, loadApps(), app, question, todayIso());
    saveJson(path.join(DATA_DIR, 'matrix.json'), { ...matrix, cells });
    console.log(`Attested ${app}/${question}: verified ${cell.verified_at} (UTC), verified_via manual, fingerprint ${cell.manual_fingerprint?.slice(0, 8)}.`);
    console.log(`You are vouching that you read this quote, exactly, on ${cell.evidence_url} today:`);
    console.log(`  "${cell.quote.trim()}"`);
    console.log('Now run npm run build, and commit data/matrix.json, README.md and docs/ in a pull request you open yourself.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  }
}
