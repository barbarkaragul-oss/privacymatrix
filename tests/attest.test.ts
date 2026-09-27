import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestCell } from '../src/attest.js';
import { fingerprint } from '../src/fingerprint.js';
import type { App, Cell } from '../src/types.js';

const apps: App[] = [
  { id: 'blocked', name: 'Blocked', vendor: 'v', homepage: 'https://b.x/', repo: null, sources: ['https://b.x/'], blocked_from_cloud: true },
  { id: 'open', name: 'Open', vendor: 'v', homepage: 'https://o.x/', repo: null, sources: ['https://o.x/'] },
];
function cell(app: string, question: string, extra: Partial<Cell> = {}): Cell {
  return { app, question, value: 'yes', quote: 'A sentence the maintainer read on the page.', evidence_url: 'https://b.x/p', notes: 'n', confidence: 'high', verified: true, verified_at: '2026-09-01', ...extra };
}

test('attestCell records a reading of exactly this evidence, today', () => {
  const before = [cell('blocked', 'x', { verified_via: 'archive', archive_timestamp: '20260901000000', quote_missing_since: '2026-09-20' }), cell('blocked', 'y')];
  const { cells, cell: read } = attestCell(before, apps, 'blocked', 'x', '2026-09-27');
  assert.equal(read.verified_via, 'manual');
  assert.equal(read.verified_at, '2026-09-27');
  assert.equal(read.manual_fingerprint, fingerprint(read));
  assert.equal(read.archive_timestamp, undefined);
  assert.equal(read.quote_missing_since, undefined, 'the quote was found on the page');
  assert.deepEqual(cells[1], before[1], 'other cells untouched');
  assert.equal(read.quote, before[0]!.quote);
});

test('attestCell refuses what a reading cannot vouch for', () => {
  const refuse = (cells: Cell[], app: string, question: string, pattern: RegExp) => assert.throws(() => attestCell(cells, apps, app, question, '2026-09-27'), pattern);
  refuse([cell('open', 'x')], 'open', 'x', /not marked blocked_from_cloud/);
  refuse([cell('blocked', 'x', { value: 'unknown', quote: '', evidence_url: '' })], 'blocked', 'x', /no value, quote or evidence URL/);
  refuse([cell('blocked', 'x', { quote: 'too short' })], 'blocked', 'x', /quote shorter than 12 characters; fix the quote first/);
  refuse([cell('blocked', 'x')], 'blocked', 'nope', /no cell blocked\/nope/);
});
