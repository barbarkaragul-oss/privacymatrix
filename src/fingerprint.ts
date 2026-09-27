/**
 * The fingerprint of a maintainer's reading: which cell, claim, quote, page and day it covers.
 *
 * When a maintainer confirms a quote on a page the checker cannot read (the reading page, or
 * `npm run attest`), the cell gets manual_fingerprint = fingerprint(cell). The pull-request gate
 * accepts the reading only while the fingerprint still matches the cell, so a later change of the
 * value, quote, URL or date, in the same pull request or another, needs a new reading.
 *
 * It is an integrity check, not a credential: anyone can compute it. Who may vouch for a reading
 * is decided separately, from GitHub's record of the pull request's author (see unverifiedChanges
 * in src/check.ts).
 */
import { createHash } from 'node:crypto';
import type { Cell } from './types.js';

export type FingerprintInput = Pick<Cell, 'app' | 'question' | 'value' | 'quote' | 'evidence_url' | 'verified_at'>;

/** First 32 hex characters of SHA-256 over a JSON array (unambiguous even when a quote or URL holds a separator). */
export function fingerprint(cell: FingerprintInput): string {
  const input = JSON.stringify([cell.app, cell.question, cell.value, cell.quote.trim(), cell.evidence_url.trim(), cell.verified_at]);
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}
