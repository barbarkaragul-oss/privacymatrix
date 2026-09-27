import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../src/fingerprint.js';
import type { Cell } from '../src/types.js';

test('local manual save works without Git, preserves a dirty checkout and writes only a review draft', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const matrixFile = path.join(root, 'data/matrix.json');
  const before = readFileSync(matrixFile, 'utf8');
  const cells = (JSON.parse(before) as { cells: Cell[] }).cells;
  const cell = cells.find(c => c.app === 'perplexity' && c.quote.trim())!;
  const state = mkdtempSync(path.join(tmpdir(), 'pm-manual-local-'));
  writeFileSync(path.join(state, 'last-report.json'), JSON.stringify({ run_at: new Date().toISOString(), cells: [{ ...cell, status: 'error' }] }));
  // An empty PATH ensures an accidental Git/npm branch fails instead of creating any commit.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/manual.ts', '--state', state, '--local-only', '--all', '--no-open', '--minutes', '1'], {
    cwd: root, env: { ...process.env, PATH: '', Path: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    let match: RegExpExecArray | null = null;
    for (let i = 0; i < 150; i++) {
      match = /http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/.exec(output);
      if (match || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(match, output);
    const address = new URL(match[0]);
    const page = await (await fetch(address)).text();
    assert.match(page, /Local draft mode/);
    const post = async (route: string, body: unknown = {}) => (await fetch(new URL(route, address), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': address.searchParams.get('t')!, origin: address.origin }, body: JSON.stringify(body),
    })).json() as Promise<Record<string, any>>;
    const checked = await post('/check', { url: cell.evidence_url, text: `${cell.quote}\n${'Test fixture text, not a real source reading. '.repeat(10)}` });
    assert.equal(checked.unusable, null);
    assert.ok(checked.results.some((r: { found: boolean }) => r.found));
    const saved = await post('/save');
    assert.equal(saved.error, undefined, JSON.stringify(saved));
    assert.match(saved.message, /Local draft saved/);
    const draftFile = readdirSync(state).find(name => name.startsWith('manual-draft-'))!;
    const draft = JSON.parse(readFileSync(path.join(state, draftFile), 'utf8'));
    const change = draft.changes.find((c: { cell: Cell }) => c.cell.question === cell.question);
    assert.equal(change.base_fingerprint, fingerprint(cell));
    assert.equal(change.cell.verified_via, 'manual');
    assert.equal(change.cell.manual_fingerprint, fingerprint(change.cell));
    assert.equal(readFileSync(matrixFile, 'utf8'), before);
    assert.deepEqual(readdirSync(state).sort(), ['last-report.json', draftFile].sort());
    // A local save is a checkpoint: the page must remain open for the next source.
    await new Promise(resolve => setTimeout(resolve, 3800));
    assert.equal(child.exitCode, null, output);
    assert.equal((await fetch(address)).status, 200);
    // Clearing a pasted page must also remove its previous matches from the server's draft.
    await post('/check', { url: cell.evidence_url, text: '' });
    assert.match((await post('/save')).error, /no page has been read/);
    await post('/check', { url: cell.evidence_url, text: `${cell.quote}\n${'Test fixture text. '.repeat(20)}` });
    assert.match((await post('/save')).message, /Local draft saved/);
    assert.equal(readdirSync(state).filter(name => name.startsWith('manual-draft-')).length, 2);
  } finally {
    child.kill();
    await exited;
    assert.equal(path.dirname(state), path.resolve(tmpdir()));
    rmSync(state, { recursive: true, force: true });
  }
});
