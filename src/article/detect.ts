/**
 * P3.0 — URL classification for the article pipeline.
 *
 * Two outcomes mapped to the spec's `ArticleSource` enum:
 *   - `'x-article'`     — X's native long-form Article URLs and any tweet
 *                          card whose URL points back into x.com/i/article/.
 *                          P3.0's only fully-wired path.
 *   - `'external-html'` — any other HTTP(S) URL (Substack, Medium, etc.).
 *                          Classifier returns this correctly so P3.1 can
 *                          drop in the fetcher without revisiting detect.
 *
 * Returns `null` for non-URLs and known non-article resources (media
 * files, mailto, etc.). Pure function — no I/O.
 */
import type { ArticleSource } from '../models/article.ts';

/** Extensions for assets that are never articles — short-circuit the classifier. */
const NON_ARTICLE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
  '.ogg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
]);

/** Hosts that are X (the platform itself), used to spot X Article URLs. */
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com']);

/**
 * Classify a URL into an `ArticleSource`, or return `null` when it is
 * non-HTTP, non-URL, or points at a known non-article resource.
 *
 * X Article shapes recognised in P3.0:
 *   - `https://x.com/i/article/{id}`
 *   - `https://x.com/{handle}/articles/{id}` (and `/article/` singular)
 *   - `https://twitter.com/...` equivalents
 *
 * Plain tweet URLs (`status/<id>`) are NOT articles — return `null` so
 * callers don't accidentally feed a thread URL into the article pipeline.
 */
export function detectArticleSource(url: string): ArticleSource | null {
  if (typeof url !== 'string' || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Filter non-article resources by extension. Case-insensitive so `.PDF`
  // is caught alongside `.pdf`. Use `pathname` so query strings don't
  // false-positive on `?ext=.mp4`.
  const lowerPath = parsed.pathname.toLowerCase();
  for (const ext of NON_ARTICLE_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (X_HOSTS.has(host)) {
    // X Article paths: /i/article/<id>, /<handle>/articles/<id>, /<handle>/article/<id>.
    // A bare /status/<id> is a tweet, not an article — fall through to null.
    if (/^\/i\/article\//i.test(parsed.pathname)) return 'x-article';
    if (/^\/[^/]+\/articles?\//i.test(parsed.pathname)) return 'x-article';
    return null;
  }

  return 'external-html';
}

/**
 * P3.0 — `ArticleParseError`-style sentinel for the parse step. Defined
 * here so `detect` callers can throw a consistent error type when they
 * mean "this URL classified, but the underlying card / page had no
 * extractable body". `parse-x-article.ts` also throws this.
 */
export class ArticleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArticleParseError';
  }
}

/**
 * P3.0 — Standardised error for orchestrator-level failures (unsupported
 * source, network, etc.). Distinct from `ArticleParseError` so callers
 * can decide whether to escalate or skip.
 */
export class ArticleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArticleError';
  }
}
