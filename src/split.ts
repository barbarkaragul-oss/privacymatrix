/**
 * Splitting a run's result between main and a pull request: dates and missing-quote flags go to
 * main at once, value changes (a demotion, or a re-derived value) wait in a pull request for a
 * human. Used by the residential task and by the weekly workflow (scripts/split-value-changes.ts).
 */

export interface SplitCell {
  app: string;
  question: string;
  [key: string]: unknown;
}
export interface SplitMatrix {
  cells: SplitCell[];
  [key: string]: unknown;
}

const key = (c: { app: string; question: string }): string => `${c.app}|${c.question}`;

/**
 * The matrix that goes to main when a run also changes values: the run's result, except that every
 * changed cell keeps its version from before the run (still flagged, so the next run demotes it
 * again until the pull request is merged or the quote is fixed). A changed cell that did not exist
 * before goes to main as unknown, so its new value too waits for the pull request.
 */
export function withoutDemotions(result: SplitMatrix, before: SplitMatrix, demoted: Array<{ app: string; question: string }>): SplitMatrix {
  const demotedKeys = new Set(demoted.map(key));
  const beforeByKey = new Map(before.cells.map((c) => [key(c), c]));
  const placeholder = (c: SplitCell): SplitCell => ({ app: c.app, question: c.question, value: 'unknown', quote: '', evidence_url: '', notes: '', confidence: 'low', verified: false, verified_at: '' });
  return { ...result, cells: result.cells.map((c) => (demotedKeys.has(key(c)) ? (beforeByKey.get(key(c)) ?? placeholder(c)) : c)) };
}
