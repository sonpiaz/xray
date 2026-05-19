import { describe, expect, it } from 'vitest';
import type { XComment } from '../../src/models/comment.ts';
import type { ResearchReport } from '../../src/models/report.ts';
import { renderReportMarkdown } from '../../src/render/markdown.ts';

function mkComment(
  id: string,
  text: string,
  likes: number,
  stance: NonNullable<XComment['classification']>['stance'],
  quality: NonNullable<XComment['classification']>['quality'],
  qualityScore: number,
): XComment {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    author: { handle: `u${id}`, verified: false },
    text,
    metrics: { likes },
    media: [],
    links: [],
    isReply: true,
    isQuote: false,
    depth: 0,
    replies: [],
    classification: { stance, quality, qualityScore },
  };
}

function baseReport(comments: XComment[]): ResearchReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-18T18:00:00.000Z',
    source: { url: 'https://x.com/alice/status/1001', model: 'gemini-2.5-flash', cacheHit: false },
    thread: {
      rootPost: {
        id: '1001',
        url: 'https://x.com/alice/status/1001',
        author: { handle: 'alice', verified: false },
        text: 'Root post text.',
        metrics: { likes: 100, reposts: 5, replies: 12, views: 3000 },
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      },
      authorPosts: [],
      quoteTweets: [],
      comments,
      fetchedAt: '2026-05-18T18:01:00.000Z',
      partial: false,
    },
    tldr: 'tldr',
    summary: 'summary',
    keyInsights: [],
    notableReplies: [],
    openQuestions: [],
    warnings: [],
    coverage: {
      targetDepth: 3,
      achievedDepth: 2,
      targetReplies: 50,
      fetchedReplies: comments.length,
      classifiedReplies: comments.length,
      paginationCursors: [],
      status: 'ok',
    },
    stanceDistribution: {
      agree: comments.filter((c) => c.classification?.stance === 'agree').length,
      disagree: comments.filter((c) => c.classification?.stance === 'disagree').length,
      neutral: comments.filter((c) => c.classification?.stance === 'neutral').length,
      question: comments.filter((c) => c.classification?.stance === 'question').length,
      humor: comments.filter((c) => c.classification?.stance === 'humor').length,
      meta: comments.filter((c) => c.classification?.stance === 'meta').length,
    },
  };
}

describe('renderReportMarkdown — Top Quality Replies (P1.2)', () => {
  it('renders top 5 classified replies sorted by qualityScore desc', () => {
    const comments: XComment[] = [
      mkComment('a', 'low quality reply', 1, 'agree', 'noise', 0.05),
      mkComment('b', 'expert take with citation', 100, 'agree', 'expert', 0.95),
      mkComment('c', 'solid analysis', 50, 'neutral', 'substantive', 0.8),
      mkComment('d', 'correction with source', 30, 'disagree', 'correction', 0.9),
      mkComment('e', 'anecdote', 5, 'agree', 'anecdotal', 0.4),
      mkComment('f', 'meta-comment', 8, 'meta', 'noise', 0.1),
      mkComment('g', 'good question', 12, 'question', 'substantive', 0.7),
    ];
    const md = renderReportMarkdown(baseReport(comments));
    expect(md).toContain('## Top Quality Replies');

    // Must show top 5 (b, d, c, g, e), in that order, scores formatted to 2 decimals
    const section = md.split('## Top Quality Replies')[1]!.split('## ')[0]!;
    const handlesInOrder = [...section.matchAll(/@u([a-z])/g)].map((m) => m[1]);
    expect(handlesInOrder.slice(0, 5)).toEqual(['b', 'd', 'c', 'g', 'e']);
    expect(section).toContain('score **0.95**');
    expect(section).toContain('[agree]');
    expect(section).toContain('expert');
    expect(section).not.toContain('@ua'); // noise reply (score 0.05) drops off top-5
  });

  it('does NOT render when classification fields are absent', () => {
    const report = baseReport([]);
    // Strip stanceDistribution to simulate a report that ran without classification
    const r: ResearchReport = { ...report, stanceDistribution: undefined };
    const md = renderReportMarkdown(r);
    expect(md).not.toContain('## Top Quality Replies');
    expect(md).not.toContain('## Dissenting Views');
  });

  it('does NOT render when no comments have classification attached', () => {
    // Coverage + stanceDistribution present, but the comments array is empty —
    // section gating must also check that at least one classified comment exists.
    const md = renderReportMarkdown(baseReport([]));
    expect(md).not.toContain('## Top Quality Replies');
    expect(md).not.toContain('## Dissenting Views');
  });
});

describe('renderReportMarkdown — Dissenting Views (P1.2)', () => {
  it('renders top 3 disagree replies sorted by qualityScore desc', () => {
    const comments: XComment[] = [
      mkComment('a', 'meh disagree', 5, 'disagree', 'noise', 0.2),
      mkComment('b', 'strong disagree with data', 80, 'disagree', 'correction', 0.92),
      mkComment('c', 'agree', 50, 'agree', 'substantive', 0.7),
      mkComment('d', 'thoughtful disagree', 30, 'disagree', 'substantive', 0.75),
      mkComment('e', 'another disagree', 20, 'disagree', 'anecdotal', 0.55),
      mkComment('f', 'fourth disagree dropped', 15, 'disagree', 'anecdotal', 0.5),
    ];
    const md = renderReportMarkdown(baseReport(comments));
    expect(md).toContain('## Dissenting Views');

    const section = md.split('## Dissenting Views')[1]!.split('## ')[0]!;
    const handlesInOrder = [...section.matchAll(/@u([a-z])/g)].map((m) => m[1]);
    expect(handlesInOrder.slice(0, 3)).toEqual(['b', 'd', 'e']);
    expect(section).not.toContain('@uc'); // agreement is excluded
    expect(section).not.toContain('@uf'); // 4th disagree dropped (top-3 cap)
  });

  it('is omitted when no classified comment has stance == disagree', () => {
    const comments: XComment[] = [
      mkComment('a', 'agree', 10, 'agree', 'substantive', 0.7),
      mkComment('b', 'neutral', 8, 'neutral', 'anecdotal', 0.4),
    ];
    const md = renderReportMarkdown(baseReport(comments));
    expect(md).toContain('## Top Quality Replies'); // still rendered
    expect(md).not.toContain('## Dissenting Views');
  });
});

describe('renderReportMarkdown — P1.2 section ordering', () => {
  it('places Top Quality Replies AFTER Conversation Analysis and BEFORE Source — Root Post', () => {
    const comments: XComment[] = [
      mkComment('a', 'expert reply', 50, 'agree', 'expert', 0.9),
      mkComment('b', 'disagree', 20, 'disagree', 'substantive', 0.8),
    ];
    const md = renderReportMarkdown(baseReport(comments));
    const idxConv = md.indexOf('## Conversation Analysis');
    const idxTop = md.indexOf('## Top Quality Replies');
    const idxDis = md.indexOf('## Dissenting Views');
    const idxSrc = md.indexOf('## Source — Root Post');

    expect(idxConv).toBeGreaterThan(-1);
    expect(idxTop).toBeGreaterThan(idxConv);
    expect(idxDis).toBeGreaterThan(idxTop);
    expect(idxSrc).toBeGreaterThan(idxDis);
  });
});
