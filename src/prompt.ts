import type { App, QuestionsFile } from './types.js';

/**
 * The system prompt is deliberately stable across apps and runs so it is served from the
 * prompt cache: it contains only the rubric and the output contract. Everything that varies
 * (app metadata, fetched policy text) goes in the user message.
 */
export function buildSystemPrompt(qs: QuestionsFile): string {
  const lines: string[] = [];
  lines.push('You maintain PrivacyMatrix, a public, cited comparison of how AI assistant apps handle user data. You will receive the official privacy policy, terms of service and help-center pages of ONE app and must answer every question below about that app, using only those documents.');
  lines.push('');
  lines.push('Scope: the consumer, individual plan (free tier unless the documents say the paid consumer tier differs materially), default settings, the global or United States version of the policy unless the vendor publishes a single worldwide policy. Regional differences (EU, UK, Korea, and so on) and business or API differences belong in the notes, not in the value.');
  lines.push('');
  lines.push('Every question is phrased so that "yes" is the more privacy-protective answer.');
  lines.push('');
  lines.push('Value definitions:');
  for (const [k, v] of Object.entries(qs.values)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  if (qs.conventions?.length) {
    lines.push('Conventions that apply to every question:');
    for (const c of qs.conventions) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('Questions (id, name, question, rubric):');
  for (const q of qs.questions) {
    lines.push(`- ${q.id} — ${q.name}. ${q.question} Rubric: ${q.rubric}`);
  }
  lines.push('');
  lines.push('Output contract:');
  lines.push('- Return exactly one entry per question id listed above, in that order.');
  lines.push('- quote: a verbatim excerpt of 12 to 400 characters copied character for character from the provided documents that justifies the value. One contiguous excerpt, no internal ellipsis, no paraphrase. The excerpt will be checked mechanically against the source; a quote that does not appear in the source turns the cell into "unknown".');
  lines.push('- evidence_url: the URL of the source section (given as "=== SOURCE: <url> ===") that contains the quote. Use only URLs that appear in the provided documents.');
  lines.push('- For value "no": quote the sentence that states the less protective practice (for example that conversations are used to train models by default).');
  lines.push('- For value "unknown": empty quote and empty evidence_url. Use unknown whenever the documents do not address the question; never infer a practice from silence, and never rely on knowledge from memory, news or other vendors.');
  lines.push('- notes: one or two sentences with the concrete mechanism (setting name, retention period, plan or region caveat, the exact scope of an opt-out). Never empty for yes, partial or no.');
  lines.push('- confidence: high for an explicit statement, medium when some interpretation was needed, low for weak evidence.');
  lines.push('- Legal text is precise: "may", "some", "in certain cases" and lists of exceptions matter. When a statement is qualified, prefer "partial" with the qualification in the notes over an unqualified yes or no. A wrong "yes" (claiming a protection that does not exist) is the worst outcome; a wrong "no" (accusing a vendor of a practice it does not have) is the second worst.');
  return lines.join('\n');
}

export interface SourceText {
  url: string;
  text: string;
  truncated: boolean;
}

export function buildUserPrompt(app: App, sources: SourceText[]): string {
  const parts: string[] = [];
  parts.push(`App under review: ${app.name} (id: ${app.id}) by ${app.vendor}. Homepage: ${app.homepage}.`);
  parts.push('');
  parts.push('Official documents follow. Each source begins with a line "=== SOURCE: <url> ===".');
  parts.push('');
  for (const s of sources) {
    parts.push(`=== SOURCE: ${s.url} ===`);
    parts.push(s.text);
    if (s.truncated) parts.push('[source truncated]');
    parts.push('');
  }
  parts.push('Answer every question for this app according to the rubric and the output contract. Return the structured result.');
  return parts.join('\n');
}
