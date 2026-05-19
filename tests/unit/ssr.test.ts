import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../../src/core/errors.ts';
import { parseSsrHtml } from '../../src/fetcher/ssr.ts';
import { parseXUrl } from '../../src/fetcher/url.ts';

const fixtureHtml = readFileSync(join(__dirname, '..', 'fixtures', 'x-ssr-page.html'), 'utf8');
const fixtureParsedUrl = parseXUrl('https://x.com/karpathy/status/1234567890');

describe('parseSsrHtml — happy path', () => {
  const { thread, coverage } = parseSsrHtml(fixtureHtml, fixtureParsedUrl);

  it('extracts the root post id and canonical url', () => {
    expect(thread.rootPost.id).toBe('1234567890');
    expect(thread.rootPost.url).toBe('https://x.com/karpathy/status/1234567890');
  });

  it('extracts the author handle from canonical link', () => {
    expect(thread.rootPost.author.handle).toBe('karpathy');
  });

  it('extracts display name from og:title', () => {
    expect(thread.rootPost.author.displayName).toBe('Andrej Karpathy');
  });

  it('extracts tweet text from og:description', () => {
    expect(thread.rootPost.text).toMatch(/Transformer scaling is decelerating/);
  });

  it('extracts a single image attachment from og:image', () => {
    expect(thread.rootPost.media).toHaveLength(1);
    expect(thread.rootPost.media[0]?.type).toBe('image');
    expect(thread.rootPost.media[0]?.url).toContain('pbs.twimg.com/media/');
  });

  it('returns empty replies / authorPosts / quoteTweets', () => {
    expect(thread.comments).toEqual([]);
    expect(thread.authorPosts).toEqual([]);
    expect(thread.quoteTweets).toEqual([]);
  });

  it('flags the thread as partial with an SSR-specific reason', () => {
    expect(thread.partial).toBe(true);
    expect(thread.partialReason).toMatch(/SSR/i);
  });

  it('reports coverage tier=ssr with zero depth/reply targets', () => {
    expect(coverage.tier).toBe('ssr');
    expect(coverage.targetDepth).toBe(0);
    expect(coverage.achievedDepth).toBe(0);
    expect(coverage.targetReplies).toBe(0);
    expect(coverage.fetchedReplies).toBe(0);
    expect(coverage.status).toBe('ok');
  });

  it('leaves metrics empty since SSR does not expose engagement counts', () => {
    expect(thread.rootPost.metrics.likes).toBeUndefined();
    expect(thread.rootPost.metrics.reposts).toBeUndefined();
    expect(thread.rootPost.metrics.replies).toBeUndefined();
    expect(thread.rootPost.metrics.views).toBeUndefined();
  });
});

describe('parseSsrHtml — handle fallback', () => {
  it('falls back to og:url when canonical link is absent', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Some User on X: hello" />
        <meta property="og:description" content="hello world" />
        <meta property="og:url" content="https://x.com/someuser/status/1234567890" />
      </head><body></body></html>
    `;
    const { thread } = parseSsrHtml(html, fixtureParsedUrl);
    expect(thread.rootPost.author.handle).toBe('someuser');
  });

  it('falls back to the input URL handle when neither canonical nor og:url is present', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Karpathy on X: hi" />
        <meta property="og:description" content="hi" />
      </head><body></body></html>
    `;
    const { thread } = parseSsrHtml(html, fixtureParsedUrl);
    expect(thread.rootPost.author.handle).toBe('karpathy');
  });
});

describe('parseSsrHtml — media handling', () => {
  it('skips og:image when it is not a real tweet media URL', () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://x.com/karpathy/status/1234567890" />
        <meta property="og:title" content="Andrej Karpathy on X: text only" />
        <meta property="og:description" content="text only" />
        <meta property="og:image" content="https://abs.twimg.com/icons/apple-touch-icon-192x192.png" />
      </head><body></body></html>
    `;
    const { thread } = parseSsrHtml(html, fixtureParsedUrl);
    expect(thread.rootPost.media).toEqual([]);
  });

  it('omits media entirely when og:image is missing', () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://x.com/karpathy/status/1234567890" />
        <meta property="og:title" content="Andrej Karpathy on X: text only" />
        <meta property="og:description" content="text only" />
      </head><body></body></html>
    `;
    const { thread } = parseSsrHtml(html, fixtureParsedUrl);
    expect(thread.rootPost.media).toEqual([]);
  });
});

describe('parseSsrHtml — error cases', () => {
  it('throws ParseError when no og:title and no og:description are present', () => {
    const html = '<html><head><title>Login on X</title></head><body>Sign in</body></html>';
    expect(() => parseSsrHtml(html, fixtureParsedUrl)).toThrow(ParseError);
  });

  it('throws ParseError when og tags exist but no handle can be derived (i-status fallback unavailable)', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="X on X: announcement" />
        <meta property="og:description" content="announcement" />
      </head><body></body></html>
    `;
    // An /i/status URL has no handle, and the test HTML has no canonical/og:url —
    // so no handle is recoverable from any source.
    const iStatusUrl = parseXUrl('https://x.com/i/status/9999');
    expect(() => parseSsrHtml(html, iStatusUrl)).toThrow(ParseError);
  });
});
