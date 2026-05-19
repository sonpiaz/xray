/**
 * P3.2 — Article markdown rendering tests.
 *
 * Covers:
 *   1. `renderArticleMarkdown` standalone mode — top-level `# Article`
 *   2. `renderArticleMarkdown` embedded mode — `### Article`
 *   3. Cross-reference table — present + sorted by confidence
 *   4. Cross-reference table — absent when crossReferences empty
 *   5. `renderCrossReferenceTable` — clamps + escaping
 *
 * Plus the thread renderer's "## Articles" section gating.
 */
import { describe, expect, it } from 'vitest';
import type { ArticleSummary, CrossReference } from '../../src/models/article.ts';
import type { ResearchReport } from '../../src/models/report.ts';
import type { XThread } from '../../src/models/thread.ts';
import {
  renderArticleMarkdown,
  renderCrossReferenceTable,
} from '../../src/render/article-markdown.ts';
import { renderReportMarkdown } from '../../src/render/markdown.ts';

function mkSummary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    url: 'https://example.com/post',
    canonicalUrl: 'https://example.com/post',
    source: 'external-html',
    body: {
      title: 'Sample Article',
      text: 'Sample body.',
      wordCount: 10,
      contentSource: 'readability',
    },
    summary: 'A one-paragraph synthesis.',
    keyPoints: ['Point A', 'Point B'],
    crossReferences: [],
    estimatedCostUsd: 0.012,
    costBreakdown: { summarize: 0.007, crossReference: 0.005 },
    partial: false,
    errors: [],
    generatedAt: '2026-05-19T12:00:00.000Z',
    ...overrides,
  };
}

const sampleRefs: CrossReference[] = [
  {
    tweetClaim: 'Self-attention is the key innovation',
    articlePassage: 'The self-attention mechanism enables long-context weighting',
    relationship: 'supports',
    confidence: 0.95,
  },
  {
    tweetClaim: 'Scaling alone solves intelligence',
    articlePassage: 'Diminishing returns past 70B parameters suggest scaling alone is insufficient',
    relationship: 'contradicts',
    confidence: 0.92,
  },
  {
    tweetClaim: 'Fine-tuning is overrated',
    articlePassage: 'Domain-specific fine-tuning yields disproportionate gains',
    relationship: 'contradicts',
    confidence: 0.7,
  },
];

// ──────────────────────────────────────────────────────────────────────
// renderArticleMarkdown
// ──────────────────────────────────────────────────────────────────────

describe('renderArticleMarkdown', () => {
  it('emits a top-level `# Article` heading in standalone mode', () => {
    const md = renderArticleMarkdown(mkSummary());
    expect(md.startsWith('# Article — Sample Article')).toBe(true);
    expect(md).toContain('## Summary');
    expect(md).toContain('## Key Points');
  });

  it('emits a `### Article` heading in embedded mode + subheadings use ####', () => {
    const md = renderArticleMarkdown(mkSummary(), { mode: 'embedded' });
    expect(md.startsWith('### Article — Sample Article')).toBe(true);
    expect(md).toContain('#### Summary');
    expect(md).toContain('#### Key Points');
    // Standalone-only heading must not appear on its own line.
    expect(md).not.toMatch(/^## Summary$/m);
    expect(md).not.toMatch(/^# Article/m);
  });

  it('includes byline/published metadata when present', () => {
    const md = renderArticleMarkdown(
      mkSummary({
        body: {
          title: 'T',
          text: 'b',
          wordCount: 1,
          contentSource: 'readability',
          byline: 'Jane Smith',
          publishedAt: '2026-05-19T00:00:00.000Z',
        },
      }),
    );
    expect(md).toContain('Author: Jane Smith');
    expect(md).toContain('Published: 2026-05-19T00:00:00.000Z');
  });

  it('renders cross-reference table when refs is non-empty', () => {
    const md = renderArticleMarkdown(mkSummary({ crossReferences: sampleRefs }));
    expect(md).toContain('## Cross-References (tweet → article)');
    expect(md).toContain('| Tweet Claim | Article Passage | Relationship | Confidence |');
    expect(md).toContain('supports');
    expect(md).toContain('contradicts');
    expect(md).toContain('0.95');
  });

  it('skips cross-reference section when refs is empty', () => {
    const md = renderArticleMarkdown(mkSummary({ crossReferences: [] }));
    expect(md).not.toContain('Cross-References');
  });

  it('renders Notes section when errors[] populated', () => {
    const md = renderArticleMarkdown(mkSummary({ errors: ['paywall detected', 'truncated body'] }));
    expect(md).toContain('## Notes');
    expect(md).toContain('- paywall detected');
    expect(md).toContain('- truncated body');
  });

  it('renders "no summary generated" stub when partial + no summary', () => {
    const md = renderArticleMarkdown(
      mkSummary({ summary: undefined, partial: true, errors: ['fail'] }),
    );
    expect(md).toContain('_No summary generated');
  });

  it('shows cost in the meta line', () => {
    const md = renderArticleMarkdown(mkSummary());
    expect(md).toContain('Cost: $0.0120');
  });
});

// ──────────────────────────────────────────────────────────────────────
// renderCrossReferenceTable
// ──────────────────────────────────────────────────────────────────────

describe('renderCrossReferenceTable', () => {
  it('returns an empty array when refs is empty', () => {
    expect(renderCrossReferenceTable([])).toEqual([]);
  });

  it('sorts rows by confidence descending', () => {
    const rows = renderCrossReferenceTable(sampleRefs);
    // rows[0] is the header, rows[1] is the separator, rows[2] is first data row.
    expect(rows[2]).toContain('Self-attention');
    expect(rows[3]).toContain('Scaling');
    expect(rows[4]).toContain('Fine-tuning');
  });

  it('clamps wide cells', () => {
    const wide: CrossReference[] = [
      {
        tweetClaim: 'x'.repeat(200),
        articlePassage: 'y'.repeat(300),
        relationship: 'supports',
        confidence: 0.5,
      },
    ];
    const rows = renderCrossReferenceTable(wide);
    // Header + separator + 1 data row.
    expect(rows).toHaveLength(3);
    expect(rows[2]!.length).toBeLessThan(250);
  });

  it('escapes pipe characters inside cells', () => {
    const piped: CrossReference[] = [
      {
        tweetClaim: 'left | right',
        articlePassage: 'a | b | c',
        relationship: 'supports',
        confidence: 0.5,
      },
    ];
    const rows = renderCrossReferenceTable(piped);
    expect(rows[2]).toContain('left \\| right');
    expect(rows[2]).toContain('a \\| b \\| c');
  });

  it('caps at 8 rows regardless of input length', () => {
    const ten: CrossReference[] = Array.from({ length: 10 }, (_, i) => ({
      tweetClaim: `c${i}`,
      articlePassage: `p${i}`,
      relationship: 'supports' as const,
      confidence: 1 - i * 0.05,
    }));
    const rows = renderCrossReferenceTable(ten);
    // 8 data rows + header + separator = 10
    expect(rows).toHaveLength(10);
  });
});

// ──────────────────────────────────────────────────────────────────────
// thread report renders the Articles section
// ──────────────────────────────────────────────────────────────────────

function emptyThread(): XThread {
  return {
    rootPost: {
      id: '1',
      url: 'https://x.com/u/status/1',
      author: { handle: 'u', verified: false },
      text: 'root text',
      metrics: { likes: 5, reposts: 1, replies: 0, views: 100 },
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
    },
    authorPosts: [],
    quoteTweets: [],
    comments: [],
    fetchedAt: '2026-05-19T12:00:00.000Z',
    partial: false,
  };
}

function emptyReport(articleSummaries?: ArticleSummary[]): ResearchReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-19T12:00:00.000Z',
    source: { url: 'https://x.com/u/status/1', model: 'gemini', cacheHit: false },
    thread: emptyThread(),
    tldr: 'tldr',
    summary: 'summary text',
    keyInsights: [],
    notableReplies: [],
    openQuestions: [],
    warnings: [],
    ...(articleSummaries ? { articleSummaries } : {}),
  };
}

describe('renderReportMarkdown (P3.2 Articles section)', () => {
  it('omits the Articles section when articleSummaries is absent', () => {
    const md = renderReportMarkdown(emptyReport());
    expect(md).not.toContain('## Articles');
  });

  it('renders the Articles section when articleSummaries is non-empty', () => {
    const md = renderReportMarkdown(emptyReport([mkSummary()]));
    expect(md).toContain('## Articles (1)');
    expect(md).toContain('### Article — Sample Article');
  });

  it('includes the cross-reference table when refs present', () => {
    const md = renderReportMarkdown(emptyReport([mkSummary({ crossReferences: sampleRefs })]));
    expect(md).toContain('#### Cross-References (tweet → article)');
    expect(md).toContain('supports');
  });
});
