import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReadings, checkPastedPage, duePages, lastReadByHand, MANUAL_EVERY_DAYS, unreachablePages } from '../src/manual.js';
import type { Cell } from '../src/types.js';

function cell(app: string, question: string, url: string, extra: Partial<Cell> = {}): Cell {
  return { app, question, value: 'yes', quote: `A documented sentence about ${question}.`, evidence_url: url, notes: 'note', confidence: 'high', verified: true, verified_at: '2026-09-11', ...extra };
}

const A = 'https://help.example/a';
const B = 'https://help.example/b';

test('unreachablePages lists the pages of blocked apps whose cells the run could not read', () => {
  const report = {
    cells: [
      { app: 'blocked', evidence_url: B, status: 'error' },
      { app: 'blocked', evidence_url: A, status: 'error' },
      { app: 'blocked', evidence_url: A, status: 'error' },
      { app: 'blocked', evidence_url: 'https://help.example/read', status: 'ok' },
      { app: 'open', evidence_url: 'https://open.example/x', status: 'error' },
    ],
  };
  assert.deepEqual(unreachablePages(report, new Set(['blocked'])), [A, B]);
  assert.deepEqual(unreachablePages({}, new Set(['blocked'])), [], 'no report yet: nothing to read');
  assert.deepEqual(unreachablePages({ cells: [{ app: 'blocked', evidence_url: '', status: 'error' }] }, new Set(['blocked'])), [], 'a cell without a page is not a page');
});

test('a page is due when it has not been read by hand for MANUAL_EVERY_DAYS', () => {
  const cells = [cell('x', 'q1', A), cell('x', 'q2', B, { verified_via: 'manual', verified_at: '2026-09-23' })];
  // A has never been read by hand; B was, on 2026-09-23 (a reading from before the reading page, found in the data).
  assert.equal(lastReadByHand(B, {}, cells), '2026-09-23');
  assert.deepEqual(duePages([A, B], {}, cells, '2026-09-26'), [A]);
  assert.deepEqual(duePages([A, B], {}, cells, '2026-10-21'), [A, B], `${MANUAL_EVERY_DAYS} days later B is due again`);
  // The reading page's own record wins over the data (an archive capture may have re-dated the cell since).
  assert.deepEqual(duePages([A, B], { [A]: '2026-10-01' }, cells, '2026-10-10'), []);
  assert.deepEqual(duePages([], {}, cells, '2026-10-10'), [], 'every page read by the run: nothing due');
  assert.deepEqual(duePages([A, B], {}, cells, '2026-10-20'), [A], '27 days after B was read, it is not due yet');
  assert.deepEqual(duePages([B], { [B]: 'bad' }, cells, '2026-10-01'), [], 'an unreadable record falls back to the data');
  // The newer of the record and the data wins, whichever it is.
  assert.equal(lastReadByHand(B, { [B]: '2026-09-01' }, cells), '2026-09-23');
  assert.equal(lastReadByHand(B, { [B]: '2026-10-05' }, cells), '2026-10-05');
});

test('checkPastedPage matches the quotes of that page and refuses a bot challenge or a scrap of text', () => {
  const cells = [cell('x', 'q1', A), cell('x', 'q2', A), cell('x', 'q3', B), cell('x', 'q4', A, { value: 'unknown', quote: '' })];
  const pasted = 'Help centre. Menu. A documented sentence about q1. Some other text that is long enough to be a page.';
  const r = checkPastedPage(cells, A, pasted);
  assert.equal(r.unusable, null);
  assert.deepEqual(
    r.results.map((q) => [q.question, q.found]),
    [
      ['q1', true],
      ['q2', false],
    ],
    'only the quoted cells cited on this page',
  );
  assert.match(checkPastedPage(cells, A, 'Just a moment... Checking if the site connection is secure. Enable JavaScript and cookies to continue').unusable ?? '', /bot challenge/);
  assert.match(checkPastedPage(cells, A, 'too short').unusable ?? '', /characters/);
});

test('applyReadings dates only the cells whose quotes were found, as read by hand, and never demotes', () => {
  const cells = [
    cell('x', 'q1', A, { verified_via: 'archive', archive_timestamp: '20260921065036', verified_at: '2026-09-21' }),
    cell('x', 'q2', A, { quote_missing_since: '2026-09-20' }),
    cell('x', 'q3', A),
  ];
  const { cells: out, dated } = applyReadings(cells, [{ app: 'x', question: 'q1' }, { app: 'x', question: 'q2' }], '2026-09-26');
  assert.equal(dated, 2);
  assert.equal(out[0]?.verified_at, '2026-09-26');
  assert.equal(out[0]?.verified_via, 'manual');
  assert.equal('archive_timestamp' in (out[0] as object), false, 'no archive provenance left');
  assert.equal(out[0]?.quote, cells[0]?.quote);
  assert.equal(out[1]?.quote_missing_since, undefined, 'the quote is on the live page, so the missing flag goes');
  assert.equal(out[1]?.verified_via, 'manual');
  assert.deepEqual(out[2], cells[2], 'a quote not found leaves its cell as it was');
});
