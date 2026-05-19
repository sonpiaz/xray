/**
 * P3.2 — Cross-reference module tests.
 *
 * Covers:
 *   1. `buildCrossReferencePrompts` — pure prompt assembly
 *   2. `estimateCrossReferenceCost` — cost formula
 *   3. `repairCrossReferenceResponse` — lenient relationship/confidence repair
 *   4. `parseCrossReferenceResponse` — drops unfixable rows, enforces 8-cap
 *   5. `crossReferenceArticle` — full call with mocked Kyma chat
 *
 * Kyma `chat()` is mocked at module level so no network call escapes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kyma/client.ts', () => ({
  chat: vi.fn(),
}));

import {
  CROSS_REFERENCE_PROMPT_VERSION,
  MAX_CROSS_REFERENCES,
  buildCrossReferencePrompts,
  crossReferenceArticle,
  estimateCrossReferenceCost,
  parseCrossReferenceResponse,
  repairCrossReferenceResponse,
} from '../../src/article/cross-reference.ts';
import { chat } from '../../src/kyma/client.ts';
import type { ArticleBody } from '../../src/models/article.ts';

const mockChat = vi.mocked(chat);

const fixturePath = join(__dirname, '..', 'fixtures', 'article-crossref-response.json');
const fixtureRaw = readFileSync(fixturePath, 'utf8');
const fixturePayload = JSON.parse(fixtureRaw) as {
  crossReferences: Array<Record<string, unknown>>;
};

const sampleBody: ArticleBody = {
  title: 'How LLMs Actually Work',
  text: 'Large language models are transformer-based neural networks. They predict the next token. The self-attention mechanism enables the model to weigh tokens across long contexts without recurrence. Diminishing returns past 70B parameters suggest that scaling alone is not sufficient.',
  wordCount: 40,
  contentSource: 'x-article-card',
};

const sampleThesis = 'Scaling alone solves intelligence. Self-attention is the key innovation.';

beforeEach(() => {
  mockChat.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// 1. buildCrossReferencePrompts
// ──────────────────────────────────────────────────────────────────────

describe('buildCrossReferencePrompts', () => {
  it('embeds tweet thesis + article title in user prompt', () => {
    const { user } = buildCrossReferencePrompts(sampleBody, sampleThesis);
    expect(user).toContain('TWEET THESIS:');
    expect(user).toContain(sampleThesis);
    expect(user).toContain('ARTICLE TITLE: How LLMs Actually Work');
    expect(user).toContain('Large language models');
  });

  it('omits ARTICLE SUMMARY block when summary is undefined', () => {
    const { user } = buildCrossReferencePrompts(sampleBody, sampleThesis);
    expect(user).not.toContain('ARTICLE SUMMARY');
  });

  it('includes ARTICLE SUMMARY block when summary is supplied', () => {
    const { user } = buildCrossReferencePrompts(
      sampleBody,
      sampleThesis,
      'A one-paragraph synthesis.',
    );
    expect(user).toContain('ARTICLE SUMMARY');
    expect(user).toContain('A one-paragraph synthesis.');
  });

  it('emits a system prompt that defines all four relationships', () => {
    const { system } = buildCrossReferencePrompts(sampleBody, sampleThesis);
    expect(system).toContain('supports');
    expect(system).toContain('extends');
    expect(system).toContain('contradicts');
    expect(system).toContain('unrelated');
    expect(system).toContain('verbatim');
  });

  it('truncates very long article bodies with a marker', () => {
    const longBody: ArticleBody = {
      ...sampleBody,
      text: 'x'.repeat(40_000),
      wordCount: 40_000,
    };
    const { user } = buildCrossReferencePrompts(longBody, sampleThesis);
    expect(user).toContain('[truncated — original was 40000 chars]');
    expect(user.length).toBeLessThan(20_000);
  });

  it('truncates a very long tweet thesis', () => {
    const longThesis = 'x'.repeat(10_000);
    const { user } = buildCrossReferencePrompts(sampleBody, longThesis);
    // 4000 char cap on thesis — total user prompt much smaller than 10K.
    expect(user.length).toBeLessThan(8_000);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. estimateCrossReferenceCost
// ──────────────────────────────────────────────────────────────────────

describe('estimateCrossReferenceCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(estimateCrossReferenceCost(0, 0)).toBe(0);
  });

  it('weights input + output prices correctly', () => {
    // 10K input * $0.0001/1K = $0.001 + 1K output * $0.0003/1K = $0.0003 → $0.0013
    expect(estimateCrossReferenceCost(10_000, 1_000)).toBeCloseTo(0.0013, 5);
  });

  it('returns a positive value for non-zero usage', () => {
    expect(estimateCrossReferenceCost(500, 200)).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. repairCrossReferenceResponse
// ──────────────────────────────────────────────────────────────────────

describe('repairCrossReferenceResponse', () => {
  it('passes through valid payloads unchanged', () => {
    const out = repairCrossReferenceResponse(fixturePayload) as typeof fixturePayload;
    expect(out.crossReferences).toHaveLength(3);
    expect(out.crossReferences[0]?.relationship).toBe('contradicts');
  });

  it("repairs 'related' → 'extends'", () => {
    const input = {
      crossReferences: [
        {
          tweetClaim: 'a',
          articlePassage: 'b',
          relationship: 'related',
          confidence: 0.5,
        },
      ],
    };
    const out = repairCrossReferenceResponse(input) as typeof input;
    expect(out.crossReferences[0]?.relationship).toBe('extends');
  });

  it("repairs 'disagrees' → 'contradicts' and 'agrees' → 'supports'", () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'disagrees', confidence: 0.7 },
        { tweetClaim: 'c', articlePassage: 'd', relationship: 'agrees', confidence: 0.8 },
      ],
    };
    const out = repairCrossReferenceResponse(input) as typeof input;
    expect(out.crossReferences[0]?.relationship).toBe('contradicts');
    expect(out.crossReferences[1]?.relationship).toBe('supports');
  });

  it('normalises upper-case relationships to lower-case', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'SUPPORTS', confidence: 0.5 },
      ],
    };
    const out = repairCrossReferenceResponse(input) as typeof input;
    expect(out.crossReferences[0]?.relationship).toBe('supports');
  });

  it('rescales 0-100 confidence into 0-1 range', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'supports', confidence: 85 },
      ],
    };
    const out = repairCrossReferenceResponse(input) as typeof input;
    expect(out.crossReferences[0]?.confidence).toBe(0.85);
  });

  it('coerces stringly-typed confidence numbers', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'supports', confidence: '0.42' },
      ],
    };
    const out = repairCrossReferenceResponse(input) as typeof input;
    expect(out.crossReferences[0]?.confidence).toBe(0.42);
  });

  it('returns input unchanged when crossReferences is not an array', () => {
    const input = { crossReferences: 'oops' };
    const out = repairCrossReferenceResponse(input);
    expect(out).toEqual(input);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. parseCrossReferenceResponse
// ──────────────────────────────────────────────────────────────────────

describe('parseCrossReferenceResponse', () => {
  it('parses the fixture into 3 cross-references', () => {
    const refs = parseCrossReferenceResponse(fixturePayload);
    expect(refs).toHaveLength(3);
    expect(refs[0]?.relationship).toBe('contradicts');
    expect(refs[1]?.relationship).toBe('supports');
  });

  it('returns empty array when payload missing crossReferences', () => {
    expect(parseCrossReferenceResponse({})).toEqual([]);
    expect(parseCrossReferenceResponse(null)).toEqual([]);
    expect(parseCrossReferenceResponse(undefined)).toEqual([]);
  });

  it('drops rows with an unfixable relationship', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'fubar', confidence: 0.5 },
        { tweetClaim: 'c', articlePassage: 'd', relationship: 'supports', confidence: 0.9 },
      ],
    };
    const refs = parseCrossReferenceResponse(input);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.tweetClaim).toBe('c');
  });

  it('drops rows where required fields are missing', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a' }, // no passage / relationship / confidence
        { tweetClaim: 'b', articlePassage: 'p', relationship: 'supports', confidence: 0.5 },
      ],
    };
    const refs = parseCrossReferenceResponse(input);
    expect(refs).toHaveLength(1);
  });

  it('enforces the MAX_CROSS_REFERENCES (8) cap', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      tweetClaim: `claim ${i}`,
      articlePassage: `passage ${i}`,
      relationship: 'supports',
      confidence: 0.5,
    }));
    const refs = parseCrossReferenceResponse({ crossReferences: ten });
    expect(refs).toHaveLength(MAX_CROSS_REFERENCES);
    expect(MAX_CROSS_REFERENCES).toBe(8);
  });

  it('repairs known synonyms inline (e.g. related → extends)', () => {
    const input = {
      crossReferences: [
        { tweetClaim: 'a', articlePassage: 'b', relationship: 'related', confidence: 0.6 },
      ],
    };
    const refs = parseCrossReferenceResponse(input);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.relationship).toBe('extends');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. crossReferenceArticle (full call with mocked Kyma)
// ──────────────────────────────────────────────────────────────────────

describe('crossReferenceArticle', () => {
  it('returns parsed crossReferences + cost when Kyma returns valid JSON', async () => {
    mockChat.mockResolvedValue({
      content: fixtureRaw,
      model: 'gemini-2.5-flash',
      cached: false,
      usage: { promptTokens: 500, completionTokens: 200 },
    });

    const res = await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
    });
    expect(res.crossReferences).toHaveLength(3);
    expect(res.crossReferences[0]?.relationship).toBe('contradicts');
    expect(res.estimatedCostUsd).toBeGreaterThan(0);
    expect(res.cached).toBe(false);
    expect(res.model).toBe('gemini-2.5-flash');
  });

  it('returns 0 cost when the response was cache-served', async () => {
    mockChat.mockResolvedValue({
      content: fixtureRaw,
      model: 'gemini-2.5-flash',
      cached: true,
    });
    const res = await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
    });
    expect(res.cached).toBe(true);
    expect(res.estimatedCostUsd).toBe(0);
  });

  it('throws when the Kyma JSON cannot be parsed', async () => {
    mockChat.mockResolvedValue({
      content: 'this is not json',
      model: 'gemini-2.5-flash',
      cached: false,
    });
    await expect(
      crossReferenceArticle({
        articleBody: sampleBody,
        tweetThesis: sampleThesis,
        urlCanonical: 'https://x.com/i/article/123',
      }),
    ).rejects.toThrow(/JSON parse failed/);
  });

  it('returns empty crossReferences when Kyma returns empty array', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ crossReferences: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const res = await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
    });
    expect(res.crossReferences).toEqual([]);
  });

  it('passes JSON mode + temperature + the cache key into chat()', async () => {
    mockChat.mockResolvedValue({
      content: fixtureRaw,
      model: 'gemini-2.5-flash',
      cached: false,
    });
    await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
    });
    const call = mockChat.mock.calls[0]?.[0];
    expect(call?.jsonMode).toBe(true);
    expect(call?.temperature).toBe(0.2);
    expect(call?.maxTokens).toBe(4000);
    expect(call?.cacheKey).toContain('article-crossref');
    expect(call?.cacheKey).toContain('https://x.com/i/article/123');
    expect(call?.cacheKey).toContain(CROSS_REFERENCE_PROMPT_VERSION);
  });

  it('salts the cache key with a random suffix when noCache=true', async () => {
    mockChat.mockResolvedValue({
      content: fixtureRaw,
      model: 'gemini-2.5-flash',
      cached: false,
    });
    await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
      noCache: true,
    });
    const call = mockChat.mock.calls[0]?.[0];
    expect(call?.cacheKey).toMatch(/article-crossref:.+:v1:[0-9]+-[a-z0-9]+/);
  });

  it('drops unfixable rows but keeps fixable ones in the same batch', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        crossReferences: [
          { tweetClaim: 'a', articlePassage: 'b', relationship: 'related', confidence: 0.5 },
          { tweetClaim: 'c', articlePassage: 'd', relationship: 'fubar', confidence: 0.4 },
          { tweetClaim: 'e', articlePassage: 'f', relationship: 'supports', confidence: 0.9 },
        ],
      }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const res = await crossReferenceArticle({
      articleBody: sampleBody,
      tweetThesis: sampleThesis,
      urlCanonical: 'https://x.com/i/article/123',
    });
    expect(res.crossReferences).toHaveLength(2);
    expect(res.crossReferences.map((r) => r.relationship)).toEqual(['extends', 'supports']);
  });
});
