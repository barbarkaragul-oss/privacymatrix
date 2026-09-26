import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFix, classifyCell, groupFetchErrors, structuralProblems, unusablePage, BOT_CHALLENGE, GRACE_DAYS, type ArchivedPage, type CellReport } from '../src/check.js';
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

test('classifyCell with confirmOnly: a found quote counts, a missing one is an unreadable page, not a failure', () => {
  // The cloud run reading an app marked blocked_from_cloud, whose vendor may serve it a page without its text.
  const page = prepareText('Skip to Main content. Cart. Orders. Conditions of Use. Privacy Notice.');
  const missing = classifyCell(cell('a', 'x', 'yes'), page, { confirmOnly: true });
  assert.equal(missing.status, 'error');
  assert.match(missing.problems.join(' '), /only the residential re-check can show the quote is gone/);
  const found = classifyCell(cell('a', 'x', 'yes'), prepareText('Intro. A documented sentence about the feature. Outro.'), { confirmOnly: true });
  assert.equal(found.status, 'ok');
  assert.equal(found.via, undefined, 'a live read, not an archive one');
  assert.equal(classifyCell(cell('a', 'x', 'yes'), page).status, 'fail', 'without confirmOnly a missing quote is still a failure');
});

// --- Internet Archive fallback -------------------------------------------------------------------

const archivedPage = (text: string, archiveTimestamp = '20260921065036'): ArchivedPage => ({ ...prepareText(text), via: 'archive', archiveTimestamp });

test('classifyCell on an archive capture: found confirms, missing is an error, never a failure', () => {
  const found = classifyCell(cell('a', 'x', 'yes'), archivedPage('Intro. A documented sentence about the feature. Outro.'));
  assert.equal(found.status, 'ok');
  assert.equal(found.via, 'archive');
  assert.equal(found.archive_timestamp, '20260921065036');

  // A capture may predate the sentence, so it cannot show the live page lacks it.
  const missing = classifyCell(cell('a', 'x', 'yes'), archivedPage('A page that says something else entirely.'));
  assert.equal(missing.status, 'error');
  assert.match(missing.problems.join(' '), /20260921065036/);

  // A malformed quote is a data error, but a capture never demotes: it is reported, not acted on.
  const malformed = classifyCell(cell('a', 'x', 'yes', 'short'), archivedPage('short text of the page is here'));
  assert.equal(malformed.status, 'error');
  const { cells: [kept], demoted } = applyFix([cell('a', 'x', 'yes', 'short')], [malformed], [], '2026-09-28');
  assert.equal(demoted, 0);
  assert.equal(kept?.value, 'yes');
  // ...and structuralProblems still flags it, whatever the network.
  const qs: Question[] = [{ id: 'x', group: 'g', name: 'X', question: 'q', rubric: 'r' }];
  const apps: App[] = [{ id: 'a', name: 'A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] }];
  assert.ok(structuralProblems([cell('a', 'x', 'yes', 'short')], apps, qs).problems.some((p) => p.startsWith('a|x: quote shorter than')));
});

test('applyFix: a demoted or unverified cell keeps no archive or manual provenance', () => {
  // The weekly run tests the data after --fix; a demoted cell that still said how it was
  // verified would fail that test and stop the run before it could open the demotion PR.
  for (const via of ['archive', 'manual'] as const) {
    const withVia: Cell = { ...cell('a', 'x', 'yes'), verified_via: via, ...(via === 'archive' ? { archive_timestamp: '20260910120000' } : {}) };
    const { cells: [flagged] } = applyFix([withVia], [missingReport('a', 'x', 'yes')], [], '2026-09-28');
    const { cells: [demoted] } = applyFix([flagged as Cell], [missingReport('a', 'x', 'yes')], [], '2026-10-05');
    assert.equal(demoted?.value, 'unknown');
    assert.ok(!('verified_via' in (demoted ?? {})), `${via}: verified_via survived the demotion`);
    assert.ok(!('archive_timestamp' in (demoted ?? {})), `${via}: archive_timestamp survived the demotion`);
  }
  const staleUnknown: Cell = { ...cell('a', 'x', 'unknown', '', ''), verified: true, verified_via: 'archive', archive_timestamp: '20260910120000' };
  const skipped: CellReport = { app: 'a', question: 'x', value: 'unknown', status: 'skipped', method: 'none', evidence_url: '', problems: [] };
  const { cells: [unverified] } = applyFix([staleUnknown], [skipped], [], '2026-09-28');
  assert.equal(unverified?.verified, false);
  assert.ok(!('verified_via' in (unverified ?? {})));
});

const archiveOk = (app: string, question: string, ts: string): CellReport => ({
  app,
  question,
  value: 'yes',
  status: 'ok',
  method: 'exact',
  evidence_url: 'https://docs.example/page',
  problems: [],
  via: 'archive',
  archive_timestamp: ts,
});

test('applyFix: an archive confirmation dates the cell to the capture, only if that is newer', () => {
  const older = { ...cell('a', 'x', 'yes'), verified_at: '2026-09-01' };
  const { cells: [newer] } = applyFix([older], [archiveOk('a', 'x', '20260921065036')], [], '2026-09-23');
  assert.equal(newer?.verified_at, '2026-09-21');
  assert.equal(newer?.verified_via, 'archive');
  assert.equal(newer?.archive_timestamp, '20260921065036');

  // A capture older than a manual or live read must not roll the date back.
  const manual: Cell = { ...cell('a', 'x', 'yes'), verified_at: '2026-09-23', verified_via: 'manual' };
  const { cells: [kept] } = applyFix([manual], [archiveOk('a', 'x', '20260921065036')], [], '2026-09-24');
  assert.deepEqual(kept, manual);
});

test('applyFix: an archive capture never starts, stops or advances the missing-quote clock', () => {
  const flagged: Cell = { ...cell('a', 'x', 'yes'), verified_at: '2026-09-01', quote_missing_since: '2026-09-18' };
  const { cells: [after], demoted, pending } = applyFix([flagged], [archiveOk('a', 'x', '20260921065036')], [], '2026-09-28');
  assert.equal(after?.quote_missing_since, '2026-09-18');
  assert.equal(after?.value, 'yes');
  assert.equal(demoted, 0);
  assert.equal(pending.length, 0);

  // An archive miss is an error report, and errors leave the cell exactly as it was.
  const missReport: CellReport = { ...archiveOk('a', 'x', '20260921065036'), status: 'error', problems: ['quote not found in Internet Archive capture 20260921065036'] };
  const { cells: [untouched] } = applyFix([flagged], [missReport], [], '2026-10-30');
  assert.deepEqual(untouched, flagged);
});

test('applyFix: a live read clears archive and manual provenance', () => {
  const archived: Cell = { ...cell('a', 'x', 'yes'), verified_at: '2026-09-21', verified_via: 'archive', archive_timestamp: '20260921065036' };
  const liveOk: CellReport = { app: 'a', question: 'x', value: 'yes', status: 'ok', method: 'exact', evidence_url: 'https://docs.example/page', problems: [] };
  const { cells: [live] } = applyFix([archived], [liveOk], [], '2026-09-28');
  assert.equal(live?.verified_at, '2026-09-28');
  assert.equal(live?.verified_via, undefined);
  assert.equal(live?.archive_timestamp, undefined);
  assert.ok(!('verified_via' in (live ?? {})));
});

test('unusablePage treats the Wayback Machine not-archived page as unusable', () => {
  assert.equal(unusablePage('Hrm. The Wayback Machine has not archived that URL. This page is not available on the web because page does not exist', false), BOT_CHALLENGE);
});

test('classifyCell will not confirm a quote from a capture on a punctuation-insensitive match alone', () => {
  // The capture carries the qualifier the stored quote was cut before: the Lumo failure mode.
  const r = classifyCell(cell('a', 'x', 'yes', 'We never share your data.'), archivedPage('Intro. We never share your data, except with your consent. Outro.'));
  assert.equal(r.status, 'error');
  assert.equal(r.method, 'compact');
  assert.match(r.problems.join(' '), /punctuation is ignored/);
});
