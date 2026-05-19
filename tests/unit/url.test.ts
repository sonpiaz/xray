import { describe, expect, it } from 'vitest';
import { parseXUrl } from '../../src/fetcher/url.ts';

describe('parseXUrl', () => {
  it('parses standard tweet url', () => {
    const p = parseXUrl('https://x.com/karpathy/status/1234567890');
    expect(p.id).toBe('1234567890');
    expect(p.handle).toBe('karpathy');
    expect(p.canonical).toBe('https://x.com/karpathy/status/1234567890');
  });

  it('parses twitter.com legacy url', () => {
    const p = parseXUrl('https://twitter.com/karpathy/status/1234567890?s=20');
    expect(p.id).toBe('1234567890');
    expect(p.handle).toBe('karpathy');
  });

  it('parses /i/status form', () => {
    const p = parseXUrl('https://x.com/i/status/9999');
    expect(p.id).toBe('9999');
    expect(p.handle).toBeUndefined();
    expect(p.canonical).toBe('https://x.com/i/status/9999');
  });

  it('rejects non-tweet urls', () => {
    expect(() => parseXUrl('https://x.com/karpathy')).toThrow();
  });

  it('rejects non-x hosts', () => {
    expect(() => parseXUrl('https://example.com/foo/status/1')).toThrow();
  });

  it('rejects non-numeric ids', () => {
    expect(() => parseXUrl('https://x.com/u/status/abc')).toThrow();
  });
});
