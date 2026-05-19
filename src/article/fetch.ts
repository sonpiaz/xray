/**
 * P3.1 — External HTML article 3-tier fetch pipeline.
 *
 * Tier 1 — Cheerio meta extraction.
 *   Pulls `og:*` / `<title>` / canonical / byline meta tags via cheerio.
 *   Fast path for OG-rich pages (Substack, news sites, dev.to). Stops
 *   here when body extraction yields ≥200 words.
 *
 * Tier 2 — @mozilla/readability via linkedom.
 *   Same HTML body, parsed with linkedom into a Document, then run
 *   through Mozilla's Readability lib. Catches blog/long-form content
 *   where Tier 1's meta-only extraction comes up short. linkedom chosen
 *   over jsdom: ~10x smaller (~3MB vs ~25MB), Readability-compatible.
 *
 * Tier 3 — Playwright SPA fallback.
 *   Reuses the existing `getBrowser()` singleton from `src/fetcher/browser.ts`
 *   so we don't pay for a second headless Chromium boot. Navigates,
 *   waits for `networkidle`, dumps `page.content()` back through
 *   linkedom + Readability. 30s timeout. Only fires when Tier 1+2 give
 *   <200 words (real SPAs like Medium custom domains, Notion-style).
 *
 * Paywall detection runs on every successful tier — body text scanned for
 * "subscribe to read", "members only", login-form markers, etc. Detected
 * paywalls set `partial: true` + push a `errors[]` entry but still return
 * whatever was extractable (often a title + first paragraph).
 *
 * All three tiers are wrapped in undici + linkedom timeouts so a slow
 * upstream can't hang the orchestrator forever.
 */
import { type CheerioAPI, load as loadHtml } from 'cheerio';
import { parseHTML } from 'linkedom';
import { request } from 'undici';
import { FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ArticleBody } from '../models/article.ts';
import { type ExternalPlatform, detectExternalPlatform } from './detect.ts';

// We can't import the type from @mozilla/readability directly without a
// runtime dep — declare a structural type that matches `Readability#parse`.
type ReadabilityResult = {
  title: string | null | undefined;
  content: string | null | undefined;
  textContent: string | null | undefined;
  length: number | null | undefined;
  excerpt: string | null | undefined;
  byline: string | null | undefined;
  publishedTime: string | null | undefined;
  siteName: string | null | undefined;
} | null;

/**
 * Same Safari UA the SSR + browser fetchers use. Keeps our HTTP fingerprint
 * consistent so we're not flagged as a bot. Mirrors the value in
 * `src/fetcher/browser.ts` and `src/fetcher/ssr.ts` rather than importing
 * — those modules transitively pull in bun:sqlite which crashes under
 * vitest, and we want this module to remain unit-testable.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

/** Minimum word count before we accept a tier's output. Spec §5.2. */
const MIN_WORD_COUNT_THRESHOLD = 200;
/** Below this, even Tier 3 escalates a paywall flag. Spec §10. */
const PAYWALL_WORD_COUNT_THRESHOLD = 200;

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 30_000;

/** Phrases that indicate a paywall when present in body text. */
const PAYWALL_PHRASES = [
  'subscribe to read',
  'subscribe to continue',
  'continue reading',
  'subscribers only',
  'members only',
  'premium content',
  'this is a premium',
  'paywall',
  'become a paid subscriber',
  'sign up to read',
  'log in to read',
  'log in to continue',
  'unlock this',
  'unlock the rest',
];

export type FetchedArticleBody = {
  body: ArticleBody;
  /** Tier that produced the body. Mirrored into `body.contentSource`. */
  contentSource: 'cheerio-fallback' | 'readability' | 'playwright';
  /** Final URL after canonicalization (caller decides cache key). */
  canonicalUrl: string;
  /** True when paywall markers were detected. */
  partial?: boolean;
  /** Human-readable warning strings (paywall, fallback escalation, etc.). */
  errors?: string[];
};

export type FetchExternalOptions = {
  url: string;
  /** Tier 1/2 HTTP timeout (default 10s). */
  timeoutMs?: number;
  /** Tier 3 Playwright timeout (default 30s). */
  playwrightTimeoutMs?: number;
  /**
   * Test-only escape hatch: force a specific tier and skip escalation.
   *   - `'cheerio'`     — run Tier 1 (cheerio meta) only.
   *   - `'readability'` — run Tier 2 (linkedom + Readability) only.
   *   - `'playwright'`  — run Tier 3 only.
   * Production callers omit this and let the escalation chain pick.
   */
  forceTier?: 'cheerio' | 'readability' | 'playwright';
};

// ─────────────────────────────────────────────────────────────────────────
// Test seams
// ─────────────────────────────────────────────────────────────────────────

/**
 * Test seam — production callers never set these. The orchestrator wires
 * the real implementations via the default `_fetchDeps` table.
 *
 * - `httpFetch`        — replaces undici GET; tests inject a fixture body.
 * - `getBrowserPage`   — replaces the Playwright headless singleton so
 *                        Tier 3 can be unit-tested without launching
 *                        Chromium. Returns a stub page with `goto` and
 *                        `content`. Tests should assert the page was
 *                        used, then close.
 */
export type HttpFetchResult = { statusCode: number; html: string; finalUrl: string };
export type FetchDeps = {
  httpFetch: (url: string, opts: { timeoutMs: number }) => Promise<HttpFetchResult>;
  getBrowserPage: () => Promise<{
    goto: (url: string, opts: { timeout: number; waitUntil: 'networkidle' }) => Promise<void>;
    content: () => Promise<string>;
    close: () => Promise<void>;
  }>;
};

export const _fetchDeps: FetchDeps = {
  httpFetch: defaultHttpFetch,
  getBrowserPage: defaultGetBrowserPage,
};

async function defaultHttpFetch(
  url: string,
  opts: { timeoutMs: number },
): Promise<HttpFetchResult> {
  // Manual redirect follow — undici v7 dropped the basic `maxRedirections`
  // option on `request()`. The interceptor pattern is overkill for ≤5
  // hops, so we do it inline.
  const MAX_HOPS = 5;
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await request(current, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      bodyTimeout: opts.timeoutMs,
      headersTimeout: opts.timeoutMs,
    });
    const status = res.statusCode;
    if (status >= 300 && status < 400) {
      // Drain body, follow Location header.
      await res.body.dump();
      const loc = res.headers.location;
      const next = Array.isArray(loc) ? loc[0] : loc;
      if (!next) {
        throw new FetchError(`article fetch got ${status} but no Location header for ${current}`);
      }
      current = new URL(next, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      await res.body.dump();
      throw new FetchError(`article fetch returned HTTP ${status} for ${current}`);
    }
    const html = await res.body.text();
    return { statusCode: status, html, finalUrl: current };
  }
  throw new FetchError(`article fetch hit redirect limit (${MAX_HOPS}) starting from ${url}`);
}

async function defaultGetBrowserPage(): Promise<{
  goto: (url: string, opts: { timeout: number; waitUntil: 'networkidle' }) => Promise<void>;
  content: () => Promise<string>;
  close: () => Promise<void>;
}> {
  // Lazy import — `src/fetcher/browser.ts` transitively imports config /
  // playwright / cookie reader which can fail under vitest. Importing
  // inside the call keeps module-load clean.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../fetcher/browser.ts') as typeof import('../fetcher/browser.ts');
  const browser = await mod.getBrowser();
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1800 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  return {
    goto: async (url: string, gotoOpts: { timeout: number; waitUntil: 'networkidle' }) => {
      await page.goto(url, gotoOpts);
    },
    content: () => page.content(),
    close: async () => {
      // Closing the context is cheaper than closing the browser — we
      // keep the singleton hot for the next fetch.
      await ctx.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fetch an external HTML article via the 3-tier pipeline. Returns a
 * `FetchedArticleBody` even on paywall detection (partial=true). Throws
 * `FetchError` only when ALL three tiers fail outright (network down,
 * 4xx/5xx + Playwright also fails).
 *
 * The orchestrator owns cache lookups + URL canonicalization for cache
 * keys. This module just resolves a URL to a body and reports which tier
 * succeeded. The `canonicalUrl` field surfaces the post-redirect URL
 * (undici's terminal URL after `maxRedirections`), which the orchestrator
 * can re-canonicalize as a stable cache key.
 */
export async function fetchExternalArticle(
  opts: FetchExternalOptions,
): Promise<FetchedArticleBody> {
  const url = opts.url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const playwrightTimeoutMs = opts.playwrightTimeoutMs ?? DEFAULT_PLAYWRIGHT_TIMEOUT_MS;
  const platform = detectExternalPlatform(url);
  const errors: string[] = [];

  // ── Test seam: forceTier bypasses escalation ────────────────────────
  if (opts.forceTier === 'cheerio') {
    const { html, finalUrl } = await _fetchDeps.httpFetch(url, { timeoutMs });
    return finalize(extractCheerio(html, finalUrl, platform), finalUrl, 'cheerio-fallback', errors);
  }
  if (opts.forceTier === 'readability') {
    const { html, finalUrl } = await _fetchDeps.httpFetch(url, { timeoutMs });
    const r = extractReadability(html, finalUrl, platform);
    return finalize(r, finalUrl, 'readability', errors);
  }
  if (opts.forceTier === 'playwright') {
    return fetchTier3Playwright(url, platform, playwrightTimeoutMs, errors);
  }

  // ── Real pipeline: Tier 1 → Tier 2 → Tier 3 ─────────────────────────
  let html: string;
  let finalUrl: string;
  try {
    const res = await _fetchDeps.httpFetch(url, { timeoutMs });
    html = res.html;
    finalUrl = res.finalUrl;
  } catch (err) {
    // HTTP fetch failed outright — escalate straight to Playwright.
    logger.debug('article tier1+2 fetch failed, escalating to playwright', {
      url,
      err: String(err),
    });
    errors.push(`tier 1/2 HTTP fetch failed: ${String(err)}`);
    return fetchTier3Playwright(url, platform, playwrightTimeoutMs, errors);
  }

  // Tier 1: cheerio meta extraction. Fast path for OG-rich pages.
  const tier1 = extractCheerio(html, finalUrl, platform);
  if (tier1 && tier1.wordCount >= MIN_WORD_COUNT_THRESHOLD) {
    return finalize(tier1, finalUrl, 'cheerio-fallback', errors);
  }

  // Tier 2: Readability extraction (default for most articles).
  errors.push('cheerio meta extraction below threshold, escalating to Readability');
  const tier2 = extractReadability(html, finalUrl, platform);
  if (tier2 && tier2.wordCount >= MIN_WORD_COUNT_THRESHOLD) {
    return finalize(tier2, finalUrl, 'readability', errors);
  }

  // Tier 3: Playwright SPA fallback. Heavy — only fires when 1+2 are
  // both too short. SPA articles (Medium custom domains, dynamic
  // single-page blogs) typically need this.
  errors.push('readability extraction below threshold, escalating to Playwright');
  logger.debug('article escalating to Playwright', { url });
  return fetchTier3Playwright(url, platform, playwrightTimeoutMs, errors, {
    fallbackBody: tier2 ?? tier1,
    fallbackFinalUrl: finalUrl,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Tier 1 — cheerio meta + content extraction
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pull title / description / byline / canonical / body text out of an
 * HTML string via cheerio. No Readability — pure semantic selectors +
 * OG/Twitter meta tags. This is the "good page well-structured" path.
 *
 * Body text is extracted from `<article>` first, then `<main>`, then
 * common WordPress/blog selectors. Nav/footer/script/style stripped.
 *
 * Returns undefined when the page yields neither a title nor any body
 * text — caller escalates.
 */
function extractCheerio(
  html: string,
  finalUrl: string,
  platform: ExternalPlatform,
): ArticleBody | undefined {
  let $: CheerioAPI;
  try {
    $ = loadHtml(html);
  } catch {
    return undefined;
  }

  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('meta[name="twitter:title"]').attr('content')?.trim() ||
    $('title').text().trim() ||
    'Untitled';

  const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim();
  const excerpt = ogDescription ?? metaDescription;

  const byline =
    $('meta[name="author"]').attr('content')?.trim() ||
    $('meta[property="article:author"]').attr('content')?.trim() ||
    $('[itemprop="author"]').first().text().trim() ||
    $('a[rel="author"]').first().text().trim() ||
    undefined;

  const publishedAt =
    isoOrUndefined($('meta[property="article:published_time"]').attr('content')) ||
    isoOrUndefined($('meta[name="article:published_time"]').attr('content')) ||
    isoOrUndefined($('time[datetime]').first().attr('datetime')) ||
    undefined;

  // Strip noise BEFORE extracting body text.
  $(
    'nav, header, footer, aside, script, style, noscript, iframe, .nav, .navbar, .sidebar, .footer, .header, .ad, .advertisement, .comments, .related, .recommended, .newsletter-signup',
  ).remove();

  const bodySelectors = [
    'article',
    'main article',
    'main',
    '[itemprop="articleBody"]',
    '.post-body',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.markdown-body', // GitHub README
    '#content',
    'body',
  ];

  let bodyText = '';
  for (const sel of bodySelectors) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const text = normalizeWhitespace(el.text());
    if (text.length > bodyText.length) bodyText = text;
    if (countWords(text) >= MIN_WORD_COUNT_THRESHOLD) {
      // Found a long-enough block — stop scanning.
      bodyText = text;
      break;
    }
  }

  // Fallback to excerpt + title if no real body text surfaced. This is
  // the OG-only path (title + description from meta tags). For
  // well-structured pages with proper og:description this can carry
  // enough signal to skip Readability entirely.
  if (!bodyText && excerpt) bodyText = excerpt;

  if (!bodyText && title === 'Untitled') return undefined;

  const body: ArticleBody = {
    title,
    text: bodyText,
    wordCount: countWords(bodyText),
    contentSource: 'cheerio-fallback',
    platform,
  };
  if (byline) body.byline = byline;
  if (publishedAt) body.publishedAt = publishedAt;
  // Mirror `finalUrl` into html field as a debugging convenience — keeps
  // the canonical destination next to the body without a separate column.
  // (Spec doesn't require html on cheerio path, but it costs nothing.)
  void finalUrl;
  return body;
}

// ─────────────────────────────────────────────────────────────────────────
// Tier 2 — linkedom + Readability
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lazily load Readability via require. Static-imported `@mozilla/readability`
 * would force the dep at module-load time; deferring keeps tests that
 * don't exercise Tier 2 lightweight.
 */
type ReadabilityCtor = new (
  document: Document,
  options?: Record<string, unknown>,
) => { parse(): ReadabilityResult };

function loadReadability(): ReadabilityCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@mozilla/readability') as { Readability: ReadabilityCtor };
  return mod.Readability;
}

function extractReadability(
  html: string,
  finalUrl: string,
  platform: ExternalPlatform,
): ArticleBody | undefined {
  let document: Document;
  try {
    const { document: doc } = parseHTML(html);
    document = doc as unknown as Document;
  } catch {
    return undefined;
  }

  let parsed: ReadabilityResult = null;
  try {
    const Readability = loadReadability();
    parsed = new Readability(document).parse();
  } catch (err) {
    logger.debug('readability parse threw', { err: String(err), finalUrl });
    return undefined;
  }
  if (!parsed) return undefined;

  const title = (parsed.title ?? '').trim() || 'Untitled';
  const text = normalizeWhitespace(parsed.textContent ?? '');
  if (!text) return undefined;

  const body: ArticleBody = {
    title,
    text,
    wordCount: countWords(text),
    contentSource: 'readability',
    platform,
  };
  if (parsed.byline) body.byline = parsed.byline.trim();
  if (parsed.publishedTime) {
    const iso = isoOrUndefined(parsed.publishedTime);
    if (iso) body.publishedAt = iso;
  }
  if (parsed.content) body.html = parsed.content;
  return body;
}

// ─────────────────────────────────────────────────────────────────────────
// Tier 3 — Playwright SPA fallback
// ─────────────────────────────────────────────────────────────────────────

/**
 * Launch a headless page, navigate, dump the rendered HTML, then run it
 * back through Readability. Reuses the shared `getBrowser()` singleton
 * via the test seam so production gets one browser process per xray run
 * regardless of how many articles it analyzes.
 *
 * Pricing note: this is the most expensive tier (real browser, CPU + RAM,
 * 30s timeout). Only fires when Tier 1 + 2 came up short.
 */
async function fetchTier3Playwright(
  url: string,
  platform: ExternalPlatform,
  timeoutMs: number,
  errors: string[],
  opts: { fallbackBody?: ArticleBody; fallbackFinalUrl?: string } = {},
): Promise<FetchedArticleBody> {
  let page: Awaited<ReturnType<typeof _fetchDeps.getBrowserPage>>;
  try {
    page = await _fetchDeps.getBrowserPage();
  } catch (err) {
    // Browser unavailable. Surface whatever Tier 1/2 had, else throw.
    errors.push(`playwright unavailable: ${String(err)}`);
    if (opts.fallbackBody && opts.fallbackFinalUrl) {
      return finalize(
        opts.fallbackBody,
        opts.fallbackFinalUrl,
        opts.fallbackBody.contentSource as 'readability' | 'cheerio-fallback' | 'playwright',
        errors,
      );
    }
    throw new FetchError(`fetchExternalArticle: all tiers failed for ${url}`, { cause: err });
  }

  let html = '';
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'networkidle' });
    html = await page.content();
  } catch (err) {
    errors.push(`playwright navigate failed: ${String(err)}`);
  } finally {
    try {
      await page.close();
    } catch {
      // Closing a context never throws fatally for us — ignore.
    }
  }

  if (html) {
    const tier3 = extractReadability(html, url, platform);
    if (tier3) {
      // Mark Playwright as the producing tier even though extraction
      // ran through Readability under the hood.
      tier3.contentSource = 'playwright';
      return finalize(tier3, url, 'playwright', errors);
    }
    // Try cheerio against the rendered HTML as a last resort.
    const tier3Cheerio = extractCheerio(html, url, platform);
    if (tier3Cheerio) {
      tier3Cheerio.contentSource = 'playwright';
      return finalize(tier3Cheerio, url, 'playwright', errors);
    }
  }

  // Tier 3 also failed — fall back to the best of Tier 1/2 if available.
  if (opts.fallbackBody && opts.fallbackFinalUrl) {
    errors.push('playwright extraction produced no body — using tier 1/2 fallback');
    return finalize(
      opts.fallbackBody,
      opts.fallbackFinalUrl,
      opts.fallbackBody.contentSource as 'readability' | 'cheerio-fallback' | 'playwright',
      errors,
    );
  }

  throw new FetchError(`fetchExternalArticle: all tiers failed for ${url} (no extractable body)`);
}

// ─────────────────────────────────────────────────────────────────────────
// Paywall detection + finalize
// ─────────────────────────────────────────────────────────────────────────

/**
 * Scan a body for paywall markers. Returns true when the body looks
 * partial. Cheap heuristic — phrase match + form-class scan + length.
 *
 * Spec §5.2/§10:
 *   - Body contains a known paywall phrase (case-insensitive).
 *   - Body has a login form / paywall meter class.
 *   - Word count < threshold AND title is generic (skipped — too lossy).
 */
export function detectPaywall(body: ArticleBody, html?: string): boolean {
  const lowerText = body.text.toLowerCase();
  for (const phrase of PAYWALL_PHRASES) {
    if (lowerText.includes(phrase)) return true;
  }
  if (html) {
    // Class-based scan on the original HTML — cheap regex (no DOM walk).
    const classMarker = /class\s*=\s*['"][^'"]*(?:paywall|piano|meter|subscribe-wall)[^'"]*['"]/i;
    if (classMarker.test(html)) return true;
  }
  return false;
}

/**
 * Wrap an extracted ArticleBody with the FetchedArticleBody envelope,
 * running paywall detection + word-count threshold checks. Always
 * succeeds — paywall flags surface as `partial: true` instead of throws.
 */
function finalize(
  body: ArticleBody | undefined,
  finalUrl: string,
  contentSource: 'cheerio-fallback' | 'readability' | 'playwright',
  errors: string[],
  html?: string,
): FetchedArticleBody {
  // Body should always be present at this point — caller checks. If not,
  // surface an empty body shell so the orchestrator can still degrade
  // gracefully.
  const finalBody: ArticleBody = body ?? {
    title: 'Untitled',
    text: '',
    wordCount: 0,
    contentSource,
  };
  finalBody.contentSource = contentSource;

  const paywall = detectPaywall(finalBody, html);
  const wordCountLow = finalBody.wordCount < PAYWALL_WORD_COUNT_THRESHOLD;
  const partial = paywall || wordCountLow;
  const errs = [...errors];
  if (paywall) {
    errs.push(`paywall detected — only excerpt available (${finalBody.wordCount} words extracted)`);
  }
  return {
    body: finalBody,
    contentSource,
    canonicalUrl: finalUrl,
    partial,
    errors: errs,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
