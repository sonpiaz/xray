import type { BrowserContext, Page, Request, Response } from 'playwright';
import { putCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { AuthRequiredError, FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { XPost } from '../models/post.ts';
import type { XThread } from '../models/thread.ts';
import { newContext } from './browser.ts';
import { type PaginationContext, type WalkCoverage, walkReplyTree } from './pagination.ts';
import {
  type ExtractedCursors,
  type ParsedDetail,
  extractCursors,
  parseTweetDetail,
} from './parser.ts';
import { type ParsedXUrl, parseXUrl } from './url.ts';

export type FetchMode = 'auto' | 'anon' | 'auth';

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
};

export async function fetchThread(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const parsed = parseXUrl(rawUrl);
  const cfg = loadConfig();
  const mode = opts.mode ?? cfg.fetcher.mode;

  if (mode === 'auth') {
    return fetchInMode(parsed, 'auth', opts);
  }
  if (mode === 'anon') {
    return fetchInMode(parsed, 'anon', opts);
  }
  // auto: anonymous first; on AuthRequiredError, retry with auth
  try {
    return await fetchInMode(parsed, 'anon', opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      logger.info('anonymous fetch hit auth wall; retrying with saved login');
      return fetchInMode(parsed, 'auth', opts);
    }
    throw err;
  }
}

async function fetchInMode(
  parsed: ParsedXUrl,
  mode: 'anon' | 'auth',
  opts: FetchOptions,
): Promise<FetchResult> {
  const cfg = loadConfig();
  const ctx = await newContext(mode);
  try {
    const captured = await navigateAndCapture(ctx, parsed.canonical, parsed.id, opts);
    const detail = captured.detail;
    if (!detail.rootPost) {
      // Either auth wall or the page didn't deliver TweetDetail.
      if (mode === 'anon') throw new AuthRequiredError();
      throw new FetchError(
        'TweetDetail response was not captured. The tweet may be deleted, protected, or X may have rate-limited.',
      );
    }
    const coverage = captured.coverage;
    const partial = detail.comments.length === 0 || (coverage ? coverage.status !== 'ok' : false);
    let partialReason: string | undefined;
    if (detail.comments.length === 0) {
      partialReason = 'no replies returned in first page';
    } else if (coverage && coverage.status !== 'ok') {
      partialReason = coverage.failureReason ?? `coverage status: ${coverage.status}`;
    }
    const thread: XThread = {
      rootPost: detail.rootPost,
      authorPosts: detail.authorPosts,
      quoteTweets: dedupePosts(detail.quoteTweets),
      comments: detail.comments,
      fetchedAt: new Date().toISOString(),
      partial,
      ...(partialReason !== undefined ? { partialReason } : {}),
    };
    putCachedThread(thread);
    return { thread, ...(coverage ? { coverage } : {}) };
  } finally {
    await ctx.close();
    void cfg; // silence unused
  }
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
};

const DEFAULT_MAX_REPLIES = 50;
const DEFAULT_DEPTH = 3;

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

  let authWall = false;
  let coverage: WalkCoverage | undefined;
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.fetcher.timeoutMs,
    });
    if (response && (response.status() === 401 || response.status() === 403)) {
      authWall = true;
    }
    // wait briefly for the GraphQL TweetDetail response to land
    await waitForRoot(page, rootId, aggregate, cfg.fetcher.timeoutMs);
    // small scroll to nudge X into firing the first follow-up TweetDetail if any
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => undefined);
    await page.waitForTimeout(400);

    if (!aggregate.rootPost && page.url().includes('/i/flow/login')) {
      authWall = true;
    }

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

  if (authWall && !aggregate.rootPost) throw new AuthRequiredError();
  return { detail: aggregate, ...(coverage ? { coverage } : {}) };
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
