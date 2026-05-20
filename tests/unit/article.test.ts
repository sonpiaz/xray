/**
 * P3.0 — Article module tests.
 *
 * Covers the four sub-modules and the orchestrator:
 *   1. `detectArticleSource` — URL classification matrix
 *   2. `parseXArticle`       — happy path + missing-field failures
 *   3. `summarizeArticle`    — prompt assembly + cost estimate
 *   4. Cache round-trip      — body + summary tables, TTL stale read
 *   5. `analyzeArticle`      — orchestrator cache hit + noCache bypass
 *
 * The SQLite tables are exercised via the same in-memory shim pattern
 * `video-cache.test.ts` uses: inject a fake db module via
 * `_setDbModuleForTests` before any cache helper runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _setDbModuleForTests,
  articleCacheInfo,
  clearArticleCache,
  getCachedArticleBody,
  getCachedArticleSummary,
  putCachedArticleBody,
  putCachedArticleSummary,
} from '../../src/article/cache.ts';
import { ArticleError, ArticleParseError, detectArticleSource } from '../../src/article/detect.ts';
import { parseXArticle } from '../../src/article/parse-x-article.ts';
import {
  SUMMARIZE_PROMPT_VERSION,
  buildSummarizePrompts,
  estimateSummarizeCost,
} from '../../src/article/summarize.ts';
import { resetConfigForTests } from '../../src/core/config.ts';
import {
  analyzeArticle,
  _orchestratorDeps as articleDeps,
} from '../../src/intelligence/article.ts';
import type { ArticleBody, ArticleSummary } from '../../src/models/article.ts';

// ──────────────────────────────────────────────────────────────────────
// In-memory db shim — implements just enough of bun:sqlite for the
// article cache module's exact SQL statements.
// ──────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type TableName = 'article_bodies' | 'article_summaries';

const tables: Record<TableName, Map<string, Row>> = {
  article_bodies: new Map(),
  article_summaries: new Map(),
};

function resetTables(): void {
  for (const t of Object.keys(tables) as TableName[]) tables[t].clear();
}

function pickTable(sql: string): TableName {
  for (const name of Object.keys(tables) as TableName[]) {
    if (sql.includes(name)) return name;
  }
  throw new Error(`shim: unknown table in SQL: ${sql.slice(0, 80)}`);
}

function fakeQuery(sql: string) {
  const lower = sql.toLowerCase().trim();
  return {
    get(...params: unknown[]) {
      if (!lower.startsWith('select')) return undefined;
      const table = pickTable(sql);
      if (lower.includes('count(*)')) {
        return { c: tables[table]!.size };
      }
      if (table === 'article_summaries') {
        const key = `${String(params[0])}::${String(params[1] ?? '')}`;
        return tables[table]!.get(key);
      }
      const key = String(params[0]);
      return tables[table]!.get(key);
    },
    all() {
      const table = pickTable(sql);
      return Array.from(tables[table]!.values());
    },
    run(...params: unknown[]) {
      const table = pickTable(sql);
      if (lower.startsWith('insert')) {
        if (table === 'article_bodies') {
          const [url_canonical, source, body_json, fetched_at] = params as [
            string,
            string,
            string,
            number,
          ];
          tables[table]!.set(url_canonical, {
            url_canonical,
            source,
            body_json,
            fetched_at,
          });
        } else if (table === 'article_summaries') {
          const [url_canonical, tweet_context_hash, summary_json, model, created_at] = params as [
            string,
            string,
            string,
            string,
            number,
          ];
          const key = `${url_canonical}::${tweet_context_hash}`;
          tables[table]!.set(key, {
            url_canonical,
            tweet_context_hash,
            summary_json,
            model,
            created_at,
          });
        }
      } else if (lower.startsWith('delete')) {
        // Whole-table delete handled in fakeExec.
        if (table === 'article_summaries') {
          const key = `${String(params[0])}::${String(params[1] ?? '')}`;
          tables[table]!.delete(key);
        } else {
          tables[table]!.delete(String(params[0]));
        }
      }
    },
  };
}

function fakeExec(sql: string): void {
  const lower = sql.toLowerCase().trim();
  if (lower.startsWith('delete from')) {
    const table = pickTable(sql);
    tables[table]!.clear();
  }
  // Migrations / pragmas are silent no-ops in the shim.
}

const fakeDb = { query: fakeQuery, exec: fakeExec };

const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => {
    /* noop */
  },
  isFresh: (ms: number) => Date.now() - ms < 86400 * 1000,
};

beforeAll(() => {
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
});

afterAll(() => {
  _setDbModuleForTests(undefined);
});

beforeEach(() => {
  resetTables();
  resetConfigForTests();
});

// ──────────────────────────────────────────────────────────────────────
// 1. detectArticleSource
// ──────────────────────────────────────────────────────────────────────

describe('detectArticleSource', () => {
  it('classifies x.com/i/article/<id> as x-article', () => {
    expect(detectArticleSource('https://x.com/i/article/1234567890')).toBe('x-article');
  });

  it('classifies x.com/<handle>/articles/<id> as x-article', () => {
    expect(detectArticleSource('https://x.com/karpathy/articles/abc')).toBe('x-article');
  });

  it('classifies x.com/<handle>/article/<id> (singular) as x-article', () => {
    expect(detectArticleSource('https://x.com/karpathy/article/abc')).toBe('x-article');
  });

  it('classifies twitter.com mirror as x-article', () => {
    expect(detectArticleSource('https://twitter.com/i/article/12345')).toBe('x-article');
  });

  it('returns null for bare tweet URL (status, not article)', () => {
    expect(detectArticleSource('https://x.com/karpathy/status/12345')).toBeNull();
  });

  it('classifies an arbitrary HTTPS URL as external-html', () => {
    expect(detectArticleSource('https://stratechery.com/2026/some-post/')).toBe('external-html');
  });

  it('classifies a Substack URL as external-html', () => {
    expect(detectArticleSource('https://newsletter.example.com/p/post')).toBe('external-html');
  });

  it('returns null for a non-URL input', () => {
    expect(detectArticleSource('not a url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectArticleSource('')).toBeNull();
  });

  it('returns null for non-HTTP protocols (mailto)', () => {
    expect(detectArticleSource('mailto:foo@example.com')).toBeNull();
  });

  it('returns null for a PDF URL', () => {
    expect(detectArticleSource('https://example.com/paper.pdf')).toBeNull();
  });

  it('returns null for an image URL', () => {
    expect(detectArticleSource('https://example.com/photo.jpg')).toBeNull();
  });

  it('returns null for a video URL', () => {
    expect(detectArticleSource('https://example.com/clip.mp4')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. parseXArticle
// ──────────────────────────────────────────────────────────────────────

describe('parseXArticle', () => {
  const fixturePath = join(__dirname, '..', 'fixtures', 'x-article-card.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { card: unknown };

  it('extracts title + body from a real-shape fixture', () => {
    const body = parseXArticle(fixture);
    expect(body.title).toBe('How LLMs Actually Work');
    expect(body.text).toContain('Large language models are transformer-based');
    expect(body.wordCount).toBeGreaterThan(50);
    expect(body.contentSource).toBe('x-article-card');
  });

  it('extracts byline + publishedAt when present', () => {
    const body = parseXArticle(fixture);
    expect(body.byline).toBe('Jane Smith');
    expect(body.publishedAt).toBe('2026-05-15T14:30:00.000Z');
  });

  it('accepts a raw card sub-object directly', () => {
    const body = parseXArticle(fixture.card);
    expect(body.title).toBe('How LLMs Actually Work');
  });

  it('throws ArticleParseError when no binding_values exist', () => {
    expect(() => parseXArticle({ card: { legacy: {} } })).toThrow(ArticleParseError);
  });

  it('throws ArticleParseError when the card lacks a body field', () => {
    const partial = {
      card: {
        legacy: {
          binding_values: [{ key: 'title', value: { string_value: 'Headline only' } }],
        },
      },
    };
    expect(() => parseXArticle(partial)).toThrow(ArticleParseError);
  });

  it('throws ArticleParseError when input is undefined', () => {
    expect(() => parseXArticle(undefined)).toThrow(ArticleParseError);
  });

  it('defaults title to "Untitled" when title binding missing but body present', () => {
    const noTitle = {
      card: {
        legacy: {
          binding_values: [
            { key: 'body_text', value: { string_value: 'Some body content here.' } },
          ],
        },
      },
    };
    const body = parseXArticle(noTitle);
    expect(body.title).toBe('Untitled');
    expect(body.text).toBe('Some body content here.');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. summarize prompt + cost
// ──────────────────────────────────────────────────────────────────────

describe('buildSummarizePrompts', () => {
  const body: ArticleBody = {
    title: 'Demo',
    text: 'Sample body for the prompt test.',
    wordCount: 6,
    contentSource: 'x-article-card',
  };

  it('includes title, byline + JSON instructions', () => {
    const { system, user } = buildSummarizePrompts(
      { ...body, byline: 'AB', publishedAt: '2026-05-19T00:00:00.000Z' },
      undefined,
    );
    expect(system).toContain('summary');
    expect(system).toContain('keyPoints');
    expect(user).toContain('ARTICLE TITLE: Demo');
    expect(user).toContain('BYLINE: AB');
    expect(user).toContain('PUBLISHED: 2026-05-19');
    expect(user).toContain('Sample body for the prompt test.');
  });

  it('omits BYLINE/PUBLISHED lines when not provided', () => {
    const { user } = buildSummarizePrompts(body, undefined);
    expect(user).not.toContain('BYLINE');
    expect(user).not.toContain('PUBLISHED');
  });

  it('includes tweet context when provided', () => {
    const { user } = buildSummarizePrompts(body, { text: 'My tweet about it.' });
    expect(user).toContain('TWEET CONTEXT');
    expect(user).toContain('My tweet about it.');
  });

  it('truncates very long article bodies', () => {
    const longBody: ArticleBody = { ...body, text: 'x'.repeat(200_000), wordCount: 200_000 };
    const { user } = buildSummarizePrompts(longBody, undefined);
    expect(user).toContain('[truncated');
    expect(user.length).toBeLessThan(110_000);
  });
});

describe('estimateSummarizeCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(estimateSummarizeCost(0, 0)).toBe(0);
  });

  it('weights input + output prices correctly', () => {
    // 10K input at $0.0001/1K + 1K output at $0.0003/1K = $0.001 + $0.0003 = $0.0013
    expect(estimateSummarizeCost(10_000, 1_000)).toBeCloseTo(0.0013, 5);
  });

  it('returns a positive number for non-zero usage', () => {
    expect(estimateSummarizeCost(500, 200)).toBeGreaterThan(0);
  });
});

describe('SUMMARIZE_PROMPT_VERSION', () => {
  it('exports a non-empty version string', () => {
    expect(typeof SUMMARIZE_PROMPT_VERSION).toBe('string');
    expect(SUMMARIZE_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Cache round-trip + TTL
// ──────────────────────────────────────────────────────────────────────

describe('article cache', () => {
  const url = 'https://x.com/i/article/abc';
  const body: ArticleBody = {
    title: 'Demo',
    text: 'short',
    wordCount: 1,
    contentSource: 'x-article-card',
  };
  const summary: ArticleSummary = {
    url,
    canonicalUrl: url,
    source: 'x-article',
    body,
    summary: 'Demo summary.',
    keyPoints: ['point one'],
    crossReferences: [],
    estimatedCostUsd: 0.001,
    costBreakdown: { summarize: 0.001 },
    partial: false,
    errors: [],
    generatedAt: new Date().toISOString(),
  };

  it('round-trips a body put/get', () => {
    putCachedArticleBody({ urlCanonical: url, source: 'x-article', body });
    const got = getCachedArticleBody(url);
    expect(got?.title).toBe('Demo');
    expect(got?.text).toBe('short');
  });

  it('returns undefined on body miss', () => {
    expect(getCachedArticleBody('https://x.com/i/article/missing')).toBeUndefined();
  });

  it('UPSERTs on duplicate URL (latest wins)', () => {
    putCachedArticleBody({ urlCanonical: url, source: 'x-article', body });
    putCachedArticleBody({
      urlCanonical: url,
      source: 'x-article',
      body: { ...body, title: 'Updated' },
    });
    expect(getCachedArticleBody(url)?.title).toBe('Updated');
  });

  it('returns undefined for stale rows (TTL expired)', () => {
    tables.article_bodies.set(url, {
      url_canonical: url,
      source: 'x-article',
      body_json: JSON.stringify(body),
      fetched_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
    });
    expect(getCachedArticleBody(url)).toBeUndefined();
  });

  it('round-trips a summary put/get with empty tweet context hash', () => {
    putCachedArticleSummary({
      urlCanonical: url,
      tweetContextHash: '',
      summary,
      model: 'gemini-2.5-flash',
    });
    const got = getCachedArticleSummary({ urlCanonical: url, tweetContextHash: '' });
    expect(got?.summary).toBe('Demo summary.');
    expect(got?.keyPoints).toEqual(['point one']);
  });

  it('isolates summary cache by tweet_context_hash', () => {
    putCachedArticleSummary({
      urlCanonical: url,
      tweetContextHash: 'aaa',
      summary,
      model: 'm',
    });
    expect(getCachedArticleSummary({ urlCanonical: url, tweetContextHash: 'aaa' })).toBeDefined();
    expect(getCachedArticleSummary({ urlCanonical: url, tweetContextHash: 'bbb' })).toBeUndefined();
  });

  it('articleCacheInfo reports counts', () => {
    putCachedArticleBody({ urlCanonical: url, source: 'x-article', body });
    putCachedArticleSummary({
      urlCanonical: url,
      tweetContextHash: '',
      summary,
      model: 'm',
    });
    const info = articleCacheInfo();
    expect(info.bodyCount).toBe(1);
    expect(info.summaryCount).toBe(1);
  });

  it('clearArticleCache empties both tables', () => {
    putCachedArticleBody({ urlCanonical: url, source: 'x-article', body });
    putCachedArticleSummary({
      urlCanonical: url,
      tweetContextHash: '',
      summary,
      model: 'm',
    });
    clearArticleCache();
    expect(articleCacheInfo().bodyCount).toBe(0);
    expect(articleCacheInfo().summaryCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. analyzeArticle orchestrator
// ──────────────────────────────────────────────────────────────────────

describe('analyzeArticle orchestrator', () => {
  const url = 'https://x.com/i/article/orchestrator';
  const fixturePath = join(__dirname, '..', 'fixtures', 'x-article-card.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { card: unknown };

  let restore: Array<() => void>;

  beforeEach(() => {
    restore = [];
  });

  afterEach(() => {
    for (const r of restore.splice(0)) r();
  });

  function patch<K extends keyof typeof articleDeps>(key: K, impl: (typeof articleDeps)[K]): void {
    const orig = articleDeps[key];
    articleDeps[key] = impl;
    restore.push(() => {
      articleDeps[key] = orig;
    });
  }

  it('throws ArticleError on unclassifiable URL', async () => {
    await expect(analyzeArticle({ url: 'not-a-url' })).rejects.toThrow(ArticleError);
  });

  it('returns a body-only ArticleSummary in raw mode (no Kyma call)', async () => {
    const summarizeSpy = vi.fn(async () => {
      throw new Error('should not be called in raw mode');
    });
    patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

    const result = await analyzeArticle({
      url,
      raw: true,
      cardData: fixture,
      noCache: true,
    });
    expect(result.body.title).toBe('How LLMs Actually Work');
    expect(result.summary).toBeUndefined();
    expect(summarizeSpy).not.toHaveBeenCalled();
  });

  it('calls summarize when Kyma key is set + raw is false', async () => {
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();
    try {
      const summarizeSpy = vi.fn(async () => ({
        summary: 'A test summary.',
        keyPoints: ['k1', 'k2', 'k3'],
        wordCount: 100,
        estimatedCostUsd: 0.0042,
        cached: false,
        model: 'gemini-2.5-flash',
      }));
      patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

      const result = await analyzeArticle({
        url,
        cardData: fixture,
        noCache: true,
      });
      expect(summarizeSpy).toHaveBeenCalledTimes(1);
      expect(result.summary).toBe('A test summary.');
      expect(result.keyPoints).toEqual(['k1', 'k2', 'k3']);
      expect(result.estimatedCostUsd).toBe(0.0042);
      expect(result.costBreakdown?.summarize).toBe(0.0042);
      expect(result.partial).toBe(false);
    } finally {
      // biome-ignore lint/performance/noDelete: env var unset != "undefined"
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('marks partial=true + skips summarize when Kyma key missing', async () => {
    const origKey = process.env.KYMA_API_KEY;
    // biome-ignore lint/performance/noDelete: env var unset != "undefined"
    delete process.env.KYMA_API_KEY;
    resetConfigForTests();
    try {
      const summarizeSpy = vi.fn(async () => {
        throw new Error('should not run when Kyma key missing');
      });
      patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

      const result = await analyzeArticle({ url, cardData: fixture, noCache: true });
      expect(result.partial).toBe(true);
      expect(result.errors.some((e) => e.includes('KYMA_API_KEY'))).toBe(true);
      expect(result.summary).toBeUndefined();
      expect(summarizeSpy).not.toHaveBeenCalled();
    } finally {
      if (origKey !== undefined) process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('cache hit short-circuits the Kyma call', async () => {
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();
    try {
      const cachedSummary: ArticleSummary = {
        url,
        canonicalUrl: url,
        source: 'x-article',
        body: {
          title: 'Cached',
          text: 'cached',
          wordCount: 1,
          contentSource: 'x-article-card',
        },
        summary: 'Cached summary',
        keyPoints: ['cached'],
        crossReferences: [],
        estimatedCostUsd: 0,
        costBreakdown: { summarize: 0 },
        partial: false,
        errors: [],
        generatedAt: new Date().toISOString(),
      };
      putCachedArticleSummary({
        urlCanonical: url,
        tweetContextHash: '',
        summary: cachedSummary,
        model: 'm',
      });

      const summarizeSpy = vi.fn(async () => {
        throw new Error('cache hit should skip summarize');
      });
      patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

      const result = await analyzeArticle({ url, cardData: fixture });
      expect(result.summary).toBe('Cached summary');
      expect(summarizeSpy).not.toHaveBeenCalled();
    } finally {
      // biome-ignore lint/performance/noDelete: env var unset != "undefined"
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('noCache forces a fresh summarize call even when cache is populated', async () => {
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();
    try {
      // Pre-populate cache (should be ignored).
      const cachedSummary: ArticleSummary = {
        url,
        canonicalUrl: url,
        source: 'x-article',
        body: {
          title: 'stale',
          text: 'stale',
          wordCount: 1,
          contentSource: 'x-article-card',
        },
        summary: 'stale summary',
        keyPoints: [],
        crossReferences: [],
        estimatedCostUsd: 0,
        costBreakdown: { summarize: 0 },
        partial: false,
        errors: [],
        generatedAt: new Date().toISOString(),
      };
      putCachedArticleSummary({
        urlCanonical: url,
        tweetContextHash: '',
        summary: cachedSummary,
        model: 'm',
      });

      const summarizeSpy = vi.fn(async () => ({
        summary: 'fresh summary',
        keyPoints: ['fresh'],
        wordCount: 10,
        estimatedCostUsd: 0.001,
        cached: false,
        model: 'gemini-2.5-flash',
      }));
      patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

      const result = await analyzeArticle({ url, cardData: fixture, noCache: true });
      expect(summarizeSpy).toHaveBeenCalledTimes(1);
      expect(result.summary).toBe('fresh summary');
    } finally {
      // biome-ignore lint/performance/noDelete: env var unset != "undefined"
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('partial=true + error string when card data has no body', async () => {
    const result = await analyzeArticle({
      url,
      cardData: { card: { legacy: { binding_values: [] } } },
      noCache: true,
      raw: true,
    });
    expect(result.partial).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/parse/i);
  });

  it('writes body + summary to cache on success', async () => {
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();
    try {
      const summarizeSpy = vi.fn(async () => ({
        summary: 'fresh',
        keyPoints: ['k'],
        wordCount: 10,
        estimatedCostUsd: 0.001,
        cached: false,
        model: 'gemini-2.5-flash',
      }));
      patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

      await analyzeArticle({ url, cardData: fixture });
      expect(getCachedArticleBody(url)).toBeDefined();
      expect(getCachedArticleSummary({ urlCanonical: url, tweetContextHash: '' })).toBeDefined();
    } finally {
      // biome-ignore lint/performance/noDelete: env var unset != "undefined"
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // P3.2 — Cross-reference stage wiring
  // ──────────────────────────────────────────────────────────────────

  describe('P3.2 cross-reference stage', () => {
    it('calls crossReferenceArticle when tweetContext supplied + Kyma key set', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        patch(
          'summarizeArticle',
          vi.fn(async () => ({
            summary: 'demo summary',
            keyPoints: ['k1', 'k2'],
            wordCount: 100,
            estimatedCostUsd: 0.002,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.summarizeArticle,
        );
        const crxSpy = vi.fn(async () => ({
          crossReferences: [
            {
              tweetClaim: 'Scaling is everything',
              articlePassage: 'Diminishing returns past 70B parameters...',
              relationship: 'contradicts' as const,
              confidence: 0.9,
            },
          ],
          estimatedCostUsd: 0.005,
          cached: false,
          model: 'gemini-2.5-flash',
        }));
        patch(
          'crossReferenceArticle',
          crxSpy as unknown as typeof articleDeps.crossReferenceArticle,
        );

        const result = await analyzeArticle({
          url,
          cardData: fixture,
          noCache: true,
          tweetContext: {
            text: 'Scaling is everything. Just keep adding parameters.',
            postId: '999',
          },
        });

        expect(crxSpy).toHaveBeenCalledTimes(1);
        expect(result.crossReferences).toHaveLength(1);
        expect(result.crossReferences?.[0]?.relationship).toBe('contradicts');
        expect(result.costBreakdown?.crossReference).toBe(0.005);
        // Total cost = summarize + cross-reference.
        expect(result.estimatedCostUsd).toBeCloseTo(0.007, 5);
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });

    it('skips cross-reference when tweetContext is absent', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        patch(
          'summarizeArticle',
          vi.fn(async () => ({
            summary: 'standalone',
            keyPoints: [],
            wordCount: 100,
            estimatedCostUsd: 0.001,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.summarizeArticle,
        );
        const crxSpy = vi.fn(async () => {
          throw new Error('should not run in standalone mode');
        });
        patch(
          'crossReferenceArticle',
          crxSpy as unknown as typeof articleDeps.crossReferenceArticle,
        );

        const result = await analyzeArticle({ url, cardData: fixture, noCache: true });
        expect(crxSpy).not.toHaveBeenCalled();
        expect(result.crossReferences).toEqual([]);
        expect(result.costBreakdown?.crossReference).toBeUndefined();
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });

    it('skips cross-reference when raw=true even with tweetContext', async () => {
      const crxSpy = vi.fn(async () => {
        throw new Error('should not run in raw mode');
      });
      patch('crossReferenceArticle', crxSpy as unknown as typeof articleDeps.crossReferenceArticle);

      const result = await analyzeArticle({
        url,
        cardData: fixture,
        raw: true,
        noCache: true,
        tweetContext: { text: 'thesis', postId: '999' },
      });
      expect(crxSpy).not.toHaveBeenCalled();
      expect(result.crossReferences).toEqual([]);
    });

    it('degrades to partial=true when cross-reference throws but summary succeeded', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        patch(
          'summarizeArticle',
          vi.fn(async () => ({
            summary: 'summary fine',
            keyPoints: [],
            wordCount: 50,
            estimatedCostUsd: 0.001,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.summarizeArticle,
        );
        patch(
          'crossReferenceArticle',
          vi.fn(async () => {
            throw new Error('kyma 500');
          }) as unknown as typeof articleDeps.crossReferenceArticle,
        );

        const result = await analyzeArticle({
          url,
          cardData: fixture,
          noCache: true,
          tweetContext: { text: 'thesis', postId: '999' },
        });
        expect(result.summary).toBe('summary fine');
        expect(result.crossReferences).toEqual([]);
        expect(result.partial).toBe(true);
        expect(result.errors.some((e) => e.includes('cross-reference'))).toBe(true);
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });

    it('uses different cache keys for different tweet contexts', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        // Pre-populate summary cache for a SPECIFIC tweet context hash.
        const cached: ArticleSummary = {
          url,
          canonicalUrl: url,
          source: 'x-article',
          body: { title: 't', text: 't', wordCount: 1, contentSource: 'x-article-card' },
          summary: 'cached for thesisA',
          keyPoints: [],
          crossReferences: [],
          estimatedCostUsd: 0,
          costBreakdown: {},
          partial: false,
          errors: [],
          generatedAt: new Date().toISOString(),
        };
        // Hash for 'thesis A' is computed via the orchestrator's
        // hashTweetContext — derive it by reusing the same djb2 logic.
        function hash(t: string): string {
          let h = 5381;
          for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
          return h.toString(36);
        }
        putCachedArticleSummary({
          urlCanonical: url,
          tweetContextHash: hash('thesis A'),
          summary: cached,
          model: 'm',
        });

        const summarizeSpy = vi.fn(async () => ({
          summary: 'fresh for thesisB',
          keyPoints: [],
          wordCount: 10,
          estimatedCostUsd: 0.001,
          cached: false,
          model: 'gemini-2.5-flash',
        }));
        patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);
        patch(
          'crossReferenceArticle',
          vi.fn(async () => ({
            crossReferences: [],
            estimatedCostUsd: 0,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.crossReferenceArticle,
        );

        // First call hits the cache.
        const a = await analyzeArticle({
          url,
          cardData: fixture,
          tweetContext: { text: 'thesis A', postId: '1' },
        });
        expect(a.summary).toBe('cached for thesisA');
        expect(summarizeSpy).not.toHaveBeenCalled();

        // Second call (different thesis) misses the cache → fresh summarize.
        const b = await analyzeArticle({
          url,
          cardData: fixture,
          tweetContext: { text: 'thesis B', postId: '1' },
        });
        expect(b.summary).toBe('fresh for thesisB');
        expect(summarizeSpy).toHaveBeenCalledTimes(1);
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });

    it('persists crossReferences into the summary cache', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        patch(
          'summarizeArticle',
          vi.fn(async () => ({
            summary: 's',
            keyPoints: [],
            wordCount: 10,
            estimatedCostUsd: 0.001,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.summarizeArticle,
        );
        patch(
          'crossReferenceArticle',
          vi.fn(async () => ({
            crossReferences: [
              {
                tweetClaim: 'c',
                articlePassage: 'p',
                relationship: 'supports' as const,
                confidence: 0.8,
              },
            ],
            estimatedCostUsd: 0.003,
            cached: false,
            model: 'gemini-2.5-flash',
          })) as unknown as typeof articleDeps.crossReferenceArticle,
        );

        const tweetContext = { text: 'thesis here', postId: '777' };
        const result = await analyzeArticle({ url, cardData: fixture, tweetContext });
        expect(result.crossReferences).toHaveLength(1);

        // Cache lookup should return the same object.
        function hash(t: string): string {
          let h = 5381;
          for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
          return h.toString(36);
        }
        const cached = getCachedArticleSummary({
          urlCanonical: url,
          tweetContextHash: hash('thesis here'),
        });
        expect(cached?.crossReferences).toHaveLength(1);
        expect(cached?.crossReferences?.[0]?.relationship).toBe('supports');
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // v1.0.1 — structured XArticleCard fast path
  // ────────────────────────────────────────────────────────────────────

  describe('analyzeArticle — structured XArticleCard fast path (v1.0.1)', () => {
    it('skips parseXArticle when cardData has bodyText already extracted', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        // Spy on parseXArticle — the structured fast path must not call it.
        const parseSpy = vi.fn(() => {
          throw new Error('parseXArticle should NOT run on structured cardData');
        });
        patch('parseXArticle', parseSpy as unknown as typeof articleDeps.parseXArticle);
        const summarizeSpy = vi.fn(async () => ({
          summary: 'Pre-extracted body summary.',
          keyPoints: ['p1', 'p2'],
          wordCount: 20,
          estimatedCostUsd: 0.001,
          cached: false,
          model: 'gemini-2.5-flash',
        }));
        patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);

        const structured = {
          url,
          title: 'Pre-Extracted Title',
          bodyText: 'Article body that the parser already pulled out of binding_values.',
          byline: 'Test Author',
          publishedAt: '2026-05-19T00:00:00.000Z',
        };
        const result = await analyzeArticle({
          url,
          cardData: structured,
          noCache: true,
        });
        expect(parseSpy).not.toHaveBeenCalled();
        expect(result.body.title).toBe('Pre-Extracted Title');
        expect(result.body.text).toContain('Article body that the parser');
        expect(result.body.byline).toBe('Test Author');
        expect(result.body.publishedAt).toBe('2026-05-19T00:00:00.000Z');
        expect(result.body.wordCount).toBeGreaterThan(0);
        expect(result.summary).toBe('Pre-extracted body summary.');
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });

    it('falls through to parseXArticle when cardData is the raw card shape (no bodyText)', async () => {
      const origKey = process.env.KYMA_API_KEY;
      process.env.KYMA_API_KEY = 'test-key';
      resetConfigForTests();
      try {
        const summarizeSpy = vi.fn(async () => ({
          summary: 'Summary from parseXArticle path.',
          keyPoints: [],
          wordCount: 50,
          estimatedCostUsd: 0.001,
          cached: false,
          model: 'gemini-2.5-flash',
        }));
        patch('summarizeArticle', summarizeSpy as unknown as typeof articleDeps.summarizeArticle);
        // Passing the raw card (with `legacy.binding_values`) — fast path
        // must skip + the standard parseXArticle path must run.
        const result = await analyzeArticle({
          url,
          cardData: fixture,
          noCache: true,
        });
        expect(result.body.title).toBe('How LLMs Actually Work');
        expect(result.summary).toBe('Summary from parseXArticle path.');
      } finally {
        // biome-ignore lint/performance/noDelete: env var unset != "undefined"
        if (origKey === undefined) delete process.env.KYMA_API_KEY;
        else process.env.KYMA_API_KEY = origKey;
        resetConfigForTests();
      }
    });
  });
});
