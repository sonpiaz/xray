/**
 * P4.1 — Semantic search result schemas.
 *
 * `SearchEntityType` is a superset of `EmbeddingEntityType` from
 * `./embedding.ts` (adds `thread` for future use — see PHASE_4_PLAN §6).
 * Right now only `comment`, `post`, and `article-passage` ever come out
 * of the store; `thread` is reserved so a future P4.x can emit
 * thread-level hits (e.g. ranked across thread synthesis snippets)
 * without breaking the public schema.
 *
 * `SearchResult.source` is intentionally narrow — just the fields a
 * caller needs to attribute a hit back to its origin. We don't echo the
 * full `EmbeddingMeta` (model_version, content_hash, createdAt) because
 * those are storage internals.
 *
 * `rerankScore` is optional and only populated when the search ran with
 * `rerank: true`. Consumers can sort by `rerankScore ?? similarity` to
 * get the final order regardless of which path produced the result.
 */
import { z } from 'zod';

export const SearchEntityTypeSchema = z.enum(['comment', 'post', 'thread', 'article-passage']);
export type SearchEntityType = z.infer<typeof SearchEntityTypeSchema>;

export const SearchSourceSchema = z.object({
  threadId: z.string().optional(),
  postId: z.string().optional(),
  authorHandle: z.string().optional(),
  url: z.string().url().optional(),
});
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchResultSchema = z.object({
  entityType: SearchEntityTypeSchema,
  entityId: z.string(),
  snippet: z.string(),
  /** Cosine similarity in [-1, 1]; unit-normalized vectors typically land in [0, 1]. */
  similarity: z.number().min(-1).max(1),
  source: SearchSourceSchema,
  /** Present only when LLM rerank was enabled. 0..1, higher = more relevant. */
  rerankScore: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  reranked: z.boolean().default(false),
  limit: z.number().int().positive(),
  threshold: z.number().min(-1).max(1).optional(),
  typeFilter: SearchEntityTypeSchema.optional(),
  results: z.array(SearchResultSchema),
  estimatedCostUsd: z.number().nonnegative().default(0),
  generatedAt: z.string().datetime(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
