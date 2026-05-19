import { describe, expect, it } from 'vitest';
import type { XComment } from '../../src/models/comment.ts';
import type { XPost } from '../../src/models/post.ts';
import type { ResearchReport } from '../../src/models/report.ts';
import { renderReportMarkdown } from '../../src/render/markdown.ts';

// ────────────────────────────────────────────────────────────────────────────
// P1.6 — unified "Author Thread" block + "Author engagement" section
// ────────────────────────────────────────────────────────────────────────────

function root(): XPost {
  return {
    id: '1001',
    url: 'https://x.com/alice/status/1001',
    author: { id: 'u1', handle: 'alice', verified: false },
    text: 'Why transformer scaling is decelerating. Thread below.',
    metrics: { likes: 12400, reposts: 1800, replies: 423, views: 240000 },
    media: [],
    links: [],
    isReply: false,
    isQuote: false,
  };
}

function authorPost(id: string, text: string, inReplyTo?: string): XPost {
  const base: XPost = {
    id,
    url: `https://x.com/alice/status/${id}`,
    author: { id: 'u1', handle: 'alice', verified: false },
    text,
    metrics: { likes: 500 },
    media: [],
    links: [],
    isReply: Boolean(inReplyTo),
    isQuote: false,
  };
  return inReplyTo ? { ...base, inReplyToPostId: inReplyTo } : base;
}

function reply(
  id: string,
  handle: string,
  text: string,
  inReplyTo: string,
  isAuthorReply?: boolean,
): XComment {
  return {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: { id: handle === 'alice' ? 'u1' : `u-${handle}`, handle, verified: false },
    text,
    metrics: { likes: 50 },
    media: [],
    links: [],
    isReply: true,
    inReplyToPostId: inReplyTo,
    isQuote: false,
    depth: 0,
    replies: [],
    ...(isAuthorReply ? { isAuthorReply: true } : {}),
  };
}

function makeReport(overrides: Partial<ResearchReport['thread']> = {}): ResearchReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-19T18:00:00.000Z',
    source: { url: 'https://x.com/alice/status/1001', model: 'gemini-2.5-flash', cacheHit: false },
    thread: {
      rootPost: root(),
      authorPosts: [],
      quoteTweets: [],
      comments: [],
      fetchedAt: '2026-05-19T18:01:00.000Z',
      partial: false,
      ...overrides,
    },
    tldr: 'tldr',
    summary: 'summary',
    keyInsights: [],
    notableReplies: [],
    openQuestions: [],
    warnings: [],
  };
}

describe('renderReportMarkdown — P1.6 Source — Author Thread', () => {
  it('uses "Source — Root Post" + plain code block when authorPosts is empty', () => {
    const md = renderReportMarkdown(makeReport());
    expect(md).toContain('## Source — Root Post');
    expect(md).not.toContain('## Source — Author Thread');
    expect(md).not.toContain('[1/');
  });

  it('uses "Source — Author Thread" + numbered code block when authorPosts > 0', () => {
    const md = renderReportMarkdown(
      makeReport({
        authorPosts: [
          authorPost('1002', 'Continuation tweet 2.', '1001'),
          authorPost('1003', 'Continuation tweet 3.'),
        ],
      }),
    );
    expect(md).toContain('## Source — Author Thread');
    expect(md).not.toContain('## Source — Root Post');
    expect(md).toContain('```text');
    expect(md).toContain('[1/3] Why transformer scaling is decelerating. Thread below.');
    expect(md).toContain('[2/3] Continuation tweet 2.');
    expect(md).toContain('[3/3] Continuation tweet 3.');
  });

  it('drops the legacy "### Author follow-ups" section when authorPosts > 0', () => {
    const md = renderReportMarkdown(
      makeReport({
        authorPosts: [authorPost('1002', 'Continuation 2.', '1001')],
      }),
    );
    expect(md).not.toContain('### Author follow-ups');
  });
});

describe('renderReportMarkdown — P1.6 Author engagement section', () => {
  it('omits the section when no comments are flagged isAuthorReply', () => {
    const md = renderReportMarkdown(
      makeReport({
        comments: [reply('2001', 'bob', 'Bob comment', '1001')],
      }),
    );
    expect(md).not.toContain('### Author engagement');
  });

  it('renders "@commenter ... → @author: ..." when parent is fetched', () => {
    const md = renderReportMarkdown(
      makeReport({
        comments: [
          reply('2001', 'bob', 'Isnt this a learning rate issue?', '1001'),
          reply('2099', 'alice', 'We swept LRs already.', '2001', true),
        ],
      }),
    );
    expect(md).toContain('### Author engagement (1 replies to commenters)');
    expect(md).toContain('@bob');
    expect(md).toContain('@alice');
    expect(md).toContain('learning rate');
    expect(md).toContain('We swept LRs');
    expect(md).toMatch(/@bob.*→.*@alice/);
  });

  it('falls back to author-only line when parent comment is not in the thread', () => {
    const md = renderReportMarkdown(
      makeReport({
        comments: [reply('2099', 'alice', 'Standalone author reply.', '9999', true)],
      }),
    );
    expect(md).toContain('### Author engagement');
    expect(md).toContain('(in reply to 9999)');
    expect(md).toContain('Standalone author reply.');
  });

  it('caps at 10 entries', () => {
    const comments: XComment[] = [];
    for (let i = 0; i < 12; i++) {
      const cid = `${4000 + i}`;
      comments.push(reply(cid, `user${i}`, `commenter ${i}`, '1001'));
      comments.push(reply(`${5000 + i}`, 'alice', `author reply ${i}`, cid, true));
    }
    const md = renderReportMarkdown(makeReport({ comments }));
    expect(md).toContain('### Author engagement (10 replies to commenters)');
    expect(md).toContain('author reply 9');
    expect(md).not.toContain('author reply 10');
    expect(md).not.toContain('author reply 11');
  });

  it('positions Author engagement AFTER source block and BEFORE Top replies', () => {
    const md = renderReportMarkdown(
      makeReport({
        authorPosts: [authorPost('1002', 'Continuation.', '1001')],
        comments: [
          reply('2001', 'bob', 'Bob comment', '1001'),
          reply('2099', 'alice', 'Author reply text', '2001', true),
        ],
      }),
    );
    const idxSource = md.indexOf('## Source — Author Thread');
    const idxEngage = md.indexOf('### Author engagement');
    const idxTopReplies = md.indexOf('### Top replies');
    expect(idxSource).toBeGreaterThan(-1);
    expect(idxEngage).toBeGreaterThan(idxSource);
    expect(idxTopReplies).toBeGreaterThan(idxEngage);
  });
});
