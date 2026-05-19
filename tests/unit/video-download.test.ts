/**
 * P2.1 — Platform detection, URL canonicalization, yt-dlp wrapper, and
 * platform-routing tests.
 *
 * Strict no-network policy: nothing in this file actually spawns yt-dlp or
 * hits a remote host. The yt-dlp wrapper exposes a `spawn` test seam so we
 * inject a fake `runProcess` and assert flag construction + stderr
 * classification.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyError, VideoDownloadError } from '../../src/core/errors.ts';
import { normalizeAnalyzeInput } from '../../src/intelligence/video.ts';
import type { XMedia } from '../../src/models/media.ts';
import { YT_DLP_INSTALL_HINT, assertYtDlp } from '../../src/video/dependencies.ts';
import { downloadVideo } from '../../src/video/download.ts';
import {
  SUPPORTED_PLATFORMS_LABEL,
  canonicalizeVideoUrl,
  detectPlatform,
} from '../../src/video/platforms.ts';
import {
  buildYtDlpArgs,
  classifyYtDlpStderr,
  downloadViaYtDlp,
  parseYtDlpJson,
  resolveDownloadedFile,
} from '../../src/video/ytdlp.ts';

const TMP_ROOT = join(tmpdir(), `xray-video-p21-${Date.now()}`);

beforeAll(() => mkdirSync(TMP_ROOT, { recursive: true }));
afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ──────────────────────────────────────────────────────────────────────
// 1. detectPlatform — full matrix
// ──────────────────────────────────────────────────────────────────────

describe('detectPlatform', () => {
  it('detects youtube domains (www, m, music, nocookie, youtu.be)', () => {
    expect(detectPlatform('https://youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectPlatform('https://m.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectPlatform('https://music.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectPlatform('https://youtu.be/abc')).toBe('youtube');
    expect(detectPlatform('https://www.youtube-nocookie.com/embed/abc')).toBe('youtube');
  });

  it('detects tiktok domains (www, m, vm, vt shortlinks)', () => {
    expect(detectPlatform('https://tiktok.com/@user/video/123')).toBe('tiktok');
    expect(detectPlatform('https://www.tiktok.com/@user/video/123')).toBe('tiktok');
    expect(detectPlatform('https://m.tiktok.com/@user/video/123')).toBe('tiktok');
    expect(detectPlatform('https://vm.tiktok.com/ZMabcd/')).toBe('tiktok');
    expect(detectPlatform('https://vt.tiktok.com/abc')).toBe('tiktok');
  });

  it('detects vimeo (player + canonical)', () => {
    expect(detectPlatform('https://vimeo.com/123456789')).toBe('vimeo');
    expect(detectPlatform('https://player.vimeo.com/video/123456789')).toBe('vimeo');
  });

  it('detects linkedin only on post/feed paths', () => {
    expect(detectPlatform('https://www.linkedin.com/posts/some-user_activity-12345-abcd')).toBe(
      'linkedin',
    );
    expect(detectPlatform('https://linkedin.com/feed/update/urn:li:activity:12345')).toBe(
      'linkedin',
    );
    // Profile / company / jobs URLs are NOT video URLs.
    expect(detectPlatform('https://linkedin.com/in/sonpiaz')).toBeNull();
    expect(detectPlatform('https://linkedin.com/company/affitor')).toBeNull();
  });

  it('detects x.com + twitter.com as x-native', () => {
    expect(detectPlatform('https://x.com/user/status/12345')).toBe('x-native');
    expect(detectPlatform('https://twitter.com/user/status/12345')).toBe('x-native');
    expect(detectPlatform('https://mobile.twitter.com/user/status/12345')).toBe('x-native');
  });

  it('returns null for unknown hosts + bad URLs', () => {
    expect(detectPlatform('https://example.com/video.mp4')).toBeNull();
    expect(detectPlatform('https://reddit.com/r/videos/abc')).toBeNull();
    expect(detectPlatform('not-a-url')).toBeNull();
    expect(detectPlatform('')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. canonicalizeVideoUrl — cache key stability
// ──────────────────────────────────────────────────────────────────────

describe('canonicalizeVideoUrl', () => {
  it('expands youtu.be shortlinks to youtube.com/watch?v=', () => {
    const out = canonicalizeVideoUrl('https://youtu.be/dQw4w9WgXcQ', 'youtube');
    expect(out).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('strips tracking params (si, utm_*, t)', () => {
    const out = canonicalizeVideoUrl(
      'https://youtube.com/watch?v=abc&si=xxx&utm_source=share&t=42',
      'youtube',
    );
    expect(out).toBe('https://youtube.com/watch?v=abc');
  });

  it('treats two URLs differing only in tracking params as identical', () => {
    const a = canonicalizeVideoUrl(
      'https://www.youtube.com/watch?v=abc&si=share1&feature=youtu.be',
      'youtube',
    );
    const b = canonicalizeVideoUrl(
      'https://m.youtube.com/watch?v=abc&utm_source=newsletter',
      'youtube',
    );
    expect(a).toBe(b);
  });

  it('sorts remaining query params for stability', () => {
    const a = canonicalizeVideoUrl('https://vimeo.com/123?z=2&a=1', 'vimeo');
    const b = canonicalizeVideoUrl('https://vimeo.com/123?a=1&z=2', 'vimeo');
    expect(a).toBe(b);
    expect(a).toContain('a=1');
  });

  it('strips trailing slash and fragments', () => {
    const out = canonicalizeVideoUrl('https://tiktok.com/@u/video/123/#t=10', 'tiktok');
    expect(out).toBe('https://tiktok.com/@u/video/123');
  });

  it('drops m./www./mobile. subdomain prefixes', () => {
    expect(canonicalizeVideoUrl('https://m.youtube.com/watch?v=abc', 'youtube')).toBe(
      'https://youtube.com/watch?v=abc',
    );
    expect(canonicalizeVideoUrl('https://www.x.com/user/status/12', 'x-native')).toBe(
      'https://x.com/user/status/12',
    );
  });

  it('twitter.com → x.com', () => {
    expect(canonicalizeVideoUrl('https://twitter.com/user/status/12', 'x-native')).toBe(
      'https://x.com/user/status/12',
    );
  });

  it('returns the original string on bad URL input', () => {
    expect(canonicalizeVideoUrl('not-a-url', 'youtube')).toBe('not-a-url');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. buildYtDlpArgs — flag construction
// ──────────────────────────────────────────────────────────────────────

describe('buildYtDlpArgs', () => {
  it('includes the universal safety flags', () => {
    const args = buildYtDlpArgs('https://youtube.com/watch?v=x', '/tmp/out');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--no-warnings');
    expect(args).toContain('--print-json');
    expect(args).toContain('--merge-output-format');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
  });

  it('caps quality at 720p with sensible fallbacks', () => {
    const args = buildYtDlpArgs('https://youtube.com/watch?v=x', '/tmp/out');
    const formatIdx = args.indexOf('-f');
    expect(formatIdx).toBeGreaterThan(-1);
    const formatValue = args[formatIdx + 1] ?? '';
    expect(formatValue).toContain('height<=720');
    expect(formatValue).toContain('best');
  });

  it('puts the URL as the last positional argument', () => {
    const url = 'https://youtube.com/watch?v=x';
    const args = buildYtDlpArgs(url, '/tmp/out');
    expect(args[args.length - 1]).toBe(url);
  });

  it('uses {outputDir}/%(id)s.%(ext)s as the output template', () => {
    const args = buildYtDlpArgs('https://youtube.com/watch?v=x', '/tmp/out');
    const oIdx = args.indexOf('-o');
    expect(args[oIdx + 1]).toBe('/tmp/out/%(id)s.%(ext)s');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. parseYtDlpJson — metadata parsing
// ──────────────────────────────────────────────────────────────────────

describe('parseYtDlpJson', () => {
  it('extracts id, title, duration from a youtube-shaped blob', () => {
    const blob = JSON.stringify({
      id: 'dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up',
      duration: 213,
      uploader: 'RickAstleyVEVO',
      thumbnail: 'https://i.ytimg.com/...',
      formats: [{ format_id: '247' }],
    });
    const out = parseYtDlpJson(blob);
    expect(out?.id).toBe('dQw4w9WgXcQ');
    expect(out?.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(out?.duration).toBe(213);
  });

  it('tolerates the older _filename field', () => {
    const blob = JSON.stringify({
      id: 'abc',
      duration: 10,
      _filename: '/tmp/out/abc.mp4',
    });
    const out = parseYtDlpJson(blob);
    expect(out?.filename).toBe('/tmp/out/abc.mp4');
  });

  it('returns null on empty / non-JSON stdout', () => {
    expect(parseYtDlpJson('')).toBeNull();
    expect(parseYtDlpJson('not json at all')).toBeNull();
  });

  it('finds the first JSON object even with leading noise', () => {
    const blob = `[download] Destination: ./abc.mp4\n${JSON.stringify({ id: 'abc', duration: 5 })}`;
    const out = parseYtDlpJson(blob);
    expect(out?.id).toBe('abc');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. classifyYtDlpStderr — failure-mode matrix
// ──────────────────────────────────────────────────────────────────────

describe('classifyYtDlpStderr', () => {
  it('detects login-required from age-gate / private-video phrases', () => {
    expect(classifyYtDlpStderr('Sign in to confirm your age')).toBe('login-required');
    expect(classifyYtDlpStderr('ERROR: Private video. Login required')).toBe('login-required');
    expect(classifyYtDlpStderr('This video is only available for premium users')).toBe(
      'login-required',
    );
  });

  it('detects unavailable / removed videos', () => {
    expect(classifyYtDlpStderr('Video unavailable')).toBe('unavailable');
    expect(classifyYtDlpStderr('This video has been removed by the uploader')).toBe('unavailable');
    expect(classifyYtDlpStderr('not available in your country')).toBe('unavailable');
  });

  it('detects rate-limit', () => {
    expect(classifyYtDlpStderr('HTTP Error 429: Too Many Requests')).toBe('rate-limited');
  });

  it('falls back to generic for anything else', () => {
    expect(classifyYtDlpStderr('boop')).toBe('generic');
    expect(classifyYtDlpStderr('')).toBe('generic');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. resolveDownloadedFile — output discovery
// ──────────────────────────────────────────────────────────────────────

describe('resolveDownloadedFile', () => {
  it('returns the {id}.mp4 path when present', () => {
    const dir = join(TMP_ROOT, 'resolve-direct');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'abc.mp4');
    writeFileSync(file, 'x');
    expect(resolveDownloadedFile(dir, 'abc')).toBe(file);
  });

  it('falls back to {id}.<other-ext> if mp4 not found', () => {
    const dir = join(TMP_ROOT, 'resolve-fallback');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'xyz.webm');
    writeFileSync(file, 'x');
    expect(resolveDownloadedFile(dir, 'xyz')).toBe(file);
  });

  it('returns null when no matching file exists', () => {
    const dir = join(TMP_ROOT, 'resolve-empty');
    mkdirSync(dir, { recursive: true });
    expect(resolveDownloadedFile(dir, 'missing')).toBeNull();
  });

  it('returns null on non-existent dir', () => {
    expect(resolveDownloadedFile('/nonexistent/dir', 'x')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. downloadViaYtDlp — mocked subprocess paths
// ──────────────────────────────────────────────────────────────────────

describe('downloadViaYtDlp', () => {
  it('throws VideoDownloadError on login-required exit', async () => {
    const fakeSpawn = async () => ({
      code: 1,
      stdout: '',
      stderr: 'ERROR: Sign in to confirm your age',
    });
    await expect(
      downloadViaYtDlp('https://youtube.com/watch?v=x', {
        outputDir: join(TMP_ROOT, 'login'),
        platform: 'youtube',
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(VideoDownloadError);
  });

  it('throws VideoDownloadError on unavailable video', async () => {
    const fakeSpawn = async () => ({
      code: 1,
      stdout: '',
      stderr: 'ERROR: Video unavailable',
    });
    try {
      await downloadViaYtDlp('https://youtube.com/watch?v=x', {
        outputDir: join(TMP_ROOT, 'gone'),
        platform: 'youtube',
        spawn: fakeSpawn,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VideoDownloadError);
      expect(String(err)).toContain('unavailable');
    }
  });

  it('marks rate-limit failures as transient', async () => {
    const fakeSpawn = async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTP Error 429: Too Many Requests',
    });
    try {
      await downloadViaYtDlp('https://youtube.com/watch?v=x', {
        outputDir: join(TMP_ROOT, 'rate'),
        platform: 'youtube',
        spawn: fakeSpawn,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VideoDownloadError);
      if (err instanceof VideoDownloadError) {
        expect(err.transient).toBe(true);
      }
    }
  });

  it('throws when yt-dlp succeeds but produces no output file', async () => {
    const outputDir = join(TMP_ROOT, 'no-output');
    mkdirSync(outputDir, { recursive: true });
    const fakeSpawn = async () => ({
      code: 0,
      stdout: JSON.stringify({ id: 'phantom', duration: 5 }),
      stderr: '',
    });
    await expect(
      downloadViaYtDlp('https://youtube.com/watch?v=x', {
        outputDir,
        platform: 'youtube',
        spawn: fakeSpawn,
      }),
    ).rejects.toThrow(/no output file/);
  });

  it('returns metadata + filePath on success', async () => {
    const outputDir = join(TMP_ROOT, 'success');
    mkdirSync(outputDir, { recursive: true });
    // Simulate the file yt-dlp would write before exiting.
    const expectedPath = join(outputDir, 'demoVideo.mp4');
    writeFileSync(expectedPath, Buffer.alloc(1024, 0));

    const fakeSpawn = async () => ({
      code: 0,
      stdout: JSON.stringify({ id: 'demoVideo', title: 'Demo', duration: 12.5 }),
      stderr: '',
    });

    const res = await downloadViaYtDlp('https://youtube.com/watch?v=demoVideo', {
      outputDir,
      platform: 'youtube',
      spawn: fakeSpawn,
    });
    expect(res.filePath).toBe(expectedPath);
    expect(res.sizeBytes).toBe(1024);
    expect(res.durationMs).toBe(12500);
    expect(res.title).toBe('Demo');
    expect(res.videoId).toBe('demoVideo');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. assertYtDlp — dependency-error install hint
// ──────────────────────────────────────────────────────────────────────

describe('assertYtDlp', () => {
  it('throws DependencyError with install instructions when missing', () => {
    expect(() =>
      assertYtDlp({ ffmpeg: { available: false }, ffprobe: { available: false } }),
    ).toThrow(DependencyError);
    try {
      assertYtDlp({
        ffmpeg: { available: false },
        ffprobe: { available: false },
        ytdlp: { available: false },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(String(err)).toContain('yt-dlp');
      expect(String(err)).toContain('brew install yt-dlp');
    }
  });

  it('does not throw when yt-dlp is available', () => {
    expect(() =>
      assertYtDlp({
        ffmpeg: { available: false },
        ffprobe: { available: false },
        ytdlp: { available: true, path: '/usr/local/bin/yt-dlp' },
      }),
    ).not.toThrow();
  });

  it('exports a canonical install hint constant', () => {
    expect(YT_DLP_INSTALL_HINT).toContain('brew install yt-dlp');
    expect(YT_DLP_INSTALL_HINT).toContain('pipx install yt-dlp');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9. downloadVideo — platform routing
// ──────────────────────────────────────────────────────────────────────

describe('downloadVideo routing', () => {
  it('throws with supported-platforms hint on unknown host', async () => {
    try {
      await downloadVideo({ url: 'https://example.com/foo.mp4' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VideoDownloadError);
      expect(String(err)).toContain(SUPPORTED_PLATFORMS_LABEL);
    }
  });

  it('routes YouTube URL through yt-dlp (test seam)', async () => {
    const outputDir = join(TMP_ROOT, 'route-yt');
    mkdirSync(outputDir, { recursive: true });

    // Pre-create the file the fake yt-dlp would write. Because the router
    // creates a per-URL subdir under outputDir, mirror that here.
    const fakeSpawn = async (_bin: string, args: string[]) => {
      // Find the -o flag to figure out where the output goes.
      const oIdx = args.indexOf('-o');
      const template = args[oIdx + 1] ?? '';
      const fileDir = template.replace('/%(id)s.%(ext)s', '');
      mkdirSync(fileDir, { recursive: true });
      writeFileSync(join(fileDir, 'mocked.mp4'), Buffer.alloc(512, 0));
      return {
        code: 0,
        stdout: JSON.stringify({ id: 'mocked', duration: 7 }),
        stderr: '',
      };
    };

    // Stub the dependency check by ensuring yt-dlp is actually installed on
    // dev machines — the test environment has it via Homebrew. If not, skip.
    const res = await downloadVideo({
      url: 'https://youtube.com/watch?v=mocked',
      outputDir,
      ytDlpSpawn: fakeSpawn,
    });
    expect(res.platform).toBe('youtube');
    expect(res.source).toBe('youtube');
    expect(existsSync(res.filePath)).toBe(true);
    expect(res.durationMs).toBe(7000);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 10. normalizeAnalyzeInput — orchestrator input widening
// ──────────────────────────────────────────────────────────────────────

describe('normalizeAnalyzeInput', () => {
  it('accepts a raw URL string', () => {
    const out = normalizeAnalyzeInput('https://youtube.com/watch?v=abc');
    expect(out.url).toBe('https://youtube.com/watch?v=abc');
    expect(out.mediaHint).toBeUndefined();
  });

  it('accepts an XMedia of type video and extracts both url + hint', () => {
    const media: XMedia = {
      type: 'video',
      url: 'https://video.twimg.com/foo.mp4',
      durationMs: 5000,
    };
    const out = normalizeAnalyzeInput(media);
    expect(out.url).toBe(media.url);
    expect(out.mediaHint).toBe(media);
  });

  it('rejects XMedia of non-video type', () => {
    const media: XMedia = { type: 'image', url: 'https://x.com/photo.jpg' };
    expect(() => normalizeAnalyzeInput(media)).toThrow(/video/);
  });

  it('accepts a struct with url + optional mediaHint', () => {
    const media: XMedia = {
      type: 'video',
      url: 'https://video.twimg.com/foo.mp4',
    };
    const out = normalizeAnalyzeInput({
      url: 'https://x.com/user/status/123',
      mediaHint: media,
    });
    expect(out.url).toBe('https://x.com/user/status/123');
    expect(out.mediaHint).toBe(media);
  });
});
