import type { KeyMoment, VideoReport } from '../models/video-report.ts';

/**
 * P2.3 — Render a single `VideoReport` to Markdown.
 *
 * Two modes:
 *   - `embedded` (default) — inline section meant to be glued onto an
 *     existing thread report. Uses `## Video Analysis` heading.
 *   - `standalone` — full document for `xray video <url>`. Uses
 *     `# Video Analysis — {platform}` heading and surfaces URL + platform.
 *
 * Conservative: every sub-section is gated on data presence. A report
 * that only has a transcript will render only the transcript section
 * (no empty "Key Moments" or "Visual Context" blocks). Cost is always
 * shown when `estimatedCostUsd > 0`.
 */
export type RenderVideoMarkdownOptions = {
  mode?: 'embedded' | 'standalone';
  /**
   * When set, included verbatim in the `### Transcript` section heading
   * line — used by `xray thread --video` to clarify which media this
   * came from when multiple videos appear in one thread.
   */
  label?: string;
};

const TRANSCRIPT_EXCERPT_CHARS = 500;

export function renderVideoMarkdown(
  report: VideoReport,
  opts: RenderVideoMarkdownOptions = {},
): string {
  const mode = opts.mode ?? 'embedded';
  const out: string[] = [];

  // ─── Heading ────────────────────────────────────────────────────────
  if (mode === 'standalone') {
    out.push(`# Video Analysis — ${platformLabel(report.platform)}`);
    out.push('');
  } else {
    out.push('## Video Analysis');
    if (opts.label) out.push(`> _${opts.label}_`);
    out.push('');
  }

  // ─── Meta line(s) ──────────────────────────────────────────────────
  // Standalone gets URL + platform broken out; embedded stays compact.
  if (mode === 'standalone') {
    out.push(`**URL:** ${report.url}`);
  } else {
    out.push(`**Source:** ${platformLabel(report.platform)}`);
  }

  const metaBits: string[] = [];
  if (report.durationFormatted) metaBits.push(`Duration: ${report.durationFormatted}`);
  else if (report.durationMs !== undefined) metaBits.push(`Duration: ${report.durationMs}ms`);
  if (report.frames && report.frames.count > 0) {
    metaBits.push(`${report.frames.count} frames (${report.frames.method})`);
  }
  if (metaBits.length > 0) out.push(`**Meta:** ${metaBits.join(' · ')}`);

  if (report.estimatedCostUsd !== undefined && report.estimatedCostUsd > 0) {
    out.push(`**Estimated cost:** $${formatCost(report.estimatedCostUsd)}`);
  }

  if (report.topic) out.push(`**Topic:** ${report.topic}`);

  if (report.partial && report.errors.length > 0) {
    out.push(`> ⚠ Partial result: ${report.errors.join(' · ')}`);
  }

  out.push('');

  // ─── Summary ───────────────────────────────────────────────────────
  if (report.summary) {
    out.push(mode === 'standalone' ? '## Summary' : '### Summary');
    out.push(report.summary);
    out.push('');
  }

  // ─── Key Moments ───────────────────────────────────────────────────
  if (report.keyMoments && report.keyMoments.length > 0) {
    out.push(mode === 'standalone' ? '## Key Moments' : '### Key Moments');
    for (const m of report.keyMoments) {
      out.push(renderKeyMomentLine(m));
    }
    out.push('');
  }

  // ─── Visual Context ────────────────────────────────────────────────
  if (report.visualContext && report.visualContext.length > 0) {
    out.push(mode === 'standalone' ? '## Visual Context' : '### Visual Context');
    for (const v of report.visualContext) {
      out.push(`- ${v}`);
    }
    out.push('');
  } else if (report.frames && report.frames.analyses.length > 0) {
    // No synthesis-derived visualContext but we have per-frame analyses —
    // surface the first few so the reader sees *something* about the
    // visuals. Cap at 5 to keep the section tight.
    out.push(mode === 'standalone' ? '## Visual Context' : '### Visual Context');
    for (const f of report.frames.analyses.slice(0, 5)) {
      out.push(`- \`[${formatTimestamp(f.timestampMs)}]\` ${f.description}`);
    }
    out.push('');
  }

  // ─── Transcript ────────────────────────────────────────────────────
  // Only render when there's actual text. Empty / silent / failed
  // transcripts get skipped silently — the errors block above already
  // surfaced the failure when relevant.
  if (report.transcript && report.transcript.text.trim().length > 0) {
    out.push(mode === 'standalone' ? '## Transcript' : '### Transcript');
    const txt = report.transcript.text.trim();
    const excerpt =
      txt.length > TRANSCRIPT_EXCERPT_CHARS
        ? `${txt.slice(0, TRANSCRIPT_EXCERPT_CHARS).trimEnd()}…`
        : txt;
    // Use blockquote — readable and matches the embedded thread report style.
    for (const line of excerpt.split('\n')) {
      out.push(`> ${line}`);
    }
    if (txt.length > TRANSCRIPT_EXCERPT_CHARS) {
      out.push('');
      out.push(`_(transcript truncated — ${txt.length} chars total)_`);
    }
    out.push('');
  }

  // Trim a trailing blank line for cleanliness.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Pretty-print a platform enum for headings. Exported for tests. */
export function platformLabel(p: VideoReport['platform']): string {
  switch (p) {
    case 'x-native':
      return 'X (native)';
    case 'youtube':
      return 'YouTube';
    case 'tiktok':
      return 'TikTok';
    case 'vimeo':
      return 'Vimeo';
    case 'linkedin':
      return 'LinkedIn';
    default:
      return p;
  }
}

/** Format a USD cost as a 2-decimal string, but expand to 4 for sub-cent. */
function formatCost(usd: number): string {
  if (usd >= 0.01) return usd.toFixed(2);
  return usd.toFixed(4);
}

/** Format a millisecond timestamp as `M:SS` or `H:MM:SS`. Exported for tests. */
export function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderKeyMomentLine(m: KeyMoment): string {
  const range = `${formatTimestamp(m.startMs)}–${formatTimestamp(m.endMs)}`;
  const typeTag = m.type ? ` _[${m.type}]_` : '';
  return `- \`[${range}]\`${typeTag} ${m.description}`;
}
