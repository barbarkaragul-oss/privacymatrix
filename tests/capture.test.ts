import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureAll, captureTargets, capturesFile } from '../src/capture.js';
import { loadFreshCaptures } from '../src/check.js';
import type { App, Cell } from '../src/types.js';

const KEYS = { access: 'ACCESSKEY123', secret: 'SECRETKEY456' };

function cell(app: string, question: string, url: string, extra: Partial<Cell> = {}): Cell {
  return { app, question, value: 'yes', quote: 'A documented sentence about it.', evidence_url: url, notes: '', confidence: 'high', verified: true, verified_at: '2026-09-01', ...extra };
}
const apps: App[] = [
  { id: 'blocked', name: 'B', vendor: 'v', homepage: 'https://b.x/', repo: null, sources: ['https://b.x/'], blocked_from_cloud: true },
  { id: 'open', name: 'O', vendor: 'v', homepage: 'https://o.x/', repo: null, sources: ['https://o.x/'] },
];

/** A fake archive.org: each page's capture goes through the listed status answers in turn. */
function fakeArchive(plan: Record<string, { submit?: { status: number; json: unknown }; statuses?: unknown[] }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const byJob = new Map<string, unknown[]>();
  let n = 0;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'POST') {
      const page = new URLSearchParams(init.body).get('url') as string;
      const p = plan[page] ?? {};
      if (p.submit) return { ok: p.submit.status < 400, status: p.submit.status, json: async () => p.submit!.json };
      const jobId = `job-${++n}`;
      byJob.set(jobId, [...(p.statuses ?? [{ status: 'success', timestamp: '20260928090000' }])]);
      return { ok: true, status: 200, json: async () => ({ url: page, job_id: jobId }) };
    }
    const jobId = decodeURIComponent(url.split('/').pop() as string);
    const queue = byJob.get(jobId) as unknown[];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, status: 200, json: async () => answer };
  };
  return { fetch, calls };
}
const noSleep = { sleep: async () => {} };

test('captureTargets: the quoted pages of blocked apps, once each, sorted', () => {
  const cells = [
    cell('blocked', 'x', 'https://b.x/2'),
    cell('blocked', 'y', 'https://b.x/1'),
    cell('blocked', 'z', 'https://b.x/1'),
    cell('blocked', 'u', '', { value: 'unknown', quote: '' }),
    cell('open', 'x', 'https://o.x/1'),
  ];
  assert.deepEqual(captureTargets(cells, apps), ['https://b.x/1', 'https://b.x/2']);
  assert.deepEqual(captureTargets(cells, apps, 'open'), []);
});

test('captureAll: asks gently, waits for each capture, and returns its timestamp', async () => {
  const archive = fakeArchive({
    'https://b.x/1': { statuses: [{ status: 'pending' }, { status: 'pending' }, { status: 'success', timestamp: '20260928090102' }] },
    'https://b.x/2': {},
  });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const results = await captureAll(['https://b.x/1', 'https://b.x/2'], KEYS, { fetch: archive.fetch, sleep: async (ms) => void sleeps.push(ms), log: (m) => logs.push(m) });
  assert.deepEqual(results, [
    { url: 'https://b.x/1', timestamp: '20260928090102' },
    { url: 'https://b.x/2', timestamp: '20260928090000' },
  ]);
  const posts = archive.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.url, 'https://web.archive.org/save');
  assert.equal(posts[0]!.headers.Authorization, 'LOW ACCESSKEY123:SECRETKEY456');
  assert.equal(posts[0]!.headers.Accept, 'application/json');
  const body = new URLSearchParams(posts[0]!.body);
  assert.deepEqual([body.get('url'), body.get('if_not_archived_within'), body.get('skip_first_archive')], ['https://b.x/1', '1d', '1']);
  assert.equal(body.get('capture_outlinks'), null, 'no outlinks');
  assert.equal(sleeps[0], 10_000, 'ten seconds between two capture requests');
  // The keys never appear in what is logged or returned.
  for (const text of [...logs, JSON.stringify(results)]) assert.ok(!text.includes(KEYS.secret) && !text.includes(KEYS.access));
  assert.ok(logs.some((l) => l === '  CAPTURED https://b.x/1 (20260928090102)'));
});

test('captureAll: every failure ends as a reason, never a throw', async () => {
  const archive = fakeArchive({
    'https://b.x/403': { statuses: [{ status: 'error', status_ext: 'error:no-access', message: 'Target URL could not be accessed (status=403).' }] },
    'https://b.x/daily': { submit: { status: 200, json: { status: 'error', status_ext: 'error:too-many-daily-captures', message: 'This URL has been captured 10 times today.' } } },
    'https://b.x/slow': { statuses: [{ status: 'pending' }] },
    'https://b.x/badts': { statuses: [{ status: 'success', timestamp: 'soon' }] },
  });
  const results = await captureAll(['https://b.x/403', 'https://b.x/daily', 'https://b.x/slow', 'https://b.x/badts'], KEYS, { fetch: archive.fetch, ...noSleep, log: () => {}, timeoutMs: 60_000 });
  const byUrl = Object.fromEntries(results.map((r) => [r.url, r.error]));
  assert.match(byUrl['https://b.x/403']!, /^error:no-access: Target URL could not be accessed/);
  assert.match(byUrl['https://b.x/daily']!, /^error:too-many-daily-captures/);
  assert.match(byUrl['https://b.x/slow']!, /still pending after 60 s/);
  assert.match(byUrl['https://b.x/badts']!, /without a valid timestamp/);
  assert.ok(results.every((r) => !r.timestamp));
});

test('captureAll: refused keys stop the run at the first page', async () => {
  const archive = fakeArchive({ 'https://b.x/1': { submit: { status: 401, json: {} } } });
  const results = await captureAll(['https://b.x/1', 'https://b.x/2', 'https://b.x/3'], KEYS, { fetch: archive.fetch, ...noSleep, log: () => {} });
  assert.equal(archive.calls.length, 1, 'no more requests after the keys were refused');
  assert.ok(results.every((r) => /archive.org refused the keys \(HTTP 401\)/.test(r.error ?? '')));
  assert.equal(results.length, 3);
});

test('captureAll: a network error on a page is its reason', async () => {
  const fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND web.archive.org');
  };
  const [r] = await captureAll(['https://b.x/1'], KEYS, { fetch, ...noSleep, log: () => {} });
  assert.match(r!.error ?? '', /ENOTFOUND/);
});

test('capturesFile and loadFreshCaptures: what the check reads back', () => {
  const file = capturesFile([{ url: 'https://b.x/1', timestamp: '20260928090000' }, { url: 'https://b.x/2', error: 'error:no-access' }], '2026-09-28T09:00:00Z');
  assert.deepEqual(file, { run_at: '2026-09-28T09:00:00Z', captures: { 'https://b.x/1': '20260928090000' }, errors: { 'https://b.x/2': 'error:no-access' } });
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-captures-'));
  try {
    const p = path.join(dir, 'captures.json');
    writeFileSync(p, JSON.stringify({ ...file, captures: { ...file.captures, 'https://b.x/3': 'not-a-timestamp' } }));
    assert.deepEqual([...loadFreshCaptures(p)], [['https://b.x/1', '20260928090000']]);
    assert.equal(loadFreshCaptures(path.join(dir, 'missing.json')).size, 0, 'a missing file means no captures');
    writeFileSync(p, 'not json');
    assert.equal(loadFreshCaptures(p).size, 0, 'nor does an unreadable one');
    assert.equal(loadFreshCaptures(null).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
