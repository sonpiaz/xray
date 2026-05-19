/**
 * P4.0 — Embedding metadata schemas.
 *
 * Two pieces of state per embedded item: the metadata row (snippet,
 * source URL, author, content hash for dedup) and the vector itself
 * (float[384] stored either in a sqlite-vec virtual table or, on
 * platforms where the extension fails to load, as a BLOB in the
 * fallback `embedding_vectors` table).
 *
 * `EmbeddingEntityType` covers the three sources we walk in P4.0:
 *   - `post`             — a root or author follow-up post
 *   - `comment`          — a reply pulled from a cached thread
 *   - `article-passage`  — a chunk of an article body
 *
 * `content_hash` is sha256 of the embed-time text (after author/parent
 * prefixing), used to skip re-embedding unchanged items on subsequent
 * `xray cache embed` runs.
 */
import { z } from 'zod';

export const EmbeddingEntityTypeSchema = z.enum(['comment', 'post', 'article-passage']);
export type EmbeddingEntityType = z.infer<typeof EmbeddingEntityTypeSchema>;

export const EmbeddingMetaSchema = z.object({
  entityType: EmbeddingEntityTypeSchema,
  entityId: z.string(),
  contentHash: z.string(),
  sourceUrl: z.string().url().optional(),
  authorHandle: z.string().optional(),
  snippet: z.string(),
  createdAt: z.number().int(),
});
export type EmbeddingMeta = z.infer<typeof EmbeddingMetaSchema>;
