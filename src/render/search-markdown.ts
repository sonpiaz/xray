/**
 * P4.1 — Markdown renderer for `SearchResponse`.
 *
 * Two layouts depending on `reranked`:
 *   - reranked=false → table columns: # | Score | Type | Snippet | Source
 *   - reranked=true  → adds a `Rerank` column showing the LLM score next
 *                      to the semantic similarity.
 *
 * Snippets are clamped to ~80 chars inside the table so the markdown
 * stays readable in narrow renderers. The full untruncated snippets
 * (already capped at 200 chars by the orchestrator) appear in a
 * "Full snippets" section below — useful when running with `-o file.md`.
 *
 * Empty-results case: render a hint to embed the cache or lower the
 * threshold. Matches the agent-friendly output style of the other
 * P3 renderers — no "0 results" header silence.
 */
import type { SearchResponse, SearchResult } from '../models/search.ts';

const TABLE_SNIPPET_CHARS = 80;

function fmtScore(n: number): string {
  // Two decimal places, drop trailing zeros once we have at least one digit.
  // Negative similarities print as "-0.12"; positives drop the sign.
  return n.toFixed(2);
}

function fmtCost(cost: number): string {
  if (cost === 0) return '$0';
  // 3 fractional digits so $0.005 prints intact.
  return `$${cost.toFixed(3)}`;
}

/**
 * Escape `|` in markdown table cells so the column boundaries stay
 * intact even when a snippet contains a literal pipe.
 */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function renderSource(r: SearchResult): string {
  const handle = r.source.authorHandle ? `@${r.source.authorHandle}` : '';
  if (r.source.url) {
    const linkLabel = r.entityType === 'article-passage' ? 'article' : 'tweet';
    if (handle) return `${handle} / [${linkLabel}](${r.source.url})`;
    return `[${linkLabel}](${r.source.url})`;
  }
  return handle || '—';
}

export function renderSearchMarkdown(resp: SearchResponse): string {
  const out: string[] = [];

  out.push(`# Search Results — "${resp.query}"`);
  out.push('');

  const metaBits: string[] = [];
  metaBits.push(
    `**Found:** ${resp.results.length} ${resp.results.length === 1 ? 'result' : 'results'}`,
  );
  metaBits.push(`**Reranked:** ${resp.reranked ? 'yes' : 'no'}`);
  metaBits.push(`**Cost:** ${fmtCost(resp.estimatedCostUsd)}`);
  if (resp.typeFilter) metaBits.push(`**Type:** ${resp.typeFilter}`);
  if (resp.threshold !== undefined) metaBits.push(`**Threshold:** ${fmtScore(resp.threshold)}`);
  out.push(metaBits.join(' · '));
  out.push('');

  if (resp.results.length === 0) {
    out.push(
      'No matches above threshold. Try `xray cache embed` first to populate the index, or lower `--threshold`.',
    );
    out.push('');
    return out.join('\n');
  }

  // ─── Results table ──────────────────────────────────────────────
  if (resp.reranked) {
    out.push('| # | Score | Rerank | Type | Snippet | Source |');
    out.push('|---|------:|-------:|------|---------|--------|');
  } else {
    out.push('| # | Score | Type | Snippet | Source |');
    out.push('|---|------:|------|---------|--------|');
  }
  resp.results.forEach((r, idx) => {
    const num = idx + 1;
    const snippet = tableCell(clamp(r.snippet, TABLE_SNIPPET_CHARS));
    const source = renderSource(r);
    if (resp.reranked) {
      const rerank = r.rerankScore !== undefined ? fmtScore(r.rerankScore) : '—';
      out.push(
        `| ${num} | ${fmtScore(r.similarity)} | ${rerank} | ${r.entityType} | ${snippet} | ${source} |`,
      );
    } else {
      out.push(`| ${num} | ${fmtScore(r.similarity)} | ${r.entityType} | ${snippet} | ${source} |`);
    }
  });
  out.push('');

  // ─── Full snippets (untruncated copies) ─────────────────────────
  out.push('## Full snippets');
  out.push('');
  resp.results.forEach((r, idx) => {
    out.push(`**${idx + 1}.** _${r.entityType}_ · score ${fmtScore(r.similarity)}`);
    out.push('');
    out.push(`> ${r.snippet.replace(/\n/g, '\n> ')}`);
    out.push('');
  });

  return out.join('\n');
}
