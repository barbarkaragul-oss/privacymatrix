/**
 * Generates everything derived from data/:
 *   - the matrix tables inside README.md (between <!-- matrix:start --> and <!-- matrix:end -->)
 *   - docs/index.html (static site, GitHub Pages) with the data embedded
 *   - docs/matrix.json and docs/changes.json for anyone who wants the raw data
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DOCS_DIR, ROOT, cellKey, isHttpUrl, loadApps, loadQuestions, loadChanges, loadMatrix, mdUrl, type App, type Question, type Cell, type Value, type ChangesFile } from './types.js';

const ICON: Record<Value, string> = { yes: '✅', partial: '🟡', no: '❌', unknown: '❔' };
const LABEL: Record<Value, string> = { yes: 'yes', partial: 'partial', no: 'no', unknown: 'unknown' };

/**
 * Link title for a README cell (shown as a tooltip, so markdown does not render there): markdown
 * links and emphasis are reduced to their text, double quotes would end the title and a backslash
 * would escape its closing quote. The stored quote itself stays verbatim.
 */
export function mdTitle(s: string, max = 180): string {
  const t = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\\/g, '/')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function replaceBetween(source: string, start: string, end: string, body: string): string {
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  if (i < 0 || j < 0 || j < i) throw new Error(`README markers ${start} / ${end} not found or out of order`);
  return source.slice(0, i + start.length) + '\n' + body.trim() + '\n' + source.slice(j);
}

/** "[archive 2026-09-21] " / "[manual 2026-09-23] " for cells not verified by a live read, else "". */
function provenancePrefix(cell: Cell): string {
  return cell.verified && cell.verified_via ? `[${cell.verified_via} ${cell.verified_at}] ` : '';
}

export function renderMatrixMarkdown(apps: App[], qs: ReturnType<typeof loadQuestions>, cells: Cell[]): string {
  const byKey = new Map(cells.map((c) => [cellKey(c.app, c.question), c]));
  const out: string[] = [];
  const provenanceNote = cells.some((c) => c.verified && c.verified_via)
    ? ' A tooltip that starts with [manual] was read by a maintainer from a residential connection, and one that starts with [archive] was confirmed from an Internet Archive capture, because the vendor blocks automated checks from cloud servers.'
    : '';
  out.push(`Legend: ✅ yes · 🟡 partial · ❌ no · ❔ unknown. Yes is always the more privacy-protective answer; the cells describe what the documents say, not what vendors do. Not legal advice. On desktop, hover a cell for the quote (for ❌ cells, the explanation); click it to open the source.${provenanceNote} On mobile, use the [interactive matrix](https://barbarkaragul-oss.github.io/privacymatrix/).`);
  out.push('');
  for (const group of qs.groups) {
    const groupQuestions = qs.questions.filter((c) => c.group === group.id);
    if (groupQuestions.length === 0) continue;
    out.push(`### ${group.name}`);
    out.push('');
    out.push(`| Question | ${apps.map((a) => a.name).join(' | ')} |`);
    out.push(`|---|${apps.map(() => ':---:').join('|')}|`);
    for (const cap of groupQuestions) {
      const row = apps.map((a) => {
        const cell = byKey.get(cellKey(a.id, cap.id));
        if (!cell || cell.value === 'unknown' || !isHttpUrl(cell.evidence_url)) return ICON.unknown;
        // A "no" is a claim about absence: its quote shows the closest documented feature, which reads
        // as a contradiction on its own, so the tooltip carries the explanation instead.
        const title = mdTitle(provenancePrefix(cell) + (cell.value === 'no' ? cell.notes || cell.quote : cell.quote || cell.notes || LABEL[cell.value]));
        return `[${ICON[cell.value]}](${mdUrl(cell.evidence_url)} "${title}")`;
      });
      out.push(`| **${cap.name}** | ${row.join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function renderStats(apps: App[], qs: Question[], cells: Cell[]): string {
  const verified = cells.filter((c) => c.verified).length;
  const viaArchive = cells.filter((c) => c.verified && c.verified_via === 'archive').length;
  const dates = cells.map((c) => c.verified_at).filter(Boolean).sort();
  const latest = dates.length ? dates[dates.length - 1] : 'never';
  const counts = { yes: 0, partial: 0, no: 0, unknown: 0 };
  for (const c of cells) counts[c.value]++;
  const archived = viaArchive ? ` (${viaArchive} via archived copies)` : '';
  return `**${apps.length} apps × ${qs.length} questions · ${verified}/${cells.length} cells verified against their source${archived} · last verification ${latest}** · ✅ ${counts.yes} · 🟡 ${counts.partial} · ❌ ${counts.no} · ❔ ${counts.unknown}`;
}

/**
 * README section listing the apps whose sources block the checker from cloud servers, and how each
 * one's cells were last verified. Empty when no app is marked blocked_from_cloud.
 */
export function renderBlockedSources(apps: App[], cells: Cell[]): string {
  const blocked = apps.filter((a) => a.blocked_from_cloud);
  if (blocked.length === 0) return '';
  const lines = [
    '### Sources the checker cannot reach',
    '',
    "These vendors answer HTTP 403 to every request from a cloud IP range, including GitHub's runners and our own server, although their robots.txt permits the pages. Their pages can only be read live from a residential connection; from the cloud, a quote can only be confirmed against the most recent Internet Archive capture of the vendor's page, which never demotes a cell. Each cell says how it was last verified, and the dates below show how fresh each row is.",
    '',
  ];
  for (const a of blocked) {
    const own = cells.filter((c) => c.app === a.id && c.verified);
    const manual = own.filter((c) => c.verified_via === 'manual').length;
    const archive = own.filter((c) => c.verified_via === 'archive').length;
    const live = own.length - manual - archive;
    const hosts = [...new Set(a.sources.map((s) => new URL(s).hostname))].join(', ');
    const dates = own.map((c) => c.verified_at).filter(Boolean).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const when = !first ? 'never verified' : first === last ? `verified ${last}` : `verified between ${first} and ${last}`;
    const how = [live ? `${live} read live` : '', manual ? `${manual} read by hand` : '', archive ? `${archive} confirmed from archive captures` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`- **${a.name}** (${hosts}): ${own.length} verified cells${how ? ` — ${how}` : ''}; ${when}.`);
  }
  return lines.join('\n');
}

export function renderRecentChanges(changes: ChangesFile | null, apps: App[], qs: Question[]): string {
  if (!changes) return '_The weekly re-verification has not run yet. Results appear here after the first run._';
  // The line must not claim more than the run knows: a run can change no value and still have found
  // quotes missing from their page, which are kept for a week before they demote the cell.
  // Nor may it claim a quote was found at its source when the page could not be read live: those
  // are either unreachable or confirmed only in an Internet Archive capture.
  const pending = changes.pending.length;
  const viaArchive = changes.stats.cells_verified_via_archive;
  if (changes.changes.length === 0) {
    const archived = viaArchive ? `, and ${viaArchive} cell${viaArchive === 1 ? ' rests' : 's rest'} on Internet Archive captures of pages that block the checker` : '';
    const missing =
      pending === 0
        ? `no quote was missing from any page the checker could read${archived}`
        : `${pending} quote${pending === 1 ? '' : 's'} not found at their source and pending a human look (see [changes.md](data/changes.md))`;
    return `_Last run ${changes.run_at.slice(0, 10)}: no value changed, ${missing}._`;
  }
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const questionName = new Map(qs.map((c) => [c.id, c.name]));
  const lines = changes.changes.slice(0, 15).map((ch) => {
    const src = isHttpUrl(ch.evidence_url) ? ` ([source](${mdUrl(ch.evidence_url)}))` : '';
    return `- **${appName.get(ch.app) ?? ch.app}** · ${questionName.get(ch.question) ?? ch.question}: ${LABEL[ch.from]} → **${LABEL[ch.to]}**${src}`;
  });
  const more = changes.changes.length > 15 ? `\n- …and ${changes.changes.length - 15} more in [changes.json](data/changes.json)` : '';
  return `Last run ${changes.run_at.slice(0, 10)}:\n\n${lines.join('\n')}${more}`;
}

/** Embeds the JSON payload and repository URL into the site template. Uses function replacers so `$` sequences in data are literal. */
export function embedData(template: string, payload: unknown, repoUrl: string): string {
  const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const safeRepo = isHttpUrl(repoUrl) ? repoUrl.replace(/["<>]/g, '') : '';
  return template.replace('/*__PRIVACYMATRIX_DATA__*/', () => `window.PRIVACYMATRIX = ${json};`).replace('__REPO_URL__', () => safeRepo);
}

export function generateAll(): void {
  const apps = loadApps();
  const qs = loadQuestions();
  const matrix = loadMatrix();
  const changes = loadChanges();

  const readmePath = path.join(ROOT, 'README.md');
  let readme = readFileSync(readmePath, 'utf8');
  readme = replaceBetween(readme, '<!-- stats:start -->', '<!-- stats:end -->', renderStats(apps, qs.questions, matrix.cells));
  readme = replaceBetween(readme, '<!-- matrix:start -->', '<!-- matrix:end -->', renderMatrixMarkdown(apps, qs, matrix.cells));
  readme = replaceBetween(readme, '<!-- changes:start -->', '<!-- changes:end -->', renderRecentChanges(changes, apps, qs.questions));
  readme = replaceBetween(readme, '<!-- blocked:start -->', '<!-- blocked:end -->', renderBlockedSources(apps, matrix.cells));
  writeFileSync(readmePath, readme, 'utf8');

  mkdirSync(DOCS_DIR, { recursive: true });
  const template = readFileSync(path.join(ROOT, 'src', 'site.template.html'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { repository?: { url?: string } };
  const repoUrl = (pkg.repository?.url ?? '').replace(/\.git$/, '');
  const payload = {
    generated_at: matrix.generated_at,
    apps,
    groups: qs.groups,
    questions: qs.questions,
    values: qs.values,
    conventions: qs.conventions ?? [],
    cells: matrix.cells,
    changes: changes ?? null,
  };
  writeFileSync(path.join(DOCS_DIR, 'index.html'), embedData(template, payload, repoUrl), 'utf8');
  writeFileSync(path.join(DOCS_DIR, 'matrix.json'), JSON.stringify({ ...matrix, apps, questions: qs.questions }, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(DOCS_DIR, 'changes.json'), JSON.stringify(changes ?? { run_at: '', model: '', changes: [], stats: null }, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '', 'utf8');
  console.log(`Generated README.md tables and docs/ site (${matrix.cells.length} cells, ${apps.length} apps, ${qs.questions.length} questions)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'generate.ts'));
if (isMain) {
  try {
    generateAll();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
