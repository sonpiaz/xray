/**
 * P3.0 — Minimal article markdown renderer for the standalone
 * `xray article <url>` command.
 *
 * P3.2 — Adds cross-reference table rendering and an `embedded` mode
 * for when the article is rendered inside a thread report (lighter
 * `###` heading vs the standalone `#` heading).
 *
 * The full renderer polish (long-article truncation, edge cases) lands
 * in P3.3 — this version covers the spec acceptance criteria for P3.2.
 */
import type { ArticleSummary, CrossReference } from '../models/article.ts';

export type RenderArticleOptions = {
  /** 'standalone' (default) — top-level `#` heading. 'embedded' — `###`. */
  mode?: 'standalone' | 'embedded';
};

/** Single-line clamp helper — keeps wide-character clamps consistent. */
function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Escape `|` in markdown table cells so the column boundaries stay
 * intact even when a passage contains a literal pipe.
 */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Render a cross-reference table sorted by confidence desc, capped at
 * MAX_CROSS_REFERENCES rows (8 — matches the prompt cap). Exported for
 * unit tests so the table format can be pinned down without round-
 * tripping through the full renderer.
 */
export function renderCrossReferenceTable(refs: CrossReference[]): string[] {
  if (refs.length === 0) return [];
  const sorted = [...refs].sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const out: string[] = [];
  out.push('| Tweet Claim | Article Passage | Relationship | Confidence |');
  out.push('|---|---|---|---|');
  for (const r of sorted) {
    const claim = tableCell(clamp(r.tweetClaim, 80));
    const passage = tableCell(clamp(r.articlePassage, 120));
    const conf = r.confidence.toFixed(2);
    out.push(`| ${claim} | ${passage} | ${r.relationship} | ${conf} |`);
  }
  return out;
}

export function renderArticleMarkdown(
  summary: ArticleSummary,
  opts: RenderArticleOptions = {},
): string {
  const mode = opts.mode ?? 'standalone';
  const headingPrefix = mode === 'embedded' ? '###' : '#';
  // For embedded mode, sub-sections shift from `##` to `####` so they
  // nest under whatever section heading the parent renderer placed.
  const subHeading = mode === 'embedded' ? '####' : '##';

  const lines: string[] = [];
  const body = summary.body;
  const titleLabel = mode === 'embedded' ? `Article — ${body.title}` : `Article — ${body.title}`;
  lines.push(`${headingPrefix} ${titleLabel}`);
  lines.push('');
  lines.push(`**Source:** ${summary.url}`);
  const meta: string[] = [];
  if (body.byline) meta.push(`Author: ${body.byline}`);
  if (body.publishedAt) meta.push(`Published: ${body.publishedAt}`);
  meta.push(`Words: ${body.wordCount}`);
  if (typeof summary.estimatedCostUsd === 'number') {
    meta.push(`Cost: $${summary.estimatedCostUsd.toFixed(4)}`);
  }
  lines.push(meta.join(' · '));
  lines.push('');

  if (summary.summary) {
    lines.push(`${subHeading} Summary`);
    lines.push(summary.summary);
    lines.push('');
  } else if (summary.partial) {
    lines.push(`${subHeading} Summary`);
    lines.push('_No summary generated — see errors below._');
    lines.push('');
  }

  if (summary.keyPoints.length > 0) {
    lines.push(`${subHeading} Key Points`);
    for (const kp of summary.keyPoints) {
      lines.push(`- ${kp}`);
    }
    lines.push('');
  }

  // P3.2 — Cross-reference table. Rendered only when crossReferences is
  // present + nonempty (the orchestrator emits `[]` in standalone mode
  // or when no tweet context was supplied).
  const refs = summary.crossReferences;
  if (refs && refs.length > 0) {
    lines.push(`${subHeading} Cross-References (tweet → article)`);
    for (const row of renderCrossReferenceTable(refs)) lines.push(row);
    lines.push('');
  }

  if (summary.errors.length > 0) {
    lines.push(`${subHeading} Notes`);
    for (const e of summary.errors) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
