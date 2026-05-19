# Phase 3 — External Content (Articles & Linked Sources)

**Status:** Draft
**Date:** 2026-05-19
**Owner:** sonpiaz
**Version target:** v0.4.0
**Depends on:** v0.3.1 (Phase 0 + Phase 1 + Phase 1.5 + Phase 2 complete), Kyma chat API, `@mozilla/readability` (NEW dependency), `cheerio` (already present), `playwright` (already present)

---

## 0. The Principle

> External content is a parallel pipeline. It ships alongside thread and video research but never runs without explicit intent.

**The rule:** Article analysis is always opt-in. `xray thread <url>` default behavior remains unchanged — text research only. Article processing triggers only when:
1. The user passes `--articles` on `xray thread`, or
2. The user invokes the standalone `xray article <url>` command, or
3. An MCP caller passes `articles: true` to `xray_thread` or calls the new `xray_article` tool.

This mirrors the `--video` opt-in design from Phase 2. A thread linking to five Stratechery posts could burn $0.50-1.50 on cross-reference analysis alone. The opt-in design ensures no surprise cost. Cost-bearing operations must be visible.

**Design philosophy:**
- Articles are fetched locally (cheerio/Readability), never through paid APIs.
- Summarization and cross-referencing go through Kyma — those are the cost centers.
- Paywalled content returns a partial result with what was extractable, never silently fails.
- No cost caps (matching Son's P2 decision) — cost surfaced via `estimatedCostUsd` and breakdown fields.

---

## 1. Goals

1. **X Article extraction** — parse and summarize X's native long-form articles (Articles feature / Twitter Notes) embedded in tweets.
2. **External link body extraction** — fetch, parse, and summarize linked articles from Substack, Medium, dev.to, personal blogs, and any standard HTML page.
3. **Full cross-reference attribution** — given a tweet thread's thesis and a linked article, produce claim-passage mappings showing where the article supports, extends, or contradicts the thread author's points.
4. **Standalone `xray article <url>` command** — analyze any article URL independently, without requiring a thread context.
5. **Cost transparency** — surface `estimatedCostUsd` and `costBreakdown` on every `ArticleSummary`, with WARN logs on long-form content (>10k words).

## 2. Non-Goals (deferred)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Paywalled content (full bypass) | Phase 5 | Requires paid API keys or browser auth for each platform. P3 extracts whatever the public HTML yields and flags `partial: true`. |
| PDF parsing | Phase 5 | Different extraction pipeline (pdf-parse or similar). Not HTML. |
| Academic papers (arXiv, SSRN) | Phase 5 | Specialized metadata + citation graph. Separate from HTML articles. |
| Video embeds in articles | Already P2 | `xray video` handles these independently. |
| RSS/feed batching | Phase 6+ | Batch analysis of an author's entire feed is a separate product surface. |
| Fact-checking against external sources | Phase 5+ | Cross-reference is attribution ("where does the article support/contradict"), not truth-checking. |

---

## 3. User-Facing Changes

### 3.1 CLI Surface

| Flag / Command | Type | Default | Behavior (P3) | Change from P2 |
|---|---|---|---|---|
| `xray thread <url>` (no flags) | - | Text-only research (unchanged) | No article processing. Same as v0.3.1. | **Unchanged** |
| `xray thread <url> --articles` | boolean | `false` | Detect linked articles in root post + author follow-ups, fetch + summarize + cross-reference each, embed `ArticleSummary[]` in `ResearchReport`. | **NEW** |
| `xray article <url>` | command | - | Standalone article analysis. Accepts any URL: X Article, Substack, Medium, dev.to, personal blog, any HTML page. Returns an `ArticleSummary`. | **NEW command** |
| `--json` | boolean | `false` | JSON output (applies to `thread`, `video`, and `article`). | Unchanged |
| `-o, --output <path>` | string | - | Write output to file. | Unchanged |
| `--no-cache` | boolean | `false` | Skip article cache (re-fetch, re-summarize, re-cross-reference). | Unchanged |
| `--raw` | boolean | `false` | Skip LLM summarization and cross-reference; return extracted body only. | Unchanged |

### 3.2 MCP Surface

| Tool | Args | Type | Default | Description |
|---|---|---|---|---|
| `xray_thread` | `articles` | `z.boolean().optional()` | `false` | **NEW arg.** When true, detect and analyze linked articles in the thread. |
| `xray_article` | `url` | `z.string().url()` | required | **NEW tool.** Standalone article analysis. |
| `xray_article` | `noCache` | `z.boolean().optional()` | `false` | Skip article cache. |
| `xray_article` | `raw` | `z.boolean().optional()` | `false` | Skip LLM summarization. |
| `xray_article` | `format` | `z.enum(['markdown','json','both'])` | `'markdown'` | Output format. |

### 3.3 Markdown Output Changes

When `--articles` is used on `xray thread` and linked articles are found, a new section appears in the report:

```markdown
## Article — How LLMs Actually Work (Substack)

**Source:** https://newsletter.example.com/llms-explained
**Platform:** external-html (Substack)
**Word count:** 4,200 words
**Estimated cost:** $0.08

### Summary
One-paragraph synthesis of the article's main argument...

### Key Points
1. LLMs use transformer architecture with self-attention mechanisms...
2. Training data quality matters more than model size...
3. Fine-tuning on domain-specific data yields disproportionate gains...

### Cross-Reference with Thread

| Thread Claim | Article Passage | Relationship | Confidence |
|---|---|---|---|
| "Scaling is all you need" (root post) | "Our experiments show diminishing returns past 70B parameters..." (para 4) | **contradicts** | 0.82 |
| "Fine-tuning is overrated" (follow-up #2) | "Domain-specific fine-tuning improved accuracy by 23% on medical benchmarks" (para 7) | **contradicts** | 0.91 |
| "Attention is the key innovation" (root post) | "The self-attention mechanism enables..." (para 2) | **supports** | 0.95 |
```

For standalone `xray article <url>`:

```markdown
# Article Analysis — How LLMs Actually Work

**URL:** https://newsletter.example.com/llms-explained
**Platform:** external-html (Substack)
**Author:** Jane Smith
**Published:** 2026-05-15
**Word count:** 4,200 words
**Estimated cost:** $0.05

## Summary
...

## Key Points
1. ...
2. ...
3. ...
```

---

## 4. Pipeline Architecture

```
               xray article <url>  /  xray thread <url> --articles
                         |
                         v
              +------------------------+
              |   URL Classification   |
              |   detect.ts            |
              |   (x-article |         |
              |    external-html)      |
              +-----------+------------+
                          |
           +--------------+--------------+
           |                             |
  X Article URL                 External URL
  (x.com/*/articles/*)          (substack, medium,
  or tweet with card             dev.to, blog, etc.)
           |                             |
           v                             v
  +------------------+        +--------------------+
  | X Article Fetch  |        | 3-Tier Fetch       |
  | (SSR HTML parse  |        | 1. undici GET      |
  |  or GraphQL      |        | 2. cheerio +       |
  |  card data)      |        |    Readability      |
  +--------+---------+        | 3. Playwright       |
           |                  |    fallback (SPA)   |
           |                  +---------+----------+
           |                            |
           +-------------+--------------+
                         |
                         v
              +----------+-----------+
              |   ArticleBody        |
              |   (title, byline,    |
              |    text, wordCount)  |
              +----------+-----------+
                         |
                    cache check
                    (article_bodies)
                         |
              +----------+-----------+
              |   Summarize          |
              |   (Kyma chat:        |
              |    body -> summary   |
              |    + key points)     |
              +----------+-----------+
                         |
              +----------+-----------+
              |   Cross-Reference    |
              |   (Kyma chat:        |
              |    tweet thesis +    |
              |    article body ->   |
              |    claim-passage     |
              |    attribution)      |
              +----------+-----------+
                         |
                         v
              +----------+-----------+
              |   ArticleSummary     |
              |   (Zod-validated)    |
              +----------------------+
```

---

## 5. Per-Stage Specification

### 5.1 URL Classification (`detect.ts`)

**File:** `src/article/detect.ts`

**Trigger:** `xray article <url>` or `xray thread <url> --articles` when root post / author posts contain external links.

**Logic:**
1. If the URL matches `x.com/*/articles/*` or the fetched tweet has a `card` with `binding_values` containing article content: classify as `x-article`.
2. If the URL is any other HTTP(S) URL: classify as `external-html`.
3. URLs pointing to known non-article resources (images, videos, PDFs, tweet URLs, audio files) are filtered out.

**Domain heuristics for known platforms:**

| Platform | URL pattern | Notes |
|---|---|---|
| X Article | `x.com/*/articles/*`, tweet cards with `card.name === 'article'` | Native long-form content |
| Substack | `*.substack.com/*`, custom domains with Substack fingerprint | Clean HTML, Readability works well |
| Medium | `medium.com/*`, `*.medium.com/*`, custom domains with Medium fingerprint | Has some JS-rendered content |
| dev.to | `dev.to/*` | Clean HTML, semantic tags |
| GitHub (README/issues) | `github.com/*/blob/*`, `github.com/*/issues/*` | Raw HTML available via `?plain=1` |
| General blog | Any other `http(s)://` URL | Readability handles most |

**Inputs:** `url: string`
**Outputs:** `{ source: ArticleSource, url: string, canonicalUrl: string }`
**Dependencies:** None (pure URL parsing)
**Cost:** Free
**Failure modes:**
- Non-HTTP URL (mailto, ftp, etc.) -> skip with debug log
- URL pointing to media file (.jpg, .mp4, .pdf, etc.) -> skip with debug log

### 5.2 Fetch — 3-Tier Strategy (`fetch.ts`)

**File:** `src/article/fetch.ts`

**Trigger:** After URL classification succeeds.

**3-tier fetch pipeline:**

**Tier 1: undici GET + cheerio + Readability**
1. `undici.request(url)` with 10-second timeout and `Accept: text/html` header.
2. Parse the HTML response with `cheerio.load()`.
3. Pass the DOM to `@mozilla/readability`'s `Readability` class to extract article body.
4. If Readability returns a non-empty `textContent` with > 100 words, accept the result.
5. If Readability fails (returns null or < 100 words), escalate to Tier 2.

**Tier 2: Direct cheerio extraction (fallback)**
1. If Readability fails, fall back to a manual cheerio extraction:
   - Look for `<article>` tag content
   - Fall back to `main` -> `#content` -> `.post-body` -> `.entry-content` -> `body`
   - Strip nav, footer, sidebar, ads, script, style elements
2. If extracted text > 100 words, accept.
3. If < 100 words, escalate to Tier 3.

**Tier 3: Playwright fallback (SPA rendering)**
1. Launch headless Chromium (already installed for Phase 1.5).
2. Navigate to URL with 30-second timeout.
3. Wait for `networkidle` or `domcontentloaded` + 2-second settle.
4. Extract `document.body.innerText` via `page.evaluate()`.
5. Run Readability on the rendered DOM.
6. Accept whatever Readability returns (even partial).

**Inputs:** `url: string, source: ArticleSource`
**Outputs:** `ArticleBody`
**Dependencies:** `undici`, `cheerio`, `@mozilla/readability`, `playwright` (for Tier 3)
**Cost:** Free (just HTTP + CPU)
**Failure modes:**
- Network timeout (10s undici / 30s Playwright) -> `FetchError` with `transient: true`
- HTTP 4xx/5xx -> `FetchError` with status code
- Paywall detected (< 200 words extracted + paywall heuristic markers: "Subscribe to continue", "Members only", login forms) -> return partial body with `partial: true` and paywall warning
- SSL error -> `FetchError`
- Redirect chain > 5 hops -> `FetchError`

### 5.3 X Article Extraction (`parse-x-article.ts`)

**File:** `src/article/parse-x-article.ts`

**Trigger:** When `detect.ts` classifies a URL as `x-article`.

**X Article source methods (tried in order):**

1. **Tweet card data** — When the article is linked from a tweet, the GraphQL TweetDetail response includes `card.legacy.binding_values[]` with keys like `card_url`, `title`, `description`, and sometimes the full body text. Parse these from the existing `parser.ts` output by adding a `parseCardBindings()` export.

2. **Direct HTML fetch** — X Articles are also available at `x.com/{handle}/articles/{id}`. Fetch the page HTML and extract the article body from the rendered content. X Articles use server-rendered HTML for the article body (unlike tweets which are SPA-rendered), so Tier 1 (undici + Readability) should work for most cases.

3. **Playwright fallback** — If SSR extraction fails (X changes their rendering), fall back to Playwright.

**Parser changes (`src/fetcher/parser.ts`):**

Add a new exported function to extract card binding values from the GraphQL response:

```typescript
export function parseCardBindings(tweetResult: unknown): Record<string, string> | undefined {
  const tweet = unwrapTweetResult(tweetResult);
  const card = obj(tweet?.card);
  const legacy = obj(card?.legacy);
  const bindings = arr(legacy?.binding_values);
  if (!bindings) return undefined;
  const out: Record<string, string> = {};
  for (const b of bindings) {
    const bo = obj(b);
    const key = str(bo?.key);
    const value = str(obj(bo?.string_value)?.string_value) ?? str(obj(bo?.scribe_value)?.value);
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
```

**Inputs:** URL string, optional tweet card data from parser
**Outputs:** `ArticleBody`
**Dependencies:** `parser.ts` card extraction, `undici`, `cheerio`, `@mozilla/readability`
**Cost:** Free
**Failure modes:**
- X Article format changes -> fall through to Playwright
- Article deleted (404) -> `FetchError`
- Private article -> partial result with `partial: true`

### 5.4 Summarize (`summarize.ts`)

**File:** `src/article/summarize.ts`

**Trigger:** After fetch returns an `ArticleBody` with `wordCount > 0`.

**What it does:**
1. Construct a Kyma chat prompt with the article text (truncated at 100k characters to stay within context limits).
2. Request a structured JSON response with `summary` (1 paragraph) and `keyPoints[]` (3-7 bullet points).
3. Parse and validate against Zod schema.

**Prompt structure:**
```
System: You are analyzing an article. Produce a structured analysis with:
- summary: one paragraph capturing the article's main argument and conclusions
- keyPoints: 3-7 bullet points of the most important claims, findings, or arguments

Be specific and evidence-based. Reference concrete claims, data points, or arguments from the text.

User:
## Article: {title}
By: {byline}
Published: {publishedAt}
Word count: {wordCount}

{article text}

Respond in JSON: { "summary": "...", "keyPoints": ["...", ...] }
```

**Inputs:** `ArticleBody`
**Outputs:** `{ summary: string, keyPoints: string[] }`
**Dependencies:** Kyma API key, Kyma chat endpoint
**Cost:** Depends on article length. Token estimate: ~1.3 tokens/word for input + ~200-500 output tokens.
  - Short article (1-2k words): ~$0.01-0.02
  - Medium article (3-5k words): ~$0.02-0.04
  - Long article (8-15k words): ~$0.04-0.08
**Failure modes:**
- Kyma API key not set -> skip summarization, return body-only result with `partial: true`
- Kyma returns invalid JSON -> retry once with stricter prompt
- Article too long (> 100k chars) -> truncate with warning
- Kyma rate limit -> retry with exponential backoff (max 3)

### 5.5 Cross-Reference Attribution (`cross-reference.ts`)

**File:** `src/article/cross-reference.ts`

**Trigger:** After summarize succeeds AND a tweet thread context is available (not in standalone `xray article` mode unless caller provides context).

**What it does:**
1. Extract the tweet thread's thesis: root post text + author follow-up texts + existing `tldr` from ResearchReport.
2. Construct a Kyma chat prompt asking the model to find claim-passage mappings between the tweet thread and the article.
3. For each mapping, classify the relationship: `supports`, `extends`, `contradicts`, or `unrelated`.
4. Assign a confidence score (0-1) to each mapping.

**Prompt structure:**
```
System: You are a research analyst comparing a tweet thread's claims against a linked article.

For each significant claim in the tweet thread, find the most relevant passage in the article and classify their relationship:
- "supports": the article provides evidence or agreement for the claim
- "extends": the article adds nuance, context, or additional detail beyond the claim
- "contradicts": the article presents evidence or argument against the claim
- "unrelated": no meaningful connection

Return JSON: { "crossReferences": [{ "tweetClaim": "...", "articlePassage": "...", "relationship": "supports|extends|contradicts|unrelated", "confidence": 0.0-1.0 }] }

Focus on substantive claims only (ignore greetings, meta-commentary, self-promotion). Limit to the 5-10 most significant mappings.

User:
## Tweet Thread
Author: @{handle}
{root post text}
{author follow-up texts}

Thread TL;DR: {tldr}

## Article: {title}
{article text}
```

**Inputs:** `ArticleBody`, tweet thread context (root post + author follow-ups + tldr)
**Outputs:** `CrossReference[]`
**Dependencies:** Kyma API key, Kyma chat endpoint
**Cost:** This is the most expensive stage because both the tweet thread AND the article are sent as input context.
  - Short article + short thread: ~$0.03-0.05
  - Long article + long thread: ~$0.08-0.15
  - Very long article (Stratechery 8k+): ~$0.10-0.25
**Failure modes:**
- No tweet context available (standalone mode) -> skip cross-reference, return summary-only
- Kyma returns invalid JSON -> retry once
- Model hallucinates passages -> confidence scores help downstream consumers filter (low-confidence mappings can be dropped)
- Very long combined input -> truncate article to most relevant sections (first 50k chars + last 10k chars)

---

## 6. Data Model Deltas

### 6.1 ArticleSource (NEW)

```typescript
// src/models/article.ts

export const ArticleSourceSchema = z.enum(['x-article', 'external-html']);
export type ArticleSource = z.infer<typeof ArticleSourceSchema>;
```

### 6.2 ArticleBody (NEW)

```typescript
export const ArticleBodySchema = z.object({
  title: z.string().default('Untitled'),
  byline: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  wordCount: z.number().int().nonnegative(),
  /** Cleaned HTML from Readability (retained for potential re-processing). */
  html: z.string().optional(),
  /** Plain text extracted from the article. Primary input for summarization. */
  text: z.string(),
  /** Which source provided the body (x-article card, readability, cheerio fallback, playwright). */
  contentSource: z.enum([
    'x-article-card',
    'readability',
    'cheerio-fallback',
    'playwright',
  ]),
  /** Detected platform (substack, medium, devto, github, generic). */
  platform: z.string().optional(),
});
export type ArticleBody = z.infer<typeof ArticleBodySchema>;
```

### 6.3 CrossReference (NEW)

```typescript
export const CrossReferenceRelationshipSchema = z.enum([
  'supports',
  'extends',
  'contradicts',
  'unrelated',
]);
export type CrossReferenceRelationship = z.infer<typeof CrossReferenceRelationshipSchema>;

export const CrossReferenceSchema = z.object({
  /** The claim from the tweet thread being referenced. */
  tweetClaim: z.string(),
  /** The relevant passage from the article. */
  articlePassage: z.string(),
  /** How the article passage relates to the tweet claim. */
  relationship: CrossReferenceRelationshipSchema,
  /** Model confidence in this mapping (0-1). */
  confidence: z.number().min(0).max(1),
});
export type CrossReference = z.infer<typeof CrossReferenceSchema>;
```

### 6.4 ArticleSummary (NEW)

```typescript
export const ArticleSummarySchema = z.object({
  /** Original URL as provided. */
  url: z.string().url(),
  /** Canonical URL after redirect resolution. */
  canonicalUrl: z.string().url().optional(),
  /** X Article or external HTML. */
  source: ArticleSourceSchema,
  /** Extracted article body. */
  body: ArticleBodySchema,
  /** LLM-generated summary (absent when --raw or Kyma key not set). */
  summary: z.string().optional(),
  /** LLM-extracted key points (absent when --raw). */
  keyPoints: z.array(z.string()).default([]),
  /** Claim-passage attribution mappings (absent in standalone mode or --raw). */
  crossReferences: z.array(CrossReferenceSchema).default([]),
  /** Total estimated cost of LLM calls for this article. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  /** Per-stage cost breakdown. */
  costBreakdown: z.object({
    summarize: z.number().nonnegative().optional(),
    crossReference: z.number().nonnegative().optional(),
  }).optional(),
  /** True when extraction or analysis was incomplete (paywall, error). */
  partial: z.boolean().default(false),
  /** Accumulated warnings and errors. */
  errors: z.array(z.string()).default([]),
  /** ISO timestamp. */
  generatedAt: z.string().datetime(),
});
export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;
```

### 6.5 ResearchReport Extension

```typescript
// In src/models/report.ts — add to ResearchReportSchema:

// P3 — present only when `--articles` ran AND at least one linked article was
// found and processed. Absent on text-only or video-only runs so all prior
// outputs remain valid.
articleSummaries: z.array(ArticleSummarySchema).optional(),
```

### 6.6 ResearchOptions Extension

```typescript
// In src/intelligence/analyze-thread.ts:

export type ResearchOptions = {
  // ... existing fields ...
  /** P3 — when true, fetch + summarize + cross-reference linked articles. Default false. */
  articles?: boolean;
};
```

---

## 7. Architecture Changes

### 7.1 New Files

| File | Purpose |
|------|---------|
| `src/article/detect.ts` | URL classification: `x-article` vs `external-html`. Domain heuristics for known platforms. Non-article URL filtering. |
| `src/article/fetch.ts` | 3-tier fetch pipeline: undici GET -> cheerio + Readability -> Playwright fallback. Returns `ArticleBody`. |
| `src/article/parse-x-article.ts` | X Article-specific extraction: card binding values from GraphQL, direct HTML fetch, Playwright fallback. |
| `src/article/cache.ts` | SQLite `article_bodies` + `article_summaries` tables. URL-keyed with 7-day TTL. |
| `src/article/summarize.ts` | Kyma chat call: article body -> summary + key points. |
| `src/article/cross-reference.ts` | Kyma chat call: tweet thesis + article body -> claim-passage attribution mappings. |
| `src/article/index.ts` | Re-exports for the article module. |
| `src/intelligence/article.ts` | Article analysis orchestrator. detect -> fetch -> cache check -> summarize -> cross-reference -> ArticleSummary. |
| `src/cli/commands/article.ts` | CLI handler for `xray article <url>`. |
| `src/render/article-markdown.ts` | Markdown renderer for ArticleSummary (standalone + embedded in ResearchReport). |
| `src/models/article.ts` | Zod schemas: ArticleSource, ArticleBody, CrossReference, ArticleSummary. |
| `tests/unit/article-detect.test.ts` | URL classification tests. |
| `tests/unit/article-fetch.test.ts` | 3-tier fetch tests with mock HTTP. |
| `tests/unit/article-summarize.test.ts` | Summarize prompt + response parsing tests. |
| `tests/unit/article-cross-reference.test.ts` | Cross-reference prompt + response parsing tests. |
| `tests/unit/article-cache.test.ts` | Cache read/write/TTL tests. |
| `tests/unit/article-markdown.test.ts` | Markdown rendering tests. |
| `tests/unit/article-model.test.ts` | ArticleSummary Zod schema validation tests. |
| `tests/fixtures/article-substack.html` | Sample Substack HTML for fetch testing. |
| `tests/fixtures/article-medium.html` | Sample Medium HTML for fetch testing. |
| `tests/fixtures/article-devto.html` | Sample dev.to HTML for fetch testing. |
| `tests/fixtures/article-x-article.html` | Sample X Article HTML for parse testing. |

### 7.2 Modified Files

| File | Changes |
|------|---------|
| `src/intelligence/analyze-thread.ts` | Add `articles?: boolean` to `ResearchOptions`. When true + thread has external links, run article pipeline and attach `articleSummaries` to report. Add `collectArticleCandidates()` helper mirroring `collectVideoCandidates()`. |
| `src/fetcher/parser.ts` | Add `parseCardBindings()` export to extract card binding values from GraphQL tweet data. |
| `src/cli/index.ts` | Register `xray article <url>` command. |
| `src/cli/commands/thread.ts` | Add `--articles` flag. Pass `articles: true` to research options. |
| `src/mcp/server.ts` | Add `articles` arg to `xray_thread` tool. Register new `xray_article` tool. |
| `src/models/report.ts` | Import `ArticleSummarySchema`, add `articleSummaries` optional field to `ResearchReportSchema`. |
| `src/models/index.ts` | Re-export article model types. |
| `src/render/markdown.ts` | When `report.articleSummaries` is present, render the `## Article — {title}` sections. |
| `src/cache/db.ts` | Add migration for `article_bodies` and `article_summaries` tables. |
| `package.json` | Add `@mozilla/readability` dependency. Version bump to 0.4.0. |

---

## 8. Cost Surfacing

### 8.1 Deliberate Design Decision: No Cost Limits

**Carried forward from Phase 2 (Son's explicit decision):** XRay imposes no hard cost caps on article processing. This applies to article analysis just as it does to video analysis.

The rationale remains the same: XRay is a power tool for researchers and AI agents. Agents cannot click "confirm $0.30 charge" dialogs. A researcher who invokes `--articles` on a thread linking to five Stratechery essays accepts the cost.

### 8.2 What XRay Does Instead

1. **Surface cost in output:** Every `ArticleSummary` includes `estimatedCostUsd` and `costBreakdown` fields.

2. **Log cost at debug level:** Each pipeline stage logs its estimated cost:
   ```
   DEBUG article:summarize cost=$0.03 words=4200 model=gemini-2.5-flash
   DEBUG article:cross-reference cost=$0.08 words=4200 threadWords=850 model=gemini-2.5-flash
   DEBUG article:total cost=$0.11
   ```

3. **Warn on long articles:** Articles over 10,000 words emit a WARN-level log:
   ```
   WARN article:fetch wordCount=14200 — this article may cost >$0.15 to fully analyze
   ```
   This is informational. The pipeline does NOT pause or prompt.

### 8.3 Cost Reference Table

| Stage | Per-article cost | Short (1-2k words) | Medium (3-5k words) | Long (8k+ words) |
|---|---|---|---|---|
| Detect | $0 | $0 | $0 | $0 |
| Fetch (cheerio/Readability) | $0 | $0 | $0 | $0 |
| Fetch (Playwright fallback) | $0 (just CPU) | $0 | $0 | $0 |
| Summarize (Kyma chat) | $0.01-0.08 | $0.01-0.02 | $0.02-0.04 | $0.04-0.08 |
| Cross-reference (Kyma chat) | $0.03-0.25 | $0.03-0.05 | $0.05-0.10 | $0.10-0.25 |
| **Total typical** | **$0.04-0.13** | **$0.04-0.07** | **$0.07-0.14** | **$0.14-0.33** |

**Thread-level cost compound:**
- Thread with 2 linked articles (medium): ~$0.14-0.28
- Thread with 5 linked articles (mixed lengths): ~$0.35-0.65
- Thread linking to a mega-article (Stratechery 15k words) with full cross-reference: ~$0.20-0.40 for that single article

---

## 9. Caching Strategy

### 9.1 SQLite Tables

New tables added to the existing `~/.xray/cache/xray.db`:

```sql
-- P3.0: Raw article body cache. Keyed by canonical URL.
-- Articles rarely change after publication, so 7-day TTL is generous.
CREATE TABLE IF NOT EXISTS article_bodies (
  url_canonical TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  source TEXT NOT NULL,       -- 'x-article' | 'external-html'
  fetched_at INTEGER NOT NULL
);

-- P3.2: Summarized article cache. Keyed by canonical URL + tweet context.
-- The tweet_context_hash captures the thread context used for cross-ref so
-- the same article analyzed against different threads gets separate cache entries.
CREATE TABLE IF NOT EXISTS article_summaries (
  url_canonical TEXT NOT NULL,
  tweet_context_hash TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (url_canonical, tweet_context_hash)
);

CREATE INDEX IF NOT EXISTS idx_article_bodies_fetched
  ON article_bodies(fetched_at);
CREATE INDEX IF NOT EXISTS idx_article_summaries_created
  ON article_summaries(created_at);
```

### 9.2 Cache Keys

- **URL canonicalization:** Strip tracking params (`utm_*`, `ref`, `source`), resolve `t.co` shortlinks via HEAD request, normalize trailing slashes. Reuse URL canonicalization pattern from video cache.
- **Tweet context hash:** SHA-256 of `rootPost.text + authorPosts[].text`. Empty string for standalone `xray article` calls (no thread context). This ensures the same article cross-referenced against different threads gets cached separately.

### 9.3 TTL

- **Article bodies:** 7-day TTL. Articles are rarely edited after publication. `--no-cache` bypasses.
- **Article summaries:** 7-day TTL. Tied to the body TTL — when the body expires, the summary is also stale. `--no-cache` bypasses.

### 9.4 Cache Behavior

| Scenario | Behavior |
|---|---|
| Same article URL, within 7-day TTL | Return cached body from SQLite. Skip fetch. If summary also cached (same tweet context), skip Kyma calls too. |
| Same article URL, beyond 7-day TTL | Re-fetch body. Re-summarize. Overwrite cache. |
| Same article, different thread context | Body cache hit (skip fetch). Summary cache miss (different tweet_context_hash). Re-run cross-reference only. |
| `--no-cache` flag | Skip all cache reads. Re-fetch, re-summarize, overwrite. |
| Article deleted (404/410) | Fetch fails. Cached result (if any) is still served until TTL expires. |

---

## 10. Failure Modes & Partial Results

Every `ArticleSummary` carries `partial: boolean` and `errors: string[]`. The pipeline degrades gracefully:

| Failure | Result | `partial` | `errors[]` entry |
|---|---|---|---|
| Network timeout (10s undici) | Escalate to Playwright. If that also fails, no article to process. | true | `"Fetch timed out for {url}"` |
| HTTP 404/410 (article deleted) | Skip article. | true | `"Article not found (404): {url}"` |
| HTTP 403 / paywall detected | Extract whatever is publicly available. Often a title + first paragraph. | true | `"Paywall detected — extracted partial content ({wordCount} words)"` |
| Readability extraction fails | Try cheerio fallback, then Playwright. | false (if fallback works) | `"Readability failed, using cheerio fallback"` |
| Playwright not installed | Tier 1/2 still work for most articles. Only fails on SPAs. | true | `"Playwright not available for SPA rendering"` |
| JS-rendered article (SPA) | Tier 1/2 return < 100 words. Tier 3 (Playwright) handles it. | false | - |
| Kyma API key not set | Return body-only result. No summary, no cross-reference. | true | `"KYMA_API_KEY not set — returning raw article body only"` |
| Kyma rate limit | Retry 3x with backoff. If still fails, return body without summary. | true | `"Summarization failed after 3 retries"` |
| Cross-reference model hallucination | Low-confidence mappings (< 0.5) logged at debug. All mappings returned — consumer filters. | false | - |
| Article text too long (> 100k chars) | Truncate at 100k with warning. Summary covers truncated content. | true | `"Article truncated from {originalChars} to 100000 chars"` |
| Non-HTML content type | Skip. | - | Debug log: `"Skipping non-HTML content: {contentType}"` |

---

## 11. Test Plan

### 11.1 New Test Files

| File | What it covers | Est. test count |
|------|---------------|----------------|
| `tests/unit/article-detect.test.ts` | URL classification: x-article vs external-html. Non-article URL filtering. Known platform detection (Substack, Medium, dev.to, GitHub). Edge cases: query params, fragments, redirected URLs. | ~10 |
| `tests/unit/article-fetch.test.ts` | 3-tier fetch: mock undici responses, Readability extraction, cheerio fallback, Playwright escalation trigger. Paywall detection heuristic. Word count threshold. | ~8 |
| `tests/unit/article-summarize.test.ts` | Kyma prompt construction, response parsing, key point extraction, truncation logic, empty body handling. Mock Kyma chat. | ~6 |
| `tests/unit/article-cross-reference.test.ts` | Cross-reference prompt construction, relationship classification parsing, confidence score validation, standalone mode (no thread context). Mock Kyma chat. | ~6 |
| `tests/unit/article-cache.test.ts` | Cache key canonicalization, SQLite read/write, TTL expiry, tweet_context_hash isolation, `--no-cache` bypass. | ~6 |
| `tests/unit/article-markdown.test.ts` | Markdown rendering: standalone ArticleSummary, embedded in ResearchReport, cross-reference table, partial results with errors. | ~6 |
| `tests/unit/article-model.test.ts` | ArticleSummary Zod schema: valid/invalid inputs, optional fields, cost fields, cross-reference schema validation. | ~5 |

### 11.2 Existing Test Survival

All existing ~200+ tests (from P0/P1/P1.5/P2) remain untouched. Phase 3 is purely additive — no existing schemas or behavior change.

### 11.3 Fixtures

| Fixture | Description |
|---------|-------------|
| `tests/fixtures/article-substack.html` | Sample Substack newsletter HTML (~2k words). Clean semantic markup. |
| `tests/fixtures/article-medium.html` | Sample Medium post HTML with JS-rendered sections. Tests Readability extraction. |
| `tests/fixtures/article-devto.html` | Sample dev.to article HTML with code blocks. Clean semantic markup. |
| `tests/fixtures/article-x-article.html` | Sample X Article page HTML. Tests X-specific extraction. |
| `tests/fixtures/article-summary-response.json` | Sample Kyma summarize response for mocking. |
| `tests/fixtures/article-crossref-response.json` | Sample Kyma cross-reference response for mocking. |

### 11.4 Target Test Count After P3

- Existing after P2: ~200+
- New: ~47
- **Target: ~250 tests across ~32 files**

### 11.5 Integration Testing

Live integration tests (manual smoke test):
1. `xray article "https://substack.example.com/p/some-post"` — full pipeline, Substack
2. `xray article "https://medium.com/@user/some-article-abc123"` — Medium extraction
3. `xray article "https://dev.to/user/some-post-abc"` — dev.to extraction
4. `xray thread "https://x.com/user/status/123" --articles` — embedded in thread report with cross-reference
5. `xray article "<url>" --raw --json` — body-only, no summarization
6. `xray article "<url>" --json | jq '.estimatedCostUsd'` — cost surfacing
7. `xray article "<paywalled-url>"` — partial result with paywall warning

---

## 12. Sub-Phase Delivery

### P3.0 — X Article + Simple Summary + Standalone Command (~8-10h)

**Scope:** X Article extraction, standalone `xray article` command, simple Kyma summarization (no cross-reference yet), caching skeleton for article bodies.

**Files:**
- NEW: `src/models/article.ts` (ArticleSource, ArticleBody, ArticleSummary schemas)
- NEW: `src/article/detect.ts` (URL classification)
- NEW: `src/article/parse-x-article.ts` (X Article extraction)
- NEW: `src/article/fetch.ts` (Tier 1 only: undici + cheerio + Readability)
- NEW: `src/article/summarize.ts` (Kyma summary + key points)
- NEW: `src/article/cache.ts` (article_bodies table, no article_summaries yet)
- NEW: `src/article/index.ts` (re-exports)
- NEW: `src/intelligence/article.ts` (orchestrator: detect -> fetch -> summarize)
- NEW: `src/cli/commands/article.ts` (standalone command)
- NEW: `src/render/article-markdown.ts` (standalone renderer)
- MOD: `src/fetcher/parser.ts` (add `parseCardBindings()` export)
- MOD: `src/cli/index.ts` (register `xray article`)
- MOD: `src/cache/db.ts` (add `article_bodies` migration)
- MOD: `package.json` (add `@mozilla/readability`, no version bump yet)
- NEW: `tests/unit/article-detect.test.ts`
- NEW: `tests/unit/article-model.test.ts`
- NEW: `tests/unit/article-summarize.test.ts`
- NEW: `tests/fixtures/article-x-article.html`
- NEW: `tests/fixtures/article-summary-response.json`

**Acceptance criteria:**
```bash
# Standalone article analysis (X Article or any blog)
xray article "https://some-blog.com/post" --json | jq '.source'
# Must output "external-html" (or "x-article" for X Articles)

# Summary and key points present
xray article "https://some-blog.com/post" --json | jq '.summary' | head -c 100
# Must output non-empty string

xray article "https://some-blog.com/post" --json | jq '.keyPoints | length'
# Must output 3-7

# Raw mode skips summarization
xray article "https://some-blog.com/post" --raw --json | jq '.summary'
# Must output null

# Cost surfaced
xray article "https://some-blog.com/post" --json | jq '.estimatedCostUsd'
# Must output a number > 0 (or 0 for --raw)

# All tests pass
bun test
```

### P3.1 — External Link Fetch Pipeline (~6-8h)

**Scope:** Full 3-tier fetch for external links (Substack, Medium, dev.to, general blogs). Cheerio fallback + Playwright SPA fallback. Paywall detection. URL canonicalization.

**Files:**
- MOD: `src/article/fetch.ts` (add Tier 2 cheerio fallback + Tier 3 Playwright SPA fallback)
- MOD: `src/article/detect.ts` (add domain heuristics for Substack, Medium, dev.to, GitHub)
- MOD: `src/article/cache.ts` (add URL canonicalization: strip tracking params, resolve t.co)
- NEW: `tests/unit/article-fetch.test.ts`
- NEW: `tests/fixtures/article-substack.html`
- NEW: `tests/fixtures/article-medium.html`
- NEW: `tests/fixtures/article-devto.html`

**Acceptance criteria:**
```bash
# Substack extraction
xray article "https://newsletter.example.com/p/some-post" --raw --json | jq '.body.wordCount'
# Must output > 100

# Medium extraction (may need Playwright)
xray article "https://medium.com/@user/article-abc123" --raw --json | jq '.body.contentSource'
# Must output "readability" or "playwright"

# Paywall detection
xray article "https://paywalled-site.com/premium-article" --json | jq '.partial'
# Must output true (with paywall warning in errors[])

# URL canonicalization (t.co -> expanded)
xray article "https://t.co/abc123" --json | jq '.canonicalUrl'
# Must output the expanded URL

# Cache works
XRAY_LOG_LEVEL=debug xray article "<url>" 2>&1 | grep "cache"
# First run: "article body cache miss"
# Second run: "article body cache hit"

bun test
```

### P3.2 — Full Cross-Reference Attribution (~5-7h)

**Scope:** Cross-reference pipeline: given tweet thesis + article body, produce claim-passage mappings. Wire into `xray thread --articles` flow. Article summary caching with tweet context hash.

**Files:**
- NEW: `src/article/cross-reference.ts`
- MOD: `src/article/cache.ts` (add `article_summaries` table with `tweet_context_hash`)
- MOD: `src/intelligence/article.ts` (add cross-reference stage, accept thread context)
- MOD: `src/intelligence/analyze-thread.ts` (add `articles?: boolean` to options, add `collectArticleCandidates()`, run article pipeline, attach `articleSummaries`)
- MOD: `src/models/report.ts` (add `articleSummaries` optional field)
- MOD: `src/render/article-markdown.ts` (add cross-reference table rendering)
- MOD: `src/render/markdown.ts` (render `articleSummaries` section in thread report)
- MOD: `src/cache/db.ts` (add `article_summaries` migration)
- NEW: `tests/unit/article-cross-reference.test.ts`
- NEW: `tests/unit/article-cache.test.ts`
- NEW: `tests/fixtures/article-crossref-response.json`

**Acceptance criteria:**
```bash
# Thread with articles flag produces cross-references
xray thread "https://x.com/user/status/123" --articles --json | \
  jq '.articleSummaries[0].crossReferences | length'
# Must output > 0

# Cross-references have required fields
xray thread "https://x.com/user/status/123" --articles --json | \
  jq '.articleSummaries[0].crossReferences[0] | keys'
# Must include: tweetClaim, articlePassage, relationship, confidence

# Relationship types are valid
xray thread "https://x.com/user/status/123" --articles --json | \
  jq '.articleSummaries[0].crossReferences[0].relationship'
# Must be one of: supports, extends, contradicts, unrelated

# Default thread behavior unchanged
xray thread "https://x.com/user/status/123" --json | jq '.articleSummaries'
# Must output null (no --articles flag)

# Cost breakdown includes cross-reference
xray thread "https://x.com/user/status/123" --articles --json | \
  jq '.articleSummaries[0].costBreakdown.crossReference'
# Must output a number > 0

bun test
```

### P3.3 — MCP Tool + --articles Wiring + Polish + Version Bump (~4-5h)

**Scope:** Wire `xray_article` MCP tool, add `articles` arg to `xray_thread` MCP tool, final markdown rendering polish, version bump to v0.4.0.

**Files:**
- NEW: `src/mcp/tools/article.ts` (or inline in `src/mcp/server.ts`)
- MOD: `src/mcp/server.ts` (register `xray_article` tool, add `articles` arg to `xray_thread`)
- MOD: `src/cli/commands/thread.ts` (add `--articles` flag, pass to research options)
- MOD: `src/render/article-markdown.ts` (polish: handle edge cases, empty cross-refs, long articles)
- MOD: `src/models/index.ts` (re-export article types)
- MOD: `package.json` (version -> 0.4.0)
- NEW: `tests/unit/article-markdown.test.ts`

**Acceptance criteria:**
```bash
# MCP tool registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | grep xray_article
# Must appear in tool list

# MCP xray_article works
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"xray_article","arguments":{"url":"https://some-blog.com/post"}},"id":1}' \
  | bun run src/mcp/index.ts
# Must return valid response

# MCP xray_thread with articles arg
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"xray_thread","arguments":{"url":"https://x.com/user/status/123","articles":true}},"id":1}' \
  | bun run src/mcp/index.ts
# Must return response with articleSummaries

# CLI --articles flag
xray thread "https://x.com/user/status/123" --articles | grep "## Article"
# Must show article section headers

# Standalone markdown rendering
xray article "https://some-blog.com/post" | head -3
# Must start with "# Article Analysis"

# Version bump
grep '"version"' package.json
# "0.4.0"

# Full test suite
bun test
# All ~250 tests pass
```

### Total Effort Estimate

| Sub-phase | Hours | Cumulative |
|-----------|-------|------------|
| P3.0 X Article + simple summary + standalone + caching skeleton | 8-10 | 8-10 |
| P3.1 External link fetch (3-tier) | 6-8 | 14-18 |
| P3.2 Full cross-reference attribution | 5-7 | 19-25 |
| P3.3 MCP tool + CLI wiring + polish + version bump | 4-5 | 23-30 |
| **Total** | **23-30 hours** |

---

## 13. Acceptance Criteria — Phase 3 Overall

All of the following must pass before Phase 3 is considered complete:

```bash
# 1. All tests pass (existing ~200 + new ~47)
bun test

# 2. Standalone article analysis works (external HTML)
xray article "https://some-substack.com/p/some-post" --json | jq '.source'
# Must output "external-html"

# 3. Standalone article analysis works (X Article)
xray article "https://x.com/user/articles/12345" --json | jq '.source'
# Must output "x-article"

# 4. Thread with articles flag embeds ArticleSummary[]
xray thread "https://x.com/user/status/123" --articles --json | jq '.articleSummaries | length'
# Must output >= 1 (if thread has links)

# 5. Default thread behavior unchanged (no --articles = no article processing)
xray thread "https://x.com/user/status/123" --json | jq '.articleSummaries'
# Must output null

# 6. Cross-references present when thread context available
xray thread "https://x.com/user/status/123" --articles --json | \
  jq '.articleSummaries[0].crossReferences | length'
# Must output >= 1

# 7. Cost surfaced in output
xray article "https://some-blog.com/post" --json | jq '.estimatedCostUsd'
# Must output a number > 0

# 8. Cache works
xray article "<url>" --json > /dev/null  # first run
xray article "<url>" --json > /dev/null  # second run (should be faster)

# 9. Raw mode skips summarization and cross-reference
xray article "<url>" --raw --json | jq '[.summary, .crossReferences] | map(length)'
# Must output [0, 0]

# 10. Markdown rendering
xray article "<url>" | head -3
# Must start with "# Article Analysis"

# 11. MCP tool registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | grep xray_article
# Must appear in tool list

# 12. Version bump
grep '"version"' package.json
# Must show "0.4.0"

# 13. Paywall graceful degradation
xray article "<paywalled-url>" --json | jq '.partial'
# Must output true

# 14. --video and --articles are independent (can combine)
xray thread "https://x.com/user/status/123" --video --articles --json | \
  jq '[.videoAnalysis != null, .articleSummaries != null]'
# Must output [true, true] (if thread has both)
```

---

## 14. Migration & Backward Compatibility

### 14.1 No Breaking Changes

Phase 3 is fully additive. No existing CLI flags, MCP args, or data model fields change. Specifically:

- `xray thread <url>` (no flags) behaves identically to v0.3.1.
- `ResearchReport` gains an optional `articleSummaries` field that is absent unless `--articles` is passed.
- `xray_thread` MCP tool gains an optional `articles: boolean` arg that defaults to `false`.
- All existing tests pass without modification.
- The `--video` and `--articles` flags are independent and composable.

### 14.2 New Dependency

`@mozilla/readability` is added as a production dependency. It is a well-maintained Mozilla library (~50KB) that extracts article content from HTML. No native binaries required. No external system dependencies (unlike yt-dlp/ffmpeg in P2).

### 14.3 CHANGELOG Entry Suggestion

```markdown
## [0.4.0] - 2026-XX-XX

### Added
- **Article analysis pipeline** — fetch, parse, summarize, and cross-reference
  linked articles in X threads.
- **`xray article <url>`** standalone command — analyze any article URL (X Article,
  Substack, Medium, dev.to, personal blog, any HTML page).
- **`--articles` flag** on `xray thread` — opt-in article analysis embedded in the
  thread research report.
- **`xray_article` MCP tool** — standalone article analysis for AI agents.
- **`articles` arg** on `xray_thread` MCP tool — opt-in article processing.
- **Cross-reference attribution** — claim-passage mappings showing where a linked
  article supports, extends, or contradicts the thread author's points.
- **3-tier article fetch** — undici + cheerio + Readability (Tier 1) → cheerio
  fallback (Tier 2) → Playwright SPA rendering (Tier 3).
- **Article caching** — body and summary cached in SQLite with 7-day TTL.
  Cross-reference results keyed by tweet context hash so the same article
  analyzed against different threads caches separately.
- **Paywall detection** — partial extraction with `partial: true` flag when
  paywall markers are detected.
- **Cost surfacing** — `estimatedCostUsd` and `costBreakdown` fields on every
  ArticleSummary. Debug-level per-stage cost logs. WARN on articles >10k words.

### Dependencies
- **@mozilla/readability** (new) — Mozilla's article content extractor.
```

---

## 15. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Cost without caps at full scope** — Son chose maximum scope (both content types + full cross-reference + no cost caps). A thread linking 5 long-form articles could burn $1.00-1.65 in a single `--articles` call. OSS users may not expect this. | Medium | Medium | Cost is surfaced in output and logs. Defensive cap of MAX_ARTICLES_PER_THREAD (5) mirrors the MAX_VIDEOS_PER_THREAD pattern. README documents cost table. |
| **Paywall prevalence** — Many high-quality articles (Stratechery, The Information, WSJ) are paywalled. P3 only extracts public content, which may be just a title + first paragraph. | High | Medium | Partial results are flagged with `partial: true`. Paywall bypass deferred to Phase 5. Error message explains limitation. |
| **SPA article rendering failures** — Some sites (particularly Medium custom domains, newer platforms) heavily rely on client-side rendering. Readability fails, cheerio fails, Playwright may timeout. | Medium | Low | 3-tier escalation handles most cases. Playwright fallback with 30s timeout catches SPAs. Worst case: partial result with whatever was extractable. |
| **Cross-reference hallucination** — The LLM may fabricate article passages or misclassify relationships, especially for nuanced arguments. | Medium | Medium | Confidence scores help downstream consumers filter. Prompt instructs model to quote exact passages. Low-confidence mappings (< 0.5) logged at debug. |
| **Article content freshness** — 7-day cache TTL means edits within 7 days are missed. Articles are rarely edited but some platforms (dev.to, personal blogs) support post-publish updates. | Low | Low | `--no-cache` bypass available. 7-day TTL is a reasonable balance. |
| **X Article format instability** — X's Article feature is relatively new and the HTML structure / GraphQL card shape may change. | Medium | Low | Fallback from card data to HTML to Playwright. Same resilience pattern as the SSR/Playwright escalation in P1.5. |
| **Readability extraction quality** — Some sites produce poor results with Readability (nav/footer leaking, article content truncated). | Medium | Low | Cheerio fallback (Tier 2) catches cases where Readability's heuristics fail. Word count threshold (> 100 words) triggers escalation. |

### Open Questions

1. **MAX_ARTICLES_PER_THREAD cap?** Recommend cap at 5 articles per thread (mirroring MAX_VIDEOS_PER_THREAD = 3 but higher since articles are cheaper than video). Prevents runaway cost on link-heavy threads. Surface a warning when capped.

2. **Should cross-reference run in standalone `xray article` mode?** Current spec: cross-reference only runs when thread context is available. In standalone mode, only summary + key points are returned. An alternative: allow the caller to provide custom context text for cross-referencing. Recommend: defer custom context to Phase 5.

3. **t.co link resolution strategy?** X shortlinks (`t.co/xxx`) need to be resolved to the actual URL before classification. Options: (a) HEAD request to follow redirects, (b) check the `expandedUrl` field from the parser's `links[]` array (already populated by `parseLinks()`). Recommend: use `expandedUrl` from parser first, fall back to HEAD request for standalone mode.

4. **Should articles in quote tweets be included?** Current spec: only root post + author follow-up links. Quote tweets may link to relevant articles. Recommend: include links from `quoteTweets[]` but count them toward the MAX_ARTICLES_PER_THREAD cap.

---

## 16. Out of Scope (Explicit Deferrals)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Paywall bypass (auth, cookies, paid APIs) | Phase 5 | Each paywall platform needs separate auth integration. P3 extracts whatever is public. |
| PDF document parsing | Phase 5 | Different extraction pipeline (pdf-parse). Not HTML. |
| Academic paper parsing (arXiv, SSRN) | Phase 5 | Specialized metadata, citation graph, LaTeX math. |
| RSS/feed batch analysis | Phase 6+ | Analyzing an author's entire feed is a separate product surface. |
| Fact-checking / truth verification | Phase 5+ | Cross-reference is attribution (supports/contradicts), not truth-checking against ground truth. |
| Custom context for standalone cross-reference | Phase 5 | Let standalone callers provide their own thesis text. Useful but adds API complexity. |
| Article comparison (article vs article) | Phase 5+ | Cross-referencing two articles against each other. Higher-level orchestration. |
| Embedded media extraction from articles | Phase 5+ | Images, videos, and charts within articles. Separate extraction pipeline. |
| Multi-language article support | Phase 5+ | Current pipeline works with any language (Kyma handles it) but prompts are English-optimized. |

---

**End of PHASE_3_PLAN.md**
