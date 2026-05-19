/**
 * P4.0 — Zod schema validation for EmbeddingMeta + EmbeddingEntityType.
 *
 * Round-trip a known-good shape, reject invalid entity types, and
 * cover the optional fields (sourceUrl, authorHandle). Mirrors the
 * shape of `tests/unit/models.test.ts` so a future writer of search /
 * profile schema tests has an obvious template.
 */
import { describe, expect, it } from 'vitest';
import { EmbeddingEntityTypeSchema, EmbeddingMetaSchema } from '../../src/models/embedding.ts';

describe('EmbeddingEntityTypeSchema', () => {
  it('accepts the three known entity types', () => {
    expect(EmbeddingEntityTypeSchema.parse('post')).toBe('post');
    expect(EmbeddingEntityTypeSchema.parse('comment')).toBe('comment');
    expect(EmbeddingEntityTypeSchema.parse('article-passage')).toBe('article-passage');
  });

  it('rejects unknown entity types', () => {
    expect(() => EmbeddingEntityTypeSchema.parse('thread')).toThrow();
    expect(() => EmbeddingEntityTypeSchema.parse('')).toThrow();
    expect(() => EmbeddingEntityTypeSchema.parse(42)).toThrow();
  });
});

describe('EmbeddingMetaSchema', () => {
  it('accepts a fully-populated meta row', () => {
    const meta = {
      entityType: 'post' as const,
      entityId: '1234567890',
      contentHash: 'a'.repeat(64),
      sourceUrl: 'https://x.com/karpathy/status/1234567890',
      authorHandle: 'karpathy',
      snippet: 'hello world',
      createdAt: 1_700_000_000_000,
    };
    expect(EmbeddingMetaSchema.parse(meta)).toEqual(meta);
  });

  it('accepts a minimal meta row (no sourceUrl, no authorHandle)', () => {
    const meta = {
      entityType: 'article-passage' as const,
      entityId: 'article:https://example.com/post:chunk:0',
      contentHash: 'b'.repeat(64),
      snippet: 'passage text',
      createdAt: 1_700_000_000_000,
    };
    const parsed = EmbeddingMetaSchema.parse(meta);
    expect(parsed.sourceUrl).toBeUndefined();
    expect(parsed.authorHandle).toBeUndefined();
  });

  it('rejects rows missing required fields', () => {
    expect(() =>
      EmbeddingMetaSchema.parse({
        entityType: 'post',
        entityId: '1',
        // contentHash omitted
        snippet: '',
        createdAt: 0,
      }),
    ).toThrow();
  });

  it('rejects malformed sourceUrl', () => {
    expect(() =>
      EmbeddingMetaSchema.parse({
        entityType: 'post' as const,
        entityId: '1',
        contentHash: 'h',
        sourceUrl: 'not-a-url',
        snippet: 's',
        createdAt: 0,
      }),
    ).toThrow();
  });

  it('rejects non-integer createdAt', () => {
    expect(() =>
      EmbeddingMetaSchema.parse({
        entityType: 'post' as const,
        entityId: '1',
        contentHash: 'h',
        snippet: 's',
        createdAt: 1.5,
      }),
    ).toThrow();
  });
});
