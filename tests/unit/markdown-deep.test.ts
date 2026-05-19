import { describe, expect, it } from 'vitest';
import type { ResearchReport } from '../../src/models/report.ts';
import { renderReportMarkdown } from '../../src/render/markdown.ts';

function baseReport(): ResearchReport {
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
      comments: [],
      fetchedAt: '2026-05-18T18:01:00.000Z',
      partial: false,
    },
    tldr: 'tldr',
    summary: 'summary',
    keyInsights: [],
    notableReplies: [],
    openQuestions: [],
    warnings: [],
  };
}

describe('renderReportMarkdown — Deep Analysis section (P1.3)', () => {
  it('renders Subtree Summaries section only when subtreeSummaries present + nonempty', () => {
    const reportNoDeep = baseReport();
    expect(renderReportMarkdown(reportNoDeep)).not.toContain(
      '## Deep Analysis — Subtree Summaries',
    );

    const reportEmptyDeep: ResearchReport = { ...baseReport(), subtreeSummaries: [] };
    expect(renderReportMarkdown(reportEmptyDeep)).not.toContain(
      '## Deep Analysis — Subtree Summaries',
    );

    const reportWithDeep: ResearchReport = {
      ...baseReport(),
      subtreeSummaries: [
        {
          rootReplyPostId: '2001',
          rootReplyHandle: 'expert',
          replyCount: 5,
          headline: 'Whether scaling has decelerated.',
          keyPoints: ['point one', 'point two'],
          dissent: ['dissent one'],
        },
      ],
    };
    const md = renderReportMarkdown(reportWithDeep);
    expect(md).toContain('## Deep Analysis — Subtree Summaries');
    expect(md).toContain('### Subtree: @expert (5 replies)');
    expect(md).toContain('**Headline:** Whether scaling has decelerated.');
    expect(md).toContain('- point one');
    expect(md).toContain('- dissent one');
  });

  it('handles singular reply count grammar', () => {
    const report: ResearchReport = {
      ...baseReport(),
      subtreeSummaries: [
        {
          rootReplyPostId: '2001',
          rootReplyHandle: 'solo',
          replyCount: 1,
          headline: 'Single-reply subtree.',
          keyPoints: [],
          dissent: [],
        },
      ],
    };
    expect(renderReportMarkdown(report)).toContain('### Subtree: @solo (1 reply)');
  });

  it('renders synthesis sub-sections (Top Arguments / Dissent Map / Sub-threads) when deepSynthesis present', () => {
    const report: ResearchReport = {
      ...baseReport(),
      subtreeSummaries: [
        {
          rootReplyPostId: '2001',
          rootReplyHandle: 'a',
          replyCount: 3,
          headline: 'h',
          keyPoints: [],
          dissent: [],
        },
      ],
      deepSynthesis: {
        topArguments: [
          {
            argument: 'Scaling decelerated.',
            voicedBy: ['@a', '@b'],
            evidenceSubtreeIds: ['2001'],
          },
        ],
        dissentMap: [
          {
            claim: 'OP conflates pretraining with capability.',
            againstOp: true,
            voicedBy: ['@a'],
            evidenceSubtreeIds: ['2001'],
          },
        ],
        subThreadsWorthReading: [
          {
            rootReplyPostId: '2001',
            handle: '@a',
            reason: 'Most-cited subtree.',
          },
        ],
      },
    };
    const md = renderReportMarkdown(report);
    expect(md).toContain('### Top Arguments');
    expect(md).toContain('Scaling decelerated.');
    expect(md).toContain('voiced by: @a, @b');
    expect(md).toContain('### Dissent Map');
    expect(md).toContain('[vs OP]');
    expect(md).toContain('### Sub-threads Worth Reading');
    expect(md).toContain('Most-cited subtree.');
  });

  it('omits synthesis sub-sections when their arrays are empty', () => {
    const report: ResearchReport = {
      ...baseReport(),
      subtreeSummaries: [
        {
          rootReplyPostId: '2001',
          rootReplyHandle: 'a',
          replyCount: 1,
          headline: 'h',
          keyPoints: [],
          dissent: [],
        },
      ],
      deepSynthesis: {
        topArguments: [],
        dissentMap: [],
        subThreadsWorthReading: [],
      },
    };
    const md = renderReportMarkdown(report);
    expect(md).toContain('## Deep Analysis — Subtree Summaries');
    expect(md).not.toContain('### Top Arguments');
    expect(md).not.toContain('### Dissent Map');
    expect(md).not.toContain('### Sub-threads Worth Reading');
  });

  it('positions Deep Analysis BEFORE Source — Root Post', () => {
    const report: ResearchReport = {
      ...baseReport(),
      subtreeSummaries: [
        {
          rootReplyPostId: '2001',
          rootReplyHandle: 'a',
          replyCount: 1,
          headline: 'h',
          keyPoints: [],
          dissent: [],
        },
      ],
    };
    const md = renderReportMarkdown(report);
    const idxDeep = md.indexOf('## Deep Analysis — Subtree Summaries');
    const idxSrc = md.indexOf('## Source — Root Post');
    expect(idxDeep).toBeGreaterThan(-1);
    expect(idxSrc).toBeGreaterThan(idxDeep);
  });
});
