import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DOCS_DIR = path.join(ROOT, 'docs');

const httpUrl = z.string().refine((s) => /^https?:\/\/\S+$/.test(s), 'must be an http(s) URL');
const httpUrlOrEmpty = z.string().refine((s) => s === '' || /^https?:\/\/\S+$/.test(s), 'must be empty or an http(s) URL');

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s);
}

/** Makes a URL safe as a markdown link destination: spaces and parentheses would end or break it. */
export function mdUrl(url: string): string {
  return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export const ValueSchema = z.enum(['yes', 'partial', 'no', 'unknown']);
export type Value = z.infer<typeof ValueSchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const AppSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes'),
  name: z.string().min(1),
  vendor: z.string().min(1),
  homepage: httpUrl,
  repo: httpUrl.nullable(),
  sources: z.array(httpUrl).min(1),
});
export type App = z.infer<typeof AppSchema>;

export const AppsFileSchema = z.object({ apps: z.array(AppSchema).min(1) });

export const QuestionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case id'),
  group: z.string().min(1),
  name: z.string().min(1),
  question: z.string().min(1),
  rubric: z.string().min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionsFileSchema = z.object({
  values: z.record(z.string(), z.string()),
  conventions: z.array(z.string()).optional(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
  questions: z.array(QuestionSchema).min(1),
});
export type QuestionsFile = z.infer<typeof QuestionsFileSchema>;

export const CellSchema = z.object({
  app: z.string(),
  question: z.string(),
  value: ValueSchema,
  quote: z.string(),
  evidence_url: httpUrlOrEmpty,
  notes: z.string(),
  confidence: ConfidenceSchema,
  verified: z.boolean(),
  verified_at: z.string(),
  /** Set by the weekly check when the quote was not found at its URL; the cell is demoted only if it is still missing a week later. */
  quote_missing_since: z.string().optional(),
});
export type Cell = z.infer<typeof CellSchema>;

export const MatrixFileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  cells: z.array(CellSchema),
});
export type MatrixFile = z.infer<typeof MatrixFileSchema>;

export const ChangeSchema = z.object({
  app: z.string(),
  question: z.string(),
  from: ValueSchema,
  to: ValueSchema,
  quote: z.string(),
  evidence_url: httpUrlOrEmpty,
  notes: z.string(),
});
export type Change = z.infer<typeof ChangeSchema>;

/** A quote that was not found at its URL in a run; the cell is kept until it has been missing for a week. */
export const PendingQuoteSchema = z.object({
  app: z.string(),
  question: z.string(),
  evidence_url: z.string(),
  since: z.string(),
});
export type PendingQuote = z.infer<typeof PendingQuoteSchema>;

export const ChangesFileSchema = z.object({
  run_at: z.string(),
  model: z.string(),
  changes: z.array(ChangeSchema),
  // Absent in files written before 2026-09-23, which is why it defaults rather than being required.
  pending: z.array(PendingQuoteSchema).default([]),
  stats: z.object({
    apps_checked: z.number(),
    apps_failed: z.array(z.string()),
    cells_total: z.number(),
    cells_verified: z.number(),
    cells_unknown: z.number(),
  }),
});
export type ChangesFile = z.infer<typeof ChangesFileSchema>;

export function cellKey(app: string, question: string): string {
  return `${app}|${question}`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadApps(): App[] {
  return AppsFileSchema.parse(readJson(path.join(DATA_DIR, 'apps.json'))).apps;
}

export function loadQuestions(): QuestionsFile {
  const file = QuestionsFileSchema.parse(readJson(path.join(DATA_DIR, 'questions.json')));
  const groupIds = new Set(file.groups.map((g) => g.id));
  for (const c of file.questions) {
    if (!groupIds.has(c.group)) throw new Error(`question ${c.id} references unknown group ${c.group}`);
  }
  const ids = new Set<string>();
  for (const c of file.questions) {
    if (ids.has(c.id)) throw new Error(`duplicate question id ${c.id}`);
    ids.add(c.id);
  }
  return file;
}

export function loadMatrix(): MatrixFile {
  const file = path.join(DATA_DIR, 'matrix.json');
  if (!existsSync(file)) return { version: 1, generated_at: '', cells: [] };
  return MatrixFileSchema.parse(readJson(file));
}

export function loadChanges(): ChangesFile | null {
  const file = path.join(DATA_DIR, 'changes.json');
  if (!existsSync(file)) return null;
  return ChangesFileSchema.parse(readJson(file));
}

export function saveJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Sort cells in canonical order (app order, then question order) so diffs stay stable. */
export function sortCells(cells: Cell[], apps: App[], questions: Question[]): Cell[] {
  const appOrder = new Map(apps.map((a, i) => [a.id, i]));
  const questionOrder = new Map(questions.map((c, i) => [c.id, i]));
  return [...cells].sort((a, b) => {
    const da = (appOrder.get(a.app) ?? 1e9) - (appOrder.get(b.app) ?? 1e9);
    if (da !== 0) return da;
    return (questionOrder.get(a.question) ?? 1e9) - (questionOrder.get(b.question) ?? 1e9);
  });
}
