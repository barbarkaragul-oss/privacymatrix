import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { archiveRawUrl, captureDate, fetchCapture, landedCapture, latestCapture, type Capture } from './archive.js';
import type { FetchResult } from './fetch.js';

/** Only timestamps are cached, never response text or an arbitrary redirect address. */
export class ArchiveReader {
  private captures: Record<string, string> = Object.create(null) as Record<string, string>;
  constructor(private file: string) {
    try {
      const stored: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [url, timestamp] of Object.entries(stored)) {
          if (/^https?:\/\//.test(url) && typeof timestamp === 'string' && captureDate(timestamp)) this.captures[url] = timestamp;
        }
      }
    } catch { /* Missing or damaged cache is a cache miss, never evidence. */ }
  }

  async read(url: string, usable: (text: string, truncated: boolean) => string | null,
    deps: { lookup?: typeof latestCapture; fetch?: typeof fetchCapture; onResponse?: (capture: Capture, response: FetchResult) => void } = {},
  ): Promise<{ response: FetchResult; capture: Capture; cached: boolean } | { error: string }> {
    const latest = await (deps.lookup ?? latestCapture)(url);
    if (latest === null) return { error: 'no Internet Archive capture' };
    const known = this.captures[url];
    const candidates: Capture[] = 'error' in latest ? [] : [latest];
    if (known && !candidates.some(c => c.timestamp === known)) candidates.push({ timestamp: known, rawUrl: archiveRawUrl(known, url) });
    // Every step's reason is kept: the last one alone would hide a failed lookup behind a later miss.
    const errors: string[] = 'error' in latest ? [`Internet Archive lookup failed: ${latest.error}`] : [];
    for (const candidate of candidates) {
      const response = await (deps.fetch ?? fetchCapture)(candidate);
      deps.onResponse?.(candidate, response);
      const problem = !response.ok ? (response.error ?? `HTTP ${response.status}`) : usable(response.text, response.truncated);
      if (problem) { errors.push(`Internet Archive capture ${candidate.timestamp} unusable: ${problem}`); continue; }
      const landed = landedCapture(response.finalUrl, url);
      if ('error' in landed) { errors.push(landed.error); continue; }
      this.captures[url] = landed.timestamp;
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.captures, null, 2) + '\n', 'utf8');
      } catch { /* Cache persistence must not invalidate a successful read. */ }
      return { response, capture: { timestamp: landed.timestamp, rawUrl: archiveRawUrl(landed.timestamp, url) }, cached: 'error' in latest || candidate.timestamp !== latest.timestamp };
    }
    return { error: errors.join('; ') || 'no usable Internet Archive capture' };
  }
}
