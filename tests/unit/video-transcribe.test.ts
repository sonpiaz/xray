import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIBE_MODEL,
  buildTranscribeCacheKey,
  estimateTranscribeCostUsd,
  parseWhisperResponse,
} from '../../src/video/transcribe.ts';

// ──────────────────────────────────────────────────────────────────────
// estimateTranscribeCostUsd — cost-surface tests
// ──────────────────────────────────────────────────────────────────────

describe('estimateTranscribeCostUsd — P2.3 cost coverage', () => {
  it('rounds to 4 decimals', () => {
    // 7 seconds → 7/60 * 0.001 = 0.0001166… → 0.0001
    expect(estimateTranscribeCostUsd(7)).toBe(0.0001);
  });

  it('scales linearly with duration', () => {
    expect(estimateTranscribeCostUsd(60)).toBe(0.001);
    expect(estimateTranscribeCostUsd(120)).toBe(0.002);
    expect(estimateTranscribeCostUsd(1800)).toBe(0.03); // 30 min ≈ $0.03
  });

  it('treats sub-second durations as nearly free', () => {
    expect(estimateTranscribeCostUsd(0.5)).toBe(0);
  });

  it('returns 0 for non-positive durations', () => {
    expect(estimateTranscribeCostUsd(0)).toBe(0);
    expect(estimateTranscribeCostUsd(-100)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildTranscribeCacheKey — cache key shape
// ──────────────────────────────────────────────────────────────────────

describe('buildTranscribeCacheKey — model isolation', () => {
  it('changes when the model changes', () => {
    const bytes = Buffer.from('audio-bytes');
    const a = buildTranscribeCacheKey(bytes, DEFAULT_TRANSCRIBE_MODEL);
    const b = buildTranscribeCacheKey(bytes, 'whisper-large-v3');
    expect(a).not.toBe(b);
    expect(a.startsWith('video:transcribe:whisper-v3-turbo:')).toBe(true);
    expect(b.startsWith('video:transcribe:whisper-large-v3:')).toBe(true);
  });

  it('produces a 64-char hex tail per sha256', () => {
    const key = buildTranscribeCacheKey(Buffer.from('x'), DEFAULT_TRANSCRIBE_MODEL);
    const tail = key.split(':').pop() ?? '';
    expect(tail).toHaveLength(64);
    expect(tail).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseWhisperResponse — additional edge cases
// ──────────────────────────────────────────────────────────────────────

describe('parseWhisperResponse — P2.3 edge cases', () => {
  it('preserves the language code from raw response', () => {
    const t = parseWhisperResponse({ text: 'bonjour', segments: [], language: 'fr' });
    expect(t.language).toBe('fr');
  });

  it('trims leading/trailing whitespace from segment text', () => {
    const t = parseWhisperResponse({
      text: 'x',
      segments: [{ start: 0, end: 1, text: '  hello  ' }],
    });
    expect(t.segments[0]?.text).toBe('hello');
  });

  it('skips entries where the trimmed segment text is empty', () => {
    const t = parseWhisperResponse({
      text: 'x',
      segments: [
        { start: 0, end: 1, text: 'real text' },
        { start: 1, end: 2, text: '   ' },
      ],
    });
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]?.text).toBe('real text');
  });

  it('handles a missing segments array', () => {
    const t = parseWhisperResponse({ text: 'hi' });
    expect(t.segments).toEqual([]);
    expect(t.empty).toBe(false);
  });
});
