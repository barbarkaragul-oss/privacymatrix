import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, Fetcher, fetchText, htmlToText, stripInlineHtml, toFetchableUrl } from '../src/fetch.js';

test('toFetchableUrl rewrites GitHub blob URLs to raw and strips fragments', () => {
  assert.equal(
    toFetchableUrl('https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#v2'),
    'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  );
  assert.equal(toFetchableUrl('https://aider.chat/docs/usage.html#x'), 'https://aider.chat/docs/usage.html');
  assert.equal(toFetchableUrl('https://github.com/openai/codex'), 'https://github.com/openai/codex');
  assert.equal(toFetchableUrl('not a url'), 'not a url');
});

test('decodeEntities handles named, decimal and hex entities and leaves invalid code points alone', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &nbsp;e &unknown;'), "a & b <c> 'd'  e &unknown;");
  assert.equal(decodeEntities('&#99999999; &#x110000; &#xD800; &#65;'), '&#99999999; &#x110000; &#xD800; A');
});

test('htmlToText strips scripts, styles and tags, keeps visible text with line breaks', () => {
  const html = `<!doctype html><html><head><title>T</title><style>.x{}</style><script>var a="<b>hidden</b>"</script></head>
  <body><nav>Menu</nav><h1>Hooks</h1><p>Hooks run <code>shell</code> commands.<br>Second line.</p>
  <ul><li>One</li><li>Two &amp; three</li></ul><!-- comment --><table><tr><td>a</td><td>b</td></tr></table></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('Hooks run shell commands.'));
  assert.ok(text.includes('Second line.'));
  assert.ok(text.includes('Two & three'));
  assert.ok(!text.includes('hidden'));
  assert.ok(!text.includes('comment'));
  assert.ok(!text.includes('<'));
});

test('stripInlineHtml removes documentation tags inside markdown but leaves code generics and placeholders alone', () => {
  assert.equal(stripInlineHtml('press <kbd>Esc</kbd> twice, see <a href="x">docs</a><br/>'), 'press  Esc  twice, see  docs  ');
  assert.equal(stripInlineHtml('use Array<string> and Map<K, V> and Option<A> and List<B>'), 'use Array<string> and Map<K, V> and Option<A> and List<B>');
  assert.equal(stripInlineHtml('gemini extensions install <source> [--ref <ref>] <path>'), 'gemini extensions install <source> [--ref <ref>] <path>');
});

// --- residential runner: 403 retry and request spacing, without the network ----------------------

async function withFakeFetch<T>(statuses: number[], fn: (calls: number[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: number[] = [];
  let i = 0;
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return new Response(status === 200 ? 'plain text body of the page' : 'Forbidden', { status, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('fetchText gives up on a 403 at once unless retryForbidden is set', async () => {
  await withFakeFetch([403, 403, 200], async (calls) => {
    const r = await fetchText('https://blocked.example/p');
    assert.equal(r.status, 403);
    assert.equal(calls.length, 1, 'a 403 from the cloud is permanent; asking again would only be rude');
  });
  await withFakeFetch([403, 403, 200], async (calls) => {
    const r = await fetchText('https://blocked.example/p', { retryForbidden: true, forbiddenDelaysMs: [1, 1, 1] });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 3);
  });
  await withFakeFetch([403], async (calls) => {
    const r = await fetchText('https://blocked.example/p', { retryForbidden: true, forbiddenDelaysMs: [1, 1] });
    assert.equal(r.status, 403);
    assert.equal(calls.length, 3, 'one attempt plus one per configured delay');
  });
});

test('Fetcher spaces request starts by minIntervalMs', async () => {
  await withFakeFetch([200], async (calls) => {
    // Measured where the fake fetch is called, so the first request's warm-up shortens the first
    // gap under load; 200 ms spacing with a 120 ms floor leaves room for that without hiding a bug.
    const f = new Fetcher({}, 1, 200);
    await Promise.all([f.get('https://a.example/1'), f.get('https://a.example/2'), f.get('https://a.example/3')]);
    assert.equal(calls.length, 3);
    for (let i = 1; i < calls.length; i++) assert.ok((calls[i] as number) - (calls[i - 1] as number) >= 120, `gap ${i} was ${(calls[i] as number) - (calls[i - 1] as number)} ms`);
  });
});
