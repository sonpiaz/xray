import { existsSync } from 'node:fs';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import { detectChromiumBrowsers } from '../auth/browsers.ts';
import { type DecryptedCookie, readXCookies } from '../auth/cookie-reader.ts';
import { putCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { AuthWallError, FetchError, KeychainDeniedError, XRateLimitError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { withRetry } from '../core/retry.ts';
import type { XPost } from '../models/post.ts';
import type { XThread } from '../models/thread.ts';
import { newContext, newContextWithCookies } from './browser.ts';
import { type PaginationContext, type WalkCoverage, walkReplyTree } from './pagination.ts';
import {
  type ExtractedCursors,
  type ParsedDetail,
  extractCursors,
  parseTweetDetail,
} from './parser.ts';
import { fetchSsr } from './ssr.ts';
import { type ParsedXUrl, parseXUrl } from './url.ts';

/**
 * P1.5.2 — Fetch modes. `'anon'` was removed in v0.2.0 — the anonymous
 * Playwright tier produced the same content as SSR but slower. Use `'ssr'`
 * for an authentication-free fetch, or `'cookie'` to force the
 * Chromium-cookie-injected Playwright path with no fallback. Spec §6.3.
 */
export type FetchMode = 'auto' | 'ssr' | 'cookie' | 'auth';

export type FetchOptions = {
  mode?: FetchMode;
  /** P1.0: max top-level replies to walk (default 50). */
  maxReplies?: number;
  /** P1.0: max nested reply depth to expand (default 3). */
  depth?: number;
};

export type FetchResult = {
  thread: XThread;
  coverage?: WalkCoverage;
  /**
   * P1.5.2 — which escalation tier produced this result. Always set for
   * fetches that go through `fetchThread`. Surfaces into
   * `ResearchReport.coverage.tier` for downstream agents.
   */
  tier?: 'ssr' | 'cookie' | 'auth';
};

/**
 * P1.5.2 — Test seam for the 3-tier orchestrator. The orchestrator calls
 * every external dependency through this object so unit tests can swap in
 * mocks without standing up the real Chromium / cookie-decrypt / SQLite
 * stack. Production code never reassigns these.
 *
 * Tier-1 cookie internals (`readXCookies`, `newContextWithCookies`) and the
 * cookie-injected fetch (`fetchWithCookies`) are all exposed so tests can
 * stub at whatever granularity they need:
 *   - Swap `fetchWithCookies` for end-to-end tier-selection tests.
 *   - Swap individual primitives for per-error-path tests.
 *
 * `fetchWithStorageState` and `putCachedThread` are exposed for the same
 * reason — Tier 3 needs a real Playwright launch otherwise, and the cache
 * needs `bun:sqlite` which the Node test runner can't import.
 *
 * Spec §8.1 / §8.2.
 */
export const _orchestratorDeps = {
  detectChromiumBrowsers,
  readXCookies,
  newContextWithCookies,
  fetchSsr,
  fetchWithCookies: (
    parsed: ParsedXUrl,
    cookies: DecryptedCookie[],
    opts: FetchOptions,
  ): Promise<FetchResult> => fetchWithCookiesImpl(parsed, cookies, opts),
  fetchWithStorageState: (parsed: ParsedXUrl, opts: FetchOptions): Promise<FetchResult> =>
    fetchWithStorageStateImpl(parsed, opts),
  putCachedThread,
};

/**
 * Default reply/depth caps, replayed here for the Tier 1/Tier 3 Playwright
 * paths. SSR (Tier 2) ignores both — it always returns the OG card only.
 */
const DEFAULT_MAX_REPLIES = 50;
const DEFAULT_DEPTH = 3;

/**
 * P1.5.2 — Top-level orchestrator.
 *
 * `mode === 'auto'` (default) runs the 3-tier invisible-escalation chain:
 * Cookie+PW → SSR fallback → saved auth (PHASE_1_5_PLAN.md §4 + §8.1).
 *
 * Direct-mode overrides (`'ssr' | 'cookie' | 'auth'`) skip escalation
 * entirely and run exactly the named tier. `'cookie'` does NOT fall back to
 * SSR — that's the whole point of forcing the cookie path (spec §4.4).
 */
export async function fetchThread(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const parsed = parseXUrl(rawUrl);
  const cfg = loadConfig();
  const mode = opts.mode ?? cfg.fetcher.mode;

  // ---- Direct-mode overrides (skip escalation) ----
  if (mode === 'ssr') {
    const result = await _orchestratorDeps.fetchSsr(parsed.canonical);
    _orchestratorDeps.putCachedThread(result.thread);
    return { thread: result.thread, tier: 'ssr' };
  }

  if (mode === 'cookie') {
    const browsers = _orchestratorDeps.detectChromiumBrowsers();
    if (browsers.length === 0) {
      throw new FetchError(
        '--mode cookie requires Chrome, Brave, or Edge with X cookies, but no Chromium browser was detected on this system.',
      );
    }
    let lastErr: unknown;
    for (const browser of browsers) {
      try {
        const cookies = await _orchestratorDeps.readXCookies(browser);
        if (cookies.length === 0) {
          logger.debug('mode=cookie: no X cookies in browser, trying next', {
            browser: browser.name,
          });
          continue;
        }
        const result = await _orchestratorDeps.fetchWithCookies(parsed, cookies, opts);
        return { ...result, tier: 'cookie' };
      } catch (err) {
        lastErr = err;
        logger.debug('mode=cookie: browser failed, trying next', {
          browser: browser.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw new FetchError(
      '--mode cookie failed: no Chromium browser yielded usable X cookies. Are you logged into X in Chrome/Brave/Edge?',
      { cause: lastErr },
    );
  }

  if (mode === 'auth') {
    const result = await _orchestratorDeps.fetchWithStorageState(parsed, opts);
    return { ...result, tier: 'auth' };
  }

  // ---- AUTO mode — 3-tier escalation ----
  // ---- TIER 1: COOKIE+PW (PRIMARY) ----
  try {
    const browsers = _orchestratorDeps.detectChromiumBrowsers();
    for (const browser of browsers) {
      try {
        const cookies = await _orchestratorDeps.readXCookies(browser);
        if (cookies.length === 0) {
          logger.debug('cookie tier: no X cookies in browser, trying next', {
            browser: browser.name,
          });
          continue;
        }
        const result = await _orchestratorDeps.fetchWithCookies(parsed, cookies, opts);
        return { ...result, tier: 'cookie' };
      } catch (err) {
        if (err instanceof KeychainDeniedError) {
          logger.debug('cookie tier: keychain denied, trying next browser', {
            browser: browser.name,
          });
          continue;
        }
        if (err instanceof AuthWallError) {
          logger.debug('cookie tier: cookies present but expired, trying next browser', {
            browser: browser.name,
          });
          continue;
        }
        // Fatal Playwright launch / network / unexpected error — propagate.
        throw err;
      }
    }
    logger.debug('cookie tier: no Chromium browser yielded usable X cookies, falling back to SSR');
  } catch (err) {
    if (err instanceof FetchError) throw err;
    // Catch-all: detection itself failed (FS permission, etc.). Don't block
    // the user — let SSR take over.
    logger.debug('cookie tier failed entirely, falling back to SSR', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- TIER 2: SSR (FALLBACK) ----
  try {
    const ssr = await _orchestratorDeps.fetchSsr(parsed.canonical);
    if (ssr.thread.rootPost) {
      _orchestratorDeps.putCachedThread(ssr.thread);
      return { thread: ssr.thread, tier: 'ssr' };
    }
    logger.info('SSR returned no root post — likely login wall, escalating to saved auth');
  } catch (err) {
    logger.warn('SSR fetch failed, escalating to saved auth', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- TIER 3: SAVED AUTH (LAST RESORT) ----
  if (existsSync(cfg.fetcher.storageStatePath)) {
    try {
      const result = await _orchestratorDeps.fetchWithStorageState(parsed, opts);
      return { ...result, tier: 'auth' };
    } catch (err) {
      logger.error('saved auth fetch failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // All tiers exhausted — surface a clear actionable error.
  throw new FetchError(
    'This content requires authentication. Possible causes: not logged into X in Chrome/Brave/Edge, cookies expired, or protected/age-gated content. Run `xray auth` to save a login session.',
  );
}

/**
 * P1.5.2 — Tier 1 inner path. Builds a Playwright context seeded with the
 * decrypted Chromium cookies, runs the existing TweetDetail capture flow,
 * and projects the captured detail into the canonical `XThread` shape.
 *
 * Throws `AuthWallError` when the cookie-injected fetch fails to produce a
 * root post — signals "cookies present but session no longer valid" and
 * lets the orchestrator silently try the next browser / SSR. Spec §8.2.
 */
async function fetchWithCookiesImpl(
  parsed: ParsedXUrl,
  cookies: DecryptedCookie[],
  opts: FetchOptions,
): Promise<FetchResult> {
  // P5.1 — retry only the rate-limited path. Auth-wall (dead session) is
  // NOT retryable; falling through to SSR is the right call there. Max
  // 3 attempts; on exhaustion we throw `AuthWallError` so the orchestrator
  // still falls back per Phase 1.5 logic.
  return withRetry(
    async () => {
      const ctx = await _orchestratorDeps.newContextWithCookies(cookies);
      try {
        const captured = await navigateAndCapture(ctx, parsed.canonical, parsed.id, opts);
        const detail = captured.detail;
        if (!detail.rootPost) {
          if (captured.rateLimited) {
            // X bounced us on TweetDetail with 429 — backoff + retry inside
            // this same browser/cookie context.
            throw new XRateLimitError(
              'cookie-tier fetch hit X rate limit (HTTP 429 on TweetDetail)',
            );
          }
          // Cookies were present but X still didn't deliver TweetDetail — session
          // is dead. Distinct from a hard FetchError so the orchestrator can
          // fall through silently.
          throw new AuthWallError('cookie-injected fetch returned no root post');
        }
        return buildResult(detail, captured.coverage);
      } finally {
        await ctx.close();
      }
    },
    {
      label: 'x-cookie',
      // Only the rate-limited path is retryable here. Auth-wall, fetch
      // errors, Playwright launch failures all surface immediately.
      isRetryable: (err) => err instanceof XRateLimitError,
    },
  ).catch((err) => {
    // After retry exhaustion we still want the orchestrator to fall back
    // to SSR rather than surface a hard rate-limit error to the user, so
    // remap to AuthWallError per Phase 1.5 escalation logic.
    if (err instanceof XRateLimitError) {
      throw new AuthWallError(`cookie-tier rate-limited after retries: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  });
}

/**
 * P1.5.2 — Tier 3 inner path. Wraps the existing `newContext('auth')` flow
 * (which loads `~/.xray/storageState.json`) so the orchestrator's three
 * tier-paths all return the same `{ thread, coverage }` shape.
 */
async function fetchWithStorageStateImpl(
  parsed: ParsedXUrl,
  opts: FetchOptions,
): Promise<FetchResult> {
  const ctx = await newContext('auth');
  try {
    const captured = await navigateAndCapture(ctx, parsed.canonical, parsed.id, opts);
    const detail = captured.detail;
    if (!detail.rootPost) {
      throw new FetchError(
        'TweetDetail response was not captured. The tweet may be deleted, protected, or X may have rate-limited.',
      );
    }
    return buildResult(detail, captured.coverage);
  } finally {
    await ctx.close();
  }
}

/**
 * Shared projection of `ParsedDetail` → `XThread` + cache write. Identical
 * for Tier 1 and Tier 3 — both go through the GraphQL capture flow.
 */
function buildResult(detail: ParsedDetail, coverage: WalkCoverage | undefined): FetchResult {
  const partial = detail.comments.length === 0 || (coverage ? coverage.status !== 'ok' : false);
  let partialReason: string | undefined;
  if (detail.comments.length === 0) {
    partialReason = 'no replies returned in first page';
  } else if (coverage && coverage.status !== 'ok') {
    partialReason = coverage.failureReason ?? `coverage status: ${coverage.status}`;
  }
  const thread: XThread = {
    rootPost: detail.rootPost as NonNullable<ParsedDetail['rootPost']>,
    authorPosts: detail.authorPosts,
    quoteTweets: dedupePosts(detail.quoteTweets),
    comments: detail.comments,
    fetchedAt: new Date().toISOString(),
    partial,
    ...(partialReason !== undefined ? { partialReason } : {}),
  };
  _orchestratorDeps.putCachedThread(thread);
  return { thread, ...(coverage ? { coverage } : {}) };
}

function dedupePosts(posts: XPost[]): XPost[] {
  const seen = new Set<string>();
  const out: XPost[] = [];
  for (const p of posts) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

type CapturedDetail = {
  detail: ParsedDetail;
  coverage?: WalkCoverage;
  /** P5.1 — true when any TweetDetail GraphQL response returned HTTP 429. */
  rateLimited?: boolean;
};

async function navigateAndCapture(
  ctx: BrowserContext,
  url: string,
  rootId: string,
  opts: FetchOptions,
): Promise<CapturedDetail> {
  const cfg = loadConfig();
  const page = await ctx.newPage();

  const aggregate: ParsedDetail = {
    rootPost: undefined,
    authorPosts: [],
    comments: [],
    quoteTweets: [],
  };
  const seenIds = new Set<string>();
  // Capture the very first TweetDetail request so pagination can replay it.
  let pagCtx: PaginationContext | undefined;
  let lastCursors: ExtractedCursors = { showMore: [] };
  // P5.1 — flagged when X returns 429 on a TweetDetail response. Surfaced
  // to the cookie-tier wrapper so it can back off + retry rather than
  // falling straight through to SSR on a transient rate limit.
  let rateLimited = false;

  const onRequest = (req: Request) => {
    const u = req.url();
    if (!u.includes('/graphql/') || !u.includes('TweetDetail')) return;
    if (pagCtx) return; // keep the first; queryId is stable per session
    const headers = req.headers();
    // Browsers/playwright surface forbidden headers in lowercase — that's fine,
    // page.evaluate(fetch) will forward them as a plain object.
    pagCtx = { url: u, headers };
  };
  const onResponse = async (res: Response) => {
    const u = res.url();
    if (!u.includes('/graphql/') || !u.includes('TweetDetail')) return;
    if (res.status() === 429) {
      rateLimited = true;
      logger.debug('graphql 429 on TweetDetail', { url: u });
      return;
    }
    try {
      const json = (await res.json()) as unknown;
      const parsed = parseTweetDetail(json, rootId);
      mergeInto(aggregate, parsed, seenIds);
      lastCursors = extractCursors(json);
    } catch (err) {
      logger.debug('graphql parse error', { err: String(err) });
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  let coverage: WalkCoverage | undefined;
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.fetcher.timeoutMs,
    });
    // wait briefly for the GraphQL TweetDetail response to land
    await waitForRoot(page, rootId, aggregate, cfg.fetcher.timeoutMs);
    // small scroll to nudge X into firing the first follow-up TweetDetail if any
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => undefined);
    await page.waitForTimeout(400);

    if (aggregate.rootPost) {
      const walkOpts = {
        maxReplies: opts.maxReplies ?? DEFAULT_MAX_REPLIES,
        depth: opts.depth ?? DEFAULT_DEPTH,
      };
      coverage = await walkReplyTree(
        page,
        rootId,
        aggregate,
        seenIds,
        lastCursors,
        pagCtx,
        walkOpts,
      );
    }
  } catch (err) {
    logger.warn('navigation issue', { url, err: String(err) });
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    await page.close();
  }

  return {
    detail: aggregate,
    ...(coverage ? { coverage } : {}),
    ...(rateLimited ? { rateLimited: true } : {}),
  };
}

async function waitForRoot(
  page: Page,
  rootId: string,
  aggregate: ParsedDetail,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (aggregate.rootPost) return;
    await page.waitForTimeout(150);
  }
  logger.debug('waitForRoot timed out', { rootId, ms: timeoutMs });
}

function mergeInto(target: ParsedDetail, src: ParsedDetail, seen: Set<string>): void {
  if (src.rootPost && !target.rootPost) target.rootPost = src.rootPost;
  for (const p of src.authorPosts) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    target.authorPosts.push(p);
  }
  for (const c of src.comments) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    target.comments.push(c);
  }
  for (const q of src.quoteTweets) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    target.quoteTweets.push(q);
  }
}
