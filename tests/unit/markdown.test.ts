import { describe, expect, it } from 'vitest';
import type { ResearchReport } from '../../src/models/report.ts';
import { renderReportMarkdown } from '../../src/render/markdown.ts';

const report: ResearchReport = {
  schemaVersion: 1,
  generatedAt: '2026-05-18T18:00:00.000Z',
  source: { url: 'https://x.com/alice/status/1001', model: 'gemini-2.5-flash', cacheHit: false },
  thread: {
    rootPost: {
      id: '1001',
      url: 'https://x.com/alice/status/1001',
      author: { handle: 'alice', verified: false },
      text: 'Why transformer scaling is decelerating.',
      metrics: { likes: 12400, reposts: 1800, replies: 423, views: 240000 },
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
    },
    authorPosts: [],
    quoteTweets: [],
    comments: [],
    fetchedAt: '2026-05-18T18:01:00.000Z',
    partial: false,
  },
  topic: 'Transformer scaling deceleration',
  tldr: 'OP claims scaling has flattened.',
  summary: 'Three sentence narrative summary about the thread.',
  keyInsights: [
    { insight: 'Loss curves flattened at 70B', evidencePostIds: ['1002'], confidence: 'high' },
  ],
  notableReplies: [],
  openQuestions: ['Is this learning rate or fundamental?'],
  warnings: [],
};

describe('renderReportMarkdown', () => {
  const md = renderReportMarkdown(report);

  it('includes title and topic', () => {
    expect(md).toContain('# Thread Research — @alice');
    expect(md).toContain('Transformer scaling deceleration');
  });

  it('formats large numbers', () => {
    expect(md).toContain('12.4k likes');
    expect(md).toContain('240k views');
  });

  it('includes TL;DR and key insight', () => {
    expect(md).toContain('## TL;DR');
    expect(md).toContain('## Key Insights');
    expect(md).toContain('Loss curves flattened at 70B');
  });

  it('includes open questions', () => {
    expect(md).toContain('## Open Questions');
    expect(md).toContain('learning rate');
  });

  it('does NOT render Conversation Analysis when coverage + stanceDistribution are absent', () => {
    // Phase 0 reports omit both fields; ensure the new section is gated on presence.
    expect(md).not.toContain('## Conversation Analysis');
  });
});

describe('renderReportMarkdown — Conversation Analysis (P1.1)', () => {
  const reportWithClassification: ResearchReport = {
    ...report,
    coverage: {
      targetDepth: 3,
      achievedDepth: 2,
      targetReplies: 50,
      fetchedReplies: 47,
      classifiedReplies: 40,
      paginationCursors: ['CURSOR_1', 'CURSOR_2'],
      status: 'partial',
    },
    stanceDistribution: {
      agree: 18,
      disagree: 12,
      neutral: 8,
      question: 5,
      humor: 3,
      meta: 1,
    },
  };

  const md = renderReportMarkdown(reportWithClassification);

  it('renders the Conversation Analysis heading', () => {
    expect(md).toContain('## Conversation Analysis');
  });

  it('shows coverage line with fetched / target / depth / classified', () => {
    expect(md).toContain('47/50 replies fetched');
    expect(md).toContain('depth 2/3');
    expect(md).toContain('40 classified');
    expect(md).toContain('status partial');
  });

  it('shows stance distribution counts in fixed order', () => {
    expect(md).toContain('18 agree · 12 disagree · 8 neutral · 5 question · 3 humor · 1 meta');
  });
});
