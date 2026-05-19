/**
 * P3.3 — MCP input-schema validation tests for `xray_article` and the
 * new `articles` arg on `xray_thread`.
 *
 * Rationale: the MCP `registerTool` flow wires Zod-validated argument
 * objects into the handler. Standing up the SDK transport in a unit
 * test is heavy; instead we lift the exported schema records from
 * `src/mcp/server.ts` and validate input shapes via `z.object()`.
 *
 * Coverage:
 *   1. ArticleInput — happy path (URL only)
 *   2. ArticleInput — rejects non-URL strings
 *   3. ArticleInput — accepts optional tweetContext + tweetPostId
 *   4. ArticleInput — accepts synthesize=false and format=both
 *   5. ArticleInput — rejects unknown format value
 *   6. ThreadInput  — `articles: true` is accepted alongside `video: true`
 *   7. ArticleInput — synthesize default behavior is undefined (handler
 *      treats `undefined` as the "synthesize" path; only explicit
 *      `false` flips to raw)
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArticleInput, ThreadInput } from '../../src/mcp/schemas.ts';

const ArticleSchema = z.object(ArticleInput);
const ThreadSchema = z.object(ThreadInput);

describe('MCP ArticleInput schema (xray_article)', () => {
  it('accepts a minimal payload with only a URL', () => {
    const parsed = ArticleSchema.parse({ url: 'https://example.com/post' });
    expect(parsed.url).toBe('https://example.com/post');
    // Optional fields are undefined rather than defaulted — the handler
    // applies the article-specific default (synthesize=true unless
    // explicitly false).
    expect(parsed.synthesize).toBeUndefined();
    expect(parsed.format).toBeUndefined();
  });

  it('rejects non-URL strings', () => {
    expect(() => ArticleSchema.parse({ url: 'not-a-url' })).toThrow();
  });

  it('accepts tweetContext + tweetPostId together', () => {
    const parsed = ArticleSchema.parse({
      url: 'https://example.com/post',
      tweetContext: 'Author thesis here',
      tweetPostId: '1234567890',
    });
    expect(parsed.tweetContext).toBe('Author thesis here');
    expect(parsed.tweetPostId).toBe('1234567890');
  });

  it('accepts synthesize=false and format=both', () => {
    const parsed = ArticleSchema.parse({
      url: 'https://example.com/post',
      synthesize: false,
      format: 'both',
    });
    expect(parsed.synthesize).toBe(false);
    expect(parsed.format).toBe('both');
  });

  it('rejects unknown format values', () => {
    expect(() =>
      ArticleSchema.parse({ url: 'https://example.com/post', format: 'yaml' }),
    ).toThrow();
  });

  it('accepts noCache + model overrides', () => {
    const parsed = ArticleSchema.parse({
      url: 'https://example.com/post',
      noCache: true,
      model: 'gemini-2.5-pro',
    });
    expect(parsed.noCache).toBe(true);
    expect(parsed.model).toBe('gemini-2.5-pro');
  });
});

describe('MCP ThreadInput schema (P3.3 articles arg)', () => {
  it('accepts `articles: true` alongside `video: true`', () => {
    const parsed = ThreadSchema.parse({
      url: 'https://x.com/u/status/1',
      articles: true,
      video: true,
    });
    expect(parsed.articles).toBe(true);
    expect(parsed.video).toBe(true);
  });

  it('still accepts a payload without `articles`', () => {
    const parsed = ThreadSchema.parse({ url: 'https://x.com/u/status/1' });
    expect(parsed.articles).toBeUndefined();
  });

  it('rejects non-boolean `articles`', () => {
    expect(() =>
      ThreadSchema.parse({ url: 'https://x.com/u/status/1', articles: 'yes' }),
    ).toThrow();
  });
});
