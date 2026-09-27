import type { Cell } from './types.js';

export const FRESHNESS_POLICY = { warning_after_days: 14, stale_after_days: 28 } as const;
export interface Freshness {
  as_of: string;
  status: 'recent' | 'unconfirmed' | 'stale' | 'unknown';
  age_days: number | null;
}

/** Freshness describes the age of evidence, never a change to the policy claim. */
export function freshness(cell: Pick<Cell, 'verified' | 'verified_at'>, asOf: string): Freshness {
  const day = asOf.slice(0, 10);
  const date = cell.verified_at;
  const stamp = Date.parse(date);
  const age = Math.floor((Date.parse(day) - stamp) / 86_400_000);
  if (!cell.verified || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(age) || age < 0 || new Date(stamp).toISOString().slice(0, 10) !== date) {
    return { as_of: day, status: 'unknown', age_days: null };
  }
  return { as_of: day, status: age >= FRESHNESS_POLICY.stale_after_days ? 'stale' : age >= FRESHNESS_POLICY.warning_after_days ? 'unconfirmed' : 'recent', age_days: age };
}
