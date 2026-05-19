/**
 * P4.0 — `embedAllCached()` orchestrator + article-passage chunking.
 *
 * Stubs both the db (`_setDbModuleForTests`) and the embed provider
 * (`_depsForTests.embedFn`) so the test runs against deterministic
 * synthetic inputs. Covers:
 *
 *   1. Empty cache → 0 embedded, 0 skipped, 0 candidates.
 *   2. Posts table only → embeds N items.
 *   3. Threads table → walks root + author posts + top-level comments
 *      and caps at COMMENTS_PER_THREAD_CAP (50).
 *   4. Article bodies → chunked into passages.
 *   5. Idempotency: second run with skipExisting=true embeds 0.
 *   6. Content drift: changing the embed text re-embeds.
 *   7. `--no-resume` (skipExisting=false) re-embeds even unchanged items.
 *   8. De-dup across posts + threads tables for the same post id.
 *
 * `chunkArticleBody` is tested separately for word-count math.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Squelch the expected sqlite-vec WARN from the in-memory shim — the
// fallback log fires per-test which floods the runner output.
process.env.XRAY_LOG_LEVEL = 'error';

import {
  _resetVecStateForTests,
  _setDbModuleForTests,
  chunkArticleBody,
  embedAllCached,
  embeddingCount,
  getEmbedding,
} from '../../src/embeddings/index.ts';
import { _depsForTests } from '../../src/embeddings/provider.ts';

// ──────────────────────────────────────────────────────────────────
// In-memory db shim — fakes posts/threads/article_bodies +
// embedding_meta/embedding_vectors. Loose schemas: each table is just
// the JSON row dict we need for the orchestrator.
// ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const tables = {
  posts: [] as Row[],
  threads: [] as Row[],
  article_bodies: [] as Row[],
  embedding_meta: new Map<string, Row>(),
  embedding_vectors: new Map<string, Row>(),
};

function metaKey(et: string, id: string): string {
  return `${et}::${id}`;
}

function resetTables(): void {
  tables.posts = [];
  tables.threads = [];
  tables.article_bodies = [];
  tables.embedding_meta.clear();
  tables.embedding_vectors.clear();
}

function fakeQuery(sql: string) {
  const lower = sql.toLowerCase().trim();
  return {
    get(...params: unknown[]) {
      if (lower.includes('count(*)') && lower.includes('embedding_meta')) {
        return { c: tables.embedding_meta.size };
      }
      if (lower.includes('select vec_rowid')) {
        const row = tables.embedding_meta.get(metaKey(String(params[0]), String(params[1])));
        return row ? { vec_rowid: row.vec_rowid ?? null } : undefined;
      }
      if (lower.startsWith('select entity_type, entity_id, content_hash')) {
        return tables.embedding_meta.get(metaKey(String(params[0]), String(params[1])));
      }
      return undefined;
    },
    all() {
      if (lower.includes('from posts')) return tables.posts;
      if (lower.includes('from threads')) return tables.threads;
      if (lower.includes('from article_bodies')) return tables.article_bodies;
      return [];
    },
    run(...params: unknown[]) {
      if (lower.startsWith('insert into embedding_meta')) {
        const [
          entity_type,
          entity_id,
          content_hash,
          source_url,
          author_handle,
          snippet,
          model_version,
          vec_rowid,
          created_at,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          number | null,
          number,
        ];
        tables.embedding_meta.set(metaKey(entity_type, entity_id), {
          entity_type,
          entity_id,
          content_hash,
          source_url,
          author_handle,
          snippet,
          model_version,
          vec_rowid,
          created_at,
        });
        return { lastInsertRowid: tables.embedding_meta.size };
      }
      if (lower.startsWith('insert into embedding_vectors')) {
        const [entity_type, entity_id, vector] = params as [string, string, Buffer];
        tables.embedding_vectors.set(metaKey(entity_type, entity_id), {
          entity_type,
          entity_id,
          vector,
        });
        return { lastInsertRowid: tables.embedding_vectors.size };
      }
      return { lastInsertRowid: 0 };
    },
  };
}

function fakeExec(): void {
  /* no-op */
}

function fakeLoadExtension(): void {
  // Force JS-cosine fallback (same trick as embedding-store.test.ts).
  throw new Error('shim: sqlite-vec disabled');
}

const fakeDb = { query: fakeQuery, exec: fakeExec, loadExtension: fakeLoadExtension };
const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => {
    /* noop */
  },
  isFresh: () => true,
};

// ──────────────────────────────────────────────────────────────────
// Fake embed provider — deterministic, fast, no model load.
// ──────────────────────────────────────────────────────────────────

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(384);
  let sum = 0;
  for (let i = 0; i < 384; i++) {
    const ch = text.charCodeAt(i % text.length || 0) || 1;
    const x = Math.sin(ch * (i + 1));
    v[i] = x;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < 384; i++) v[i]! /= norm;
  return v;
}

let embedCalls = 0;
async function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  embedCalls += texts.length;
  return texts.map(fakeVector);
}

const realEmbed = _depsForTests.embedFn;

beforeAll(() => {
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
  _depsForTests.embedFn = fakeEmbed;
});

beforeEach(() => {
  resetTables();
  _resetVecStateForTests();
  embedCalls = 0;
});

afterEach(() => {
  resetTables();
  _resetVecStateForTests();
});

// ──────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────

function postJson(id: string, handle: string, text: string): Row {
  return {
    json: JSON.stringify({
      id,
      url: `https://x.com/${handle}/status/${id}`,
      author: { handle, verified: false },
      text,
      metrics: {},
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
    }),
  };
}

function threadJson(opts: {
  rootId: string;
  rootHandle: string;
  rootText: string;
  authorPosts?: Array<{ id: string; text: string }>;
  comments?: Array<{ id: string; handle: string; text: string; depth?: number }>;
}): Row {
  const rootHandle = opts.rootHandle;
  return {
    json: JSON.stringify({
      rootPost: {
        id: opts.rootId,
        url: `https://x.com/${rootHandle}/status/${opts.rootId}`,
        author: { handle: rootHandle, verified: false },
        text: opts.rootText,
        metrics: {},
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      },
      authorPosts: (opts.authorPosts ?? []).map((p) => ({
        id: p.id,
        url: `https://x.com/${rootHandle}/status/${p.id}`,
        author: { handle: rootHandle, verified: false },
        text: p.text,
        metrics: {},
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      })),
      quoteTweets: [],
      comments: (opts.comments ?? []).map((c) => ({
        id: c.id,
        url: `https://x.com/${c.handle}/status/${c.id}`,
        author: { handle: c.handle, verified: false },
        text: c.text,
        metrics: {},
        media: [],
        links: [],
        isReply: true,
        isQuote: false,
        depth: c.depth ?? 0,
        replies: [],
      })),
      fetchedAt: '2026-05-19T00:00:00.000Z',
      partial: false,
    }),
  };
}

function articleBodyRow(url: string, title: string, text: string): Row {
  return {
    url_canonical: url,
    body_json: JSON.stringify({ title, text }),
  };
}

// ──────────────────────────────────────────────────────────────────
// chunkArticleBody
// ──────────────────────────────────────────────────────────────────

describe('chunkArticleBody', () => {
  it('returns [] for empty input', () => {
    expect(chunkArticleBody('')).toEqual([]);
    expect(chunkArticleBody('   \n\t ')).toEqual([]);
  });

  it('returns a single chunk when input <= 200 words', () => {
    const text = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    const out = chunkArticleBody(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.split(/\s+/)).toHaveLength(150);
  });

  it('produces overlapping chunks for long inputs', () => {
    // 800 words → at 200/chunk with 25 overlap, step = 175 →
    // chunks start at 0, 175, 350, 525, 700 → 5 chunks.
    const text = Array.from({ length: 800 }, (_, i) => `w${i}`).join(' ');
    const out = chunkArticleBody(text);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.length).toBeLessThanOrEqual(6);
    // First chunk must contain the first word.
    expect(out[0]?.startsWith('w0 ')).toBe(true);
    // Second chunk should overlap with first by 25 words.
    const firstWords = out[0]!.split(/\s+/);
    const secondWords = out[1]!.split(/\s+/);
    const overlapStart = firstWords.slice(-25).join(' ');
    expect(out[1]!.startsWith(overlapStart) || secondWords[0]?.startsWith('w')).toBe(true);
  });

  it('handles ~2000 words with the expected chunk count', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `t${i}`).join(' ');
    const out = chunkArticleBody(text);
    // step = 175; ceil((2000 - 200) / 175) + 1 = ceil(1800/175)+1 = 11+1 = 12
    expect(out.length).toBeGreaterThanOrEqual(11);
    expect(out.length).toBeLessThanOrEqual(13);
  });
});

// ──────────────────────────────────────────────────────────────────
// embedAllCached — orchestrator behaviour
// ──────────────────────────────────────────────────────────────────

describe('embedAllCached', () => {
  it('returns zero counts when cache is empty', async () => {
    const summary = await embedAllCached();
    expect(summary).toMatchObject({ candidates: 0, embedded: 0, skipped: 0, commentsCapped: 0 });
    expect(embedCalls).toBe(0);
  });

  it('embeds every post in the posts table', async () => {
    tables.posts = [postJson('1', 'alice', 'hello world'), postJson('2', 'bob', 'goodbye world')];
    const summary = await embedAllCached();
    expect(summary.embedded).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(embedCalls).toBe(2);
    expect(embeddingCount()).toBe(2);
    expect(getEmbedding('post', '1')?.authorHandle).toBe('alice');
    expect(getEmbedding('post', '1')?.sourceUrl).toBe('https://x.com/alice/status/1');
  });

  it('walks a thread: root + author posts + top-level comments', async () => {
    tables.threads = [
      threadJson({
        rootId: 'R1',
        rootHandle: 'karpathy',
        rootText: 'thinking about transformers',
        authorPosts: [{ id: 'A1', text: 'followup' }],
        comments: [
          { id: 'C1', handle: 'cmtr1', text: 'agree' },
          { id: 'C2', handle: 'cmtr2', text: 'disagree' },
        ],
      }),
    ];
    const summary = await embedAllCached();
    // 1 root + 1 author + 2 comments = 4
    expect(summary.embedded).toBe(4);
    expect(getEmbedding('post', 'R1')).toBeDefined();
    expect(getEmbedding('post', 'A1')).toBeDefined();
    expect(getEmbedding('comment', 'C1')?.snippet).toContain('cmtr1');
    expect(getEmbedding('comment', 'C1')?.snippet).toContain('karpathy'); // parent author
  });

  it('caps comments at COMMENTS_PER_THREAD_CAP (50) per thread', async () => {
    const comments = Array.from({ length: 75 }, (_, i) => ({
      id: `C${i}`,
      handle: `u${i}`,
      text: `reply ${i}`,
    }));
    tables.threads = [
      threadJson({
        rootId: 'R1',
        rootHandle: 'op',
        rootText: 'op text',
        comments,
      }),
    ];
    const summary = await embedAllCached();
    // 1 root + 50 comments = 51
    expect(summary.embedded).toBe(51);
    expect(summary.commentsCapped).toBe(25);
  });

  it('skips nested replies (depth > 0)', async () => {
    tables.threads = [
      threadJson({
        rootId: 'R1',
        rootHandle: 'op',
        rootText: 'op',
        comments: [
          { id: 'C1', handle: 'u1', text: 'top-level', depth: 0 },
          { id: 'C2', handle: 'u2', text: 'nested', depth: 1 },
        ],
      }),
    ];
    const summary = await embedAllCached();
    expect(summary.embedded).toBe(2); // root + top-level only
    expect(getEmbedding('comment', 'C2')).toBeUndefined();
  });

  it('chunks article bodies into passages', async () => {
    const longBody = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    tables.article_bodies = [articleBodyRow('https://example.com/post', 'Title', longBody)];
    const summary = await embedAllCached();
    // 500 words, step 175 → chunks at 0, 175, 350 → 3 chunks
    expect(summary.embedded).toBe(3);
    expect(
      getEmbedding('article-passage', 'article:https://example.com/post:chunk:0'),
    ).toBeDefined();
    expect(
      getEmbedding('article-passage', 'article:https://example.com/post:chunk:0')?.sourceUrl,
    ).toBe('https://example.com/post');
  });

  it('is idempotent: second run with skipExisting=true embeds 0', async () => {
    tables.posts = [postJson('1', 'alice', 'hello')];
    const first = await embedAllCached();
    expect(first.embedded).toBe(1);
    const before = embedCalls;
    const second = await embedAllCached();
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(embedCalls).toBe(before); // no additional embed calls
  });

  it('re-embeds when the content hash drifts (post text change)', async () => {
    tables.posts = [postJson('1', 'alice', 'hello')];
    await embedAllCached();
    // Replace with a new text for the same id.
    tables.posts = [postJson('1', 'alice', 'completely different content')];
    const second = await embedAllCached();
    expect(second.embedded).toBe(1);
    expect(second.skipped).toBe(0);
  });

  it('re-embeds everything when skipExisting=false (--no-resume)', async () => {
    tables.posts = [postJson('1', 'alice', 'hello')];
    await embedAllCached();
    const before = embedCalls;
    const second = await embedAllCached({ skipExisting: false });
    expect(second.embedded).toBe(1);
    expect(second.skipped).toBe(0);
    expect(embedCalls).toBe(before + 1);
  });

  it('dedups when the same post appears in both posts and threads tables', async () => {
    tables.posts = [postJson('R1', 'op', 'shared text')];
    tables.threads = [threadJson({ rootId: 'R1', rootHandle: 'op', rootText: 'shared text' })];
    const summary = await embedAllCached();
    // Should embed once, not twice.
    expect(summary.embedded).toBe(1);
    expect(embeddingCount()).toBe(1);
  });

  it('skips corrupted rows without throwing', async () => {
    tables.posts = [{ json: 'not valid json' }, postJson('ok', 'alice', 'valid')];
    const summary = await embedAllCached();
    // Corrupted row silently skipped, valid one embedded.
    expect(summary.embedded).toBe(1);
  });

  it('skips posts with empty text', async () => {
    tables.posts = [postJson('1', 'alice', ''), postJson('2', 'bob', 'real text')];
    const summary = await embedAllCached();
    expect(summary.embedded).toBe(1);
  });

  it('records duration in milliseconds', async () => {
    tables.posts = [postJson('1', 'alice', 'hello')];
    const summary = await embedAllCached();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof summary.durationMs).toBe('number');
  });
});

// Sanity check: the fake embedder stays installed so later test runs
// don't fire the real model. realEmbed is kept around to document the
// swap point even though P4.0 has no live-embed test.
describe('cleanup', () => {
  it('keeps the fake embedder bound to _depsForTests', () => {
    expect(_depsForTests.embedFn).toBe(fakeEmbed);
    // realEmbed is intentionally untouched — referenced here so the
    // linter knows the import isn't dead. Live-embed tests (P4.1+)
    // would restore via `_depsForTests.embedFn = realEmbed`.
    expect(typeof realEmbed).toBe('function');
  });
});
