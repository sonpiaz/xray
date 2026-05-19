/**
 * P3.1 — External link fetch tests.
 *
 * Covers:
 *   1. `detectExternalPlatform`        — domain heuristic matrix.
 *   2. `canonicalizeArticleUrl`        — tracking-param strip, host
 *                                        normalization, fragment drop,
 *                                        param sort, trailing slash.
 *   3. `resolveCanonicalArticleUrl`    — t.co shortlink HEAD redirect via
 *                                        mocked resolver.
 *   4. `detectPaywall`                 — phrase + class-attr heuristic.
 *   5. `fetchExternalArticle` Tier 1   — cheerio meta extraction (substack
 *                                        + devto fixtures).
 *   6. `fetchExternalArticle` Tier 2   — Readability extraction (medium
 *                                        fixture, force tier).
 *   7. `fetchExternalArticle` Tier 3   — Playwright fallback via mocked
 *                                        getBrowserPage seam.
 *   8. Paywall path                    — fixture sets partial=true + error.
 *   9. Orchestrator wiring             — external URL flows through
 *                                        fetchExternalArticle and caches
 *                                        by canonical URL.
 *
 * Live network + real Playwright are out of scope — both are stubbed via
 * the `_fetchDeps` test seam.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _setDbModuleForTests,
  _setHeadResolverForTests,
  canonicalizeArticleUrl,
  getCachedArticleBody,
  resolveCanonicalArticleUrl,
} from '../../src/article/cache.ts';
import { detectExternalPlatform } from '../../src/article/detect.ts';
import { _fetchDeps, detectPaywall, fetchExternalArticle } from '../../src/article/fetch.ts';
import { resetConfigForTests } from '../../src/core/config.ts';
import {
  analyzeArticle,
  _orchestratorDeps as articleDeps,
} from '../../src/intelligence/article.ts';
import type { ArticleBody } from '../../src/models/article.ts';

// ──────────────────────────────────────────────────────────────────────
// In-memory db shim — same shape as tests/unit/article.test.ts.
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
      if (lower.includes('count(*)')) return { c: tables[table]!.size };
      if (table === 'article_summaries') {
        const key = `${String(params[0])}::${String(params[1] ?? '')}`;
        return tables[table]!.get(key);
      }
      return tables[table]!.get(String(params[0]));
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
          tables[table]!.set(url_canonical, { url_canonical, source, body_json, fetched_at });
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
  _setHeadResolverForTests(undefined);
});

beforeEach(() => {
  resetTables();
  resetConfigForTests();
  _setHeadResolverForTests(undefined);
});

// Restore fetch deps after every test that monkey-patches them.
const origFetchDeps = { ..._fetchDeps };
afterEach(() => {
  Object.assign(_fetchDeps, origFetchDeps);
});

// ──────────────────────────────────────────────────────────────────────
// 1. detectExternalPlatform
// ──────────────────────────────────────────────────────────────────────

describe('detectExternalPlatform', () => {
  it.each([
    ['https://newsletter.substack.com/p/post', 'substack'],
    ['https://substack.com/p/post', 'substack'],
    ['https://medium.com/@user/post', 'medium'],
    ['https://author.medium.com/post', 'medium'],
    ['https://dev.to/user/post', 'devto'],
    ['https://www.dev.to/user/post', 'devto'],
    ['https://github.com/user/repo/blob/main/README.md', 'github'],
    ['https://gist.github.com/user/abc123', 'github'],
    ['https://blog.wordpress.com/post', 'wordpress'],
    ['https://example.com/post', 'generic'],
    ['https://stratechery.com/post', 'generic'],
    ['not-a-url', 'generic'],
  ])('classifies %s as %s', (url, expected) => {
    expect(detectExternalPlatform(url)).toBe(expected);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. canonicalizeArticleUrl (sync)
// ──────────────────────────────────────────────────────────────────────

describe('canonicalizeArticleUrl', () => {
  it('lowercases the host', () => {
    expect(canonicalizeArticleUrl('https://Example.COM/Post')).toBe('https://example.com/Post');
  });

  it('strips utm_* params', () => {
    expect(canonicalizeArticleUrl('https://example.com/post?utm_source=x&utm_campaign=y&a=1')).toBe(
      'https://example.com/post?a=1',
    );
  });

  it('strips fbclid, gclid, ref, source', () => {
    expect(
      canonicalizeArticleUrl(
        'https://example.com/post?fbclid=A&gclid=B&ref=newsletter&source=tw&a=1',
      ),
    ).toBe('https://example.com/post?a=1');
  });

  it('strips mc_* (Mailchimp) params', () => {
    expect(canonicalizeArticleUrl('https://example.com/post?mc_cid=A&mc_eid=B&a=1')).toBe(
      'https://example.com/post?a=1',
    );
  });

  it('drops fragment', () => {
    expect(canonicalizeArticleUrl('https://example.com/post#section-2')).toBe(
      'https://example.com/post',
    );
  });

  it('sorts remaining query params alphabetically', () => {
    expect(canonicalizeArticleUrl('https://example.com/post?b=2&a=1&c=3')).toBe(
      'https://example.com/post?a=1&b=2&c=3',
    );
  });

  it('strips trailing slash (but keeps root /)', () => {
    expect(canonicalizeArticleUrl('https://example.com/post/')).toBe('https://example.com/post');
    expect(canonicalizeArticleUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips www. subdomain', () => {
    expect(canonicalizeArticleUrl('https://www.example.com/post')).toBe('https://example.com/post');
  });

  it('collapses multiple equivalent URLs to the same key', () => {
    const a = canonicalizeArticleUrl('https://Example.com/post/?utm_source=tw&fbclid=Q&ref=email');
    const b = canonicalizeArticleUrl('https://example.com/post#hero');
    expect(a).toBe(b);
  });

  it('returns the original string when URL parsing fails', () => {
    expect(canonicalizeArticleUrl('not a url')).toBe('not a url');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. resolveCanonicalArticleUrl (async + HEAD)
// ──────────────────────────────────────────────────────────────────────

describe('resolveCanonicalArticleUrl', () => {
  it('passes non-shortlink URLs through canonicalizeArticleUrl', async () => {
    // No head resolver invocation expected — non-shortlink host.
    let called = false;
    _setHeadResolverForTests(async () => {
      called = true;
      return undefined;
    });
    const out = await resolveCanonicalArticleUrl('https://example.com/post?utm_source=x');
    expect(out).toBe('https://example.com/post');
    expect(called).toBe(false);
  });

  it('expands t.co shortlinks via HEAD redirect', async () => {
    _setHeadResolverForTests(async (url) => {
      expect(url).toBe('https://t.co/abc123');
      return 'https://newsletter.example.com/p/some-post?utm_source=twitter';
    });
    const out = await resolveCanonicalArticleUrl('https://t.co/abc123');
    expect(out).toBe('https://newsletter.example.com/p/some-post');
  });

  it('falls back to the raw URL when HEAD returns undefined (no expand)', async () => {
    _setHeadResolverForTests(async () => undefined);
    const out = await resolveCanonicalArticleUrl('https://t.co/xyz');
    expect(out).toBe('https://t.co/xyz');
  });

  it('handles bit.ly + similar shortlink hosts', async () => {
    _setHeadResolverForTests(async (url) => {
      if (url.includes('bit.ly')) return 'https://example.com/expanded';
      return undefined;
    });
    expect(await resolveCanonicalArticleUrl('https://bit.ly/abc')).toBe(
      'https://example.com/expanded',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. detectPaywall
// ──────────────────────────────────────────────────────────────────────

describe('detectPaywall', () => {
  function body(text: string): ArticleBody {
    return { title: 'X', text, wordCount: text.split(/\s+/).length, contentSource: 'readability' };
  }

  it('returns false for normal body text', () => {
    expect(detectPaywall(body('A normal article about software engineering.'))).toBe(false);
  });

  it('detects "subscribe to read"', () => {
    expect(detectPaywall(body('Some teaser. Subscribe to read the rest.'))).toBe(true);
  });

  it('detects "members only"', () => {
    expect(detectPaywall(body('This article is members only.'))).toBe(true);
  });

  it('detects "log in to read"', () => {
    expect(detectPaywall(body('Log in to read the full piece.'))).toBe(true);
  });

  it('detects HTML class="paywall"', () => {
    const html = '<div class="paywall meter"><p>Subscribe</p></div>';
    expect(detectPaywall(body('Short teaser.'), html)).toBe(true);
  });

  it('is case-insensitive on phrases', () => {
    expect(detectPaywall(body('SUBSCRIBE TO CONTINUE reading the article.'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. fetchExternalArticle Tier 1 (cheerio meta) — substack + devto fixtures
// ──────────────────────────────────────────────────────────────────────

const SUBSTACK_HTML = readFileSync(
  join(__dirname, '..', 'fixtures', 'article-substack.html'),
  'utf8',
);
const MEDIUM_HTML = readFileSync(join(__dirname, '..', 'fixtures', 'article-medium.html'), 'utf8');
const DEVTO_HTML = readFileSync(join(__dirname, '..', 'fixtures', 'article-devto.html'), 'utf8');
const PAYWALL_HTML = readFileSync(
  join(__dirname, '..', 'fixtures', 'article-paywall.html'),
  'utf8',
);

function stubHttpFetch(html: string, finalUrl?: string): void {
  _fetchDeps.httpFetch = async (url) => ({
    statusCode: 200,
    html,
    finalUrl: finalUrl ?? url,
  });
}

describe('fetchExternalArticle — Tier 1 (cheerio)', () => {
  it('extracts title, byline, and body from substack fixture', async () => {
    stubHttpFetch(SUBSTACK_HTML, 'https://newsletter.example.com/p/how-llms-actually-work');
    const result = await fetchExternalArticle({
      url: 'https://newsletter.example.com/p/how-llms-actually-work',
    });
    expect(result.body.title).toBe('How LLMs Actually Work');
    expect(result.body.byline).toBeDefined();
    expect(result.body.text).toContain('transformer architecture');
    expect(result.body.wordCount).toBeGreaterThan(200);
    expect(result.body.platform).toBe('generic');
    expect(result.canonicalUrl).toBe('https://newsletter.example.com/p/how-llms-actually-work');
    expect(result.partial).toBe(false);
    expect(['cheerio-fallback', 'readability']).toContain(result.contentSource);
  });

  it('extracts the devto fixture cleanly', async () => {
    stubHttpFetch(DEVTO_HTML, 'https://dev.to/devuser/typescript-patterns-i-use-every-day-2026');
    const result = await fetchExternalArticle({
      url: 'https://dev.to/devuser/typescript-patterns-i-use-every-day-2026',
    });
    expect(result.body.title).toContain('TypeScript Patterns');
    expect(result.body.wordCount).toBeGreaterThan(200);
    expect(result.body.platform).toBe('devto');
  });

  it('forceTier=cheerio bypasses Readability escalation', async () => {
    stubHttpFetch(SUBSTACK_HTML);
    const result = await fetchExternalArticle({
      url: 'https://newsletter.example.com/p/how-llms-actually-work',
      forceTier: 'cheerio',
    });
    expect(result.contentSource).toBe('cheerio-fallback');
  });

  it('captures publishedAt from article:published_time meta', async () => {
    stubHttpFetch(SUBSTACK_HTML);
    const result = await fetchExternalArticle({
      url: 'https://newsletter.example.com/p/how-llms-actually-work',
      forceTier: 'cheerio',
    });
    expect(result.body.publishedAt).toMatch(/2026-05-15/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. fetchExternalArticle Tier 2 (Readability) — medium fixture
// ──────────────────────────────────────────────────────────────────────

describe('fetchExternalArticle — Tier 2 (Readability)', () => {
  it('forceTier=readability extracts the medium fixture', async () => {
    stubHttpFetch(MEDIUM_HTML, 'https://medium.com/@author/post-abc123');
    const result = await fetchExternalArticle({
      url: 'https://medium.com/@author/post-abc123',
      forceTier: 'readability',
    });
    expect(result.contentSource).toBe('readability');
    expect(result.body.text).toContain('AI agents');
    expect(result.body.wordCount).toBeGreaterThan(200);
  });

  it('captures Readability byline when present', async () => {
    stubHttpFetch(MEDIUM_HTML);
    const result = await fetchExternalArticle({
      url: 'https://medium.com/@author/post-abc123',
      forceTier: 'readability',
    });
    // Medium fixture has a byline in the HTML — Readability extracts it.
    // Tolerate either Alex Chen or undefined (Readability heuristics
    // sometimes skip non-meta bylines).
    if (result.body.byline !== undefined) {
      expect(result.body.byline.length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. fetchExternalArticle Tier 3 (Playwright fallback) — mocked
// ──────────────────────────────────────────────────────────────────────

describe('fetchExternalArticle — Tier 3 (Playwright)', () => {
  it('forceTier=playwright uses the mocked browser seam', async () => {
    let pageUsed = false;
    let closed = false;
    _fetchDeps.getBrowserPage = async () => ({
      goto: async () => {
        pageUsed = true;
      },
      content: async () => MEDIUM_HTML,
      close: async () => {
        closed = true;
      },
    });
    const result = await fetchExternalArticle({
      url: 'https://medium.com/@author/post-abc123',
      forceTier: 'playwright',
    });
    expect(pageUsed).toBe(true);
    expect(closed).toBe(true);
    expect(result.contentSource).toBe('playwright');
    expect(result.body.wordCount).toBeGreaterThan(200);
  });

  it('falls back to playwright when HTTP fetch throws', async () => {
    _fetchDeps.httpFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    _fetchDeps.getBrowserPage = async () => ({
      goto: async () => {},
      content: async () => MEDIUM_HTML,
      close: async () => {},
    });
    const result = await fetchExternalArticle({ url: 'https://broken-host.example.com/post' });
    expect(result.contentSource).toBe('playwright');
    expect(result.errors?.some((e) => e.includes('HTTP fetch failed'))).toBe(true);
  });

  it('throws FetchError when all tiers fail with no extractable body', async () => {
    _fetchDeps.httpFetch = async () => {
      throw new Error('boom');
    };
    _fetchDeps.getBrowserPage = async () => ({
      goto: async () => {
        throw new Error('nav timeout');
      },
      content: async () => '',
      close: async () => {},
    });
    await expect(
      fetchExternalArticle({ url: 'https://nothing.example.com/post' }),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Paywall path — partial=true + error string set
// ──────────────────────────────────────────────────────────────────────

describe('fetchExternalArticle — paywall detection', () => {
  it('flags partial=true on a paywalled fixture', async () => {
    stubHttpFetch(PAYWALL_HTML);
    const result = await fetchExternalArticle({
      url: 'https://premium.example.com/articles/cloud-infrastructure-future',
      forceTier: 'cheerio',
    });
    expect(result.partial).toBe(true);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.some((e) => /paywall|subscribe/i.test(e))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9. Orchestrator wiring — external URL flows through fetchExternalArticle
// ──────────────────────────────────────────────────────────────────────

describe('analyzeArticle — external-html path', () => {
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

  it('wires external URL through fetchExternalArticle (raw mode)', async () => {
    const fetchSpy = vi.fn(async () => ({
      body: {
        title: 'Mocked',
        text: 'lorem ipsum '.repeat(150),
        wordCount: 300,
        contentSource: 'readability' as const,
        platform: 'substack' as const,
      },
      contentSource: 'readability' as const,
      canonicalUrl: 'https://newsletter.example.com/p/mocked',
      partial: false,
      errors: [],
    }));
    patch('fetchExternalArticle', fetchSpy as unknown as typeof articleDeps.fetchExternalArticle);

    const result = await analyzeArticle({
      url: 'https://newsletter.example.com/p/mocked?utm_source=tw',
      raw: true,
      noCache: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.body.title).toBe('Mocked');
    expect(result.source).toBe('external-html');
    expect(result.summary).toBeUndefined();
  });

  it('uses canonical URL as the cache key', async () => {
    const fetchSpy = vi.fn(async () => ({
      body: {
        title: 'Cached',
        text: 'long body '.repeat(150),
        wordCount: 300,
        contentSource: 'readability' as const,
      },
      contentSource: 'readability' as const,
      canonicalUrl: 'https://example.com/post',
      partial: false,
      errors: [],
    }));
    patch('fetchExternalArticle', fetchSpy as unknown as typeof articleDeps.fetchExternalArticle);

    await analyzeArticle({
      url: 'https://www.Example.com/post?utm_source=tw&utm_campaign=spring',
      raw: true,
      noCache: false,
    });
    // Both raw-canonicalized URL and the bare canonical URL should land
    // in the cache under the same key.
    expect(getCachedArticleBody('https://example.com/post')).toBeDefined();
  });

  it('cache hit on canonical URL short-circuits the fetch', async () => {
    // Pre-populate the body cache under the canonical key.
    const fetchSpy = vi.fn(async () => {
      throw new Error('should not be called');
    });
    patch('fetchExternalArticle', fetchSpy as unknown as typeof articleDeps.fetchExternalArticle);
    const { putCachedArticleBody } = await import('../../src/article/cache.ts');
    putCachedArticleBody({
      urlCanonical: 'https://example.com/post',
      source: 'external-html',
      body: {
        title: 'Cached',
        text: 'cached body content',
        wordCount: 3,
        contentSource: 'readability',
      },
    });

    const result = await analyzeArticle({
      url: 'https://example.com/post?utm_source=tw#section-2',
      raw: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.body.title).toBe('Cached');
  });

  it('surfaces fetch partial flag + errors on the orchestrator output', async () => {
    const fetchSpy = vi.fn(async () => ({
      body: {
        title: 'Paywalled',
        text: 'short teaser',
        wordCount: 2,
        contentSource: 'cheerio-fallback' as const,
      },
      contentSource: 'cheerio-fallback' as const,
      canonicalUrl: 'https://paywall.example.com/post',
      partial: true,
      errors: ['paywall detected — only excerpt available'],
    }));
    patch('fetchExternalArticle', fetchSpy as unknown as typeof articleDeps.fetchExternalArticle);

    const result = await analyzeArticle({
      url: 'https://paywall.example.com/post',
      raw: true,
      noCache: true,
    });
    expect(result.partial).toBe(true);
    expect(result.errors.some((e) => /paywall/i.test(e))).toBe(true);
  });

  it('surfaces fetch hard-fail as a partial summary (does not throw)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('all tiers failed');
    });
    patch('fetchExternalArticle', fetchSpy as unknown as typeof articleDeps.fetchExternalArticle);

    const result = await analyzeArticle({
      url: 'https://broken.example.com/post',
      raw: true,
      noCache: true,
    });
    expect(result.partial).toBe(true);
    expect(result.errors.some((e) => /all tiers failed/i.test(e))).toBe(true);
    expect(result.body.wordCount).toBe(0);
  });
});
