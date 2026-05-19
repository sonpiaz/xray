import { FetchError } from '../core/errors.ts';

export type ParsedXUrl = {
  id: string;
  handle?: string;
  canonical: string;
};

const HOSTS = new Set([
  'x.com',
  'twitter.com',
  'www.x.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

export function parseXUrl(input: string): ParsedXUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError(`Not a valid URL: ${input}`);
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    throw new FetchError(`Not an X/Twitter URL: ${input}`);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  // patterns: /<handle>/status/<id> | /i/status/<id>
  const statusIdx = parts.indexOf('status');
  if (statusIdx === -1 || !parts[statusIdx + 1]) {
    throw new FetchError(`URL is not a tweet (need /<user>/status/<id>): ${input}`);
  }
  const idRaw = parts[statusIdx + 1];
  const id = idRaw?.split('?')[0]?.split('/')[0];
  if (!id || !/^\d+$/.test(id)) {
    throw new FetchError(`Tweet id must be numeric: ${idRaw}`);
  }
  const handle = statusIdx > 0 && parts[0] !== 'i' ? parts[0] : undefined;
  const canonical = handle
    ? `https://x.com/${handle}/status/${id}`
    : `https://x.com/i/status/${id}`;
  return { id, handle, canonical };
}
