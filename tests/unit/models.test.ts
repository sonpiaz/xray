import { describe, expect, it } from 'vitest';
import { XPostSchema } from '../../src/models/post.ts';
import { ResearchReportSchema } from '../../src/models/report.ts';
import { XThreadSchema } from '../../src/models/thread.ts';

const samplePost = {
  id: '1',
  url: 'https://x.com/a/status/1',
  author: { handle: 'a' },
  text: 'hi',
};

describe('zod schemas', () => {
  it('XPost applies defaults', () => {
    const p = XPostSchema.parse(samplePost);
    expect(p.media).toEqual([]);
    expect(p.links).toEqual([]);
    expect(p.isReply).toBe(false);
    expect(p.author.verified).toBe(false);
  });

  it('XThread requires fetchedAt', () => {
    const t = XThreadSchema.parse({
      rootPost: samplePost,
      fetchedAt: new Date().toISOString(),
    });
    expect(t.comments).toEqual([]);
    expect(t.partial).toBe(false);
  });

  it('ResearchReport accepts minimal shape', () => {
    const r = ResearchReportSchema.parse({
      generatedAt: new Date().toISOString(),
      source: { url: 'https://x.com/a/status/1', model: 'm' },
      thread: { rootPost: samplePost, fetchedAt: new Date().toISOString() },
      tldr: 'short',
      summary: 'longer',
    });
    expect(r.schemaVersion).toBe(1);
    expect(r.keyInsights).toEqual([]);
  });
});
