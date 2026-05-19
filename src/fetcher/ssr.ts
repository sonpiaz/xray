/**
 * P1.5.0 — Tier 1: SSR HTML scrape.
 *
 * Fetches the server-rendered HTML of an X status URL with undici and extracts
 * the root post from `og:*` meta tags plus the canonical/og:url path. No
 * Playwright, no cookies, no auth — sub-second for fast networks.
 *
 * What SSR reliably gives us today (verified by inspecting public X status URLs
 * without a logged-in session): the OG card meta tags (`og:title`,
 * `og:description`, `og:image`, `og:url`) and a `<link rel="canonical">`. X
 * strips replies, metrics, and most of the reply tree from the SSR HTML for
 * logged-out clients — so this tier ALWAYS returns `partial=true` with only
 * the root post populated.
 *
 * Anything richer (replies, nested tree, real-time metrics) must come from a
 * later tier. Escalation logic lives in P1.5.2 (orchestrator). This module
 * exposes `fetchSsr` as a callable function only; it does NOT wire itself into
 * the default `xray thread` path.
 */
import { load as loadHtml } from 'cheerio';
import { request } from 'undici';
import { FetchError, ParseError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { XMedia } from '../models/media.ts';
import type { XAuthor, XPost } from '../models/post.ts';
import type { ThreadCoverage } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';
import { type ParsedXUrl, parseXUrl } from './url.ts';

/**
 * Real Safari UA — same value used by the Playwright path so SSR responses
 * look indistinguishable from a normal browser visit.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

const DEFAULT_TIMEOUT_MS = 8000;

export type SsrFetchOptions = {
  timeoutMs?: number;
};

export type SsrFetchResult = {
  thread: XThread;
  coverage: ThreadCoverage;
};

/**
 * Fetch the SSR HTML for `url` and parse the root post out of it.
 *
 * Throws `FetchError` on HTTP error / network failure and `ParseError` when the
 * response body doesn't look like an X status page (no recognizable OG meta).
 * The caller (P1.5.2 orchestrator, when it lands) decides whether to escalate.
 */
export async function fetchSsr(url: string, opts: SsrFetchOptions = {}): Promise<SsrFetchResult> {
  const parsed = parseXUrl(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let html: string;
  try {
    const res = await request(parsed.canonical, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new FetchError(`SSR fetch returned HTTP ${res.statusCode} for ${parsed.canonical}`);
    }
    html = await res.body.text();
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`SSR fetch failed for ${parsed.canonical}`, { cause: err });
  }

  return parseSsrHtml(html, parsed);
}

/**
 * Pure parser — takes a pre-fetched HTML string and a parsed URL, returns the
 * SSR-derived `XThread` + `ThreadCoverage`. Exposed separately so tests can
 * exercise extraction logic without standing up a network mock.
 */
export function parseSsrHtml(html: string, parsedUrl: ParsedXUrl): SsrFetchResult {
  const $ = loadHtml(html);

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
  const ogUrl = $('meta[property="og:url"]').attr('content')?.trim();
  const canonicalHref = $('link[rel="canonical"]').attr('href')?.trim();

  // Defensive: an X status page reliably ships og:description (the tweet text)
  // and og:url / canonical. If neither survives, we're either looking at a
  // login wall, an interstitial, or X changed its SSR. Treat as a parse error
  // so the orchestrator can escalate.
  if (!ogDescription && !ogTitle) {
    throw new ParseError(`SSR HTML missing og:title and og:description for tweet ${parsedUrl.id}`);
  }

  // Pull the author handle from canonical / og:url first (most reliable), fall
  // back to the URL the caller passed in.
  const handle = extractHandle(canonicalHref, ogUrl, parsedUrl.handle);
  if (!handle) {
    throw new ParseError(`SSR HTML did not yield an author handle for tweet ${parsedUrl.id}`);
  }

  const displayName = extractDisplayName(ogTitle);

  const author: XAuthor = {
    handle,
    verified: false,
    ...(displayName !== undefined ? { displayName } : {}),
  };

  const media: XMedia[] = [];
  if (ogImage && isLikelyTweetImage(ogImage)) {
    media.push({ type: 'image', url: ogImage });
  }

  const rootPost: XPost = {
    id: parsedUrl.id,
    url: `https://x.com/${handle}/status/${parsedUrl.id}`,
    author,
    text: ogDescription ?? '',
    metrics: {},
    media,
    links: [],
    isReply: false,
    isQuote: false,
  };

  const thread: XThread = {
    rootPost,
    authorPosts: [],
    quoteTweets: [],
    comments: [],
    fetchedAt: new Date().toISOString(),
    partial: true,
    partialReason: 'SSR HTML only — no replies or metrics available',
  };

  const coverage: ThreadCoverage = {
    targetDepth: 0,
    achievedDepth: 0,
    targetReplies: 0,
    fetchedReplies: 0,
    classifiedReplies: 0,
    paginationCursors: [],
    status: 'ok',
    tier: 'ssr',
  };

  logger.debug('SSR parse complete', {
    rootId: parsedUrl.id,
    handle,
    hasImage: media.length > 0,
    textLen: rootPost.text.length,
  });

  return { thread, coverage };
}

/**
 * Pull `{handle}` out of `.../{handle}/status/{id}`. Tries `link[rel=canonical]`
 * first, then `og:url`, then the originally-requested URL. Returns undefined
 * only when none of them yield a non-`i` path segment before `/status/`.
 */
function extractHandle(
  canonical: string | undefined,
  ogUrl: string | undefined,
  fallback: string | undefined,
): string | undefined {
  for (const candidate of [canonical, ogUrl]) {
    if (!candidate) continue;
    const fromUrl = handleFromStatusUrl(candidate);
    if (fromUrl) return fromUrl;
  }
  return fallback;
}

function handleFromStatusUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const statusIdx = parts.indexOf('status');
  if (statusIdx <= 0) return undefined;
  const candidate = parts[0];
  if (!candidate || candidate === 'i') return undefined;
  return candidate;
}

/**
 * X's `og:title` is shaped like `"<DisplayName> on X: \"<truncated text\""` or
 * `"<DisplayName> (@handle) on X"`. We just want the leading display name.
 * Returns undefined if the title doesn't follow a known shape — better to
 * leave display name absent than to inject garbage.
 */
function extractDisplayName(ogTitle: string | undefined): string | undefined {
  if (!ogTitle) return undefined;
  // "Name on X: ..." — common single-tweet shape
  const onXIdx = ogTitle.indexOf(' on X');
  if (onXIdx > 0) {
    const name = ogTitle.slice(0, onXIdx).trim();
    return name.length > 0 ? name : undefined;
  }
  // "Name on Twitter: ..." — legacy shape, occasionally still served
  const onTwitterIdx = ogTitle.indexOf(' on Twitter');
  if (onTwitterIdx > 0) {
    const name = ogTitle.slice(0, onTwitterIdx).trim();
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}

/**
 * X serves a generic site card image (e.g. card_img / profile placeholder) for
 * tweets without media. Real tweet media lives under `pbs.twimg.com/media/`.
 * Anything else we treat as "no SSR-visible media" rather than fabricating an
 * attachment that isn't part of the tweet.
 */
function isLikelyTweetImage(imageUrl: string): boolean {
  try {
    const u = new URL(imageUrl);
    if (u.hostname !== 'pbs.twimg.com') return false;
    return u.pathname.startsWith('/media/') || u.pathname.startsWith('/ext_tw_video_thumb/');
  } catch {
    return false;
  }
}
