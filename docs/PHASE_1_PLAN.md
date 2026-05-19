# Phase 1 — Deep Conversation

**Status:** Specced
**Date:** 2026-05-18
**Owner:** sonpiaz
**Version target:** v0.2.0
**Depends on:** Phase 0 (Foundation) — all Phase 0 deliverables must be stable before P1 work begins.

---

## 1. Goals

1. Walk the full reply tree (top 50 top-level replies, up to 3 levels deep) via cursor-based pagination inside the existing Playwright context.
2. Classify every fetched comment with `stance` and `quality` labels plus a numeric `qualityScore` (0.0–1.0), persisted per-comment in the existing `kyma_responses` cache table.
3. Provide a **deep mode** (`--deep` / `deep: true`) that sends per-subtree Kyma calls for richer analysis, versus the default shallow heuristic-filtered single-call approach.
4. Emit partial results with coverage metadata when pagination or Kyma calls fail partway through.
5. Maintain 100% backward compatibility — existing `xray thread <url>` and `xray_thread(url)` MCP calls produce the same output shape as Phase 0 (new fields are additive/optional).

## 2. Non-Goals (deferred)

| Item | Deferred to |
|------|-------------|
| Video understanding (embedded X video) | Phase 2 |
| External link analysis (articles, YouTube) | Phase 3 |
| Semantic search over reply corpus | Phase 4 |
| Profile-level analysis (user stance over time) | Phase 4 |
| Local model fallback for classification | Phase 5 |
| Conversation-thread-from-reply (walking *up* from a reply to find the root) | Phase 2+ |
| Real-time / streaming updates to reply trees | Not planned |
| Export to Obsidian / other formats | Phase 5 |

---

## 3. User-Facing Changes

### 3.1 CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--depth <N>` | integer | `3` | Maximum reply nesting depth to walk |
| `--max-replies <N>` | integer | `50` | Maximum top-level replies to fetch |
| `--deep` | boolean | `false` | Enable deep mode: per-subtree Kyma calls + synthesis |

```
xray thread <url> --depth 2 --max-replies 30
xray thread <url> --deep
xray thread <url> --deep --depth 5 --max-replies 100 --json
```

### 3.2 MCP Args (xray_thread tool)

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `depth` | `z.number().int().min(1).max(10).optional()` | `3` | Max reply depth |
| `maxReplies` | `z.number().int().min(1).max(200).optional()` | `50` | Max top-level replies |
| `deep` | `z.boolean().optional()` | `false` | Deep analysis mode |

Phase 0 calls like `xray_thread({ url: "..." })` use all defaults — zero breaking change.

### 3.3 New Output Sections in Markdown Report

When classification data is present:

```markdown
## Conversation Analysis
**Coverage:** 47/52 replies fetched · depth 3/3 achieved · 2 pagination cursors exhausted
**Stance distribution:** 18 agree · 12 disagree · 8 neutral · 5 question · 3 humor · 1 meta

### Top Quality Replies
- **@alice** (quality: expert, score: 0.92, stance: disagree) — "Actually the benchmarks show..."
- **@bob** (quality: substantive, score: 0.85, stance: agree) — "This matches what we saw..."

### Dissenting Views
- **@carol** (quality: substantive, score: 0.78, stance: disagree) — "The methodology here is..."
```

When `--deep` is used, an additional section:

```markdown
## Deep Analysis — Subtree Summaries
### Subtree: @alice's thread (12 replies)
Summary: ...
Key tension: ...

### Subtree: @dave's thread (8 replies)
Summary: ...
Key tension: ...
```

---

## 4. Data Model Deltas

### 4.1 XComment additions

File: `src/models/comment.ts`

```typescript
// New classification schema (additive — XComment gains an optional field)
export const StanceEnum = z.enum([
  'agree', 'disagree', 'neutral', 'question', 'humor', 'meta'
]);
export type Stance = z.infer<typeof StanceEnum>;

export const QualityEnum = z.enum([
  'substantive', 'anecdotal', 'noise', 'expert', 'correction'
]);
export type Quality = z.infer<typeof QualityEnum>;

export const CommentClassificationSchema = z.object({
  stance: StanceEnum,
  quality: QualityEnum,
  qualityScore: z.number().min(0).max(1),
});
export type CommentClassification = z.infer<typeof CommentClassificationSchema>;

// XComment gains:
//   classification: CommentClassificationSchema.optional()
// Added to XCommentBase.extend({...})
```

### 4.2 ResearchReport additions

File: `src/models/report.ts`

```typescript
export const ThreadCoverageSchema = z.object({
  targetDepth: z.number().int(),
  achievedDepth: z.number().int(),
  targetReplies: z.number().int(),
  fetchedReplies: z.number().int(),
  classifiedReplies: z.number().int().default(0),
  paginationCursors: z.array(z.string()).default([]),
  status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  failureReason: z.string().optional(),
});
export type ThreadCoverage = z.infer<typeof ThreadCoverageSchema>;

export const StanceDistributionSchema = z.object({
  agree: z.number().int().default(0),
  disagree: z.number().int().default(0),
  neutral: z.number().int().default(0),
  question: z.number().int().default(0),
  humor: z.number().int().default(0),
  meta: z.number().int().default(0),
});
export type StanceDistribution = z.infer<typeof StanceDistributionSchema>;

export const SubtreeSummarySchema = z.object({
  rootCommentId: z.string(),
  rootAuthorHandle: z.string(),
  replyCount: z.number().int(),
  summary: z.string(),
  keyTension: z.string().optional(),
});
export type SubtreeSummary = z.infer<typeof SubtreeSummarySchema>;

// ResearchReport gains (all optional, backward-compatible):
//   coverage: ThreadCoverageSchema.optional()
//   stanceDistribution: StanceDistributionSchema.optional()
//   subtreeSummaries: z.array(SubtreeSummarySchema).optional()
//   schemaVersion bumps to z.literal(2) with z.union([z.literal(1), z.literal(2)])
```

### 4.3 ResearchOptions additions

File: `src/intelligence/analyze-thread.ts`

```typescript
export type ResearchOptions = {
  mode?: FetchMode;
  noCache?: boolean;
  skipAnalysis?: boolean;
  // Phase 1 additions:
  depth?: number;       // default 3
  maxReplies?: number;  // default 50
  deep?: boolean;       // default false
};
```

---

## 5. Architecture Changes

### 5.1 New Files

| File | Purpose |
|------|---------|
| `src/fetcher/pagination.ts` | Cursor extraction, pagination loop, depth tracking, dedup |
| `src/intelligence/classify.ts` | Batch classification prompt, Kyma calls, parse results into `CommentClassification` |
| `src/intelligence/deep.ts` | Deep mode: subtree batching, per-subtree Kyma call, synthesis call |

### 5.2 Modified Files

| File | Changes |
|------|---------|
| `src/models/comment.ts` | Add `StanceEnum`, `QualityEnum`, `CommentClassificationSchema`, optional `classification` field on `XCommentBase` |
| `src/models/report.ts` | Add `ThreadCoverageSchema`, `StanceDistributionSchema`, `SubtreeSummarySchema`, add optional fields to `ResearchReportSchema`, bump `schemaVersion` |
| `src/fetcher/thread.ts` | Accept `depth`/`maxReplies` in `FetchOptions`, call pagination module, return richer `XThread` |
| `src/fetcher/parser.ts` | Extract cursor tokens from GraphQL response, expose `extractCursors()` function |
| `src/intelligence/analyze-thread.ts` | Accept new `ResearchOptions` fields, call classify/deep modules, populate coverage/stanceDistribution |
| `src/kyma/prompts.ts` | Add classification system prompt, deep-mode subtree prompt, deep-mode synthesis prompt |
| `src/kyma/analyze.ts` | (Unchanged directly — new modules call `chat()` from `client.ts`) |
| `src/render/markdown.ts` | Add "Conversation Analysis", "Top Quality Replies", "Dissenting Views", "Deep Analysis" sections |
| `src/mcp/server.ts` | Add `depth`, `maxReplies`, `deep` to `ThreadInput` schema |
| `src/cli/index.ts` | Register `--depth`, `--max-replies`, `--deep` flags |
| `src/cli/commands/thread.ts` | Pass new options through to `research()` |

---

## 6. Pagination & Tree-Walk Algorithm

File: `src/fetcher/pagination.ts`

### 6.1 Cursor Extraction

X's TweetDetail GraphQL response includes cursor entries of type `TimelineTimelineCursor` with `cursorType: "Bottom"` and `cursorType: "ShowMore"` (for nested replies).

```
extractCursors(payload: unknown): { bottom?: string; showMore: string[] }
  - Walk instructions → entries
  - Find entry where content.cursorType === "Bottom" → bottom cursor
  - Find entries where content.cursorType === "ShowMore" within conversation modules → showMore cursors
  - Return both
```

Added to `src/fetcher/parser.ts` as an exported function.

### 6.2 Fetch Loop — Pseudocode

```
async function walkReplyTree(page, rootId, options):
  maxTopLevel = options.maxReplies ?? 50
  maxDepth = options.maxReplies ?? 3
  aggregate = { rootPost, authorPosts, comments, quoteTweets }
  seenIds = Set<string>
  cursors = { bottom: null, showMoreByDepth: Map<number, string[]> }

  // Phase A: Paginate top-level replies
  // The initial page load already captured some via navigateAndCapture.
  // Extract the bottom cursor from the initial response.
  while aggregate.comments.length < maxTopLevel AND cursors.bottom:
    response = await page.evaluate(async (cursor, url) => {
      // Replay the TweetDetail GraphQL call with the cursor
      const graphqlUrl = buildTweetDetailUrl(rootId, cursor)
      const res = await fetch(graphqlUrl, { headers: extractHeaders() })
      return res.json()
    }, cursors.bottom, graphqlUrl)

    parsed = parseTweetDetail(response, rootId)
    mergeInto(aggregate, parsed, seenIds)
    cursors = extractCursors(response)

    if !cursors.bottom: break  // no more pages

  // Phase B: Walk nested replies (depth 1 → maxDepth)
  for depth in 1..maxDepth:
    // Collect "ShowMore" / "ShowReplies" cursors for comments at current depth
    showMoreCursors = collectShowMoreCursors(aggregate, depth)

    for cursor in showMoreCursors:
      response = await page.evaluate(fetch with cursor)
      parsed = parseTweetDetail(response, rootId)
      // Attach parsed replies as children of the appropriate parent comment
      attachReplies(aggregate, parsed, depth + 1)
      seenIds.addAll(parsed)

  // Dedup pass
  deduplicateTree(aggregate.comments)

  return aggregate
```

### 6.3 Stop Criteria

1. `aggregate.comments.length >= maxTopLevel` — enough top-level replies
2. `cursors.bottom` is null — X returned no more pages
3. `depth >= maxDepth` — reached configured nesting limit
4. 3 consecutive fetches return 0 new comments — assume end of replies
5. Global timeout: 60s total pagination time (configurable)

### 6.4 GraphQL URL Construction

The TweetDetail endpoint URL pattern is already captured by the response interceptor in `thread.ts`. The pagination module will:

1. Capture the full GraphQL URL template (including `queryId`) from the initial TweetDetail request.
2. Replace the `cursor` parameter in the variables JSON.
3. Use `page.evaluate(() => fetch(...))` to replay the request within the browser's authenticated context (reuses cookies, headers, CSRF token).

### 6.5 Deduplication

Comments are deduped by `id` across all pagination pages. A `Set<string>` of seen IDs is maintained across the entire walk. When a comment appears at multiple depths (X sometimes returns a reply both as top-level and nested), prefer the nested position (higher depth).

---

## 7. Classification & Scoring

### 7.1 Taxonomy Definitions

**Stance** — the commenter's relation to the root post's claim:

| Value | Definition | Example |
|-------|-----------|---------|
| `agree` | Supports or amplifies the OP's claim | "Yes! This is exactly right." |
| `disagree` | Challenges or contradicts the OP | "This is misleading because..." |
| `neutral` | Neither agrees nor disagrees; adds context | "For context, this happened in 2019." |
| `question` | Asks for clarification or more info | "What dataset was this tested on?" |
| `humor` | Joke, meme, or sarcastic response | "Least unhinged AI take" |
| `meta` | Commentary about the discussion itself | "This ratio tells you everything" |

**Quality** — the informational value of the reply:

| Value | Definition | Example |
|-------|-----------|---------|
| `expert` | Domain expertise with evidence/credentials | "As a compiler engineer, the issue is..." |
| `substantive` | Meaningful argument with reasoning | "The flaw in this approach is X because Y." |
| `correction` | Factual correction with evidence | "Actually the paper says the opposite. Link: ..." |
| `anecdotal` | Personal experience, no broader evidence | "I tried this and it worked for me." |
| `noise` | Low-signal: emoji-only, "this", "+1", ads | "W", "L", "Ratio" |

**Quality Score** (0.0–1.0) rubric:

| Range | Meaning |
|-------|---------|
| 0.9–1.0 | Expert-level with evidence; changes the reader's understanding |
| 0.7–0.89 | Substantive; adds meaningful perspective or correction |
| 0.4–0.69 | Anecdotal or surface-level but not noise |
| 0.1–0.39 | Low-effort agreement/disagreement, no reasoning |
| 0.0–0.09 | Pure noise, spam, emoji-only, off-topic |

### 7.2 Prompt Design — Classification (Shallow Mode)

System prompt (added to `src/kyma/prompts.ts`):

```
CLASSIFICATION_SYSTEM_PROMPT = `You classify X (Twitter) replies.
For each reply, output: stance (agree|disagree|neutral|question|humor|meta),
quality (substantive|anecdotal|noise|expert|correction),
and qualityScore (float 0.0-1.0).

Rules:
- Stance is relative to the ROOT POST's main claim. A reply that disagrees with another
  reply but agrees with OP = "agree".
- qualityScore measures information value, not agreement with OP.
- Humor that makes a substantive point = quality "substantive" + stance "humor".
- Corrections with evidence > corrections without evidence (0.8+ vs 0.5).
- One-word replies, emoji-only, "ratio", "+1" = noise + qualityScore 0.0-0.05.
- Output VALID JSON ONLY — no markdown fences, no preamble.`
```

User prompt template:

```
ROOT POST by @{handle}:
"{rootText}"

Classify each reply below. Output a JSON array:
[
  { "id": "<reply id>", "stance": "...", "quality": "...", "qualityScore": 0.XX },
  ...
]

REPLIES:
{for each comment in batch:}
- id={id} @{handle} (likes={likes}): "{text}"
{end for}
```

### 7.3 Batch Strategy (Shallow Mode — Default)

1. **Pre-filter**: Sort all fetched comments by engagement heuristic: `score = likes * 2 + reply_count + (isVerified ? 10 : 0)`. Take top ~40 comments.
2. **Single Kyma call**: Send all ~40 comments in one classification prompt.
3. **Single analysis call**: The existing `analyzeThread()` call receives the now-classified comments and produces the standard `ResearchReport` fields (tldr, summary, keyInsights, etc.).
4. Total Kyma calls in shallow mode: **2** (1 classify + 1 analyze).

### 7.4 Deep Mode

1. **No pre-filter**: All fetched comments are included.
2. **Group by subtree**: Each top-level reply and its descendants form a subtree.
3. **Per-subtree Kyma call**: For each subtree (cap at 10 subtrees, sorted by engagement), send a combined classify + summarize prompt.
4. **Synthesis call**: One final Kyma call takes the 10 subtree summaries and produces the thread-level analysis.
5. Total Kyma calls in deep mode: **up to 11** (10 subtree + 1 synthesis).

Deep mode subtree prompt (added to `src/kyma/prompts.ts`):

```
DEEP_SUBTREE_PROMPT = `Analyze this conversation subtree from an X thread.

ROOT POST by @{rootHandle}:
"{rootText}"

SUBTREE ROOT by @{subtreeHandle} (reply to OP):
"{subtreeRootText}"

REPLIES IN THIS SUBTREE:
{replies with depth indentation}

Output JSON:
{
  "classifications": [
    { "id": "...", "stance": "...", "quality": "...", "qualityScore": 0.XX }
  ],
  "subtreeSummary": "2-3 sentence summary of the conversation in this subtree",
  "keyTension": "what is the main disagreement or open question, if any"
}`
```

Deep mode synthesis prompt:

```
DEEP_SYNTHESIS_PROMPT = `You have analyzed {N} conversation subtrees from an X thread.

ROOT POST by @{rootHandle}:
"{rootText}"

SUBTREE SUMMARIES:
{for each subtree:}
- @{handle} ({replyCount} replies): {summary} | Tension: {tension}
{end for}

Produce a thread-level analysis JSON:
{
  "topic": "...",
  "tldr": "...",
  "summary": "...",
  "keyInsights": [...],
  "notableReplies": [...],
  "openQuestions": [...]
}

Same schema as before. This analysis should reflect the DEEP conversation structure.`
```

---

## 8. LLM Cost Budget

All estimates assume `gemini-2.5-flash` via Kyma ($0.15/1M input, $0.60/1M output) as configured in `src/core/config.ts`.

### 8.1 Shallow Mode (default)

| Call | Input tokens (est.) | Output tokens (est.) | Cost |
|------|--------------------:|---------------------:|-----:|
| Classification (40 comments, ~100 tokens each) | ~5,000 | ~1,500 | ~$0.002 |
| Thread analysis (existing) | ~4,000 | ~1,000 | ~$0.001 |
| **Total** | **~9,000** | **~2,500** | **~$0.003** |

### 8.2 Deep Mode

| Call | Input tokens (est.) | Output tokens (est.) | Cost |
|------|--------------------:|---------------------:|-----:|
| 10 subtree calls (avg ~3,000 in each) | ~30,000 | ~5,000 | ~$0.008 |
| Synthesis call | ~5,000 | ~1,500 | ~$0.002 |
| **Total** | **~35,000** | **~6,500** | **~$0.010** |

### 8.3 Safeguards

- **Hard cap**: Maximum 15 Kyma calls per `research()` invocation. If exceeded, stop and return partial results.
- **Per-call token limit**: `maxTokens: 2000` for classification calls, `maxTokens: 3000` for analysis/synthesis.
- **Timeout**: 120s total for all Kyma calls in one research invocation. Controlled by abort signal.
- **Batch size cap**: Never send more than 60 comments in a single classification prompt (split if needed).

---

## 9. Caching Strategy

### 9.1 Cache Key Formats

All classification results reuse the existing `kyma_responses` table. No migration needed.

| Data | Cache key format | Example |
|------|-----------------|---------|
| Per-comment classification | `comment-classify:{commentId}:{analysisVersion}` | `comment-classify:18374629...:1` |
| Thread-level analysis | `analyze:{rootPostId}` | `analyze:18374629...` (existing) |
| Deep subtree summary | `deep-subtree:{rootCommentId}:{analysisVersion}` | `deep-subtree:29481...:1` |
| Deep synthesis | `deep-synthesis:{rootPostId}:{analysisVersion}` | `deep-synthesis:18374629...:1` |

`analysisVersion` is a constant (`1` for P1 launch) bumped when prompt text changes. This ensures prompt changes auto-invalidate cache without manual purging. The version constant lives in `src/intelligence/classify.ts`.

### 9.2 TTL Table

| Cache type | TTL | Rationale |
|-----------|-----|-----------|
| Thread fetch (existing) | 24h | Existing behavior |
| Full-tree fetch (from pagination) | 24h | Same as existing |
| Classification (per-comment) | 24h | Prompt is deterministic |
| Thread analysis | 24h | Existing behavior |
| Deep subtree summary | 24h | Deterministic for same tree |
| Deep synthesis | 24h | Deterministic |
| **Partial results** | **1h** | Should be re-fetched sooner |

### 9.3 Invalidation Rules

1. `--no-cache` flag bypasses **all** caches (fetch + Kyma) — existing behavior, unchanged.
2. `analysisVersion` bump in code invalidates all classification/deep caches because the key changes.
3. `prompt_hash` column in `kyma_responses` provides a secondary invalidation signal — the existing `chat()` client already computes this. If the model changes, the hash changes, and the old cache key won't match.
4. Partial results are cached with a TTL of 1h by storing `created_at` and checking freshness with a custom TTL parameter in `isFresh()`.

---

## 10. Failure Modes & Partial-Result Handling

### 10.1 State Machine

```
             ┌─────┐
             │  ok  │ ── all targets met
             └─────┘
                ▲
   ┌────────────┼────────────┐
   │            │            │
┌──────┐  ┌─────────┐  ┌────────┐
│failed│  │ partial  │  │  ok    │
└──────┘  └─────────┘  └────────┘
   │            │
   │    pagination stopped early,
   │    or Kyma calls failed partway
   │
   └── fetch completely failed
       (no root post, auth wall)
```

Coverage status is determined by:
- `ok`: `fetchedReplies >= targetReplies * 0.9` AND `achievedDepth >= targetDepth`
- `partial`: some data returned but targets not met
- `failed`: no reply data at all (but root post may exist)

### 10.2 ThreadCoverage Schema

```typescript
export const ThreadCoverageSchema = z.object({
  targetDepth: z.number().int(),          // what was requested
  achievedDepth: z.number().int(),        // what was actually reached
  targetReplies: z.number().int(),        // maxReplies param
  fetchedReplies: z.number().int(),       // how many we actually got
  classifiedReplies: z.number().int().default(0),  // how many got classification
  paginationCursors: z.array(z.string()).default([]),  // saved for potential resume
  status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  failureReason: z.string().optional(),   // human-readable
});
```

### 10.3 User-Visible Warnings

Partial results append to `report.warnings[]`:

```
"Partial: fetched 32/50 target replies (pagination stopped at depth 2/3)"
"Partial: classified 28/32 replies (2 Kyma classification calls failed)"
"Deep mode: analyzed 7/10 subtrees (3 skipped due to Kyma timeout)"
```

### 10.4 Caching Partial Results

- Partial thread fetches are cached with the thread (existing `partial: true` field).
- Partial classification results are cached per-comment (each successful classification is individually cached even if the batch partially failed).
- Partial deep-mode results: each subtree summary is cached individually; the synthesis call is only cached if all subtrees completed.
- All partial caches use 1h TTL (vs 24h for complete results).

---

## 11. Test Plan

### 11.1 New Unit Tests

| Test file | What it covers |
|-----------|---------------|
| `tests/unit/pagination.test.ts` | `extractCursors()`, cursor parsing from fixture, dedup logic |
| `tests/unit/classify.test.ts` | Classification prompt rendering, response parsing, batch splitting, `analysisVersion` key generation |
| `tests/unit/deep.test.ts` | Subtree grouping, deep prompt rendering, synthesis response parsing |
| `tests/unit/coverage.test.ts` | `ThreadCoverage` status calculation (`ok`/`partial`/`failed`), warning message generation |
| `tests/unit/markdown-p1.test.ts` | New markdown sections render correctly (Conversation Analysis, Deep Analysis) |

### 11.2 New Fixtures

| Fixture | Description |
|---------|-------------|
| `tests/fixtures/tweet-detail-page2.min.json` | Second page of TweetDetail with bottom cursor, used for pagination tests |
| `tests/fixtures/tweet-detail-nested.min.json` | TweetDetail response with ShowMore cursors and nested reply modules |
| `tests/fixtures/classify-response.json` | Example Kyma classification response (array of `{id, stance, quality, qualityScore}`) |
| `tests/fixtures/deep-subtree-response.json` | Example Kyma deep-mode subtree response |
| `tests/fixtures/deep-synthesis-response.json` | Example Kyma deep-mode synthesis response |

### 11.3 Existing Tests (must still pass)

- `tests/unit/parser.test.ts` — no changes to existing parsing behavior
- `tests/unit/models.test.ts` — schema additions are backward-compatible
- `tests/unit/markdown.test.ts` — existing sections unchanged
- `tests/unit/url.test.ts` — unchanged

### 11.4 Integration Tests

No automated live integration tests (would require X credentials and cost Kyma tokens). Manual integration test protocol:

```bash
# Phase 0 regression — must still work identically
xray thread https://x.com/elonmusk/status/XXXX --raw --json | jq '.thread.comments | length'

# Phase 1 — pagination
xray thread https://x.com/elonmusk/status/XXXX --depth 2 --max-replies 20 --raw --json \
  | jq '.coverage'

# Phase 1 — classification
xray thread https://x.com/elonmusk/status/XXXX --depth 2 --max-replies 20 --json \
  | jq '.thread.comments[0].classification'

# Phase 1 — deep mode
xray thread https://x.com/elonmusk/status/XXXX --deep --json \
  | jq '.subtreeSummaries'
```

---

## 12. Sub-Phase Delivery

### P1.0 — Walking Skeleton (Pagination + Nested Tree)

**Scope:** Cursor-based pagination in Playwright context; nested reply tree population up to configurable depth; coverage metadata; no classification yet.

**Files touched:**
- NEW: `src/fetcher/pagination.ts`
- MOD: `src/fetcher/parser.ts` (add `extractCursors()`)
- MOD: `src/fetcher/thread.ts` (accept `depth`/`maxReplies`, call pagination)
- MOD: `src/models/report.ts` (add `ThreadCoverageSchema`, optional `coverage` field)
- MOD: `src/cli/index.ts` (register `--depth`, `--max-replies`)
- MOD: `src/cli/commands/thread.ts` (pass options)
- MOD: `src/mcp/server.ts` (add `depth`, `maxReplies` args)
- MOD: `src/intelligence/analyze-thread.ts` (accept + pass new options, populate coverage)
- NEW: `tests/unit/pagination.test.ts`
- NEW: `tests/fixtures/tweet-detail-page2.min.json`
- NEW: `tests/fixtures/tweet-detail-nested.min.json`

**Acceptance criteria:**
```bash
# Returns >20 comments for a popular thread (vs ~5-10 in Phase 0)
xray thread https://x.com/elonmusk/status/XXXX --max-replies 30 --raw --json \
  | jq '.thread.comments | length'
# Should output >= 20

# Coverage metadata present
xray thread https://x.com/elonmusk/status/XXXX --depth 2 --raw --json \
  | jq '.coverage.status'
# Should output "ok" or "partial"

# Phase 0 regression: no args = same behavior
xray thread https://x.com/karpathy/status/XXXX --raw --json | jq '.thread.rootPost.id'
# Should work unchanged

# All existing unit tests pass
bun test
```

**Effort:** ~8-12 hours

---

### P1.1 — Classification (Stance + Quality Labels)

**Scope:** Classify fetched comments via Kyma. Default shallow mode (heuristic filter + single batch call). Persist per-comment. Surface in report.

**Files touched:**
- NEW: `src/intelligence/classify.ts`
- MOD: `src/models/comment.ts` (add classification schema + optional field)
- MOD: `src/kyma/prompts.ts` (add `CLASSIFICATION_SYSTEM_PROMPT`, classification user prompt template)
- MOD: `src/intelligence/analyze-thread.ts` (call `classifyComments()` before `analyzeThread()`)
- MOD: `src/models/report.ts` (add `stanceDistribution` optional field)
- MOD: `src/render/markdown.ts` (add "Conversation Analysis" section)
- NEW: `tests/unit/classify.test.ts`
- NEW: `tests/fixtures/classify-response.json`
- NEW: `tests/unit/coverage.test.ts`

**Acceptance criteria:**
```bash
# Comments have classification
xray thread https://x.com/karpathy/status/XXXX --json \
  | jq '.thread.comments[0].classification'
# Should output { "stance": "...", "quality": "...", "qualityScore": 0.XX }

# Stance distribution in report
xray thread https://x.com/karpathy/status/XXXX --json | jq '.stanceDistribution'

# Markdown output includes "Conversation Analysis"
xray thread https://x.com/karpathy/status/XXXX | grep "Conversation Analysis"

# Cache works — second run is faster (cache hit)
time xray thread https://x.com/karpathy/status/XXXX > /dev/null  # first: ~10s
time xray thread https://x.com/karpathy/status/XXXX > /dev/null  # second: <1s

bun test
```

**Effort:** ~6-8 hours

---

### P1.2 — Quality Score + Pre-filter

**Scope:** Numeric `qualityScore` is already part of P1.1 classification response. This sub-phase adds the heuristic engagement pre-filter for shallow mode and the "Top Quality Replies" / "Dissenting Views" sections in Markdown output.

**Files touched:**
- MOD: `src/intelligence/classify.ts` (add engagement sort + top-40 filter)
- MOD: `src/render/markdown.ts` (add "Top Quality Replies", "Dissenting Views" sections)
- NEW: `tests/unit/markdown-p1.test.ts`

**Acceptance criteria:**
```bash
# Top Quality Replies section in markdown
xray thread https://x.com/karpathy/status/XXXX | grep "Top Quality Replies"

# Dissenting Views section present when disagreements exist
xray thread https://x.com/karpathy/status/XXXX | grep "Dissenting Views"

# Classification call uses <=40 comments even for threads with 100+ replies
# (verified via XRAY_LOG_LEVEL=debug — logged batch size)

bun test
```

**Effort:** ~3-4 hours

---

### P1.3 — Deep Mode

**Scope:** `--deep` flag triggers per-subtree Kyma calls + synthesis call. Subtree summaries in report. Full deep markdown output.

**Files touched:**
- NEW: `src/intelligence/deep.ts`
- MOD: `src/kyma/prompts.ts` (add `DEEP_SUBTREE_PROMPT`, `DEEP_SYNTHESIS_PROMPT`)
- MOD: `src/intelligence/analyze-thread.ts` (branch on `deep` flag)
- MOD: `src/models/report.ts` (add `subtreeSummaries` field)
- MOD: `src/render/markdown.ts` (add "Deep Analysis — Subtree Summaries" section)
- MOD: `src/cli/index.ts` (register `--deep` flag)
- MOD: `src/cli/commands/thread.ts` (pass `deep` option)
- MOD: `src/mcp/server.ts` (add `deep` arg)
- NEW: `tests/unit/deep.test.ts`
- NEW: `tests/fixtures/deep-subtree-response.json`
- NEW: `tests/fixtures/deep-synthesis-response.json`

**Acceptance criteria:**
```bash
# Deep mode produces subtree summaries
xray thread https://x.com/karpathy/status/XXXX --deep --json \
  | jq '.subtreeSummaries | length'
# Should output > 0

# Deep mode markdown includes subtree section
xray thread https://x.com/karpathy/status/XXXX --deep | grep "Subtree Summaries"

# Deep mode uses more Kyma calls (visible in debug log)
XRAY_LOG_LEVEL=debug xray thread https://x.com/karpathy/status/XXXX --deep 2>&1 \
  | grep "kyma request" | wc -l
# Should output 3-12

# MCP deep mode
# Verify via MCP test client that deep: true works

bun test
```

**Effort:** ~6-8 hours

---

## 13. Acceptance Criteria — Phase 1 Overall

All of the following must pass before Phase 1 is considered complete:

```bash
# 1. All unit tests pass
bun test

# 2. Phase 0 regression: basic thread research unchanged
xray thread https://x.com/karpathy/status/XXXX | head -5
# Must show "Thread Research" header, TL;DR, no errors

# 3. Pagination works: popular threads return significantly more replies
xray thread https://x.com/elonmusk/status/XXXX --max-replies 50 --raw --json \
  | jq '.thread.comments | length'
# Must be >= 20 (vs Phase 0's ~5-10)

# 4. Classification works: comments have stance/quality/score
xray thread https://x.com/karpathy/status/XXXX --json \
  | jq '[.thread.comments[].classification] | map(select(. != null)) | length'
# Must be > 0

# 5. Coverage metadata present
xray thread https://x.com/karpathy/status/XXXX --json | jq '.coverage.status'
# Must output "ok" or "partial"

# 6. Deep mode works
xray thread https://x.com/karpathy/status/XXXX --deep --json | jq '.subtreeSummaries | length'
# Must be > 0

# 7. MCP backward compatibility
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"xray_thread","arguments":{"url":"https://x.com/karpathy/status/XXXX"}},"id":1}' \
  | bun run src/mcp/index.ts
# Must return valid response (no errors about missing args)

# 8. Markdown report is well-formed with new sections
xray thread https://x.com/karpathy/status/XXXX | grep -c "##"
# Must have more ## sections than Phase 0

# 9. Cache works for classifications
xray cache info
# Must show kyma_responses entries with "comment-classify:" keys

# 10. Version bump
grep '"version"' package.json
# Must show "0.2.0"
```

---

## 14. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| X changes GraphQL schema or cursor format | Medium | High | Selectors are already defensive; add integration smoke test; cursors are extracted generically |
| `page.evaluate(fetch(...))` blocked by X CORS/CSP | Low | High | The fetch runs inside the browser's own context so CSP shouldn't apply; fallback: intercept and replay via Playwright's route API |
| Classification prompt quality — LLM may confuse stance of nested replies | Medium | Medium | Explicit instruction that stance is relative to root post; test with diverse fixtures |
| Pagination timeout on very large threads (1000+ replies) | Medium | Low | Hard cap at `maxReplies`; 60s timeout; partial results returned |
| Deep mode costs spike if model pricing changes | Low | Medium | Hard cap of 15 calls; explicit cost warning in `--deep` help text |

### Open Questions

1. **Should `--deep` mode warn about cost before proceeding?** Current plan: no interactive prompt (breaks MCP), but print estimated cost to stderr in CLI mode.
2. **Should partial classification results be merged into the thread analysis prompt?** Current plan: yes, classify first, then pass classified comments to the existing analysis prompt for richer insights.
3. **GraphQL queryId stability:** X's GraphQL endpoints use rotating `queryId` values. The current approach captures the queryId from the initial request. If X rotates queryId mid-session, pagination will fail. Mitigation: re-capture from any new TweetDetail response.
4. **Rate limiting on rapid pagination:** If X throttles after N rapid GraphQL calls, pagination will stop early. Mitigation: 500ms delay between pagination fetches; partial results with coverage metadata.

---

## 15. Out of Scope (Explicit Deferrals)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Walking UP from a reply to find the root thread | Phase 2+ | Requires a different fetch strategy |
| Video/media analysis within replies | Phase 2 | Separate feature track |
| Sentiment analysis (positive/negative float) | Phase 2+ | Stance + quality covers the immediate need |
| User reputation / credibility scoring | Phase 4 | Requires profile-level data |
| Batch classification across multiple threads | Phase 4 | Needs batch research infrastructure |
| Interactive exploration (REPL over thread data) | Phase 5 | UX feature, not analysis |
| Classification with local models | Phase 5 | Requires model hosting setup |
| Streaming/progressive output during pagination | Phase 5 | Nice-to-have UX |
| Alternative LLM providers for classification | Phase 5 | Currently Kyma-only by design |

---

**End of PHASE_1_PLAN.md**
