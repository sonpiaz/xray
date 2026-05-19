import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISION_MODEL,
  buildVisionCacheKey,
  estimateVisionCostUsd,
  parseVisionResponse,
} from '../../src/video/vision.ts';

// ──────────────────────────────────────────────────────────────────────
// estimateVisionCostUsd — cost-surface tests
// ──────────────────────────────────────────────────────────────────────

describe('estimateVisionCostUsd — P2.3 cost coverage', () => {
  it('scales linearly with frame count at $0.005/frame', () => {
    expect(estimateVisionCostUsd(1)).toBe(0.005);
    expect(estimateVisionCostUsd(8)).toBe(0.04);
    expect(estimateVisionCostUsd(20)).toBe(0.1);
  });

  it('returns 0 for non-positive counts', () => {
    expect(estimateVisionCostUsd(0)).toBe(0);
    expect(estimateVisionCostUsd(-3)).toBe(0);
  });

  it('rounds to 4 decimals', () => {
    // 3 frames * 0.005 = 0.015 (no rounding needed); ensure precision holds
    expect(estimateVisionCostUsd(3)).toBe(0.015);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildVisionCacheKey — ordering + content sensitivity
// ──────────────────────────────────────────────────────────────────────

describe('buildVisionCacheKey — ordering matters', () => {
  it('changes when the frame order changes', () => {
    const a = buildVisionCacheKey(
      [
        { timestampMs: 0, base64: 'AAA' },
        { timestampMs: 1000, base64: 'BBB' },
      ],
      DEFAULT_VISION_MODEL,
    );
    const b = buildVisionCacheKey(
      [
        { timestampMs: 1000, base64: 'BBB' },
        { timestampMs: 0, base64: 'AAA' },
      ],
      DEFAULT_VISION_MODEL,
    );
    expect(a).not.toBe(b);
  });

  it('changes when the model changes', () => {
    const frames = [{ timestampMs: 0, base64: 'AAA' }];
    const a = buildVisionCacheKey(frames, DEFAULT_VISION_MODEL);
    const b = buildVisionCacheKey(frames, 'gemini-2.5-pro');
    expect(a).not.toBe(b);
  });

  it('changes when the bytes change but timestamps stay', () => {
    const a = buildVisionCacheKey([{ timestampMs: 0, base64: 'AAA' }], DEFAULT_VISION_MODEL);
    const b = buildVisionCacheKey([{ timestampMs: 0, base64: 'BBB' }], DEFAULT_VISION_MODEL);
    expect(a).not.toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseVisionResponse — batch + edge cases
// ──────────────────────────────────────────────────────────────────────

describe('parseVisionResponse — batched + edge cases', () => {
  it('aligns multi-frame batch by timestamp', () => {
    const frames = [
      { path: '/tmp/a.jpg', timestampMs: 0 },
      { path: '/tmp/b.jpg', timestampMs: 1500 },
      { path: '/tmp/c.jpg', timestampMs: 3000 },
    ];
    const content = JSON.stringify({
      frames: [
        { timestampMs: 0, description: 'A' },
        { timestampMs: 1500, description: 'B' },
        { timestampMs: 3000, description: 'C' },
      ],
      visualSummary: 'Three scenes.',
    });
    const out = parseVisionResponse(content, frames);
    expect(out.analyses).toHaveLength(3);
    expect(out.analyses[0]?.description).toBe('A');
    expect(out.analyses[1]?.description).toBe('B');
    expect(out.analyses[2]?.description).toBe('C');
    expect(out.visualSummary).toBe('Three scenes.');
  });

  it('drops empty descriptions', () => {
    const frames = [
      { path: '/tmp/a.jpg', timestampMs: 0 },
      { path: '/tmp/b.jpg', timestampMs: 1500 },
    ];
    const content = JSON.stringify({
      frames: [
        { timestampMs: 0, description: 'real' },
        { timestampMs: 1500, description: '' },
      ],
    });
    const out = parseVisionResponse(content, frames);
    expect(out.analyses).toHaveLength(1);
    expect(out.analyses[0]?.description).toBe('real');
  });

  it('preserves sceneScore on the input frame when present', () => {
    const frames = [{ path: '/tmp/a.jpg', timestampMs: 0, sceneScore: 0.42 }];
    const content = JSON.stringify({
      frames: [{ timestampMs: 0, description: 'opener' }],
    });
    const out = parseVisionResponse(content, frames);
    expect(out.analyses[0]?.sceneScore).toBeCloseTo(0.42);
  });

  it('omits visualSummary when blank or missing', () => {
    const a = parseVisionResponse(JSON.stringify({ frames: [], visualSummary: '   ' }), []);
    const b = parseVisionResponse(JSON.stringify({ frames: [] }), []);
    expect(a.visualSummary).toBeUndefined();
    expect(b.visualSummary).toBeUndefined();
  });

  it('positional fallback when timestamps mismatch', () => {
    const frames = [
      { path: '/tmp/a.jpg', timestampMs: 100 },
      { path: '/tmp/b.jpg', timestampMs: 200 },
    ];
    const content = JSON.stringify({
      frames: [
        { timestampMs: 9_999, description: 'first' },
        { timestampMs: 10_000, description: 'second' },
      ],
    });
    const out = parseVisionResponse(content, frames);
    expect(out.analyses[0]?.timestampMs).toBe(100); // takes input timestamps
    expect(out.analyses[0]?.description).toBe('first');
    expect(out.analyses[1]?.description).toBe('second');
  });
});
