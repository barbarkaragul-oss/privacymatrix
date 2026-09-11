import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellKey, loadApps, loadQuestions, loadMatrix } from '../src/types.js';

test('data files parse and are internally consistent', () => {
  const apps = loadApps();
  const qs = loadQuestions();
  assert.ok(apps.length >= 1);
  assert.ok(qs.questions.length >= 1);
  const groupIds = new Set(qs.groups.map((g) => g.id));
  for (const c of qs.questions) assert.ok(groupIds.has(c.group), `group ${c.group} for ${c.id}`);
  for (const a of apps) assert.ok(a.sources.length >= 1, `app ${a.id} needs sources`);
});

test('matrix cells reference known apps and questions, no duplicates', () => {
  const apps = new Set(loadApps().map((a) => a.id));
  const qs = new Set(loadQuestions().questions.map((c) => c.id));
  const matrix = loadMatrix();
  const seen = new Set<string>();
  for (const cell of matrix.cells) {
    assert.ok(apps.has(cell.app), `unknown app ${cell.app}`);
    assert.ok(qs.has(cell.question), `unknown question ${cell.question}`);
    const key = cellKey(cell.app, cell.question);
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    if (cell.value !== 'unknown') {
      assert.ok(cell.quote.trim().length > 0, `${key} needs a quote`);
      assert.ok(/^https?:\/\//.test(cell.evidence_url), `${key} needs an evidence_url`);
    }
  }
});
