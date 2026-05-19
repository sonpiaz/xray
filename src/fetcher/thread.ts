import type { BrowserContext, Page, Response } from 'playwright';
import { putCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { AuthRequiredError, FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { XPost } from '../models/post.ts';
import type { XThread } from '../models/thread.ts';
import { newContext } from './browser.ts';
import { type ParsedDetail, parseTweetDetail } from './parser.ts';
import { type ParsedXUrl, parseXUrl } from './url.ts';

export type FetchMode = 'auto' | 'anon' | 'auth';

export type FetchOptions = {
  mode?: FetchMode;
};

export async function fetchThread(rawUrl: string, opts: FetchOptions = {}): Promise<XThread> {
  const parsed = parseXUrl(rawUrl);
  const cfg = loadConfig();
  const mode = opts.mode ?? cfg.fetcher.mode;

  if (mode === 'auth') {
    return fetchInMode(parsed, 'auth');
  }
  if (mode === 'anon') {
    return fetchInMode(parsed, 'anon');
  }
  // auto: anonymous first; on AuthRequiredError, retry with auth
  try {
    return await fetchInMode(parsed, 'anon');
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      logger.info('anonymous fetch hit auth wall; retrying with saved login');
      return fetchInMode(parsed, 'auth');
    }
    throw err;
  }
}

async function fetchInMode(parsed: ParsedXUrl, mode: 'anon' | 'auth'): Promise<XThread> {
  const cfg = loadConfig();
  const ctx = await newContext(mode);
  try {
    const detail = await navigateAndCapture(ctx, parsed.canonical, parsed.id);
    if (!detail.rootPost) {
      // Either auth wall or the page didn't deliver TweetDetail.
      if (mode === 'anon') throw new AuthRequiredError();
      throw new FetchError(
        'TweetDetail response was not captured. The tweet may be deleted, protected, or X may have rate-limited.',
      );
    }
    const thread: XThread = {
      rootPost: detail.rootPost,
      authorPosts: detail.authorPosts,
      quoteTweets: dedupePosts(detail.quoteTweets),
      comments: detail.comments,
      fetchedAt: new Date().toISOString(),
      partial: detail.comments.length === 0,
      partialReason: detail.comments.length === 0 ? 'no replies returned in first page' : undefined,
    };
    putCachedThread(thread);
    return thread;
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

async function navigateAndCapture(
  ctx: BrowserContext,
  url: string,
  rootId: string,
): Promise<ParsedDetail> {
  const cfg = loadConfig();
  const page = await ctx.newPage();

  const aggregate: ParsedDetail = {
    rootPost: undefined,
    authorPosts: [],
    comments: [],
    quoteTweets: [],
  };
  const seenIds = new Set<string>();

  const onResponse = async (res: Response) => {
    const u = res.url();
    if (!u.includes('/graphql/') || !u.includes('TweetDetail')) return;
    try {
      const json = (await res.json()) as unknown;
      const parsed = parseTweetDetail(json, rootId);
      mergeInto(aggregate, parsed, seenIds);
    } catch (err) {
      logger.debug('graphql parse error', { err: String(err) });
    }
  };
  page.on('response', onResponse);

  let authWall = false;
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
    // try to scroll to surface a few more replies
    await page.evaluate(() => window.scrollBy(0, 2000)).catch(() => undefined);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy(0, 2000)).catch(() => undefined);
    await page.waitForTimeout(800);

    if (!aggregate.rootPost && page.url().includes('/i/flow/login')) {
      authWall = true;
    }
  } catch (err) {
    logger.warn('navigation issue', { url, err: String(err) });
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  if (authWall && !aggregate.rootPost) throw new AuthRequiredError();
  return aggregate;
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
