import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutDemotions } from '../src/split.js';

test('withoutDemotions: a changed cell main never had goes to main as unknown, not with its new value', () => {
  // A Claude run derives a cell for a question main has no cell for yet; the value waits for the pull request.
  const before = { cells: [{ app: 'a', question: 'x', value: 'yes', quote: 'Q', verified_at: '2026-11-01' }] };
  const result = { cells: [{ app: 'a', question: 'x', value: 'yes', quote: 'Q', verified_at: '2026-11-09' }, { app: 'a', question: 'new', value: 'yes', quote: 'A sentence.', verified: true, verified_at: '2026-11-09' }] };
  const main = withoutDemotions(result, before, [{ app: 'a', question: 'new' }]);
  assert.equal(main.cells[0]?.verified_at, '2026-11-09', 'an unchanged cell keeps its new date');
  assert.deepEqual(main.cells[1], { app: 'a', question: 'new', value: 'unknown', quote: '', evidence_url: '', notes: '', confidence: 'low', verified: false, verified_at: '' });
});
