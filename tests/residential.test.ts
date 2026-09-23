import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isDue, MAX_AGE_DAYS, repoSlug, summarize, withoutDemotions } from '../scripts/residential.js';

test('isDue: runs when there is no success yet, or the last one is MAX_AGE_DAYS or more old', () => {
  assert.equal(isDue(null, '2026-09-28', MAX_AGE_DAYS), true);
  assert.equal(isDue('2026-09-28', '2026-09-28', MAX_AGE_DAYS), false);
  assert.equal(isDue('2026-09-22', '2026-09-27', 6), false, 'five days: not yet');
  assert.equal(isDue('2026-09-22', '2026-09-28', 6), true, 'six days: due');
  assert.equal(isDue('2026-09-01', '2026-09-28', 6), true, 'the machine was off for weeks: catch up');
  assert.equal(isDue('garbage', '2026-09-28', 6), true, 'an unreadable stamp never blocks a run');
});

test('decide: flags and dates go to main, demotions go to a pull request, the issue follows the flags', () => {
  const base = { valueChanges: 0, pending: 0, flagged: 0, unreachable: 0, dirty: false };
  // Nothing changed and every page was read: close the issue and any stale demotion PR.
  assert.deepEqual(decide(base), { commit: 'none', issue: 'close', pr: 'close' });
  // Dates refreshed: straight to main.
  assert.deepEqual(decide({ ...base, dirty: true }), { commit: 'main', issue: 'close', pr: 'close' });
  // A first miss only flags the cell; the flag must reach main, or the grace period restarts every week.
  assert.deepEqual(decide({ ...base, pending: 1, flagged: 1, dirty: true }), { commit: 'main', issue: 'open', pr: 'close' });
  // A cell flagged by an earlier run keeps the issue open even when this run found nothing new.
  assert.deepEqual(decide({ ...base, flagged: 1, dirty: true }), { commit: 'main', issue: 'open', pr: 'close' });
  // A demotion: main gets the dates and flags, a pull request gets the demotion.
  assert.deepEqual(decide({ ...base, valueChanges: 1, flagged: 0, dirty: true }), { commit: 'main+pr', issue: 'open', pr: 'open' });
  // A page could not be read: nobody can say every quote was found, so the issue is left alone.
  assert.deepEqual(decide({ ...base, unreachable: 2, dirty: true }), { commit: 'main', issue: 'keep', pr: 'close' });
});

test('withoutDemotions keeps every other change and puts the demoted cells back as they were', () => {
  const cell = (question: string, extra: Record<string, unknown> = {}) => ({ app: 'chatgpt', question, value: 'yes', verified_at: '2026-09-01', ...extra });
  const before = { version: 1, cells: [cell('a', { quote_missing_since: '2026-09-18' }), cell('b'), cell('c')] };
  const result = {
    version: 1,
    cells: [
      cell('a', { value: 'unknown', verified_at: '' }), // demoted by this run
      cell('b', { verified_at: '2026-09-28' }), // re-dated
      cell('c', { quote_missing_since: '2026-09-28' }), // first miss
    ],
  };
  const main = withoutDemotions(result, before, [{ app: 'chatgpt', question: 'a' }]);
  assert.deepEqual(main.cells[0], before.cells[0], 'the demoted cell stays as it was, still flagged');
  assert.equal(main.cells[1]?.verified_at, '2026-09-28');
  assert.equal(main.cells[2]?.quote_missing_since, '2026-09-28');
  assert.equal(result.cells[0]?.value, 'unknown', 'the result itself is not modified');
});

test('summarize reads like the weekly run summary', () => {
  assert.equal(summarize({ ok: 39, errors: 0 }, { valueChanges: 0, pending: 0, flagged: 0, unreachable: 0, dirty: true }), '0 value changes, 39 quotes present, 0 newly missing, 0 cells on unreachable pages');
  assert.equal(summarize({ ok: 38, errors: 1 }, { valueChanges: 1, pending: 1, flagged: 1, unreachable: 1, dirty: true }), '1 value change, 38 quotes present, 1 newly missing, 1 cells on unreachable pages');
});

test('repoSlug reads https and ssh GitHub remotes', () => {
  assert.equal(repoSlug('https://github.com/barbarkaragul-oss/privacymatrix.git'), 'barbarkaragul-oss/privacymatrix');
  assert.equal(repoSlug('https://github.com/barbarkaragul-oss/privacymatrix'), 'barbarkaragul-oss/privacymatrix');
  assert.equal(repoSlug('git@github.com:barbarkaragul-oss/privacymatrix.git'), 'barbarkaragul-oss/privacymatrix');
  assert.equal(repoSlug('https://gitlab.com/x/y.git'), null);
});
