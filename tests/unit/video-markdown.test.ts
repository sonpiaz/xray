import { describe, expect, it } from 'vitest';
import type { VideoReport } from '../../src/models/video-report.ts';
import {
  formatTimestamp,
  platformLabel,
  renderVideoMarkdown,
} from '../../src/render/video-markdown.ts';

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

function baseReport(overrides: Partial<VideoReport> = {}): VideoReport {
  return {
    url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/x.mp4',
    platform: 'x-native',
    partial: false,
    errors: [],
    generatedAt: GENERATED_AT,
    ...overrides,
  } as VideoReport;
}

// ──────────────────────────────────────────────────────────────────────
// platformLabel
// ──────────────────────────────────────────────────────────────────────

describe('platformLabel', () => {
  it('maps each known platform to a friendly label', () => {
    expect(platformLabel('x-native')).toBe('X (native)');
    expect(platformLabel('youtube')).toBe('YouTube');
    expect(platformLabel('tiktok')).toBe('TikTok');
    expect(platformLabel('vimeo')).toBe('Vimeo');
    expect(platformLabel('linkedin')).toBe('LinkedIn');
  });

  it('returns the enum value verbatim for unknown', () => {
    expect(platformLabel('unknown')).toBe('unknown');
  });
});

// ──────────────────────────────────────────────────────────────────────
// formatTimestamp
// ──────────────────────────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('formats sub-hour timestamps as M:SS', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5_000)).toBe('0:05');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(900_000)).toBe('15:00');
  });

  it('formats hour+ timestamps as H:MM:SS', () => {
    expect(formatTimestamp(3_600_000)).toBe('1:00:00');
    expect(formatTimestamp(3_661_000)).toBe('1:01:01');
  });

  it('clamps negative values to 0', () => {
    expect(formatTimestamp(-500)).toBe('0:00');
  });
});

// ──────────────────────────────────────────────────────────────────────
// renderVideoMarkdown — embedded mode
// ──────────────────────────────────────────────────────────────────────

describe('renderVideoMarkdown — embedded mode (default)', () => {
  it('renders the heading + Source line for a minimal report', () => {
    const md = renderVideoMarkdown(baseReport());
    expect(md).toContain('## Video Analysis');
    expect(md).toContain('**Source:** X (native)');
    // No URL in embedded mode.
    expect(md).not.toContain('**URL:**');
  });

  it('includes a label line when one is provided', () => {
    const md = renderVideoMarkdown(baseReport(), { label: 'Video 2 of 3' });
    expect(md).toContain('> _Video 2 of 3_');
  });

  it('shows duration + frame meta when present', () => {
    const md = renderVideoMarkdown(
      baseReport({
        durationMs: 134_000,
        durationFormatted: '2m14s',
        frames: { count: 6, method: 'scene-detect', threshold: 0.3, analyses: [] },
      }),
    );
    expect(md).toContain('Duration: 2m14s');
    expect(md).toContain('6 frames (scene-detect)');
  });

  it('falls back to raw ms when durationFormatted is missing', () => {
    const md = renderVideoMarkdown(baseReport({ durationMs: 12_345 }));
    expect(md).toContain('Duration: 12345ms');
  });

  it('shows estimated cost with 2 decimals when ≥ $0.01', () => {
    const md = renderVideoMarkdown(baseReport({ estimatedCostUsd: 0.123 }));
    expect(md).toContain('**Estimated cost:** $0.12');
  });

  it('shows estimated cost with 4 decimals for sub-cent', () => {
    const md = renderVideoMarkdown(baseReport({ estimatedCostUsd: 0.0034 }));
    expect(md).toContain('**Estimated cost:** $0.0034');
  });

  it('omits cost line when cost is 0 or undefined', () => {
    expect(renderVideoMarkdown(baseReport({ estimatedCostUsd: 0 }))).not.toContain(
      'Estimated cost',
    );
    expect(renderVideoMarkdown(baseReport())).not.toContain('Estimated cost');
  });

  it('renders topic when set', () => {
    const md = renderVideoMarkdown(baseReport({ topic: 'Karpathy on scaling' }));
    expect(md).toContain('**Topic:** Karpathy on scaling');
  });

  it('renders a partial warning when errors present', () => {
    const md = renderVideoMarkdown(
      baseReport({
        partial: true,
        errors: ['transcribe: timeout', 'vision: 503'],
      }),
    );
    expect(md).toContain('⚠ Partial result: transcribe: timeout · vision: 503');
  });

  it('skips the partial warning when errors empty (even if partial=true)', () => {
    const md = renderVideoMarkdown(baseReport({ partial: true, errors: [] }));
    expect(md).not.toContain('⚠ Partial result');
  });

  it('renders Summary subsection only when present', () => {
    expect(renderVideoMarkdown(baseReport())).not.toContain('### Summary');
    expect(renderVideoMarkdown(baseReport({ summary: 'A short greeting.' }))).toContain(
      '### Summary',
    );
  });

  it('renders Key Moments with timestamp range + type tag', () => {
    const md = renderVideoMarkdown(
      baseReport({
        keyMoments: [
          { startMs: 0, endMs: 15_000, description: 'Intro', type: 'introduction' },
          { startMs: 42_000, endMs: 70_000, description: 'Demo' },
        ],
      }),
    );
    expect(md).toContain('### Key Moments');
    expect(md).toContain('`[0:00–0:15]`');
    expect(md).toContain('_[introduction]_');
    expect(md).toContain('Intro');
    expect(md).toContain('`[0:42–1:10]`');
    expect(md).toContain('Demo');
  });

  it('renders Visual Context from synthesis bullets when present', () => {
    const md = renderVideoMarkdown(
      baseReport({
        visualContext: ['VS Code with TypeScript', 'Hand gestures emphasize scale'],
      }),
    );
    expect(md).toContain('### Visual Context');
    expect(md).toContain('- VS Code with TypeScript');
  });

  it('falls back to per-frame analyses when no synthesis visualContext', () => {
    const md = renderVideoMarkdown(
      baseReport({
        frames: {
          count: 2,
          method: 'scene-detect',
          analyses: [
            { timestampMs: 0, description: 'opening shot' },
            { timestampMs: 1500, description: 'speaker face' },
          ],
        },
      }),
    );
    expect(md).toContain('### Visual Context');
    expect(md).toContain('`[0:00]` opening shot');
    expect(md).toContain('`[0:01]` speaker face');
  });

  it('omits Visual Context entirely when no frames AND no synthesis context', () => {
    const md = renderVideoMarkdown(baseReport());
    expect(md).not.toContain('### Visual Context');
  });

  it('renders Transcript as blockquote when text present', () => {
    const md = renderVideoMarkdown(
      baseReport({
        transcript: { text: 'Hello world.\nThis is a test.', segments: [], empty: false },
      }),
    );
    expect(md).toContain('### Transcript');
    expect(md).toContain('> Hello world.');
    expect(md).toContain('> This is a test.');
  });

  it('truncates a long transcript and notes the truncation', () => {
    const longText = 'a'.repeat(1_200);
    const md = renderVideoMarkdown(
      baseReport({
        transcript: { text: longText, segments: [], empty: false },
      }),
    );
    expect(md).toContain('### Transcript');
    expect(md).toContain('…');
    expect(md).toContain('(transcript truncated — 1200 chars total)');
  });

  it('omits Transcript section entirely when empty', () => {
    const md = renderVideoMarkdown(
      baseReport({
        transcript: { text: '', segments: [], empty: true },
      }),
    );
    expect(md).not.toContain('### Transcript');
  });
});

// ──────────────────────────────────────────────────────────────────────
// renderVideoMarkdown — standalone mode
// ──────────────────────────────────────────────────────────────────────

describe('renderVideoMarkdown — standalone mode', () => {
  it('uses an H1 heading with the platform name', () => {
    const md = renderVideoMarkdown(baseReport({ platform: 'youtube' }), { mode: 'standalone' });
    expect(md).toContain('# Video Analysis — YouTube');
  });

  it('surfaces the URL for standalone reports', () => {
    const md = renderVideoMarkdown(baseReport({ url: 'https://youtu.be/abc' }), {
      mode: 'standalone',
    });
    expect(md).toContain('**URL:** https://youtu.be/abc');
  });

  it('uses H2 subsections (## Summary, ## Key Moments, ## Transcript)', () => {
    const md = renderVideoMarkdown(
      baseReport({
        summary: 'A summary.',
        keyMoments: [{ startMs: 0, endMs: 1000, description: 'x' }],
        transcript: { text: 'transcript text', segments: [], empty: false },
      }),
      { mode: 'standalone' },
    );
    expect(md).toContain('## Summary');
    expect(md).toContain('## Key Moments');
    expect(md).toContain('## Transcript');
    // No embedded H3 forms.
    expect(md).not.toContain('### Summary');
  });

  it('omits the label line in standalone mode even if provided', () => {
    const md = renderVideoMarkdown(baseReport(), { mode: 'standalone', label: 'Ignored' });
    expect(md).not.toContain('> _Ignored_');
  });
});
