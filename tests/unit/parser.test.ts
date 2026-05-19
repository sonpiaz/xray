import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTweetDetail } from '../../src/fetcher/parser.ts';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail.min.json'), 'utf8'),
);

describe('parseTweetDetail', () => {
  const parsed = parseTweetDetail(fixture, '1001');

  it('extracts the root post', () => {
    expect(parsed.rootPost).toBeDefined();
    expect(parsed.rootPost?.id).toBe('1001');
    expect(parsed.rootPost?.author.handle).toBe('alice');
    expect(parsed.rootPost?.metrics.likes).toBe(12400);
  });

  it('captures same-author follow-up as authorPost', () => {
    expect(parsed.authorPosts).toHaveLength(1);
    expect(parsed.authorPosts[0]?.id).toBe('1002');
  });

  it('captures replies from other authors as comments', () => {
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]?.author.handle).toBe('bob');
    expect(parsed.comments[0]?.author.verified).toBe(true);
  });

  it('returns canonical url with author handle', () => {
    expect(parsed.rootPost?.url).toBe('https://x.com/alice/status/1001');
  });
});
