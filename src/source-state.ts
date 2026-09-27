// Shared with the plain-Node residential launcher: runtime imports must stay in node: modules.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

interface Evidence { app: string; question: string; value: string; quote: string; evidence_url: string }
interface Reading { evidence_url: string; status: string; method: string; problems: string[] }
export interface SourceStatus {
  evidence: string;
  last_attempt_at: string;
  last_success_at?: string;
  next_attempt_at: string;
  status: 'confirmed' | 'quote_missing' | 'requote' | 'unreachable';
  requote: number;
  unreachable: number;
  error?: string;
}
export interface SourceState { version: 1; sources: Record<string, SourceStatus> }
export const EMPTY_SOURCE_STATE = (): SourceState => ({ version: 1, sources: {} });

export function sourceSignatures(cells: Evidence[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const c of cells) {
    if (!c.quote || !c.evidence_url) continue;
    const entries = grouped.get(c.evidence_url) ?? [];
    entries.push(JSON.stringify([c.app, c.question, c.value, c.quote]));
    grouped.set(c.evidence_url, entries);
  }
  return new Map([...grouped].map(([url, entries]) => [url, createHash('sha256').update(JSON.stringify(entries.sort())).digest('hex')]));
}

export function loadSourceState(file: string): SourceState {
  try {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (data?.version !== 1 || !data.sources || typeof data.sources !== 'object' || Array.isArray(data.sources)) return EMPTY_SOURCE_STATE();
    const sources: Record<string, SourceStatus> = {};
    for (const [url, v] of Object.entries(data.sources)) {
      const s = v as SourceStatus;
      if (/^https?:\/\//.test(url) && s && typeof s.evidence === 'string' &&
          Number.isFinite(Date.parse(s.last_attempt_at)) && Number.isFinite(Date.parse(s.next_attempt_at)) &&
          ['confirmed', 'quote_missing', 'requote', 'unreachable'].includes(s.status)) sources[url] = s;
    }
    return { version: 1, sources };
  } catch { return EMPTY_SOURCE_STATE(); }
}

export function dueSources(signatures: Map<string, string>, state: SourceState, at: string): Set<string> {
  const now = Date.parse(at);
  return new Set([...signatures].filter(([url, signature]) => {
    const s = state.sources[url];
    const next = s ? Date.parse(s.next_attempt_at) : NaN;
    // An unresolved missing quote must accompany every partial run: otherwise a new demotion
    // could replace the bot PR while silently dropping its older, still valid demotions.
    return !s || s.status === 'quote_missing' || s.evidence !== signature || !Number.isFinite(next) || !Number.isFinite(now) || next <= now;
  }).map(([url]) => url));
}

/** Unreachable sources retry the next day; a completed reading is due again after six days. */
export function updateSourceState(previous: SourceState, signatures: Map<string, string>, readings: Reading[], at: string): SourceState {
  const sources = Object.fromEntries(Object.entries(previous.sources).filter(([url]) => signatures.has(url)));
  for (const [url, evidence] of signatures) {
    const own = readings.filter(r => r.evidence_url === url && r.status !== 'skipped');
    if (!own.length) continue;
    const unreadable = own.some(r => r.status === 'error' && r.method !== 'compact');
    const status: SourceStatus['status'] = unreadable ? 'unreachable' : own.some(r => r.status === 'fail') ? 'quote_missing' : own.some(r => r.method === 'compact') ? 'requote' : 'confirmed';
    sources[url] = {
      evidence, last_attempt_at: at,
      ...(unreadable ? (sources[url]?.last_success_at ? { last_success_at: sources[url]!.last_success_at } : {}) : { last_success_at: at }),
      next_attempt_at: new Date(Date.parse(at.slice(0, 10)) + (unreadable ? 1 : 6) * 86_400_000).toISOString(),
      status,
      requote: own.filter(r => r.method === 'compact').length,
      unreachable: own.filter(r => r.status === 'error' && r.method !== 'compact').length,
      ...(unreadable ? { error: [...new Set(own.flatMap(r => r.problems))].join('; ') } : {}),
    };
  }
  return { version: 1, sources };
}

export function saveSourceState(file: string, state: SourceState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(temporary, file);
}
