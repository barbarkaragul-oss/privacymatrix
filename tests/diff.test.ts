import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMatrices, escapeMd, renderChangesMarkdown } from '../src/diff.js';
import type { Cell } from '../src/types.js';

function cell(app: string, question: string, value: Cell['value'], extra: Partial<Cell> = {}): Cell {
  return { app, question, value, quote: 'q', evidence_url: 'https://e.x/', notes: 'n', confidence: 'high', verified: true, verified_at: '2026-09-10', ...extra };
}

test('diffMatrices reports value changes and new cells only', () => {
  const prev = [cell('a', 'x', 'no'), cell('a', 'y', 'yes'), cell('a', 'z', 'partial')];
  const next = [cell('a', 'x', 'yes', { quote: 'now supported' }), cell('a', 'y', 'yes', { quote: 'different quote same value' }), cell('a', 'z', 'partial'), cell('b', 'x', 'yes')];
  const changes = diffMatrices(prev, next);
  assert.deepEqual(
    changes.map((c) => [c.app, c.question, c.from, c.to]),
    [
      ['a', 'x', 'no', 'yes'],
      ['b', 'x', 'unknown', 'yes'],
    ],
  );
  assert.equal(changes[0]?.quote, 'now supported');
});

test('escapeMd neutralises every markdown and HTML construct that could render in a PR body', () => {
  assert.equal(escapeMd('see [here](http://evil) **bold** _it_ `code` @user #12 a|b <b>x</b> & ~s~ !'), 'see &#91;here&#93;(http://evil) &#42;&#42;bold&#42;&#42; &#95;it&#95; &#96;code&#96; &#64;user &#35;12 a&#124;b &lt;b&gt;x&lt;/b&gt; &amp; &#126;s&#126; &#33;');
  assert.equal(escapeMd('path C:\\x\nnext'), 'path C:&#92;x next');
});

test('renderChangesMarkdown produces a table with names, safe link destinations and verbatim quotes', () => {
  const md = renderChangesMarkdown(
    {
      run_at: '2026-09-10T06:00:00Z',
      model: 'claude-fable-5-1',
      changes: [{ app: 'a', question: 'x', from: 'no', to: 'yes', quote: 'supports a | b and [links](x)', evidence_url: 'https://e.x/a)b', notes: '' }],
      pending: [],
      stats: { apps_checked: 1, apps_failed: ['b'], cells_total: 2, cells_verified: 2, cells_unknown: 0, cells_verified_via_archive: 0 },
    },
    [
      { id: 'a', name: 'App A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] },
      { id: 'b', name: 'App B', vendor: 'v', homepage: 'https://b.x/', repo: null, sources: ['https://b.x/'] },
    ],
    [{ id: 'x', group: 'g', name: 'Cap X', question: 'q', rubric: 'r' }],
    ['App A: 1 cell on 1 page (fetch failed: HTTP 503)'],
    [{ app: 'a', question: 'x', evidence_url: 'https://e.x/p_(1)', since: '2026-09-03' }],
  );
  assert.ok(md.includes('1 value change'));
  assert.ok(md.includes('| App A | Cap X | no → **yes** |'));
  assert.ok(md.includes('[source](https://e.x/a%29b)'));
  assert.ok(md.includes('<code>supports a &#124; b and &#91;links&#93;(x)</code>'));
  assert.ok(md.includes('App B'));
  assert.ok(md.includes('Pages that could not be fetched this run (cells left untouched):'));
  assert.ok(md.includes('- App A: 1 cell on 1 page (fetch failed: HTTP 503)'));
  assert.ok(md.includes('Quotes not found at their source this run (1).'));
  assert.ok(md.includes('- App A / Cap X — missing since 2026-09-03 — [source](https://e.x/p_%281%29)'));
});

test('renderChangesMarkdown with no changes says so', () => {
  const md = renderChangesMarkdown(
    { run_at: 'r', model: 'm', changes: [], pending: [], stats: { apps_checked: 0, apps_failed: [], cells_total: 0, cells_verified: 0, cells_unknown: 0, cells_verified_via_archive: 0 } },
    [],
    [],
  );
  assert.ok(md.includes('No question values changed'));
});

test('renderChangesMarkdown says how many quotes an archive capture confirmed, and only then', () => {
  const file = { run_at: 'r', model: 'm', changes: [], pending: [], stats: { apps_checked: 1, apps_failed: [], cells_total: 1, cells_verified: 1, cells_unknown: 0, cells_verified_via_archive: 1 } };
  const md = renderChangesMarkdown(file, [], [], [], [], { confirmed: 12, dated: 5, oldestDated: '2026-09-13' });
  assert.ok(md.includes('12 quotes on pages that refused the checker were found in Internet Archive captures'));
  assert.ok(md.includes('5 cells were re-dated to a capture newer than their last verification (oldest 2026-09-13), and the rest keep their dates'));
  assert.ok(md.includes('never demotes a cell'));
  // Found only in captures older than the cells: say plainly that nothing was re-dated.
  assert.ok(renderChangesMarkdown(file, [], [], [], [], { confirmed: 2, dated: 0, oldestDated: null }).includes('so every date is unchanged'));
  assert.ok(!renderChangesMarkdown(file, [], []).includes('Internet Archive'));
});
