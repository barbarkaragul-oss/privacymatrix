import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedData, mdTitle, renderMatrixMarkdown, replaceBetween } from '../src/generate.js';

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
