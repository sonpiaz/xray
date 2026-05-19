/**
 * P2.1 — Platform detection + URL canonicalization for the video pipeline.
 *
 * Pure helpers, no IO. Used by `download.ts` to route between the X-native
 * direct-download path and the yt-dlp subprocess wrapper. Canonicalization
 * also doubles as the cache key generator for P2.2 — keep it deterministic.
 */
import type { VideoSource } from '../models/video-report.ts';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

const TIKTOK_HOSTS = new Set([
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

const LINKEDIN_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'mobile.x.com',
]);

/**
 * Returns the platform identifier for a video URL, or `null` if the host
 * isn't one of the supported platforms. Detection is host-based; LinkedIn
 * also requires a known post/feed path so we don't accidentally fire yt-dlp
 * on a job listing or company page.
 */
export function detectPlatform(url: string): VideoSource | null {
  const parsed = safeParseUrl(url);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) return 'youtube';
  if (TIKTOK_HOSTS.has(host)) return 'tiktok';
  if (VIMEO_HOSTS.has(host)) return 'vimeo';
  if (LINKEDIN_HOSTS.has(host)) {
    // LinkedIn requires a specific path — `/posts/<slug>` or
    // `/feed/update/<urn>`. Everything else (profiles, jobs, etc.) is not
    // a video URL and yt-dlp would fail noisily.
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith('/posts/') || path.startsWith('/feed/update/')) {
      return 'linkedin';
    }
    return null;
  }
  if (X_HOSTS.has(host)) return 'x-native';

  return null;
}

/**
 * Tracking-param prefixes/keys we strip during canonicalization. Kept as
 * a static list so the function is fully deterministic (no env / locale
 * dependence).
 */
const TRACKING_PARAM_KEYS = new Set([
  'si', // YouTube share-id
  'feature', // YouTube
  'pp', // YouTube
  't', // YouTube timestamp — informative, but not identity-defining
  '_r', // TikTok
  '_t', // TikTok
  'is_from_webapp',
  'sender_device',
  'web_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'gclid',
  'fbclid',
]);

/**
 * Produce a stable canonical form of a video URL suitable for cache keys.
 *
 * Rules:
 * - youtu.be/<id> → youtube.com/watch?v=<id>
 * - m.youtube.com → youtube.com (always)
 * - strip tracking params (see TRACKING_PARAM_KEYS)
 * - lowercase host
 * - drop trailing slash on the path
 * - drop fragment (#t=42)
 * - sort remaining query params alphabetically (so ?a=1&b=2 ≡ ?b=2&a=1)
 *
 * Returns the original URL string if parsing fails — callers should still
 * have a usable string but should not expect it to be canonical.
 */
export function canonicalizeVideoUrl(url: string, platform: VideoSource): string {
  const parsed = safeParseUrl(url);
  if (!parsed) return url;

  // youtu.be short link → expand to youtube.com/watch?v=<id>
  if (platform === 'youtube' && parsed.hostname.toLowerCase() === 'youtu.be') {
    const videoId = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
    if (videoId) {
      const expanded = new URL('https://youtube.com/watch');
      expanded.searchParams.set('v', videoId);
      copyKeptParams(parsed.searchParams, expanded.searchParams);
      return finalizeUrl(expanded);
    }
  }

  // Normalize the host: drop mobile subdomain + www.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('m.') || host.startsWith('www.') || host.startsWith('mobile.')) {
    host = host.replace(/^(m|www|mobile)\./, '');
  }
  // youtube-nocookie → youtube
  if (host === 'youtube-nocookie.com') host = 'youtube.com';
  // twitter → x
  if (host === 'twitter.com') host = 'x.com';

  const canonical = new URL(`${parsed.protocol}//${host}${parsed.pathname}${parsed.search}`);
  // Sweep tracking params off the new URL's searchParams in-place.
  for (const key of Array.from(canonical.searchParams.keys())) {
    if (TRACKING_PARAM_KEYS.has(key.toLowerCase())) {
      canonical.searchParams.delete(key);
    }
  }

  // Sort params for stability.
  const sorted = new URLSearchParams();
  const keys = Array.from(canonical.searchParams.keys()).sort();
  for (const k of keys) {
    const v = canonical.searchParams.get(k);
    if (v !== null) sorted.set(k, v);
  }
  canonical.search = sorted.toString();

  // Drop trailing slash on the path (but keep root "/" as-is).
  if (canonical.pathname.length > 1 && canonical.pathname.endsWith('/')) {
    canonical.pathname = canonical.pathname.replace(/\/+$/, '');
  }

  return finalizeUrl(canonical);
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function copyKeptParams(from: URLSearchParams, to: URLSearchParams): void {
  for (const [k, v] of from) {
    if (!TRACKING_PARAM_KEYS.has(k.toLowerCase())) to.set(k, v);
  }
}

function finalizeUrl(u: URL): string {
  u.hash = '';
  // URL.toString() preserves an empty `?` if search was set then cleared;
  // strip it for cosmetic stability.
  const s = u.toString();
  return s.endsWith('?') ? s.slice(0, -1) : s;
}

/**
 * Human-readable list of supported platforms used in error messages. Update
 * when adding new platforms.
 */
export const SUPPORTED_PLATFORMS_LABEL = 'x-native, youtube, tiktok, vimeo, linkedin';
