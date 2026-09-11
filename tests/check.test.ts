import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFix, classifyCell, groupFetchErrors, structuralProblems, unusablePage, GRACE_DAYS, type CellReport } from '../src/check.js';
import { prepareText } from '../src/quotes.js';
import type { App, Question, Cell } from '../src/types.js';

function cell(app: string, question: string, value: Cell['value'], quote = 'A documented sentence about the feature.', url = 'https://docs.example/page'): Cell {
  return { app, question, value, quote, evidence_url: url, notes: 'note', confidence: 'high', verified: true, verified_at: '2026-09-01' };
}

const missingReport = (app: string, question: string, value: string): CellReport => ({
  app,
  question,
  value,
  status: 'fail',
  method: 'none',
  evidence_url: 'https://docs.example/page',
  problems: ['quote not found on page'],
});

test('classifyCell: ok, fail, error and skipped', () => {
  const page = prepareText('Intro. A documented sentence about the feature. Outro.');
  assert.equal(classifyCell(cell('a', 'x', 'yes'), page).status, 'ok');
  const fail = classifyCell(cell('a', 'x', 'yes', 'A sentence that is not on the page.'), page);
  assert.equal(fail.status, 'fail');
  assert.deepEqual(fail.problems, ['quote not found on page']);
  const err = classifyCell(cell('a', 'x', 'yes'), { error: 'HTTP 503' });
  assert.equal(err.status, 'error');
  const missing = classifyCell(cell('a', 'x', 'yes'), undefined);
  assert.equal(missing.status, 'error');
  assert.equal(classifyCell(cell('a', 'x', 'unknown', '', ''), page).status, 'skipped');
});

test('applyFix: verified cells are dated, a first missing quote only flags the cell, errors are untouched', () => {
  const cells = [cell('a', 'ok', 'yes'), cell('a', 'gone', 'partial'), cell('a', 'err', 'no'), cell('a', 'unk', 'unknown', '', '')];
  const reports: CellReport[] = [
    { app: 'a', question: 'ok', value: 'yes', status: 'ok', method: 'exact', evidence_url: 'https://docs.example/page', problems: [] },
    missingReport('a', 'gone', 'partial'),
    { app: 'a', question: 'err', value: 'no', status: 'error', method: 'none', evidence_url: 'https://docs.example/page', problems: ['fetch failed: HTTP 503'] },
    { app: 'a', question: 'unk', value: 'unknown', status: 'skipped', method: 'none', evidence_url: '', problems: [] },
  ];
  const { cells: out, demoted, pending } = applyFix(cells, reports, ['a|missing'], '2026-09-10');
  assert.equal(demoted, 0);
  assert.deepEqual(pending, [{ app: 'a', question: 'gone', evidence_url: 'https://docs.example/page', since: '2026-09-10' }]);
  const byCap = new Map(out.map((c) => [c.question, c]));
  assert.deepEqual([byCap.get('ok')!.verified, byCap.get('ok')!.verified_at], [true, '2026-09-10']);
  const gone = byCap.get('gone')!;
  assert.equal(gone.value, 'partial', 'a quote missing once must not demote the cell');
  assert.equal(gone.quote, 'A documented sentence about the feature.');
  assert.equal(gone.quote_missing_since, '2026-09-10');
  assert.equal(gone.verified_at, '2026-09-01', 'the flagged cell keeps its last verification date');
  const err = byCap.get('err')!;
  assert.equal(err.value, 'no');
  assert.equal(err.verified_at, '2026-09-01', 'fetch errors must not touch the cell');
  assert.equal(byCap.get('unk')!.verified, false);
  assert.equal(byCap.get('missing')!.value, 'unknown');
});

test('applyFix: a quote still missing a week later is demoted with its old data kept in notes', () => {
  const flagged: Cell = { ...cell('a', 'gone', 'partial'), quote_missing_since: '2026-09-10' };
  const soon = applyFix([flagged], [missingReport('a', 'gone', 'partial')], [], '2026-09-12');
  assert.equal(soon.demoted, 0, 'two days later is still inside the grace period');
  assert.equal(soon.cells[0]!.value, 'partial');
  assert.equal(soon.cells[0]!.quote_missing_since, '2026-09-10', 'the original date is kept');
  assert.equal(soon.pending.length, 1);

  const later = applyFix([flagged], [missingReport('a', 'gone', 'partial')], [], '2026-09-17');
  assert.equal(later.demoted, 1);
  assert.deepEqual(later.pending, []);
  const gone = later.cells[0]!;
  assert.equal(gone.value, 'unknown');
  assert.equal(gone.quote, '');
  assert.equal(gone.evidence_url, '');
  assert.equal(gone.verified, false);
  assert.equal(gone.quote_missing_since, undefined);
  assert.match(gone.notes, /^UNVERIFIED on 2026-09-17 \(quote not found on page since 2026-09-10; was partial\): "A documented sentence about the feature\." at https:\/\/docs\.example\/page \| note$/);
  assert.ok(GRACE_DAYS <= 7, 'a weekly schedule must be able to demote on the very next run');
});

test('applyFix: a quote found again clears the flag; a malformed quote is demoted at once', () => {
  const flagged: Cell = { ...cell('a', 'back', 'yes'), quote_missing_since: '2026-09-10' };
  const ok = applyFix([flagged], [{ app: 'a', question: 'back', value: 'yes', status: 'ok', method: 'normalized', evidence_url: 'https://docs.example/page', problems: [] }], [], '2026-09-17');
  assert.equal(ok.cells[0]!.quote_missing_since, undefined);
  assert.equal(ok.cells[0]!.verified_at, '2026-09-17');

  const malformed = applyFix([cell('a', 'short', 'yes', 'too short')], [{ app: 'a', question: 'short', value: 'yes', status: 'fail', method: 'none', evidence_url: 'https://docs.example/page', problems: ['quote shorter than 12 characters', 'quote not found on page'] }], [], '2026-09-10');
  assert.equal(malformed.demoted, 1);
  assert.equal(malformed.cells[0]!.value, 'unknown');
});

test('applyFix twice is stable: a demoted cell is skipped next time instead of failing again', () => {
  const flagged: Cell = { ...cell('a', 'gone', 'yes'), quote_missing_since: '2026-09-03' };
  const first = applyFix([flagged], [missingReport('a', 'gone', 'yes')], [], '2026-09-10');
  assert.equal(first.demoted, 1);
  const demotedCell = first.cells[0]!;
  const report = classifyCell(demotedCell, prepareText('anything'));
  assert.equal(report.status, 'skipped');
  const second = applyFix(first.cells, [report], [], '2026-09-17');
  assert.equal(second.demoted, 0);
  assert.deepEqual(second.cells[0], demotedCell);
});

test('groupFetchErrors: one line per app with page and cell counts', () => {
  const apps: App[] = [{ id: 'a', name: 'App A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] }];
  const err = (question: string, url: string): CellReport => ({ app: 'a', question, value: 'yes', status: 'error', method: 'none', evidence_url: url, problems: ['fetch failed: HTTP 403'] });
  const lines = groupFetchErrors([err('x', 'https://a.x/1'), err('y', 'https://a.x/1'), err('z', 'https://a.x/2')], apps);
  assert.deepEqual(lines, ['App A: 3 cells on 2 pages (fetch failed: HTTP 403)']);
});

test('unusablePage rejects truncated, empty and bot-challenge pages', () => {
  assert.equal(unusablePage('x'.repeat(5000), true), 'page larger than the download limit');
  assert.match(unusablePage('short', false) ?? '', /only 5 characters/);
  assert.match(unusablePage('Just a moment... Checking your browser before accessing the site. ' + 'x'.repeat(300), false) ?? '', /bot challenge/);
  assert.equal(unusablePage('Real documentation. '.repeat(20), false), null);
});

test('structuralProblems finds duplicates, unknown ids, missing quotes and missing cells', () => {
  const apps: App[] = [{ id: 'a', name: 'A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] }];
  const qs: Question[] = [
    { id: 'x', group: 'g', name: 'X', question: 'q', rubric: 'r' },
    { id: 'y', group: 'g', name: 'Y', question: 'q', rubric: 'r' },
  ];
  const { problems, missing } = structuralProblems([cell('a', 'x', 'yes'), cell('a', 'x', 'yes'), cell('b', 'z', 'no', '', ''), { ...cell('a', 'y', 'unknown', '', ''), verified: true }], apps, qs);
  assert.ok(problems.some((p) => p.startsWith('duplicate cell a|x')));
  assert.ok(problems.some((p) => p === 'unknown app b'));
  assert.ok(problems.some((p) => p === 'unknown question z'));
  assert.ok(problems.some((p) => p.includes('requires quote and evidence_url')));
  assert.ok(problems.some((p) => p.includes('unknown cells cannot be verified')));
  assert.deepEqual(missing, []);
  assert.deepEqual(structuralProblems([cell('a', 'x', 'yes')], apps, qs).missing, ['a|y']);
});
