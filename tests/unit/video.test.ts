import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDuration, normalizeKeyMoment } from '../../src/intelligence/video.ts';
import { VideoReportSchema } from '../../src/models/video-report.ts';
import { extractAudio, isNoAudioStreamError, replaceExt } from '../../src/video/audio.ts';
import { checkDependencies } from '../../src/video/dependencies.ts';
import { probeDurationMs } from '../../src/video/download.ts';
import { extractFrames, parseShowinfo } from '../../src/video/frames.ts';
import {
  DEFAULT_TRANSCRIBE_MODEL,
  buildTranscribeCacheKey,
  estimateTranscribeCostUsd,
  parseWhisperResponse,
} from '../../src/video/transcribe.ts';
import {
  DEFAULT_VISION_MODEL,
  buildVisionCacheKey,
  estimateVisionCostUsd,
  parseVisionResponse,
} from '../../src/video/vision.ts';

const FIXTURE = join(__dirname, '..', 'fixtures', 'video', 'short.mp4');
const SILENT_FIXTURE = join(__dirname, '..', 'fixtures', 'video', 'silent.mp4');

const TMP_ROOT = join(tmpdir(), `xray-video-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ──────────────────────────────────────────────────────────────────────
// 1. VideoReport schema
// ──────────────────────────────────────────────────────────────────────

describe('VideoReportSchema', () => {
  it('parses a minimal report with required fields', () => {
    const r = VideoReportSchema.parse({
      url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/x.mp4',
      platform: 'x-native',
      generatedAt: new Date().toISOString(),
    });
    expect(r.partial).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('rejects an invalid platform enum', () => {
    expect(() =>
      VideoReportSchema.parse({
        url: 'https://example.com/v.mp4',
        platform: 'unknown-platform',
        generatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('accepts the full shape including cost breakdown and key moments', () => {
    const r = VideoReportSchema.parse({
      url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/x.mp4',
      platform: 'x-native',
      durationMs: 60_000,
      durationFormatted: '1m00s',
      transcript: {
        text: 'hello world',
        segments: [{ startMs: 0, endMs: 1500, text: 'hello world' }],
        language: 'en',
        empty: false,
      },
      frames: {
        count: 4,
        method: 'scene-detect',
        threshold: 0.3,
        analyses: [{ timestampMs: 0, description: 'opening shot', sceneScore: 0.5 }],
      },
      keyMoments: [{ startMs: 0, endMs: 1500, description: 'intro', type: 'introduction' }],
      visualContext: ['speaker on camera'],
      summary: 'A short greeting.',
      topic: 'greeting',
      estimatedCostUsd: 0.025,
      costBreakdown: { transcription: 0.001, vision: 0.02, synthesis: 0.02 },
      partial: false,
      errors: [],
      generatedAt: new Date().toISOString(),
    });
    expect(r.frames?.method).toBe('scene-detect');
    expect(r.keyMoments?.[0]?.type).toBe('introduction');
    expect(r.estimatedCostUsd).toBe(0.025);
  });

  it('rejects an invalid keyMoment.type enum', () => {
    expect(() =>
      VideoReportSchema.parse({
        url: 'https://video.twimg.com/v.mp4',
        platform: 'x-native',
        keyMoments: [{ startMs: 0, endMs: 1000, description: 'x', type: 'banana' }],
        generatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Transcribe — pure helpers + fixture parsing
// ──────────────────────────────────────────────────────────────────────

describe('transcribe helpers', () => {
  it('estimates cost per minute correctly', () => {
    expect(estimateTranscribeCostUsd(0)).toBe(0);
    expect(estimateTranscribeCostUsd(60)).toBe(0.001);
    expect(estimateTranscribeCostUsd(600)).toBe(0.01);
  });

  it('returns 0 for negative / zero duration', () => {
    expect(estimateTranscribeCostUsd(-5)).toBe(0);
  });

  it('builds a deterministic cache key from bytes + model', () => {
    const a = buildTranscribeCacheKey(Buffer.from('abc'), DEFAULT_TRANSCRIBE_MODEL);
    const b = buildTranscribeCacheKey(Buffer.from('abc'), DEFAULT_TRANSCRIBE_MODEL);
    const c = buildTranscribeCacheKey(Buffer.from('xyz'), DEFAULT_TRANSCRIBE_MODEL);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('video:transcribe:')).toBe(true);
  });

  it('parses a verbose_json response into a Transcript', () => {
    const raw = {
      text: 'Hello world. This is a test.',
      language: 'en',
      duration: 3.5,
      segments: [
        { start: 0, end: 1.5, text: 'Hello world.' },
        { start: 1.5, end: 3.0, text: 'This is a test.' },
      ],
    };
    const t = parseWhisperResponse(raw);
    expect(t.text).toBe('Hello world. This is a test.');
    expect(t.empty).toBe(false);
    expect(t.language).toBe('en');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]).toEqual({ startMs: 0, endMs: 1500, text: 'Hello world.' });
    expect(t.segments[1]).toEqual({ startMs: 1500, endMs: 3000, text: 'This is a test.' });
  });

  it('marks empty text as empty: true', () => {
    const t = parseWhisperResponse({ text: '', segments: [] });
    expect(t.empty).toBe(true);
    expect(t.segments).toEqual([]);
  });

  it('skips malformed segments missing start or end', () => {
    const t = parseWhisperResponse({
      text: 'x',
      segments: [
        { start: 0, end: 1, text: 'a' },
        { text: 'b' }, // missing timing
        { start: 2, text: 'c' }, // missing end
      ],
    });
    expect(t.segments).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Vision — pure helpers + fixture parsing
// ──────────────────────────────────────────────────────────────────────

describe('vision helpers', () => {
  it('estimates cost per frame', () => {
    expect(estimateVisionCostUsd(0)).toBe(0);
    expect(estimateVisionCostUsd(4)).toBe(0.02);
    expect(estimateVisionCostUsd(12)).toBe(0.06);
  });

  it('builds a deterministic vision cache key', () => {
    const frames = [
      { timestampMs: 0, base64: 'AAA' },
      { timestampMs: 1000, base64: 'BBB' },
    ];
    const a = buildVisionCacheKey(frames, DEFAULT_VISION_MODEL);
    const b = buildVisionCacheKey(frames, DEFAULT_VISION_MODEL);
    const c = buildVisionCacheKey([frames[0]!], DEFAULT_VISION_MODEL);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('video:vision:')).toBe(true);
  });

  it('parses a vision response and aligns by timestamp', () => {
    const inputFrames = [
      { path: '/tmp/a.jpg', timestampMs: 0 },
      { path: '/tmp/b.jpg', timestampMs: 1000 },
    ];
    const content = JSON.stringify({
      frames: [
        { timestampMs: 0, description: 'red square' },
        { timestampMs: 1000, description: 'blue square' },
      ],
      visualSummary: 'Two colored squares.',
    });
    const out = parseVisionResponse(content, inputFrames);
    expect(out.analyses).toHaveLength(2);
    expect(out.analyses[0]?.description).toBe('red square');
    expect(out.analyses[1]?.timestampMs).toBe(1000);
    expect(out.visualSummary).toBe('Two colored squares.');
  });

  it('falls back to positional alignment when timestamps do not match', () => {
    const inputFrames = [
      { path: '/tmp/a.jpg', timestampMs: 100 },
      { path: '/tmp/b.jpg', timestampMs: 200 },
    ];
    // Model returned wrong timestamps — must positionally align.
    const content = JSON.stringify({
      frames: [
        { timestampMs: 999, description: 'first' },
        { timestampMs: 1000, description: 'second' },
      ],
    });
    const out = parseVisionResponse(content, inputFrames);
    expect(out.analyses).toHaveLength(2);
    expect(out.analyses[0]?.description).toBe('first');
    expect(out.analyses[0]?.timestampMs).toBe(100);
    expect(out.analyses[1]?.description).toBe('second');
  });

  it('throws on non-JSON vision content', () => {
    expect(() => parseVisionResponse('not json', [])).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Frames — parseShowinfo + real ffmpeg extraction against fixture
// ──────────────────────────────────────────────────────────────────────

describe('parseShowinfo', () => {
  it('extracts pts_time + scene from interleaved stderr', () => {
    const stderr = [
      '[Parsed_select_0 @ 0x100] n: 0 pts: 0 t:0 key:1 scene:0.412',
      '[Parsed_showinfo_1 @ 0x200] n:0 pts:0 pts_time:0 pos:48 fmt:yuv420p',
      '[Parsed_select_0 @ 0x100] n: 24 pts: 24024 t:1.001 key:0 scene:0.701',
      '[Parsed_showinfo_1 @ 0x200] n:1 pts:24024 pts_time:1.001 pos:1024 fmt:yuv420p',
    ].join('\n');
    const entries = parseShowinfo(stderr);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.ptsTimeSec).toBeCloseTo(0, 3);
    expect(entries[0]?.sceneScore).toBeCloseTo(0.412, 3);
    expect(entries[1]?.ptsTimeSec).toBeCloseTo(1.001, 3);
    expect(entries[1]?.sceneScore).toBeCloseTo(0.701, 3);
  });

  it('returns empty for stderr with no showinfo lines', () => {
    expect(parseShowinfo('random noise\nnothing here')).toEqual([]);
  });

  it('handles showinfo without preceding select line (no score)', () => {
    const stderr = '[Parsed_showinfo_1 @ 0x200] n:0 pts:480 pts_time:0.020 pos:48 fmt:yuv420p';
    const entries = parseShowinfo(stderr);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ptsTimeSec).toBeCloseTo(0.02, 3);
    expect(entries[0]?.sceneScore).toBeUndefined();
  });
});

describe('extractFrames (live ffmpeg)', () => {
  it('runs scene-detect or evenly-spaced fallback against the fixture', async () => {
    const outDir = join(TMP_ROOT, 'frames-scene');
    const res = await extractFrames(FIXTURE, {
      outDir,
      threshold: 0.3,
      minFrames: 4,
      maxFrames: 12,
      durationMs: 2000,
    });
    expect(['scene-detect', 'evenly-spaced']).toContain(res.method);
    expect(res.frames.length).toBeGreaterThan(0);
    for (const f of res.frames) {
      expect(existsSync(f.path)).toBe(true);
      expect(statSync(f.path).size).toBeGreaterThan(0);
      expect(f.timestampMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps to maxFrames when scene-detect over-shoots (forces evenly-spaced via low duration)', async () => {
    // testsrc2 has no scene changes by default — should fall back to evenly-spaced.
    const outDir = join(TMP_ROOT, 'frames-even');
    const res = await extractFrames(FIXTURE, {
      outDir,
      threshold: 0.99, // basically guarantees zero scene matches
      minFrames: 3,
      maxFrames: 5,
      durationMs: 2000,
    });
    expect(res.method).toBe('evenly-spaced');
    expect(res.frames.length).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Audio — isNoAudioStreamError + live extraction
// ──────────────────────────────────────────────────────────────────────

describe('audio helpers', () => {
  it('isNoAudioStreamError matches known ffmpeg phrases', () => {
    expect(isNoAudioStreamError('Output file does not contain any stream')).toBe(true);
    expect(isNoAudioStreamError('Stream map error')).toBe(true);
    expect(isNoAudioStreamError('No audio detected')).toBe(true);
    expect(isNoAudioStreamError('Conversion failed!')).toBe(false);
  });

  it('replaceExt swaps file extension', () => {
    expect(replaceExt('/tmp/video.mp4', '.mp3')).toBe('video.mp3');
    expect(replaceExt('/tmp/path/to/x.MP4', '.mp3')).toBe('x.mp3');
    expect(replaceExt('noext', '.mp3')).toBe('noext.mp3');
  });
});

describe('extractAudio (live ffmpeg)', () => {
  it('extracts a non-empty mp3 from the fixture with audio', async () => {
    const outDir = join(TMP_ROOT, 'audio-ok');
    mkdirSync(outDir, { recursive: true });
    const res = await extractAudio(FIXTURE, { outDir });
    expect(res.silent).toBe(false);
    expect(res.audioPath).toBeTruthy();
    expect(res.sizeBytes).toBeGreaterThan(0);
    if (res.audioPath) expect(existsSync(res.audioPath)).toBe(true);
  });

  it('returns silent: true when source has no audio track', async () => {
    const outDir = join(TMP_ROOT, 'audio-silent');
    mkdirSync(outDir, { recursive: true });
    const res = await extractAudio(SILENT_FIXTURE, { outDir });
    expect(res.silent).toBe(true);
    expect(res.audioPath).toBeNull();
    expect(res.sizeBytes).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Download — probeDurationMs against fixture
// ──────────────────────────────────────────────────────────────────────

describe('probeDurationMs (live ffprobe)', () => {
  it('returns ~2000ms for the 2s fixture', async () => {
    const ms = await probeDurationMs(FIXTURE);
    expect(ms).toBeDefined();
    if (ms !== undefined) {
      expect(ms).toBeGreaterThan(1500);
      expect(ms).toBeLessThan(2500);
    }
  });

  it('returns undefined for a non-existent file (graceful)', async () => {
    const ms = await probeDurationMs('/nonexistent/no-such-file.mp4');
    expect(ms).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. Dependency checker (live)
// ──────────────────────────────────────────────────────────────────────

describe('checkDependencies', () => {
  it('detects ffmpeg + ffprobe on this dev machine', async () => {
    const c = await checkDependencies();
    expect(c.ffmpeg.available).toBe(true);
    expect(c.ffprobe.available).toBe(true);
    expect(c.ytdlp).toBeUndefined(); // not requested
  });

  it('reports ytdlp slot only when needYtDlp: true', async () => {
    const c = await checkDependencies({ needYtDlp: true });
    expect(c.ytdlp).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Intelligence/video helpers (pure)
// ──────────────────────────────────────────────────────────────────────

describe('intelligence/video helpers', () => {
  it('formatDuration formats h/m/s correctly', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(3_661_000)).toBe('1h01m01s');
  });

  it('normalizeKeyMoment returns null on missing fields', () => {
    expect(normalizeKeyMoment({})).toBeNull();
    expect(normalizeKeyMoment({ startMs: 0, endMs: 100 })).toBeNull();
    expect(normalizeKeyMoment({ startMs: 0, description: 'x' })).toBeNull();
  });

  it('normalizeKeyMoment strips unknown type but keeps known type', () => {
    const a = normalizeKeyMoment({
      startMs: 0,
      endMs: 1000,
      description: 'intro',
      type: 'banana',
    });
    expect(a?.type).toBeUndefined();
    expect(a?.description).toBe('intro');

    const b = normalizeKeyMoment({
      startMs: 0,
      endMs: 1000,
      description: 'demo',
      type: 'demonstration',
    });
    expect(b?.type).toBe('demonstration');
  });

  it('normalizeKeyMoment clamps negative timestamps to 0', () => {
    const m = normalizeKeyMoment({
      startMs: -50,
      endMs: 500,
      description: 'x',
    });
    expect(m?.startMs).toBe(0);
  });
});
