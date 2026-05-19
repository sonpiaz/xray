import { describe, expect, it } from 'vitest';
import { renderThreadForPrompt, systemPrompt } from '../../src/kyma/prompts.ts';
import type { XComment } from '../../src/models/comment.ts';
import type { XThread } from '../../src/models/thread.ts';

function mkThread(comments: XComment[]): XThread {
  return {
    rootPost: {
      id: '1001',
      url: 'https://x.com/alice/status/1001',
      author: { id: 'u1', handle: 'alice', verified: false },
      text: 'Root text',
      metrics: { likes: 100 },
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
    },
    authorPosts: [],
    quoteTweets: [],
    comments,
    fetchedAt: '2026-05-19T18:00:00.000Z',
    partial: false,
  };
}

function mkComment(id: string, handle: string, text: string, isAuthorReply?: boolean): XComment {
  return {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: { handle, verified: false },
    text,
    metrics: { likes: 5 },
    media: [],
    links: [],
    isReply: true,
    inReplyToPostId: '1001',
    isQuote: false,
    depth: 0,
    replies: [],
    ...(isAuthorReply ? { isAuthorReply: true } : {}),
  };
}

describe('systemPrompt — P1.6', () => {
  const sys = systemPrompt();

  it('tells the model that root + author follow-ups are one thesis', () => {
    expect(sys).toContain('ROOT POST + AUTHOR FOLLOW-UPS form a single narrative thesis');
  });

  it('tells the model to surface [AUTHOR REPLY] tagged comments in notableReplies', () => {
    expect(sys).toContain('[AUTHOR REPLY]');
    expect(sys).toContain('HIGH-SIGNAL');
    expect(sys).toContain('notableReplies');
  });
});

describe('renderThreadForPrompt — P1.6 author-reply tagging', () => {
  it('prefixes isAuthorReply comments with [AUTHOR REPLY]', () => {
    const out = renderThreadForPrompt(
      mkThread([
        mkComment('2001', 'bob', 'Plain commenter line'),
        mkComment('2099', 'alice', 'Author reply line', true),
      ]),
    );
    expect(out).toContain('[AUTHOR REPLY] [2099]');
    expect(out).toContain('@alice: Author reply line');
    expect(out).not.toMatch(/\[AUTHOR REPLY\] \[2001\]/);
  });

  it('leaves third-party comments untagged', () => {
    const out = renderThreadForPrompt(mkThread([mkComment('2001', 'bob', 'Bob says hi')]));
    expect(out).not.toContain('[AUTHOR REPLY]');
    expect(out).toContain('- [2001]');
  });
});
