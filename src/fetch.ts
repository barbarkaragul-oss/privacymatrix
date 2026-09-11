/**
 * Fetching documentation pages as plain text.
 *
 * - GitHub "blob" URLs are rewritten to raw.githubusercontent.com so we get markdown, not the
 *   GitHub web app shell.
 * - HTML pages are reduced to their visible text so quotes can be matched against them.
 * - Markdown and plain-text pages keep their text but lose inline HTML tags such as <kbd> and
 *   <code>, which documentation sites mix into markdown and which would otherwise split a quote.
 * - Every URL is fetched at most once per run (in-memory cache) with a small concurrency limit
 *   and retries on transient errors. Downloads stop at maxBytes.
 */

export interface FetchResult {
  url: string;
  fetchUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
  truncated: boolean;
  error?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  maxBytes?: number;
}

// Crawler-style identity: honest about being a bot, in the format most bot filters recognise.
const DEFAULT_UA = 'Mozilla/5.0 (compatible; privacymatrix-bot/0.1; +https://github.com/barbarkaragul-oss/privacymatrix)';

export function toFetchableUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.hash = '';
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    // https://github.com/owner/repo/blob/ref/path/to/file.md -> raw
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  }
  return u.toString();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
};

function codePointToString(cp: number, whole: string): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
  return String.fromCodePoint(cp);
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x')) return codePointToString(Number.parseInt(b.slice(2), 16), whole);
    if (b.startsWith('#')) return codePointToString(Number.parseInt(b.slice(1), 10), whole);
    return ENTITIES[b] ?? whole;
  });
}

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|pre|blockquote|dd|dt|dl|nav|aside|main|figure|figcaption|details|summary)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(td|th)\b[^>]*>/gi, ' \t ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Only tags that documentation authors commonly embed in markdown prose. Deliberately short:
// command placeholders such as <source>, <ref> or <path> must survive, so generic words are out.
// Case-sensitive on purpose: HTML in markdown is lowercase, while generics such as Option<A> or
// List<B> are not, so they survive.
const INLINE_HTML_TAGS = 'a|abbr|b|br|code|details|div|em|h[1-6]|i|img|kbd|li|ol|p|pre|small|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|ul';
const INLINE_HTML_RE = new RegExp(`<\\/?(?:${INLINE_HTML_TAGS})\\b(?:\\s[^<>]*)?\\/?>`, 'g');

/** Removes common HTML tags that documentation authors embed in markdown (e.g. <kbd>Esc</kbd>). */
export function stripInlineHtml(text: string): string {
  return text.replace(INLINE_HTML_RE, ' ');
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  const head = body.slice(0, 500).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

async function readBody(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    return { buf: all.subarray(0, maxBytes), truncated: all.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      // Reaching the limit means the rest of the body was not read; treat it as truncated even
      // when the body happened to be exactly maxBytes long (a rare, harmless false positive).
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

async function fetchOnce(url: string, opts: Required<FetchOptions>): Promise<FetchResult> {
  const fetchUrl = toFetchableUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(fetchUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/markdown, text/plain, text/html;q=0.9, */*;q=0.5',
      },
    });
    const contentType = res.headers.get('content-type') ?? '';
    const { buf, truncated } = await readBody(res, opts.maxBytes);
    const body = buf.toString('utf8');
    const text = looksLikeHtml(contentType, body) ? htmlToText(body) : stripInlineHtml(body.replace(/\r\n/g, '\n'));
    return {
      url,
      fetchUrl,
      finalUrl: res.url || fetchUrl,
      status: res.status,
      ok: res.ok,
      contentType,
      text,
      truncated,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? `timeout after ${opts.timeoutMs}ms` : err.message) : String(err);
    return { url, fetchUrl, finalUrl: fetchUrl, status: 0, ok: false, contentType: '', text: '', truncated: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const opts: Required<FetchOptions> = {
    timeoutMs: options.timeoutMs ?? 30_000,
    retries: options.retries ?? 2,
    userAgent: options.userAgent ?? DEFAULT_UA,
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
  };
  let last: FetchResult | null = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const result = await fetchOnce(url, opts);
    last = result;
    const transient = result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
    if (result.ok || !transient) return result;
    await sleep(500 * 2 ** attempt);
  }
  return last as FetchResult;
}

/** Fetches each URL once per run, with bounded concurrency. */
export class Fetcher {
  private readonly cache = new Map<string, Promise<FetchResult>>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly options: FetchOptions = {},
    private readonly concurrency = 4,
  ) {}

  get(url: string): Promise<FetchResult> {
    const key = toFetchableUrl(url);
    let p = this.cache.get(key);
    if (!p) {
      p = this.withSlot(() => fetchText(url, this.options));
      this.cache.set(key, p);
    }
    return p;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
