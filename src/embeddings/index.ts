/**
 * P4.0 — Embeddings module root.
 *
 * Re-exports the provider + store APIs and provides the
 * `embedAllCached()` orchestrator that walks every cached source
 * (posts, threads → root + author follow-ups + top-level comments,
 * article bodies → chunked into passages) and embeds anything that
 * hasn't been embedded yet (or whose content hash changed).
 *
 * Idempotent — re-running the command embeds nothing when the cache
 * is unchanged. The dedup key is sha256(prepared text), so swapping
 * the prefix format (e.g. "alice: foo" vs "alice replying to bob:
 * foo") will be detected as a change and trigger a re-embed.
 *
 * All embedding is local + free; we log the wall-clock for the run.
 */
import type { XComment } from '../models/comment.ts';
import type { EmbeddingMeta } from '../models/embedding.ts';
import { type XPost, XPostSchema } from '../models/post.ts';
import { type XThread, XThreadSchema } from '../models/thread.ts';

export {
  embed,
  getEmbedder,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_VERSION,
  _depsForTests,
} from './provider.ts';
export {
  putEmbedding,
  getEmbedding,
  searchSimilar,
  embeddingCount,
  embeddingStorageBytes,
  clearEmbeddings,
  hashContent,
  cosineSimilarity,
  _resetVecStateForTests,
  type PutEmbeddingArgs,
  type SearchHit,
} from './store.ts';

import { _depsForTests } from './provider.ts';
import {
  _getDbForEmbeddings,
  _setDbModuleForTests as _setStoreDbModule,
  embeddingCount,
  getEmbedding,
  hashContent,
  putEmbedding,
} from './store.ts';

/**
 * Re-exported test seam — sets the shared db module used by BOTH
 * `store.ts` and the orchestrator below. Tests call this once in
 * `beforeAll` to install the in-memory shim.
 */
export const _setDbModuleForTests = _setStoreDbModule;

// Route all orchestrator-side db reads through the store's accessor
// so a single _setDbModuleForTests() call swaps both code paths.
function getDb(): ReturnType<typeof _getDbForEmbeddings> {
  return _getDbForEmbeddings();
}

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Per-thread cap on top-level comments to embed. Threads on X can
 * have thousands of replies; embedding all of them on first cache
 * embed would blow the time budget. 50 covers the high-signal
 * top-of-thread without forcing us to walk the full tree.
 *
 * Surfaced in the summary so the user knows comments were truncated.
 */
const COMMENTS_PER_THREAD_CAP = 50;

/** Article passage chunk size in approximate words. */
const ARTICLE_PASSAGE_WORDS = 200;
/** Word overlap between adjacent passages so phrase queries land. */
const ARTICLE_PASSAGE_OVERLAP_WORDS = 25;
/** Snippet length used for search-result display. */
const SNIPPET_CHARS = 200;

// ─── Text prep ─────────────────────────────────────────────────────

/**
 * Build the string we actually embed. Including the author handle in
 * the embed text means a search for "karpathy" can match posts by
 * @karpathy even when his name isn't in the body — same trick the
 * spec calls out in §5.3 ("text preparation").
 */
function prepPostText(post: XPost): string {
  return `${post.author.handle}: ${post.text}`.trim();
}

function prepCommentText(comment: XComment, parentAuthor?: string): string {
  if (parentAuthor) {
    return `${comment.author.handle} replying to ${parentAuthor}: ${comment.text}`.trim();
  }
  return `${comment.author.handle}: ${comment.text}`.trim();
}

function makeSnippet(text: string): string {
  if (text.length <= SNIPPET_CHARS) return text;
  return `${text.slice(0, SNIPPET_CHARS - 1)}…`;
}

/**
 * Split a body into ~200-word passages with 25-word overlap. Returns
 * the array of passage texts; the caller wraps each in an entityId
 * `article:{url}:chunk:{index}`.
 *
 * Empty / whitespace-only inputs return an empty array (caller skips).
 */
export function chunkArticleBody(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  if (words.length <= ARTICLE_PASSAGE_WORDS) return [words.join(' ')];

  const chunks: string[] = [];
  const step = ARTICLE_PASSAGE_WORDS - ARTICLE_PASSAGE_OVERLAP_WORDS;
  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + ARTICLE_PASSAGE_WORDS);
    if (slice.length === 0) break;
    chunks.push(slice.join(' '));
    if (i + ARTICLE_PASSAGE_WORDS >= words.length) break;
  }
  return chunks;
}

// ─── Cache walkers ─────────────────────────────────────────────────

type CacheItem = {
  meta: Omit<EmbeddingMeta, 'createdAt' | 'contentHash' | 'snippet'>;
  text: string;
};

function readCachedPosts(): CacheItem[] {
  const rows = getDb().query<{ json: string }, []>('SELECT json FROM posts').all();
  const items: CacheItem[] = [];
  for (const row of rows) {
    try {
      const post = XPostSchema.parse(JSON.parse(row.json));
      const text = prepPostText(post);
      if (!text || !post.text.trim()) continue;
      items.push({
        meta: {
          entityType: 'post',
          entityId: post.id,
          sourceUrl: post.url,
          authorHandle: post.author.handle,
        },
        text,
      });
    } catch {
      // Skip corrupted rows silently — matches the existing thread
      // cache behaviour.
    }
  }
  return items;
}

function readCachedThreads(summaryCounter: { commentsCapped: number }): CacheItem[] {
  const rows = getDb().query<{ json: string }, []>('SELECT json FROM threads').all();
  const items: CacheItem[] = [];
  for (const row of rows) {
    let thread: XThread;
    try {
      thread = XThreadSchema.parse(JSON.parse(row.json));
    } catch {
      continue;
    }

    // Root post + author follow-ups.
    for (const post of [thread.rootPost, ...thread.authorPosts]) {
      const text = prepPostText(post);
      if (!post.text.trim()) continue;
      items.push({
        meta: {
          entityType: 'post',
          entityId: post.id,
          sourceUrl: post.url,
          authorHandle: post.author.handle,
        },
        text,
      });
    }

    // Top-level comments only (depth = 0). Threads can be nested
    // tens deep — embedding the full tree on first pass is too
    // expensive. P4.1 / P4.2 can revisit a deeper crawl later.
    const topLevel = thread.comments.filter((c) => (c.depth ?? 0) === 0);
    const taken = topLevel.slice(0, COMMENTS_PER_THREAD_CAP);
    if (topLevel.length > taken.length) {
      summaryCounter.commentsCapped += topLevel.length - taken.length;
    }
    const rootAuthor = thread.rootPost.author.handle;
    for (const comment of taken) {
      if (!comment.text.trim()) continue;
      items.push({
        meta: {
          entityType: 'comment',
          entityId: comment.id,
          sourceUrl: comment.url,
          authorHandle: comment.author.handle,
        },
        text: prepCommentText(comment, rootAuthor),
      });
    }
  }
  return items;
}

function readCachedArticles(): CacheItem[] {
  const rows = getDb()
    .query<{ url_canonical: string; body_json: string }, []>(
      'SELECT url_canonical, body_json FROM article_bodies',
    )
    .all();
  const items: CacheItem[] = [];
  for (const row of rows) {
    let body: { text?: string; title?: string };
    try {
      body = JSON.parse(row.body_json) as { text?: string; title?: string };
    } catch {
      continue;
    }
    if (!body.text || !body.text.trim()) continue;
    const passages = chunkArticleBody(body.text);
    passages.forEach((passage, idx) => {
      items.push({
        meta: {
          entityType: 'article-passage',
          entityId: `article:${row.url_canonical}:chunk:${idx}`,
          sourceUrl: row.url_canonical,
        },
        text: body.title ? `${body.title}\n\n${passage}` : passage,
      });
    });
  }
  return items;
}

// ─── Orchestrator ──────────────────────────────────────────────────

export type EmbedSummary = {
  /** Total cache items considered (pre-dedup). */
  candidates: number;
  /** Items newly embedded this run. */
  embedded: number;
  /** Items skipped because content_hash matched an existing row. */
  skipped: number;
  /** Top-level comments dropped past per-thread cap. */
  commentsCapped: number;
  /** Wall-clock for the run, in ms. */
  durationMs: number;
};

export type EmbedAllOptions = {
  /** Re-embed even items whose content_hash matches. Default: false. */
  skipExisting?: boolean;
};

/**
 * Walk every cached source and embed any item that isn't yet stored
 * (or whose content_hash has drifted). Idempotent — subsequent calls
 * with `skipExisting=true` (the default) embed nothing when nothing
 * has changed.
 *
 * Returns counts + duration. Callers (`xray cache embed`) print this
 * to the user; tests assert on the embedded/skipped fields.
 */
export async function embedAllCached(opts: EmbedAllOptions = {}): Promise<EmbedSummary> {
  const skipExisting = opts.skipExisting ?? true;
  const start = Date.now();
  const summaryCounter = { commentsCapped: 0 };

  // Collect candidates from all sources. We may see the same post id
  // twice (raw posts table + thread cache); de-dup on (entityType,
  // entityId) so we don't waste an embed call per duplicate.
  const all: CacheItem[] = [
    ...readCachedPosts(),
    ...readCachedThreads(summaryCounter),
    ...readCachedArticles(),
  ];

  const dedup = new Map<string, CacheItem>();
  for (const item of all) {
    const key = `${item.meta.entityType}::${item.meta.entityId}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }
  const candidates = Array.from(dedup.values());

  // Hash-and-skip pass — decide which items still need an embed call.
  type Pending = { item: CacheItem; hash: string };
  const pending: Pending[] = [];
  let skipped = 0;
  for (const item of candidates) {
    const hash = hashContent(item.text);
    if (skipExisting) {
      const existing = getEmbedding(item.meta.entityType, item.meta.entityId);
      if (existing && existing.contentHash === hash) {
        skipped++;
        continue;
      }
    }
    pending.push({ item, hash });
  }

  // Run the actual embed calls — sequentially, since the provider
  // already loops internally. We pull from `_depsForTests.embedFn` so
  // tests can swap in a deterministic fake without monkey-patching.
  let embedded = 0;
  if (pending.length > 0) {
    const texts = pending.map((p) => p.item.text);
    const vectors = await _depsForTests.embedFn(texts);
    if (vectors.length !== pending.length) {
      throw new Error(
        `embedAllCached: embedder returned ${vectors.length} vectors for ${pending.length} inputs`,
      );
    }
    for (let i = 0; i < pending.length; i++) {
      const { item, hash } = pending[i]!;
      putEmbedding({
        meta: {
          ...item.meta,
          contentHash: hash,
          snippet: makeSnippet(item.text),
        },
        vector: vectors[i]!,
      });
      embedded++;
    }
  }

  return {
    candidates: candidates.length,
    embedded,
    skipped,
    commentsCapped: summaryCounter.commentsCapped,
    durationMs: Date.now() - start,
  };
}

/** Re-export for `cache info` printing convenience. */
export { embeddingCount as totalEmbeddings } from './store.ts';
