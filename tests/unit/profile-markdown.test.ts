/**
 * P4.2 — Profile markdown renderer tests.
 *
 * Pure renderer — no db, no kyma. Build a `ProfileReport` by hand and
 * assert on the markdown shape.
 */
import { describe, expect, it } from 'vitest';
import type { ProfileReport } from '../../src/models/profile.ts';
import { renderProfileMarkdown } from '../../src/render/profile-markdown.ts';

function baseReport(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return {
    handle: 'karpathy',
    samplingScope: 'cache',
    cachedThreadsAnalyzed: 5,
    cachedCommentsAnalyzed: 27,
    topics: [],
    stance: [],
    expertiseAreas: [],
    notableQuotes: [],
    summary: '',
    estimatedCostUsd: 0,
    partial: false,
    warnings: [],
    generatedAt: '2026-05-19T12:34:56.000Z',
    ...overrides,
  };
}

describe('renderProfileMarkdown — header + metadata', () => {
  it('renders the H1 with @handle', () => {
    const md = renderProfileMarkdown(baseReport());
    expect(md.split('\n')[0]).toBe('# Profile — @karpathy');
  });

  it('renders the metadata line with sampling/threads/comments/cost', () => {
    const md = renderProfileMarkdown(
      baseReport({
        cachedThreadsAnalyzed: 3,
        cachedCommentsAnalyzed: 12,
        estimatedCostUsd: 0.06,
      }),
    );
    expect(md).toContain('**Sampling:** cache');
    expect(md).toContain('**Threads:** 3');
    expect(md).toContain('**Comments:** 12');
    expect(md).toContain('**Cost:** $0.060');
  });

  it('renders $0 when cost is zero', () => {
    const md = renderProfileMarkdown(baseReport({ estimatedCostUsd: 0 }));
    expect(md).toContain('**Cost:** $0');
  });
});

describe('renderProfileMarkdown — partial warnings', () => {
  it('renders a callout when partial=true and warnings present', () => {
    const md = renderProfileMarkdown(
      baseReport({
        partial: true,
        warnings: ['fresh fetch not yet implemented', 'snippet cap reached'],
      }),
    );
    expect(md).toContain('> **Partial result.**');
    expect(md).toContain('fresh fetch not yet implemented');
    expect(md).toContain('snippet cap reached');
  });

  it('does NOT render the callout when partial=false', () => {
    const md = renderProfileMarkdown(baseReport({ partial: false, warnings: [] }));
    expect(md).not.toContain('Partial result');
  });
});

describe('renderProfileMarkdown — sections', () => {
  it('renders the Summary section when populated', () => {
    const md = renderProfileMarkdown(
      baseReport({ summary: 'A pragmatic AI researcher with a wry voice.' }),
    );
    expect(md).toContain('## Summary');
    expect(md).toContain('A pragmatic AI researcher with a wry voice.');
  });

  it('renders the Top Topics table when topics present', () => {
    const md = renderProfileMarkdown(
      baseReport({
        topics: [
          {
            topic: 'AI scaling',
            mentions: 12,
            confidence: 'high',
            representativeSnippet: 'scaling is decelerating',
          },
        ],
      }),
    );
    expect(md).toContain('## Top Topics');
    expect(md).toContain('| Topic | Mentions | Confidence | Snippet |');
    expect(md).toContain('| AI scaling | 12 | high | scaling is decelerating |');
  });

  it('renders the Stance table when stance present', () => {
    const md = renderProfileMarkdown(
      baseReport({
        stance: [
          {
            subject: 'agentic AI',
            stance: 'bullish',
            evidenceSnippets: ['agents will scale', 'tools matter'],
            confidence: 'high',
          },
        ],
      }),
    );
    expect(md).toContain('## Stance');
    expect(md).toContain('| Subject | Stance | Confidence | Evidence |');
    expect(md).toContain('agentic AI');
    expect(md).toContain('bullish');
    expect(md).toContain('"agents will scale"');
  });

  it('renders the Expertise bullet list', () => {
    const md = renderProfileMarkdown(
      baseReport({ expertiseAreas: ['LLMs', 'computer vision', 'pedagogy'] }),
    );
    expect(md).toContain('## Expertise');
    expect(md).toContain('- LLMs');
    expect(md).toContain('- computer vision');
    expect(md).toContain('- pedagogy');
  });

  it('renders Notable Quotes as blockquotes with source link', () => {
    const md = renderProfileMarkdown(
      baseReport({
        notableQuotes: [
          {
            text: 'transformer scaling is decelerating',
            sourceUrl: 'https://x.com/karpathy/status/123',
          },
        ],
      }),
    );
    expect(md).toContain('## Notable Quotes');
    expect(md).toContain('> "transformer scaling is decelerating"');
    expect(md).toContain('[source](https://x.com/karpathy/status/123)');
  });

  it('renders quote context when present', () => {
    const md = renderProfileMarkdown(
      baseReport({
        notableQuotes: [{ text: 'short quote', context: 'on Claude release' }],
      }),
    );
    expect(md).toContain('— on Claude release');
  });
});

describe('renderProfileMarkdown — empty sections', () => {
  it('skips empty sections entirely', () => {
    const md = renderProfileMarkdown(baseReport()); // all sections empty
    expect(md).not.toContain('## Summary');
    expect(md).not.toContain('## Top Topics');
    expect(md).not.toContain('## Stance');
    expect(md).not.toContain('## Expertise');
    expect(md).not.toContain('## Notable Quotes');
    // Still renders the H1 + footer
    expect(md).toContain('# Profile — @karpathy');
    expect(md).toContain('Generated by XRay v1.0.1');
  });

  it('emits an explanatory fallback line when every section is empty', () => {
    const md = renderProfileMarkdown(baseReport());
    expect(md).toContain('No synthesized content');
  });
});

describe('renderProfileMarkdown — snippet truncation in tables', () => {
  it('clamps long representativeSnippet in topics table', () => {
    const long = 'x'.repeat(300);
    const md = renderProfileMarkdown(
      baseReport({
        topics: [{ topic: 'T', mentions: 1, confidence: 'low', representativeSnippet: long }],
      }),
    );
    // The clamped cell should end in an ellipsis somewhere in the row.
    const topicRow = md.split('\n').find((line) => line.startsWith('| T |'));
    expect(topicRow).toBeTruthy();
    expect(topicRow).toContain('…');
  });

  it('escapes pipes in topic cells so the table stays intact', () => {
    const md = renderProfileMarkdown(
      baseReport({
        topics: [{ topic: 'foo|bar', mentions: 1, confidence: 'low' }],
      }),
    );
    expect(md).toContain('foo\\|bar');
  });
});

describe('renderProfileMarkdown — footer', () => {
  it('renders the generated-at footer with the report timestamp', () => {
    const md = renderProfileMarkdown(baseReport());
    expect(md).toContain('*Generated by XRay v1.0.1 at 2026-05-19T12:34:56.000Z*');
  });
});
