/**
 * Internet Archive fallback for sources that block the checker.
 *
 * Some vendors answer HTTP 403 to every data-centre IP range, so a page can be unreadable from
 * GitHub's runners while it is public and permitted by the vendor's own robots.txt. For those pages
 * the checker looks at the most recent Wayback Machine capture instead. A capture is never a
 * source: no cell cites one. It is used for one thing only, to confirm that the quoted sentence is
 * still on the vendor's page as of the capture date. It can never demote a cell, because an old
 * capture cannot show that a sentence is missing from the live page today.
 */
import { fetchText, type FetchResult } from './fetch.js';

export interface Capture {
  /** Wayback Machine timestamp, YYYYMMDDhhmmss. */
  timestamp: string;
  /** The capture in raw mode (id_): the page as archived, without the Wayback toolbar or rewritten links. */
  rawUrl: string;
}

/** https://web.archive.org/web/<ts>id_/<url> — the id_ flag returns the archived bytes unmodified. */
export function archiveRawUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

/** The human-facing capture page, for linking from the site. */
export function archiveViewUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}/${url}`;
}

/** 20260921065036 -> 2026-09-21; anything that is not a 14-digit timestamp -> null. */
export function captureDate(timestamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(timestamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Reads the response of https://archive.org/wayback/available?url=... and returns the closest
 * capture, or null when there is none or it was not a 200. Pure, so it can be tested without network.
 */
export function parseAvailability(json: unknown, url: string): Capture | null {
  const closest = (json as { archived_snapshots?: { closest?: { timestamp?: unknown; status?: unknown; available?: unknown } } } | null)
    ?.archived_snapshots?.closest;
  if (!closest || closest.available === false) return null;
  if (String(closest.status) !== '200') return null;
  const timestamp = typeof closest.timestamp === 'string' ? closest.timestamp : '';
  if (!captureDate(timestamp)) return null;
  return { timestamp, rawUrl: archiveRawUrl(timestamp, url) };
}

/**
 * Reads the response of the CDX API asked for the newest 200 capture (output=json, fl=timestamp,statuscode,
 * filter=statuscode:200, limit=-1): a header row, then at most one row. Returns that capture, or null
 * when there is none. Pure, so it can be tested without network.
 */
export function parseCdx(json: unknown, url: string): Capture | null {
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[0])) return null;
  const header = json[0] as unknown[];
  const ti = header.indexOf('timestamp');
  const si = header.indexOf('statuscode');
  if (ti < 0) return null;
  for (let i = json.length - 1; i >= 1; i--) {
    const row = json[i];
    if (!Array.isArray(row)) continue;
    const timestamp = typeof row[ti] === 'string' ? row[ti] : '';
    if (si >= 0 && String(row[si]) !== '200') continue;
    if (captureDate(timestamp)) return { timestamp, rawUrl: archiveRawUrl(timestamp, url) };
  }
  return null;
}

async function getJson(endpoint: string, timeoutMs: number): Promise<unknown | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) return { error: `archive.org answered HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message) : String(err);
    return { error: message };
  } finally {
    clearTimeout(timer);
  }
}

function isError(x: unknown): x is { error: string } {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as { error?: unknown }).error === 'string';
}

/**
 * The most recent 200 capture of url; null when the archive has none; { error } when the archive
 * itself could not be asked (outage, timeout, a non-JSON answer), which must not be reported as
 * "no capture".
 *
 * Asked through the CDX API, filtered to 200 captures. The availability API answers with the single
 * capture closest to now whatever its status, so a later redirect or empty capture (a 204 for
 * openai.com's privacy policy on 24 September 2026) hid 200 captures from days before. It is still
 * asked when the CDX API cannot be, without a timestamp parameter: with one, it was observed to
 * return an empty result for pages that do have recent captures.
 */
export async function latestCapture(url: string, timeoutMs = 20_000): Promise<Capture | null | { error: string }> {
  const cdx = await getJson(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=-1`, timeoutMs);
  if (!isError(cdx)) return parseCdx(cdx, url);
  const available = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, timeoutMs);
  if (isError(available)) return { error: `${cdx.error}; availability API: ${available.error}` };
  return parseAvailability(available, url);
}

/** Fetches the raw capture as text, through the same HTML-to-text path as a live page. */
export function fetchCapture(capture: Capture): Promise<FetchResult> {
  return fetchText(capture.rawUrl, { timeoutMs: 45_000, retries: 1 });
}
