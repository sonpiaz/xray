/**
 * P3.0 — Minimal article markdown renderer for the standalone
 * `xray article <url>` command.
 *
 * The full renderer (cross-reference tables, embedded-in-thread layout,
 * polished edge-case handling) lands in P3.3. This P3.0 implementation
 * keeps the markdown shape stable so users see the same headings, just
 * without the cross-reference block.
 */
import type { ArticleSummary } from '../models/article.ts';

export function renderArticleMarkdown(summary: ArticleSummary): string {
  const lines: string[] = [];
  const body = summary.body;
  lines.push(`# Article — ${body.title}`);
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
    lines.push('## Summary');
    lines.push(summary.summary);
    lines.push('');
  } else if (summary.partial) {
    lines.push('## Summary');
    lines.push('_No summary generated — see errors below._');
    lines.push('');
  }

  if (summary.keyPoints.length > 0) {
    lines.push('## Key Points');
    for (const kp of summary.keyPoints) {
      lines.push(`- ${kp}`);
    }
    lines.push('');
  }

  if (summary.errors.length > 0) {
    lines.push('## Notes');
    for (const e of summary.errors) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
