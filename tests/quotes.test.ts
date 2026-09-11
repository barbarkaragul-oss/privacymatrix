import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactText, findQuote, normalizeText, prepareText, quoteProblems } from '../src/quotes.js';

test('normalizeText folds smart punctuation, markdown and whitespace', () => {
  assert.equal(normalizeText('“Hello” — it’s   **bold** `code`'), '"hello" - it\'s bold code');
  assert.equal(normalizeText('See [the docs](https://x.y/z) now'), 'see the docs now');
  assert.equal(normalizeText('a b\n\n  c'), 'a b c');
});

test('compactText keeps only letters and digits', () => {
  assert.equal(compactText('Run `claude mcp serve` -- v1.2!'), 'runclaudemcpservev12');
});

test('findQuote: exact match wins', () => {
  const page = prepareText('Claude Code supports hooks. Hooks run shell commands at lifecycle events.');
  const m = findQuote(page, 'Hooks run shell commands at lifecycle events.');
  assert.equal(m.found, true);
  assert.equal(m.method, 'exact');
});

test('findQuote: normalized match survives smart quotes and markdown', () => {
  const page = prepareText('Use the **`--resume`** flag to “continue” a session — it lists prior sessions.');
  const m = findQuote(page, 'Use the --resume flag to "continue" a session - it lists prior sessions.');
  assert.equal(m.found, true);
  assert.equal(m.method, 'normalized');
});

test('findQuote: compact match survives punctuation-only differences', () => {
  const page = prepareText('Sessions can be resumed with: claude --resume (or -r).');
  const m = findQuote(page, 'Sessions can be resumed with claude --resume or -r');
  assert.equal(m.found, true);
  assert.equal(m.method, 'compact');
});

test('findQuote: different wording does not match', () => {
  const page = prepareText('Codex does not currently support lifecycle hooks.');
  const m = findQuote(page, 'Codex supports lifecycle hooks.');
  assert.equal(m.found, false);
  assert.equal(m.method, 'none');
});

test('findQuote: very short quotes are rejected', () => {
  const page = prepareText('yes yes yes MCP is supported everywhere');
  assert.equal(findQuote(page, 'yes').found, false);
});

test('quoteProblems flags length and replacement characters', () => {
  assert.deepEqual(quoteProblems('too short'), ['quote shorter than 12 characters']);
  assert.deepEqual(quoteProblems('A perfectly reasonable quote from the documentation.'), []);
  assert.ok(quoteProblems('x'.repeat(401)).some((p) => p.includes('longer')));
  assert.ok(quoteProblems('Run amp threads continue T-� to attach').some((p) => p.includes('U+FFFD')));
});

test('findQuote: a stitched quote with an ellipsis cannot pass through the compact pass', () => {
  const page = prepareText('Hooks run before tools. Skills load from SKILL.md files.');
  assert.equal(findQuote(page, 'Hooks run before tools ... Skills load from SKILL.md files').found, false);
  assert.equal(findQuote(page, 'Hooks run before tools .. Skills load from SKILL.md files').found, false);
  assert.equal(findQuote(page, 'Hooks run before tools . . . Skills load from SKILL.md files').found, false);
  assert.equal(findQuote(page, 'Hooks run before tools … Skills load from SKILL.md files').found, false);
  const code = prepareText('For background tasks, `delegate(..., async: true)` returns a task id.');
  assert.equal(findQuote(code, 'For background tasks, `delegate(..., async: true)` returns a task id.').found, true);
});
