import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFix, classifyAll, classifyCell, groupFetchErrors, needsRequote, parseArgs, changedCells, unverifiedChanges, UsageError, structuralProblems, unusablePage, BOT_CHALLENGE, GRACE_DAYS, type ArchivedPage, type CellReport } from '../src/check.js';
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

test('classifyAll: for a distrusted app a missing quote is never a failure, even on a page where another quote was found', () => {
  const frame = 'https://shop.example/frame';
  const real = 'https://shop.example/real';
  const cells = [
    cell('a', 'x', 'yes', 'A documented sentence about the feature.', frame),
    cell('a', 'y', 'yes', 'Another sentence the vendor wrote down.', frame),
    cell('a', 'z', 'yes', 'A documented sentence about the feature.', real),
    cell('a', 'w', 'yes', 'A sentence the partial page left out.', real),
  ];
  const pages = new Map([
    // what Amazon sent the runner: the site's frame, matching no quote
    [frame, prepareText('Skip to Main content. Cart. Orders. Conditions of Use. Privacy Notice.')],
    // one paragraph of the page arrived: it confirms z, and says nothing about w
    [real, prepareText('Intro. A documented sentence about the feature. Outro.')],
  ]);
  const byQuestion = (rs: CellReport[]) => Object.fromEntries(rs.map((r) => [r.question, r.status]));
  assert.deepEqual(byQuestion(classifyAll(cells, pages, () => true)), { x: 'error', y: 'error', z: 'ok', w: 'error' });
  assert.deepEqual(byQuestion(classifyAll(cells, pages, () => false)), { x: 'fail', y: 'fail', z: 'ok', w: 'fail' }, 'a trusted reader fails every miss');
});

test('classifyAll: a partial cloud page can no longer flag and then demote a blocked app\'s cell (Codex probe 2)', () => {
  const url = 'https://example.invalid/privacy';
  const anchor = cell('a', 'training', 'yes', 'Your privacy matters to our company.', url);
  const absent = cell('a', 'deletion', 'yes', 'You can delete your history whenever you want.', url);
  const partial = new Map([[url, prepareText('Your privacy matters to our company. Some other page text is missing.')]]);
  const reports = classifyAll([anchor, absent], partial, () => true);
  assert.deepEqual(reports.map((r) => r.status), ['ok', 'error']);
  const first = applyFix([anchor, absent], reports, [], '2026-09-20');
  const second = applyFix(first.cells, reports, [], '2026-09-27');
  assert.equal(first.cells[1]!.quote_missing_since, undefined);
  assert.equal(second.cells[1]!.value, 'yes');
  assert.equal(second.cells[1]!.verified_at, '2026-09-01', 'an unreadable page leaves the cell exactly as it was');
});

test('classifyAll: a malformed quote still fails for a distrusted app', () => {
  const r = classifyAll([cell('a', 'x', 'yes', 'too short')], new Map([['https://docs.example/page', prepareText('Some page text that is long enough to read.')]]), () => true);
  assert.equal(r[0]!.status, 'fail');
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

test('classifyCell will not confirm a quote from the live page on a punctuation-insensitive match either (Codex probe 6)', () => {
  const quote = cell('a', 'x', 'yes', 'We never share your data.');
  const live = classifyCell(quote, prepareText('We never share your data, except with advertising partners when you consent.'));
  assert.equal(live.status, 'error');
  assert.equal(live.method, 'compact');
  assert.ok(needsRequote(live));
  assert.match(live.problems.join(' '), /re-quote it exactly from the page/);
  // ...and the cell is left exactly as it was: not re-dated, not flagged, not demoted.
  const { cells: [kept], demoted, pending } = applyFix([quote], [live], [], '2026-09-28');
  assert.deepEqual(kept, quote);
  assert.equal(demoted, 0);
  assert.equal(pending.length, 0);
  // A malformed quote that only matches compactly is still a data error, and fails.
  const malformed = classifyCell(cell('a', 'x', 'yes', `We never share your data${'!'.repeat(400)}`), prepareText('We never share your data, except when you consent.'));
  assert.equal(malformed.status, 'fail');
  // Exact and normalized matches are unchanged.
  assert.equal(classifyCell(quote, prepareText('Intro. We never share your data. Outro.')).status, 'ok');
  assert.equal(classifyCell(quote, prepareText('Intro. WE NEVER SHARE YOUR DATA. Outro.')).method, 'normalized');
  assert.equal(needsRequote(classifyCell(quote, { error: 'HTTP 503' })), false);
});

// --- Pull-request gate (--changed-since) ---------------------------------------------------------

const TODAY = '2026-09-28';
const okReport = (c: Cell): CellReport => ({ app: c.app, question: c.question, value: c.value, status: 'ok', method: 'exact', evidence_url: c.evidence_url, problems: [] });
const byKey = (cells: Cell[]) => new Map(cells.map((c) => [`${c.app}|${c.question}`, c]));

test('changedCells: new cells and changed evidence count, notes-only edits and unknown cells do not', () => {
  const base = [cell('a', 'x', 'yes'), cell('a', 'y', 'yes'), cell('a', 'z', 'yes'), cell('a', 'n', 'yes'), cell('a', 'd', 'yes')];
  const head = [
    { ...cell('a', 'x', 'yes'), quote: 'A different sentence someone typed in.' },
    { ...cell('a', 'y', 'yes'), verified_at: '2026-09-27' },
    cell('a', 'z', 'yes'),
    { ...cell('a', 'n', 'yes'), notes: 'reworded note' },
    { ...cell('a', 'd', 'yes'), verified_via: 'manual' as const },
    cell('a', 'new', 'partial'),
    cell('a', 'unk', 'unknown', '', ''),
  ];
  assert.deepEqual([...changedCells(base, head)].sort(), ['a|d', 'a|new', 'a|x', 'a|y']);
  // Removing a field counts as much as adding one, and the capture a cell links to is evidence too.
  const withVia: Cell = { ...cell('a', 'v', 'yes'), verified_via: 'manual' };
  const withTs: Cell = { ...cell('a', 't', 'yes'), verified_via: 'archive', archive_timestamp: '20260921065036' };
  const noVia = { ...withVia };
  delete noVia.verified_via;
  assert.deepEqual([...changedCells([withVia, withTs], [noVia, { ...withTs, archive_timestamp: '20260101000000' }])].sort(), ['a|t', 'a|v']);
});

test('unverifiedChanges: an invented quote the cloud cannot confirm fails the pull request (Codex probe 1)', () => {
  const invented = cell('example', 'training', 'yes', 'We invented this privacy guarantee for the audit.', 'https://example.invalid/privacy');
  const reports = classifyAll([invented], new Map([['https://example.invalid/privacy', prepareText('This is an ordinary accessible policy page with some unrelated text.')]]), () => true);
  assert.equal(reports[0]!.status, 'error', 'still not a failure of the cell itself');
  const gate = unverifiedChanges(reports, new Set(['example|training']), byKey([invented]), new Set(), new Set(['example']), TODAY);
  assert.equal(gate.unverified.length, 1);
  assert.match(gate.unverified[0]!, /^UNVERIFIED example\/training: quote not found on the page/);
  // A fetch error is reported as an unreadable page.
  const down = unverifiedChanges([classifyCell(invented, { error: 'HTTP 503' })], new Set(['example|training']), byKey([invented]), new Set(), new Set(), TODAY);
  assert.match(down.unverified[0]!, /page not readable \(fetch failed: HTTP 503\)/);
});

test('unverifiedChanges: unchanged cells on an unreadable page do not block the pull request', () => {
  const c = cell('a', 'x', 'yes');
  const gate = unverifiedChanges([classifyCell(c, { error: 'HTTP 503' })], new Set(), byKey([c]), new Set(), new Set(), TODAY);
  assert.deepEqual(gate, { unverified: [], attested: [], confirmed: 0 });
});

test('unverifiedChanges: a confirmation from the live page or an archive capture passes', () => {
  const live = cell('a', 'x', 'yes');
  const archived = cell('a', 'y', 'yes');
  const gate = unverifiedChanges([okReport(live), archiveOk('a', 'y', '20260921065036')], new Set(['a|x', 'a|y']), byKey([live, archived]), new Set(), new Set(), TODAY);
  assert.deepEqual(gate, { unverified: [], attested: [], confirmed: 2 });
});

test('unverifiedChanges: a recent maintainer reading of an app the base marks blocked is attested, nothing else is', () => {
  const miss = (c: Cell): CellReport => classifyCell(c, prepareText('A page from which the quote is absent, long enough to count.'), { confirmOnly: true });
  const manual = (days: string, extra: Partial<Cell> = {}): Cell => ({ ...cell('b', 'x', 'yes'), verified_via: 'manual', verified_at: days, ...extra });
  const run = (c: Cell, baseBlocked: string[], headBlocked = baseBlocked) => unverifiedChanges([miss(c)], new Set(['b|x']), byKey([c]), new Set(baseBlocked), new Set(headBlocked), TODAY);

  const recent = run(manual('2026-09-21'), ['b']);
  assert.deepEqual(recent.unverified, []);
  assert.match(recent.attested[0]!, /^ATTESTED b\/x \(manual, 2026-09-21\)/);

  assert.match(run(manual('2026-09-08'), ['b']).unverified[0]!, /not within 14 days/, '20 days old');
  assert.equal(run(manual('2026-10-05'), ['b']).unverified.length, 1, 'a date in the future');
  assert.equal(run(manual('2026-09-21'), []).unverified.length, 1, 'an app not marked blocked');
  assert.equal(run(manual('2026-09-21', { verified: false }), ['b']).unverified.length, 1, 'verified: false');
  assert.equal(run({ ...cell('b', 'x', 'yes'), verified_at: '2026-09-21' }, ['b']).unverified.length, 1, 'not a manual reading');
  // Marking the app blocked in the same pull request does not open the exception.
  assert.match(run(manual(TODAY), [], ['b']).unverified[0]!, /marked blocked_from_cloud in this change; review the flag first/);
  // The window's edges: day 14 is in, day 15 is out; an empty date and a future date are out, each saying why.
  assert.equal(run(manual('2026-09-14'), ['b']).attested.length, 1, 'day 14');
  assert.match(run(manual('2026-09-13'), ['b']).unverified[0]!, /not within 14 days/, 'day 15');
  assert.match(run(manual(''), ['b']).unverified[0]!, /manual reading of no date is not within 14 days/);
  assert.match(run(manual('2026-10-05'), ['b']).unverified[0]!, /dated after today, UTC/);
});

test('unverifiedChanges: a maintainer reading does not cover a quote the run found malformed or matching only without punctuation', () => {
  const reading: Cell = { ...cell('b', 'x', 'yes', 'too short'), verified_via: 'manual', verified_at: '2026-09-27' };
  // A malformed quote fails outright, even for a blocked app; the summary must say so, not ATTESTED.
  const malformed = classifyCell(reading, prepareText('A page with text on it that is long enough to count.'), { confirmOnly: true });
  assert.equal(malformed.status, 'fail');
  const g1 = unverifiedChanges([malformed], new Set(['b|x']), byKey([reading]), new Set(['b']), new Set(['b']), TODAY);
  assert.deepEqual(g1.attested, []);
  assert.match(g1.unverified[0]!, /quote malformed \(quote shorter than 12 characters.*stands in only for a page the checker could not read/);
  // The usual path for a blocked app in CI: the page refuses the runner (status error), or only a
  // capture is read (status error too). A malformed quote is still not vouched for.
  for (const page of [{ error: 'HTTP 403' }, archivedPage('A capture of the page, with enough text on it to count as a page.')]) {
    const r = classifyCell(reading, page, { confirmOnly: true });
    assert.equal(r.status, 'error');
    const g = unverifiedChanges([r], new Set(['b|x']), byKey([reading]), new Set(['b']), new Set(['b']), TODAY);
    assert.deepEqual(g.attested, []);
    assert.match(g.unverified[0]!, /^UNVERIFIED b\/x: quote malformed \(quote shorter than 12 characters/);
  }
  // A punctuation-only match: the page was read, so the quote needs copying again, not vouching for.
  const cut: Cell = { ...reading, quote: 'We never share your data.' };
  const requote = classifyCell(cut, prepareText('We never share your data, except with advertising partners.'), { confirmOnly: true });
  const g2 = unverifiedChanges([requote], new Set(['b|x']), byKey([cut]), new Set(['b']), new Set(['b']), TODAY);
  assert.deepEqual(g2.attested, []);
  assert.match(g2.unverified[0]!, /^UNVERIFIED b\/x: quote not confirmed/);
});

test('unverifiedChanges: reasons name what was wrong: a malformed quote, a capture that lacks it, a page not read', () => {
  const c = cell('a', 'x', 'yes', `A quote that is far too long ${'x'.repeat(400)}`);
  const onPage = classifyCell(c, prepareText(`Intro. ${c.quote} Outro.`));
  assert.equal(onPage.status, 'fail');
  assert.match(unverifiedChanges([onPage], new Set(['a|x']), byKey([c]), new Set(), new Set(), TODAY).unverified[0]!, /: quote malformed \(quote longer than 400 characters\)/);
  const plain = cell('a', 'x', 'yes');
  const captureMiss = classifyCell(plain, archivedPage('A capture of a page that says something else entirely.'));
  assert.match(unverifiedChanges([captureMiss], new Set(['a|x']), byKey([plain]), new Set(), new Set(), TODAY).unverified[0]!, /: quote not found in the capture the run could read \(/);
  const down = classifyCell(plain, { error: 'HTTP 503' });
  assert.match(unverifiedChanges([down], new Set(['a|x']), byKey([plain]), new Set(), new Set(), TODAY).unverified[0]!, /: page not readable \(fetch failed: HTTP 503\)/);
  // A malformed quote that a capture matches only without punctuation is reported as malformed, not
  // as a re-quote: shortening it is the fix, whatever the page says.
  const long: Cell = { ...cell('a', 'x', 'yes'), quote: `We never share your data ${'and more words '.repeat(30)}.` };
  const loose = classifyCell(long, archivedPage(`Intro. ${long.quote.replace(/ \.$/, ',')} except with partners. Outro.`));
  assert.equal(loose.method, 'compact');
  assert.match(unverifiedChanges([loose], new Set(['a|x']), byKey([long]), new Set(), new Set(), TODAY).unverified[0]!, /: quote malformed \(quote longer than 400 characters/);
});

test('parseArgs: --changed-since takes a ref and refuses --fix', () => {
  assert.equal(parseArgs(['--changed-since', 'HEAD^1']).changedSince, 'HEAD^1');
  assert.equal(parseArgs([]).changedSince, null);
  assert.throws(() => parseArgs(['--fix', '--changed-since', 'origin/main']), (err: unknown) => err instanceof UsageError && /cannot be combined with --fix/.test(err.message));
});

test('parseArgs: --changed-since without a ref is refused, so the gate cannot be switched off by a dropped argument', () => {
  const needsRef = (err: unknown) => err instanceof UsageError && /needs a git ref/.test(err.message);
  assert.throws(() => parseArgs(['--changed-since']), needsRef);
  assert.throws(() => parseArgs(['--changed-since', '']), needsRef);
  assert.throws(() => parseArgs(['--changed-since', '--soft']), needsRef, 'the next flag is not a ref');
  assert.throws(() => parseArgs(['--fix', '--changed-since', '']), (err: unknown) => err instanceof UsageError);
});
