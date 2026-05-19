import { describe, expect, it } from 'vitest';
import { buildSynthesisPrompt, normalizeKeyMoment } from '../../src/intelligence/video.ts';
import type { Transcript } from '../../src/models/video-report.ts';

// ──────────────────────────────────────────────────────────────────────
// buildSynthesisPrompt — prompt assembly
// ──────────────────────────────────────────────────────────────────────

describe('buildSynthesisPrompt', () => {
  const emptyTranscript: Transcript = { text: '', segments: [], empty: true };

  it('includes a Transcript header and JSON schema block', () => {
    const p = buildSynthesisPrompt({
      transcript: { text: 'hello world', segments: [], empty: false },
      visionAnalyses: [],
    });
    expect(p).toContain('## Transcript');
    expect(p).toContain('## Frame Descriptions');
    expect(p).toContain('## Video Duration');
    expect(p).toContain('"keyMoments"');
    expect(p).toContain('"visualContext"');
    expect(p).toContain('Respond with strict JSON only.');
  });

  it('renders transcript segments with start-end timestamps when present', () => {
    const tx: Transcript = {
      text: 'Hello. World.',
      segments: [
        { startMs: 0, endMs: 1500, text: 'Hello.' },
        { startMs: 1500, endMs: 3000, text: 'World.' },
      ],
      empty: false,
    };
    const p = buildSynthesisPrompt({ transcript: tx, visionAnalyses: [] });
    expect(p).toMatch(/\[0:00\.00-0:01\.50\] Hello\./);
    expect(p).toMatch(/\[0:01\.50-0:03\.00\] World\./);
  });

  it('falls back to transcript.text when segments empty', () => {
    const p = buildSynthesisPrompt({
      transcript: { text: 'plain text', segments: [], empty: false },
      visionAnalyses: [],
    });
    expect(p).toContain('plain text');
  });

  it('renders "(no transcript)" placeholder when transcript text + segments empty', () => {
    const p = buildSynthesisPrompt({ transcript: emptyTranscript, visionAnalyses: [] });
    expect(p).toContain('(no transcript)');
  });

  it('renders frame descriptions when provided', () => {
    const p = buildSynthesisPrompt({
      transcript: emptyTranscript,
      visionAnalyses: [
        { timestampMs: 0, description: 'opening' },
        { timestampMs: 2_000, description: 'demo screen' },
      ],
    });
    expect(p).toMatch(/- 0:00\.00 — opening/);
    expect(p).toMatch(/- 0:02\.00 — demo screen/);
  });

  it('renders "(no frame descriptions)" placeholder when vision empty', () => {
    const p = buildSynthesisPrompt({ transcript: emptyTranscript, visionAnalyses: [] });
    expect(p).toContain('(no frame descriptions)');
  });

  it('includes Visual Summary block when provided', () => {
    const p = buildSynthesisPrompt({
      transcript: emptyTranscript,
      visionAnalyses: [],
      visualSummary: 'A speaker on a stage.',
    });
    expect(p).toContain('## Visual Summary (from vision model)');
    expect(p).toContain('A speaker on a stage.');
  });

  it('omits Visual Summary block when not provided', () => {
    const p = buildSynthesisPrompt({ transcript: emptyTranscript, visionAnalyses: [] });
    expect(p).not.toContain('## Visual Summary');
  });

  it('formats known duration via formatDuration', () => {
    const p = buildSynthesisPrompt({
      transcript: emptyTranscript,
      visionAnalyses: [],
      durationMs: 90_000,
    });
    expect(p).toContain('## Video Duration: 1m30s');
  });

  it('uses "unknown" when no duration provided', () => {
    const p = buildSynthesisPrompt({ transcript: emptyTranscript, visionAnalyses: [] });
    expect(p).toContain('## Video Duration: unknown');
  });
});

// ──────────────────────────────────────────────────────────────────────
// normalizeKeyMoment — parsing
// ──────────────────────────────────────────────────────────────────────

describe('normalizeKeyMoment — extended coverage', () => {
  it('produces a valid KeyMoment from a complete record', () => {
    const m = normalizeKeyMoment({
      startMs: 1500,
      endMs: 3000,
      description: '  greeting  ',
      type: 'introduction',
    });
    expect(m).toEqual({
      startMs: 1500,
      endMs: 3000,
      description: 'greeting',
      type: 'introduction',
    });
  });

  it('rounds float ms values to integers', () => {
    const m = normalizeKeyMoment({
      startMs: 1500.7,
      endMs: 3000.3,
      description: 'x',
    });
    expect(m?.startMs).toBe(1501);
    expect(m?.endMs).toBe(3000);
  });

  it('keeps each valid type tag', () => {
    for (const type of [
      'introduction',
      'key-point',
      'demonstration',
      'transition',
      'conclusion',
      'highlight',
    ]) {
      const m = normalizeKeyMoment({ startMs: 0, endMs: 100, description: 'x', type });
      expect(m?.type).toBe(type);
    }
  });

  it('strips empty description after trim', () => {
    expect(normalizeKeyMoment({ startMs: 0, endMs: 100, description: '   ' })).toBeNull();
  });
});
