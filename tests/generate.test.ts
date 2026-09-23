import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedData, mdTitle, renderBlockedSources, renderMatrixMarkdown, renderRecentChanges, replaceBetween } from '../src/generate.js';
import { ChangesFileSchema } from '../src/types.js';

test('mdTitle reduces markdown to plain tooltip text and neutralises quote-breaking characters', () => {
  assert.equal(mdTitle('Configure slash commands in your [configuration file](/docs/guides/config-files). List the `command` **without** the `/`.'), "Configure slash commands in your configuration file. List the command without the /.");
  assert.equal(mdTitle('say "hi" C:\\path'), "say 'hi' C:/path");
  assert.equal(mdTitle('x'.repeat(200)).length, 180);
});
import type { App, Cell } from '../src/types.js';

test('embedData keeps $ sequences and neutralises script terminators', () => {
  const template = '<script>\n/*__PRIVACYMATRIX_DATA__*/\n</script><a href="__REPO_URL__">repo</a>';
  const html = embedData(template, { q: 'costs $& and $$ and $1', tag: '</script><!--' }, 'https://github.com/o/r');
  assert.ok(html.includes('costs $& and $$ and $1'));
  assert.ok(!html.includes('</script><!--'));
  assert.ok(html.includes('<\\/script'));
  assert.ok(html.includes('href="https://github.com/o/r"'));
  assert.ok(html.includes('window.PRIVACYMATRIX = {'));
});

test('embedData drops a non-http repository URL', () => {
  const html = embedData('<a href="__REPO_URL__">', {}, 'javascript:alert(1)');
  assert.ok(html.includes('href=""'));
});

test('replaceBetween replaces only the region between markers', () => {
  const out = replaceBetween('head\n<!-- a:start -->\nold\n<!-- a:end -->\ntail', '<!-- a:start -->', '<!-- a:end -->', 'new');
  assert.equal(out, 'head\n<!-- a:start -->\nnew\n<!-- a:end -->\ntail');
  assert.throws(() => replaceBetween('no markers', '<!-- a:start -->', '<!-- a:end -->', 'x'));
});

test('renderMatrixMarkdown links only http URLs and escapes quotes in titles', () => {
  const apps: App[] = [{ id: 'a', name: 'A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] }];
  const qs = { values: {}, groups: [{ id: 'g', name: 'G' }], questions: [{ id: 'x', group: 'g', name: 'X', question: 'q', rubric: 'r' }, { id: 'y', group: 'g', name: 'Y', question: 'q', rubric: 'r' }] };
  const cells: Cell[] = [
    { app: 'a', question: 'x', value: 'yes', quote: 'say "hi" (now)', evidence_url: 'https://a.x/p(1)', notes: '', confidence: 'high', verified: true, verified_at: '2026-09-10' },
    { app: 'a', question: 'y', value: 'yes', quote: 'q', evidence_url: '', notes: '', confidence: 'high', verified: false, verified_at: '' },
  ];
  const md = renderMatrixMarkdown(apps, qs, cells);
  assert.ok(md.includes('[✅](https://a.x/p%281%29 "say \'hi\' (now)")'));
  assert.ok(md.includes('| **Y** | ❔ |'));
});

test('renderRecentChanges counts missing quotes and archive cells from the matrix, not from the last run', () => {
  const base = {
    run_at: '2026-09-21T15:05:01.071Z',
    model: 'none (mechanical quote re-check)',
    changes: [],
    pending: [],
    stats: { apps_checked: 28, apps_failed: [], cells_total: 392, cells_verified: 314, cells_unknown: 78, cells_verified_via_archive: 0 },
  };
  const c = (question: string, extra: Partial<Cell> = {}): Cell => ({ app: 'a', question, value: 'yes', quote: 'a quote of some length', evidence_url: 'https://a.x/', notes: '', confidence: 'high', verified: true, verified_at: '2026-09-21', ...extra });

  assert.equal(renderRecentChanges(base, [], [], [c('x')]), '_Last run 2026-09-21: no value changed; no quote is missing from any page the checker could read._');

  const archived = renderRecentChanges(base, [], [], [c('x', { verified_via: 'archive', archive_timestamp: '20260921065036' }), c('y')]);
  assert.ok(archived.endsWith(', and 1 cell rests on Internet Archive captures of pages that block the checker._'));

  // Flagged by a run that did not write changes.json (the residential re-check): still reported.
  const flagged = renderRecentChanges(base, [], [], [c('x', { quote_missing_since: '2026-09-28' }), c('y', { quote_missing_since: '2026-09-28' })]);
  assert.ok(!flagged.includes('no quote is missing'));
  assert.ok(flagged.includes('2 quotes are missing from their sources and wait for a human'));
  assert.ok(flagged.includes('label%3Aneeds-recheck%2Cresidential-recheck'));

  const one = renderRecentChanges(base, [], [], [c('x', { quote_missing_since: '2026-09-28' })]);
  assert.ok(one.includes('1 quote is missing from its source and waits for a human'));
});

test('a changes file written before pending existed still loads, with no pending quotes', () => {
  const parsed = ChangesFileSchema.parse({
    run_at: '2026-09-11T00:00:00Z',
    model: 'none (mechanical quote re-check)',
    changes: [],
    stats: { apps_checked: 28, apps_failed: [], cells_total: 392, cells_verified: 314, cells_unknown: 78 },
  });
  assert.deepEqual(parsed.pending, []);
  assert.equal(parsed.stats.cells_verified_via_archive, 0);
});

test('renderMatrixMarkdown marks cells that were not verified by a live read, and explains the marks', () => {
  const apps: App[] = [{ id: 'a', name: 'A', vendor: 'v', homepage: 'https://a.x/', repo: null, sources: ['https://a.x/'] }];
  const qs = { values: {}, groups: [{ id: 'g', name: 'G' }], questions: [{ id: 'x', group: 'g', name: 'X', question: 'q', rubric: 'r' }, { id: 'y', group: 'g', name: 'Y', question: 'q', rubric: 'r' }] };
  const base = { app: 'a', value: 'yes' as const, evidence_url: 'https://a.x/p', notes: '', confidence: 'high' as const, verified: true };
  const cells: Cell[] = [
    { ...base, question: 'x', quote: 'archived sentence', verified_at: '2026-09-21', verified_via: 'archive', archive_timestamp: '20260921065036' },
    { ...base, question: 'y', quote: 'hand read sentence', verified_at: '2026-09-23', verified_via: 'manual' },
  ];
  const md = renderMatrixMarkdown(apps, qs, cells);
  assert.ok(md.includes('"[archive 2026-09-21] archived sentence"'));
  assert.ok(md.includes('"[manual 2026-09-23] hand read sentence"'));
  assert.ok(md.includes('Internet Archive capture'));

  const plain = renderMatrixMarkdown(apps, qs, cells.map(({ verified_via: _v, archive_timestamp: _t, ...c }) => c));
  assert.ok(!plain.includes('[archive'));
  assert.ok(!plain.includes('Internet Archive capture'), 'the legend note appears only when a cell needs it');
});

test('renderBlockedSources lists blocked apps with their hosts and how their cells were verified', () => {
  const apps: App[] = [
    { id: 'c', name: 'ChatGPT', vendor: 'OpenAI', homepage: 'https://chatgpt.com', repo: null, sources: ['https://openai.com/p', 'https://help.openai.com/a', 'https://help.openai.com/b'], blocked_from_cloud: true },
    { id: 'o', name: 'Open', vendor: 'v', homepage: 'https://o.x/', repo: null, sources: ['https://o.x/'] },
  ];
  const base = { value: 'yes' as const, quote: 'q q q q q q q', evidence_url: 'https://help.openai.com/a', notes: '', confidence: 'high' as const, verified: true };
  const cells: Cell[] = [
    { ...base, app: 'c', question: 'x', verified_at: '2026-09-23', verified_via: 'manual' },
    { ...base, app: 'c', question: 'y', verified_at: '2026-09-21', verified_via: 'archive', archive_timestamp: '20260921065036' },
    { ...base, app: 'c', question: 'z', verified_at: '2026-09-28' },
    { ...base, app: 'o', question: 'x', verified_at: '2026-09-28' },
  ];
  const md = renderBlockedSources(apps, cells);
  assert.ok(md.startsWith('### Sources the checker cannot reach'));
  assert.ok(md.includes('**ChatGPT** (openai.com, help.openai.com): 3 verified cells'));
  assert.ok(md.includes('1 read live, 1 read by hand, 1 confirmed from archive captures; verified between 2026-09-21 and 2026-09-28.'));
  assert.ok(!md.includes('**Open**'));
  assert.equal(renderBlockedSources([apps[1] as App], cells), '');
});
