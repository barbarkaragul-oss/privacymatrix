import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshness } from '../src/freshness.js';
import { dueSources, EMPTY_SOURCE_STATE, sourceSignatures, updateSourceState } from '../src/source-state.js';
import { readNothing } from '../scripts/residential.js';
import { ArchiveReader } from '../src/archive-cache.js';
import { archiveRawUrl, getArchiveJson } from '../src/archive.js';
import { decide, protectedPush, publishCurrentCommit } from '../scripts/residential.js';
import { parseArgs } from '../src/check.js';
import { loadSources, reconcile } from '../src/verify.js';
import { networkError } from '../src/network-error.js';
import type { App, Cell, Question } from '../src/types.js';
import { freshnessAsOf } from '../src/generate.js';

test('freshness ages evidence without changing its claim, rejects invalid or future dates', () => {
  const cell = { verified: true, verified_at: '2026-09-11' };
  assert.equal(freshness(cell, '2026-09-24').status, 'recent');
  assert.equal(freshness(cell, '2026-09-25').status, 'unconfirmed');
  assert.deepEqual(freshness(cell, '2026-10-09'), { status: 'stale', as_of: '2026-10-09', age_days: 28 });
  assert.equal(freshness({ ...cell, verified_at: '2026-02-30' }, '2026-09-27').status, 'unknown');
  assert.equal(freshness(cell, '2026-09-01').status, 'unknown');
  assert.equal(freshness({ ...cell, verified: false }, '2026-09-27').status, 'unknown');
});

test('a successful source does not postpone an unreachable source; changed evidence is immediately due', () => {
  const cells = [
    { app: 'a', question: 'q', value: 'yes', quote: 'A verified sentence.', evidence_url: 'https://a.example/p' },
    { app: 'b', question: 'q', value: 'yes', quote: 'A different sentence.', evidence_url: 'https://b.example/p' },
  ];
  const signatures = sourceSignatures(cells);
  const readings = cells.map((c, i) => ({ evidence_url: c.evidence_url, status: i ? 'error' : 'ok', method: i ? 'none' : 'exact', problems: i ? ['HTTP 403'] : [] }));
  const state = updateSourceState(EMPTY_SOURCE_STATE(), signatures, readings, '2026-09-27T17:30:00Z');
  assert.deepEqual([...dueSources(signatures, state, '2026-09-27T18:00:00Z')], []);
  assert.deepEqual([...dueSources(signatures, state, '2026-09-28T17:00:00Z')], [cells[1]!.evidence_url]);
  assert.equal(dueSources(signatures, state, '2026-10-03T17:00:00Z').size, 2);
  assert.equal(state.sources[cells[0]!.evidence_url]!.last_success_at, '2026-09-27T17:30:00Z');
  assert.equal(state.sources[cells[1]!.evidence_url]!.last_success_at, undefined);
  const changed = sourceSignatures([{ ...cells[0]!, quote: 'New evidence must be checked now.' }, cells[1]!]);
  assert.deepEqual([...dueSources(changed, state, '2026-09-27T18:00:00Z')], [cells[0]!.evidence_url]);
  const next = updateSourceState(state, signatures, [{ ...readings[1]!, method: 'compact' }], '2026-09-28T17:00:00Z');
  assert.deepEqual(next.sources[cells[0]!.evidence_url], state.sources[cells[0]!.evidence_url]);
  assert.equal(next.sources[cells[1]!.evidence_url]!.requote, 1);
  assert.equal(next.sources[cells[1]!.evidence_url]!.unreachable, 0);
});

test('archive lookup retries transient errors, respects Retry-After and its total budget, never retries 403', async () => {
  const original = globalThis.fetch;
  let calls = 0, time = 0;
  const waits: number[] = [];
  const options = { now: () => time, random: () => 0, sleep: async (ms: number) => { waits.push(ms); time += ms; } };
  try {
    globalThis.fetch = (async () => ++calls === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{"ok":true}')) as typeof fetch;
    assert.deepEqual(await getArchiveJson('https://archive.example', 10000, options), { ok: true });
    assert.deepEqual(waits, [2000]);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('blocked', { status: 403 }); }) as typeof fetch;
    await getArchiveJson('https://archive.example', 10000, options);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('busy', { status: 503, headers: { 'retry-after': '120' } }); }) as typeof fetch;
    await getArchiveJson('https://archive.example', 10000, options);
    assert.equal(calls, 1, 'a long Retry-After does not cause an early retry');
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('busy', { status: 503 }); }) as typeof fetch;
    await getArchiveJson('https://archive.example', 10000, options);
    assert.equal(calls, 3, 'two retries at most');
  } finally { globalThis.fetch = original; }
});

test('cached captures must be fetched again and dated to the actual redirect, never to today', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-archive-cache-'));
  const file = path.join(dir, 'captures.json');
  const url = 'https://example.test/p';
  const old = '20260911000000', landed = '20260909000000';
  try {
    writeFileSync(file, JSON.stringify({ [url]: old }));
    const reader = new ArchiveReader(file);
    const good = await reader.read(url, () => null, {
      lookup: async () => ({ error: '503' }),
      fetch: async (capture) => ({ url: capture.rawUrl, fetchUrl: capture.rawUrl, finalUrl: archiveRawUrl(landed, url), status: 200, ok: true, contentType: 'text/plain', text: 'A complete source page read again.', truncated: false }),
    });
    assert.ok(!('error' in good));
    assert.equal(good.capture.timestamp, landed);
    assert.equal(good.cached, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[url], landed);
    const bad = await reader.read(url, () => null, {
      lookup: async () => ({ error: '503' }),
      fetch: async (capture) => ({ url: capture.rawUrl, fetchUrl: capture.rawUrl, finalUrl: archiveRawUrl(landed, 'https://other.example/p'), status: 200, ok: true, contentType: 'text/plain', text: 'A different source page.', truncated: false }),
    });
    assert.match(('error' in bad ? bad.error : ''), /another page/);
  } finally { assert.equal(path.dirname(dir), path.resolve(tmpdir())); rmSync(dir, { recursive: true, force: true }); }
});

test('protected-main publication opens an isolated PR without force or merge; ordinary failures remain failures', async () => {
  const commands: string[][] = [], calls: string[] = [];
  const sha = 'a'.repeat(40);
  const run = (...args: string[]) => {
    commands.push(args);
    if (args.includes('HEAD:main')) throw Object.assign(new Error('rejected'), { stderr: 'GH013: Changes must be made through a pull request.' });
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'remote') return 'https://github.com/owner/repo.git';
    return '';
  };
  const call = async (_token: string, method: string, url: string) => { calls.push(`${method} ${url}`); return method === 'GET' ? [] : { number: 7 }; };
  assert.deepEqual(await publishCurrentCommit('bot/manual-readings', 'reading', 'evidence', { git: run, token: () => 'test', call }), { kind: 'pr', url: 'https://github.com/owner/repo/pull/7' });
  assert.ok(commands.some(args => args.includes(`HEAD:refs/heads/bot/manual-readings/${sha}`)));
  assert.ok(commands.every(args => !args.some(a => /force|merge/.test(a))));
  assert.equal(calls.filter(c => c.startsWith('POST')).length, 1);
  assert.equal(protectedPush({ stderr: 'non-fast-forward' }), false);
  await assert.rejects(publishCurrentCommit('bot/manual-readings', '', '', { git: () => { throw new Error('network unavailable'); } }), /network unavailable/);
  assert.deepEqual(await publishCurrentCommit('bot/manual-readings', '', '', { git: () => '' }), { kind: 'main' });
});

test('model input truncation cannot hide evidence from the mechanical verifier', async () => {
  const url = 'https://example.test/long';
  const quote = 'This exact sentence is beyond the model input budget.';
  const text = 'Ordinary policy text. '.repeat(16000) + quote;
  const app: App = { id: 'a', name: 'A', vendor: 'A', homepage: url, repo: null, sources: [url] };
  const result = await loadSources(app, { get: async () => ({ url, fetchUrl: url, finalUrl: url, ok: true, status: 200, contentType: 'text/plain', text, truncated: false }) });
  assert.equal(result.sources[0]!.truncated, true);
  assert.equal(result.sources[0]!.text.includes(quote), false);
  const cell: Cell = { app: 'a', question: 'q', value: 'yes', quote, evidence_url: url, notes: '', confidence: 'high', verified: true, verified_at: '2026-09-11' };
  const q: Question = { id: 'q', group: 'g', name: 'Q', question: 'Q', rubric: 'R' };
  const reconciled = await reconcile('a', [q], [], new Map([['a|q', cell]]), async u => result.prepared.get(u) ?? null, '2026-09-27');
  assert.equal(reconciled.restored, 1);
  assert.equal(reconciled.cells[0]!.verified_at, '2026-09-27');
});

test('TLS failures explain the trusted system certificate setting without dumping error payloads', () => {
  const error = new Error('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', headers: { authorization: 'secret' } } });
  const message = networkError(error);
  assert.match(message, /NODE_USE_SYSTEM_CA=1/);
  assert.doesNotMatch(message, /secret/);
});

test('partial scheduling cannot suppress missing evidence or close a previous issue or demotion PR', () => {
  const signatures = new Map([['https://example.test/p', 'evidence']]);
  const state = updateSourceState(EMPTY_SOURCE_STATE(), signatures, [
    { evidence_url: 'https://example.test/p', status: 'fail', method: 'none', problems: ['quote absent'] },
    { evidence_url: 'https://example.test/p', status: 'error', method: 'compact', problems: ['re-quote'] },
  ], '2026-09-27T17:00:00Z');
  assert.equal(state.sources['https://example.test/p']!.status, 'quote_missing');
  assert.equal(dueSources(signatures, state, '2026-09-27T18:00:00Z').size, 1);
  // Sources merely not due do not keep the issue or PR open for ever; what they hold is counted from
  // their state: unreadable pages in unreachable, quotes to re-quote in requote.
  const outcome = { valueChanges: 0, pending: 0, flagged: 0, unreachable: 0, requote: 0, dirty: true, deferred: 2 };
  assert.deepEqual(decide(outcome), { commit: 'main', issue: 'close', pr: 'close' });
  assert.deepEqual(decide({ ...outcome, unreachable: 1 }), { commit: 'main', issue: 'keep', pr: 'keep' });
  assert.deepEqual(decide({ ...outcome, requote: 1 }), { commit: 'main', issue: 'open', pr: 'close' });
  assert.deepEqual(decide({ ...outcome, valueChanges: 1 }), { commit: 'main+pr', issue: 'open', pr: 'open' });
  assert.throws(() => parseArgs(['--source-state', 'state.json', '--due-only']), /residential/);
  assert.throws(() => parseArgs(['--residential', '--source-state', 'state.json', '--changed-since', 'HEAD']), /PR gate/);
});

test('a run whose due pages are all still unreadable is the usual state, not a failure; a dead connection still is', () => {
  // Six days of the real schedule: 9 sources read, 14 unreadable (Perplexity, OpenAI's help centre).
  const url = (i: number) => `https://vendor.example/page-${i}`;
  const cells = Array.from({ length: 23 }, (_, i) => ({ app: 'v', question: `q${i}`, value: 'yes', quote: `A sentence number ${i}.`, evidence_url: url(i) }));
  const signatures = sourceSignatures(cells);
  const readable = (i: number) => i < 9;
  const readAll = (at: string, due: Set<string>, state: ReturnType<typeof EMPTY_SOURCE_STATE>) =>
    updateSourceState(state, signatures, cells.filter((c) => due.has(c.evidence_url)).map((c, i) => {
      const n = Number(c.question.slice(1));
      return readable(n) ? { evidence_url: c.evidence_url, status: 'ok', method: 'exact', problems: [] } : { evidence_url: c.evidence_url, status: 'error', method: 'none', problems: ['HTTP 403'] };
    }), at);
  let state = readAll('2026-09-28T17:00:00Z', new Set(signatures.keys()), EMPTY_SOURCE_STATE());
  for (const day of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']) {
    const due = dueSources(signatures, state, `${day}T17:00:00Z`);
    assert.equal(due.size, 14, `${day}: only the unreadable pages are due, not everything`);
    assert.ok([...due].every((u) => state.sources[u]!.status === 'unreachable'));
    state = readAll(`${day}T17:00:00Z`, due, state);
  }
  // Six days after the full read, the readable pages are due again, with the unreadable ones.
  assert.equal(dueSources(signatures, state, '2026-10-04T17:00:00Z').size, 23);
  // Such a run reads nothing; that alone does not say the connection was down.
  assert.equal(readNothing({ ok: 0, failed: 0, errors: 19, requote: 0 }), true);
  assert.equal(readNothing({ ok: 0, failed: 1, errors: 19 }), false, 'a quote found missing means a page was read');
  assert.equal(readNothing({ ok: 0, errors: 3, requote: 3 }), false, 'a re-quote means the page was read');
  assert.equal(readNothing({ ok: 5, errors: 19 }), false);
});

test('a quote to re-quote is re-read on every run, so the issue that counts it can name it', () => {
  const signatures = new Map([['https://example.test/r', 'evidence']]);
  const state = updateSourceState(EMPTY_SOURCE_STATE(), signatures, [{ evidence_url: 'https://example.test/r', status: 'error', method: 'compact', problems: ['re-quote'] }], '2026-09-28T17:00:00Z');
  assert.equal(state.sources['https://example.test/r']!.status, 'requote');
  assert.equal(dueSources(signatures, state, '2026-09-29T17:00:00Z').size, 1);
});

test('the exported freshness is measured at the newest evidence, from the data alone', () => {
  const cells = [{ verified_at: '2026-09-20' }, { verified_at: '2026-09-30' }, { verified_at: '' }];
  // A reading by hand on 30 September, after the last check run on the 27th, is not 'in the future'.
  assert.equal(freshnessAsOf({ generated_at: '2026-09-27T17:31:20.726Z', cells }), '2026-09-30');
  assert.equal(freshnessAsOf({ generated_at: '2026-10-02T08:00:00Z', cells }), '2026-10-02');
  assert.equal(freshness({ verified: true, verified_at: '2026-09-30' }, freshnessAsOf({ generated_at: '2026-09-27T17:31:20.726Z', cells })).status, 'recent');
});

test('an archive read keeps every step\'s reason and shows every capture it fetched', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-archive-reasons-'));
  try {
    const url = 'https://vendor.example/p';
    const file = path.join(dir, 'captures.json');
    writeFileSync(file, JSON.stringify({ [url]: '20260101000000' }));
    const fetched: string[] = [];
    const found = await new ArchiveReader(file).read(url, () => 'bot challenge', {
      lookup: async () => ({ error: 'CDX API: archive.org answered HTTP 503' }),
      fetch: async (c) => ({ url: c.rawUrl, fetchUrl: c.rawUrl, finalUrl: c.rawUrl, status: 200, ok: true, contentType: 'text/html', text: 'Just a moment', truncated: false }),
      onResponse: (c) => fetched.push(c.timestamp),
    });
    assert.ok('error' in found);
    assert.match((found as { error: string }).error, /^Internet Archive lookup failed: CDX API: archive.org answered HTTP 503; Internet Archive capture 20260101000000 unusable: bot challenge$/);
    assert.deepEqual(fetched, ['20260101000000'], 'the unusable capture was offered for --dump');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a certificate the system store cannot fix is reported without the NODE_USE_SYSTEM_CA advice', () => {
  const expired = networkError(new Error('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }));
  assert.equal(expired, 'TLS certificate verification failed (CERT_HAS_EXPIRED)');
  assert.doesNotMatch(networkError(new Error('fetch failed', { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })), /NODE_USE_SYSTEM_CA/);
  assert.match(networkError(new Error('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })), /NODE_USE_SYSTEM_CA=1/);
});
