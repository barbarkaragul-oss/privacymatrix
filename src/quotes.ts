/**
 * Quote verification.
 *
 * A cell in the matrix is only trusted if its quote can be found in the text of its
 * evidence URL. Documentation pages are fetched as HTML or markdown, so matching has to
 * tolerate formatting differences (smart quotes, markdown emphasis, collapsed whitespace)
 * without tolerating changes in wording. Three passes, strictest first:
 *   1. exact substring
 *   2. normalized substring (unicode punctuation folded, markdown syntax removed, case-insensitive)
 *   3. compact substring (only letters and digits kept) — catches punctuation-only differences
 */

export type MatchMethod = 'exact' | 'normalized' | 'compact' | 'none';

export interface QuoteMatch {
  found: boolean;
  method: MatchMethod;
}

export interface PreparedText {
  raw: string;
  normalized: string;
  compact: string;
}

export const MIN_QUOTE_LENGTH = 12;
export const MAX_QUOTE_LENGTH = 400;

export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  -​  　﻿]/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function compactText(input: string): string {
  return normalizeText(input).replace(/[^a-z0-9]+/g, '');
}

export function prepareText(raw: string): PreparedText {
  const normalized = normalizeText(raw);
  return { raw, normalized, compact: normalized.replace(/[^a-z0-9]+/g, '') };
}

export function findQuote(haystack: PreparedText | string, quote: string): QuoteMatch {
  const prepared = typeof haystack === 'string' ? prepareText(haystack) : haystack;
  const q = quote.trim();
  if (q.length < MIN_QUOTE_LENGTH) return { found: false, method: 'none' };

  if (prepared.raw.includes(q)) return { found: true, method: 'exact' };

  const nq = normalizeText(q);
  if (nq.length >= MIN_QUOTE_LENGTH && prepared.normalized.includes(nq)) {
    return { found: true, method: 'normalized' };
  }

  // The compact pass drops all punctuation, so it must not be used for quotes that contain an
  // ellipsis in any spelling ("...", ". . .", "..", "…"): "A ... B" would otherwise match a page
  // where A and B are adjacent sentences.
  if (!/\.\s*\.|…/.test(q)) {
    const cq = compactText(q);
    if (cq.length >= MIN_QUOTE_LENGTH && prepared.compact.includes(cq)) {
      return { found: true, method: 'compact' };
    }
  }

  return { found: false, method: 'none' };
}

/** Validation of a quote independent of any page: length and sanity. */
export function quoteProblems(quote: string): string[] {
  const problems: string[] = [];
  const q = quote.trim();
  if (q.length < MIN_QUOTE_LENGTH) problems.push(`quote shorter than ${MIN_QUOTE_LENGTH} characters`);
  if (q.length > MAX_QUOTE_LENGTH) problems.push(`quote longer than ${MAX_QUOTE_LENGTH} characters`);
  if (q.includes('�')) problems.push('quote contains a replacement character (U+FFFD); copy it from the page again');
  return problems;
}
