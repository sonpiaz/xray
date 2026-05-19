/**
 * P4.1 — MCP input-schema validation tests for `xray_search`.
 *
 * Mirrors `tests/unit/mcp-article.test.ts` — lifts the exported Zod
 * record from `src/mcp/schemas.ts`, wraps it in `z.object()`, and
 * asserts on parse / reject paths. No need to spin up the SDK
 * transport.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SearchInput } from '../../src/mcp/schemas.ts';

const SearchSchema = z.object(SearchInput);

describe('MCP SearchInput schema (xray_search)', () => {
  it('accepts a minimal payload with just a query', () => {
    const parsed = SearchSchema.parse({ query: 'transformer scaling' });
    expect(parsed.query).toBe('transformer scaling');
    expect(parsed.limit).toBeUndefined();
    expect(parsed.threshold).toBeUndefined();
    expect(parsed.type).toBeUndefined();
    expect(parsed.format).toBeUndefined();
  });

  it('rejects an empty query', () => {
    expect(() => SearchSchema.parse({ query: '' })).toThrow();
  });

  it('accepts all optional fields together', () => {
    const parsed = SearchSchema.parse({
      query: 'AI safety',
      limit: 5,
      threshold: 0.5,
      type: 'comment',
      rerank: true,
      format: 'both',
    });
    expect(parsed.limit).toBe(5);
    expect(parsed.threshold).toBe(0.5);
    expect(parsed.type).toBe('comment');
    expect(parsed.rerank).toBe(true);
    expect(parsed.format).toBe('both');
  });

  it('rejects unknown type values', () => {
    expect(() => SearchSchema.parse({ query: 'x', type: 'image' })).toThrow();
  });

  it('rejects out-of-range threshold', () => {
    expect(() => SearchSchema.parse({ query: 'x', threshold: 2 })).toThrow();
    expect(() => SearchSchema.parse({ query: 'x', threshold: -2 })).toThrow();
  });

  it('rejects non-integer limit', () => {
    expect(() => SearchSchema.parse({ query: 'x', limit: 1.5 })).toThrow();
  });

  it('rejects limit above the cap', () => {
    expect(() => SearchSchema.parse({ query: 'x', limit: 100 })).toThrow();
  });

  it('rejects unknown format values', () => {
    expect(() => SearchSchema.parse({ query: 'x', format: 'yaml' })).toThrow();
  });

  it('accepts each valid type enum value', () => {
    for (const t of ['comment', 'post', 'thread', 'article-passage'] as const) {
      const parsed = SearchSchema.parse({ query: 'x', type: t });
      expect(parsed.type).toBe(t);
    }
  });
});
