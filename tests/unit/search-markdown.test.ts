/**
 * P4.1 — Search markdown renderer tests.
 *
 * Pure renderer — no db, no kyma. Each test builds a `SearchResponse`
 * by hand and asserts on the markdown shape.
 */
import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '../../src/models/search.ts';
import { renderSearchMarkdown } from '../../src/render/search-markdown.ts';

function baseResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: 'transformer scaling',
    reranked: false,
    limit: 10,
    results: [],
    estimatedCostUsd: 0,
    generatedAt: '2026-05-19T12:34:56.000Z',
    ...overrides,
  };
}

describe('renderSearchMarkdown — header', () => {
  it('renders the heading and metadata line', () => {
    const md = renderSearchMarkdown(baseResponse());
    expect(md).toContain('# Search Results — "transformer scaling"');
    expect(md).toContain('**Found:** 0 results');
    expect(md).toContain('**Reranked:** no');
    expect(md).toContain('**Cost:** $0');
  });

  it('singularizes "result" when exactly one match', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 'hi',
            similarity: 0.8,
            source: { authorHandle: 'alice' },
          },
        ],
      }),
    );
    expect(md).toContain('**Found:** 1 result');
  });

  it('surfaces typeFilter and threshold in metadata', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        typeFilter: 'comment',
        threshold: 0.5,
      }),
    );
    expect(md).toContain('**Type:** comment');
    expect(md).toContain('**Threshold:** 0.50');
  });
});

describe('renderSearchMarkdown — empty results', () => {
  it('emits a helpful hint when there are no results', () => {
    const md = renderSearchMarkdown(baseResponse());
    expect(md).toContain('No matches above threshold');
    expect(md).toContain('xray cache embed');
    expect(md).not.toContain('| # | Score');
  });
});

describe('renderSearchMarkdown — table layout', () => {
  it('renders the 5-column table when not reranked', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 'hello world',
            similarity: 0.87,
            source: {
              authorHandle: 'karpathy',
              postId: '1',
              url: 'https://x.com/karpathy/status/1',
            },
          },
        ],
      }),
    );
    expect(md).toContain('| # | Score | Type | Snippet | Source |');
    expect(md).toContain(
      '| 1 | 0.87 | post | hello world | @karpathy / [tweet](https://x.com/karpathy/status/1) |',
    );
    // No rerank column header.
    expect(md).not.toContain('| Rerank |');
  });

  it('renders the 6-column table with Rerank when reranked=true', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        reranked: true,
        estimatedCostUsd: 0.005,
        results: [
          {
            entityType: 'comment',
            entityId: 'c1',
            snippet: 'hi',
            similarity: 0.7,
            rerankScore: 0.95,
            source: { authorHandle: 'alice' },
          },
        ],
      }),
    );
    expect(md).toContain('| # | Score | Rerank | Type | Snippet | Source |');
    expect(md).toContain('| 1 | 0.70 | 0.95 | comment | hi | @alice |');
    expect(md).toContain('**Cost:** $0.005');
  });

  it('renders an em-dash when rerank score missing for a row', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        reranked: true,
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 'a',
            similarity: 0.5,
            source: { authorHandle: 'a' },
            // no rerankScore
          },
        ],
      }),
    );
    expect(md).toContain('| 1 | 0.50 | — | post | a | @a |');
  });
});

describe('renderSearchMarkdown — snippet handling', () => {
  it('clamps long snippets in the table to ~80 chars + ellipsis', () => {
    const long = 'a'.repeat(200);
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: long,
            similarity: 0.5,
            source: {},
          },
        ],
      }),
    );
    // The table row must contain a clamped form ending in an ellipsis.
    const rowMatch = md.match(/\| 1 \| .* \| .*…/);
    expect(rowMatch).not.toBeNull();
  });

  it('escapes pipes inside snippets so the table columns stay intact', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 'one|two|three',
            similarity: 0.5,
            source: {},
          },
        ],
      }),
    );
    expect(md).toContain('one\\|two\\|three');
  });

  it('includes a Full snippets section with each untruncated snippet', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 'this is the full snippet body',
            similarity: 0.5,
            source: { authorHandle: 'a' },
          },
        ],
      }),
    );
    expect(md).toContain('## Full snippets');
    expect(md).toContain('> this is the full snippet body');
  });
});

describe('renderSearchMarkdown — source rendering', () => {
  it('renders @handle / [tweet](url) when both present', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 's',
            similarity: 0.5,
            source: { authorHandle: 'alice', url: 'https://x.com/alice/status/1' },
          },
        ],
      }),
    );
    expect(md).toContain('@alice / [tweet](https://x.com/alice/status/1)');
  });

  it('renders [article](url) for article-passage', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'article-passage',
            entityId: 'article:x:chunk:0',
            snippet: 's',
            similarity: 0.5,
            source: { url: 'https://example.com/post' },
          },
        ],
      }),
    );
    expect(md).toContain('[article](https://example.com/post)');
  });

  it('renders em-dash when source has neither handle nor URL', () => {
    const md = renderSearchMarkdown(
      baseResponse({
        results: [
          {
            entityType: 'post',
            entityId: '1',
            snippet: 's',
            similarity: 0.5,
            source: {},
          },
        ],
      }),
    );
    // Table row ends with " — |".
    expect(md).toMatch(/\| 1 \| 0\.50 \| post \| s \| — \|/);
  });
});
