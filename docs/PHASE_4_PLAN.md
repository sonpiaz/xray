# Phase 4 — Advanced Research (Semantic Search & Profile Analysis)

**Status:** Draft
**Date:** 2026-05-19
**Owner:** sonpiaz
**Version target:** v0.5.0
**Depends on:** v0.4.0 (Phase 0 + Phase 1 + Phase 1.5 + Phase 2 + Phase 3 complete), `@xenova/transformers` (~100MB one-time MiniLM-L6-v2 download), `sqlite-vec` extension for bun:sqlite, Kyma chat API (for profile synthesis only)

---

## 0. The Principle

> Advanced research is OPT-IN cross-thread analysis. Default `xray thread` remains UNCHANGED. Embeddings are local (private, no API calls). Profile aggregates are bounded by cache content.

**The rule:** Semantic search and profile analysis are standalone commands that operate on previously cached XRay data. They never trigger new data fetching by default. A user who has run `xray thread` on 50 threads over the past week can now search across all of them by meaning, or build a profile of any author who appeared in those threads. This is post-hoc intelligence over existing cache — not a new pipeline that fires during thread research.

**Design philosophy:**
- Embeddings are computed locally using MiniLM-L6-v2 via `@xenova/transformers`. No API calls for embedding. No data leaves the machine.
- Vector similarity search uses `sqlite-vec` (native SQLite extension) for production performance. Falls back to pure-JS cosine similarity when the native extension is unavailable.
- Profile analysis aggregates cached data (comments, posts, articles) for a given author handle. Default is cache-only. `--fresh N` is the opt-in to fetch N new threads before profiling.
- The only cost-bearing operation is profile synthesis (Kyma chat calls to summarize stance/expertise). Search is always free.
- No cost caps (carrying forward Son's P2/P3 decision) — cost surfaced via `estimatedCostUsd`.

---

## 1. Goals

1. **Semantic search** — find cached content (comments, posts, article passages) by meaning, not just keywords, across all locally cached XRay data.
2. **Profile analysis** — given an X handle, aggregate all cached appearances (threads, comments, articles) and synthesize a structured profile: topics, stance patterns, expertise areas, notable quotes.
3. **Local-first embeddings** — compute and store embeddings entirely on-device using MiniLM-L6-v2. No API calls, no data exfiltration, no per-query cost.
4. **MCP exposure** — new `xray_search` and `xray_profile` tools so AI agents can query cached research semantically.
5. **Cost transparency** — profile synthesis surfaces `estimatedCostUsd`. Search is always $0.

## 2. Non-Goals (deferred)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Narrative / controversy tracking | Phase 5 | Requires temporal analysis, stance drift detection, and multi-thread correlation. Separate product surface. |
| Batch research & comparison | Phase 5 | Processing multiple threads/profiles in parallel is orchestration complexity beyond P4 scope. |
| Multi-user collaboration | Phase 6+ | Shared vector stores, team profiles, collaborative search. Different architecture. |
| Real-time alerts / monitoring | Phase 6+ | Watching for new content matching a query. Requires polling infrastructure. |
| Custom embedding models | Phase 5+ | MiniLM-L6-v2 is the single supported model in P4. BYOM adds config surface. |
| Embedding API providers (OpenAI, Cohere) | Phase 5+ | Local-only in P4 by explicit design choice. API providers add cost + privacy concerns. |
| Profile comparison (A vs B) | Phase 5 | Comparing two profiles is a higher-level orchestration on top of single-profile analysis. |
| Cross-platform profile (X + GitHub + LinkedIn) | Phase 6+ | XRay is X-focused. Cross-platform identity resolution is a different problem. |

---

## 3. User-Facing Changes

### 3.1 CLI Surface

| Flag / Command | Type | Default | Behavior (P4) | Change from P3 |
|---|---|---|---|---|
| `xray thread <url>` (no flags) | - | Text-only research (unchanged) | No embedding, no search, no profile. Same as v0.4.0. | **Unchanged** |
| `xray search "<query>"` | command | - | Semantic search across all cached XRay content. Returns top-K results ranked by cosine similarity. | **NEW command** |
| `xray search "<query>" --top <n>` | number | `10` | Limit results to top N matches. | **NEW** |
| `xray search "<query>" --type <t>` | enum | `all` | Filter by entity type: `comment`, `post`, `article-passage`, or `all`. | **NEW** |
| `xray search "<query>" --threshold <f>` | float | `0.3` | Minimum similarity score (0-1). Results below this are excluded. | **NEW** |
| `xray search "<query>" --rerank` | boolean | `false` | Use Kyma LLM to rerank top-K results for relevance. Costs ~$0.005. | **NEW** |
| `xray profile @<handle>` | command | - | Generate a profile report for the given X handle based on cached data. | **NEW command** |
| `xray profile @<handle> --fresh <n>` | number | `0` | Fetch N recent threads from this handle before profiling. Each thread costs standard `xray thread` pricing. | **NEW** |
| `xray cache embed` | command | - | Embed all cached content that hasn't been embedded yet. Idempotent. | **NEW command** |
| `xray cache clear --profiles` | flag | - | Clear only the `profile_cache` table, preserving embeddings and thread cache. | **NEW flag** |
| `--json` | boolean | `false` | JSON output (applies to `search` and `profile`). | Unchanged pattern |
| `-o, --output <path>` | string | - | Write output to file. | Unchanged pattern |
| `--no-cache` | boolean | `false` | For `profile`: bypass profile cache, re-synthesize. For `search`: no effect (search is always live). | Unchanged pattern |

### 3.2 MCP Surface

| Tool | Args | Type | Default | Description |
|---|---|---|---|---|
| `xray_search` | `query` | `z.string()` | required | **NEW tool.** Semantic search query. |
| `xray_search` | `top` | `z.number().int().positive().optional()` | `10` | Max results. |
| `xray_search` | `type` | `z.enum(['comment','post','article-passage','all']).optional()` | `'all'` | Entity type filter. |
| `xray_search` | `threshold` | `z.number().min(0).max(1).optional()` | `0.3` | Minimum similarity. |
| `xray_search` | `rerank` | `z.boolean().optional()` | `false` | LLM reranking. |
| `xray_search` | `format` | `z.enum(['markdown','json','both'])` | `'markdown'` | Output format. |
| `xray_profile` | `handle` | `z.string()` | required | **NEW tool.** X handle (with or without @). |
| `xray_profile` | `fresh` | `z.number().int().nonnegative().optional()` | `0` | Fetch N threads first. |
| `xray_profile` | `noCache` | `z.boolean().optional()` | `false` | Skip profile cache. |
| `xray_profile` | `format` | `z.enum(['markdown','json','both'])` | `'markdown'` | Output format. |

### 3.3 Markdown Output — Search Results

```markdown
# Search Results — "transformer scaling laws"

**Query:** transformer scaling laws
**Matches:** 7 results (from 142 embedded items)
**Time:** 45ms

| # | Score | Type | Source | Snippet |
|---|-------|------|--------|---------|
| 1 | 0.89 | comment | @karpathy in [thread](https://x.com/.../status/123) | "Scaling laws predict loss with remarkable accuracy up to..." |
| 2 | 0.84 | post | @ylecun [thread](https://x.com/.../status/456) | "The bitter lesson is that compute wins, but..." |
| 3 | 0.78 | article-passage | [Chinchilla Optimal](https://arxiv.org/...) via @sully | "Training compute-optimal models requires..." |
| 4 | 0.71 | comment | @random_phd in [thread](https://x.com/.../status/789) | "People forget that Kaplan et al. showed..." |
```

### 3.4 Markdown Output — Profile Report

```markdown
# Profile — @karpathy

**Handle:** @karpathy
**Sampling:** cache-only (23 cached threads, 87 comments)
**Generated:** 2026-05-19T14:30:00Z
**Estimated cost:** $0.12

## Topics

| Topic | Mentions | Representative Quote |
|-------|----------|---------------------|
| LLM training | 14 | "The key insight is that you want to train for longer on less data..." |
| Autonomous driving | 8 | "Vision-only is the right approach for self-driving..." |
| AI safety | 5 | "We should be thoughtful but not paralyzed by..." |

## Expertise Areas

1. Neural network training and optimization
2. Computer vision and autonomous driving
3. LLM architecture and scaling
4. AI education and pedagogy

## Stance Patterns

| Topic | Stance | Confidence | Evidence |
|-------|--------|------------|----------|
| Scaling laws | Proponent with caveats | 0.85 | "Scaling works but data quality matters more than people think" |
| Open-source AI | Strong advocate | 0.92 | "Models should be open. Period." |
| AI regulation | Cautiously supportive | 0.65 | "Some guardrails make sense but don't kill innovation" |

## Notable Quotes

> "The hottest new programming language is English." — [thread](https://x.com/.../status/...)

> "I don't use an IDE. I use a terminal." — [thread](https://x.com/.../status/...)

---

*Profile based on 23 cached threads. Run `xray profile @karpathy --fresh 20` to include recent activity.*
```

---

## 4. Pipeline Architecture

### 4.1 Search Pipeline

```
           xray search "<query>"
                    |
                    v
         +--------------------+
         |  Embed Query       |
         |  MiniLM-L6-v2      |
         |  (local, ~5ms)     |
         +---------+----------+
                   |
                   v
         +--------------------+
         |  Vector Search     |
         |  sqlite-vec cosine |
         |  (or JS fallback)  |
         |  → top-K results   |
         +---------+----------+
                   |
            (--rerank flag?)
           /              \
         no               yes
          |                 |
          v                 v
     SearchResult[]   +------------------+
                      |  LLM Rerank      |
                      |  Kyma chat:      |
                      |  query + K       |
                      |  snippets →      |
                      |  reordered list  |
                      +--------+---------+
                               |
                               v
                        SearchResult[]
```

### 4.2 Profile Pipeline

```
         xray profile @<handle>
                    |
              (--fresh N?)
             /           \
           no             yes
            |               |
            v               v
    use cache only    fetch N threads
    (no network)      via xray thread
            |               |
            +-------+-------+
                    |
                    v
         +--------------------+
         |  Query Cache       |
         |  Find all posts,   |
         |  comments, articles|
         |  by @handle        |
         +---------+----------+
                   |
                   v
         +--------------------+
         |  Embed & Cluster   |
         |  Embed all items   |
         |  (if not already)  |
         |  K-means cluster   |
         |  into topic groups |
         +---------+----------+
                   |
                   v
         +--------------------+
         |  Kyma Synthesize   |
         |  3-5 chat calls:   |
         |  - Topic labeling  |
         |  - Stance analysis |
         |  - Expertise       |
         |  - Notable quotes  |
         +---------+----------+
                   |
                   v
         +--------------------+
         |  ProfileReport     |
         |  (Zod-validated)   |
         +--------------------+
```

---

## 5. Per-Stage Specification

### 5.1 Embedding Provider (`src/embeddings/provider.ts`)

**Trigger:** First call to `xray search`, `xray profile`, or `xray cache embed`.

**What it does:**
1. Check if MiniLM-L6-v2 model files exist at `~/.xray/models/all-MiniLM-L6-v2/`.
2. If not present, download from HuggingFace via `@xenova/transformers` pipeline API (~100MB, one-time).
3. Show progress bar during download: `Downloading MiniLM-L6-v2 (100MB)... [████░░] 67%`
4. Initialize the `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` instance.
5. Cache the pipeline instance in-memory for the process lifetime (lazy singleton).
6. Expose `embed(text: string): Promise<Float32Array>` and `embedBatch(texts: string[]): Promise<Float32Array[]>`.

**Model details:**
- Model: `Xenova/all-MiniLM-L6-v2`
- Dimensions: 384
- Max sequence length: 256 tokens (~200 words). Longer text is truncated.
- Quantization: ONNX INT8 by default (~30MB after quantization vs ~100MB FP32).

**Inputs:** `text: string` or `texts: string[]`
**Outputs:** `Float32Array` (384-dim) or `Float32Array[]`
**Dependencies:** `@xenova/transformers`
**Cost:** $0 (local CPU inference)
**Failure modes:**
- Model download fails (offline, HuggingFace down) -> clear error: `"Failed to download MiniLM-L6-v2. Check your internet connection and retry."`
- Download interrupted -> `@xenova/transformers` handles partial downloads; retry resumes.
- Out of memory (very unlikely at ~30MB model) -> standard OOM error from Node/Bun.

### 5.2 Embedding Store (`src/embeddings/store.ts`)

**Trigger:** After embedding provider is initialized, on any embed/search/profile call.

**What it does:**
1. Load `sqlite-vec` extension into the existing `bun:sqlite` database.
2. Create a virtual table `vec_embeddings` using sqlite-vec for vector similarity search.
3. Create a metadata table `embedding_meta` for entity tracking (content hash dedup).
4. Expose `upsert(entityType, entityId, vector, contentHash)` and `search(queryVector, topK, filter?)`.

**sqlite-vec loading:**
```typescript
import * as sqliteVec from 'sqlite-vec';
const db = getDb();
sqliteVec.load(db);
```

**Schema (added to MIGRATIONS in `src/cache/db.ts`):**
```sql
-- P4.0: Embedding metadata. Tracks which entities have been embedded
-- and their content hash for change detection (re-embed if content changed).
CREATE TABLE IF NOT EXISTS embedding_meta (
  entity_type TEXT NOT NULL,       -- 'comment' | 'post' | 'article-passage'
  entity_id TEXT NOT NULL,         -- post ID or article URL + passage index
  content_hash TEXT NOT NULL,      -- SHA-256 of the embedded text
  source_url TEXT,                 -- thread/article URL for result linking
  author_handle TEXT,              -- @handle for profile queries
  snippet TEXT NOT NULL,           -- first ~200 chars for search result display
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_meta_author
  ON embedding_meta(author_handle);
CREATE INDEX IF NOT EXISTS idx_embedding_meta_type
  ON embedding_meta(entity_type);
```

**sqlite-vec virtual table (created programmatically, not in MIGRATIONS):**
```sql
-- Created at runtime after sqlite-vec extension is loaded.
-- sqlite-vec virtual tables are not CREATE IF NOT EXISTS friendly
-- in all versions, so we guard with a try/catch.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding float[384]
);
```

The rowid in `vec_embeddings` maps to a sequential integer stored in `embedding_meta` via an additional `rowid INTEGER` column. This join pattern is standard for sqlite-vec.

**Fallback (pure-JS cosine):**
When `sqlite-vec` extension loading fails (binary incompatibility on some platforms):
1. Log a WARN: `"sqlite-vec extension failed to load. Using pure-JS cosine similarity (slower)."`
2. Store embeddings as BLOB in a regular SQLite table `embedding_vectors(entity_type, entity_id, vector_blob)`.
3. On search, load all vectors into memory, compute cosine similarity in JS, sort, return top-K.
4. This is O(n) per search vs O(log n) with sqlite-vec, but works on any platform.

**Inputs:** Entity metadata + embedding vector
**Outputs:** Stored/retrieved embeddings
**Dependencies:** `sqlite-vec` (native), `bun:sqlite`
**Cost:** $0
**Failure modes:**
- sqlite-vec binary not available for platform -> fallback to pure-JS cosine
- DB locked (concurrent access) -> standard SQLite WAL handles this
- Corrupted vector data -> skip entry, log WARN

### 5.3 Embed All Cached Content (`src/embeddings/index.ts`)

**Trigger:** `xray cache embed` command, or lazily on first `xray search` / `xray profile`.

**What it does:**
1. Query all cached posts, comments (from thread cache), and article bodies from SQLite.
2. For each item, check if an embedding with matching `content_hash` already exists.
3. Skip items that are already embedded and unchanged.
4. Batch-embed new/changed items (batch size: 32).
5. Upsert into the embedding store.
6. Report progress: `Embedding cached content... 142/142 items [████████] done (23 new, 119 skipped)`

**Text preparation:**
- Posts: `"{author}: {text}"` (include handle for context).
- Comments: `"{author} replying to {parentAuthor}: {text}"`.
- Article passages: chunk article body into ~200-word passages, embed each. Entity ID = `article:{url}:chunk:{index}`.

**Inputs:** None (reads from existing cache tables)
**Outputs:** Embeddings stored in `vec_embeddings` + `embedding_meta`
**Dependencies:** Embedding provider, embedding store, cache tables
**Cost:** $0 (all local)
**Failure modes:**
- Empty cache -> `"No cached content to embed. Run xray thread first."`
- Embedding provider not initialized -> triggers MiniLM download (first-time UX)

### 5.4 Semantic Search (`src/search/search.ts`)

**Trigger:** `xray search "<query>"` or `xray_search` MCP tool.

**What it does:**
1. Ensure embeddings are up-to-date: run a quick diff of cache vs `embedding_meta` and embed any new items. (Lazy embedding — user doesn't need to run `xray cache embed` manually.)
2. Embed the query string using MiniLM-L6-v2.
3. Search `vec_embeddings` for top-K nearest neighbors (cosine similarity).
4. Join with `embedding_meta` for entity metadata (type, snippet, source_url, author_handle).
5. Filter by `--type` and `--threshold` if specified.
6. If `--rerank` is set, send the query + top-K snippets to Kyma for LLM reranking.
7. Return `SearchResult[]`.

**sqlite-vec query:**
```sql
SELECT rowid, distance
FROM vec_embeddings
WHERE embedding MATCH ?
ORDER BY distance
LIMIT ?
```

**Reranking prompt (when `--rerank` is used):**
```
System: You are a search relevance judge. Given a query and a list of search results,
reorder them by relevance to the query. Return a JSON array of indices in order of
decreasing relevance. Drop any results that are not relevant at all.

User:
Query: "{query}"

Results:
1. {snippet_1}
2. {snippet_2}
...

Respond in JSON: { "rankedIndices": [3, 1, 5, 2, ...], "droppedIndices": [4, 6] }
```

**Inputs:** Query string + options (top, type, threshold, rerank)
**Outputs:** `SearchResult[]`
**Dependencies:** Embedding provider, embedding store, optionally Kyma (rerank)
**Cost:** $0 without rerank, ~$0.005 with rerank
**Failure modes:**
- No embeddings exist -> trigger lazy embedding, then search
- Empty results -> `"No matches found. Try a broader query or embed more content with xray cache embed."`
- Rerank Kyma call fails -> return un-reranked results with warning

### 5.5 Profile Analysis (`src/intelligence/profile.ts`)

**Trigger:** `xray profile @<handle>` or `xray_profile` MCP tool.

**What it does:**
1. Normalize handle (strip `@`, lowercase).
2. If `--fresh N` is set, fetch N recent threads from this handle via `xray thread` (standard pricing applies). This populates the cache.
3. Query all cached data for this handle:
   - Posts authored by handle (from `posts` table).
   - Comments by handle (from cached thread data, parsed from `threads` table JSON).
   - Articles linked by handle (from `article_bodies` / `article_summaries` where the linking tweet author matches).
4. If no cached data found, return early: `"No cached data for @{handle}. Run xray thread on their content first, or use --fresh 20."`
5. If cached item count > 50, emit WARN log: `"@{handle} has {count} cached items — profile synthesis may cost >$0.20"`
6. Embed all un-embedded items for this handle (reuse lazy embedding from search).
7. Cluster embedded items using simple k-means (k = min(ceil(itemCount/5), 10)) to identify topic groups.
8. For each cluster, extract the centroid and find the nearest 3 items as representative quotes.
9. Send clustered data to Kyma for synthesis (3-5 calls):
   - **Call 1: Topic labeling** — given cluster centroids + representative items, produce topic labels.
   - **Call 2: Stance analysis** — given all items grouped by topic, identify stance patterns (position + confidence).
   - **Call 3: Expertise extraction** — given all items, identify expertise areas (ordered by evidence strength).
   - **Call 4: Notable quotes** — given all items, pick the 3-5 most distinctive/quotable statements.
   - (Optional) **Call 5: Summary** — if item count > 20, produce a 1-paragraph profile summary.
10. Assemble `ProfileReport` and cache it (24h TTL matching existing cache).

**Inputs:** Handle string + options (fresh, noCache)
**Outputs:** `ProfileReport`
**Dependencies:** Cache tables, embedding provider, embedding store, Kyma chat API
**Cost:** $0.05-0.20 depending on cached item count (3-5 Kyma calls at ~$0.01-0.04 each)
**Failure modes:**
- No cached data for handle -> clear message with instructions
- Kyma API key not set -> return raw aggregation (topics from clusters, quotes from top items) without synthesis. Mark `partial: true`.
- Kyma rate limit -> retry 3x with backoff, then return partial result
- Very large cache (>200 items) -> sample to 100 most recent items for synthesis, note sampling in report

---

## 6. Data Model Deltas

### 6.1 EmbeddingRow (internal, not user-facing)

```typescript
// src/models/embedding.ts

import { z } from 'zod';

export const EmbeddingEntityTypeSchema = z.enum(['comment', 'post', 'article-passage']);
export type EmbeddingEntityType = z.infer<typeof EmbeddingEntityTypeSchema>;

export const EmbeddingMetaSchema = z.object({
  entityType: EmbeddingEntityTypeSchema,
  entityId: z.string(),
  contentHash: z.string(),
  sourceUrl: z.string().url().optional(),
  authorHandle: z.string().optional(),
  snippet: z.string(),
  createdAt: z.number().int(),
});
export type EmbeddingMeta = z.infer<typeof EmbeddingMetaSchema>;
```

### 6.2 SearchResult (NEW)

```typescript
// src/models/search.ts

import { z } from 'zod';
import { EmbeddingEntityTypeSchema } from './embedding.ts';

export const SearchResultSchema = z.object({
  query: z.string(),
  entityType: EmbeddingEntityTypeSchema,
  entityId: z.string(),
  snippet: z.string(),
  similarityScore: z.number().min(0).max(1),
  sourceUrl: z.string().url().optional(),
  authorHandle: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
  totalEmbedded: z.number().int().nonnegative(),
  searchTimeMs: z.number().nonnegative(),
  reranked: z.boolean().default(false),
  estimatedCostUsd: z.number().nonnegative().default(0),
  generatedAt: z.string().datetime(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
```

### 6.3 ProfileReport (NEW)

```typescript
// src/models/profile.ts

import { z } from 'zod';

export const TopicSchema = z.object({
  label: z.string(),
  mentions: z.number().int().nonnegative(),
  representativeQuote: z.string(),
  representativeSourceUrl: z.string().url().optional(),
});
export type Topic = z.infer<typeof TopicSchema>;

export const StanceSummarySchema = z.object({
  topic: z.string(),
  stance: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});
export type StanceSummary = z.infer<typeof StanceSummarySchema>;

export const NotableQuoteSchema = z.object({
  text: z.string(),
  sourceUrl: z.string().url().optional(),
  context: z.string().optional(),
});
export type NotableQuote = z.infer<typeof NotableQuoteSchema>;

export const ProfileReportSchema = z.object({
  handle: z.string(),
  samplingScope: z.enum(['cache', 'fresh']),
  cachedThreads: z.number().int().nonnegative(),
  cachedComments: z.number().int().nonnegative(),
  cachedArticles: z.number().int().nonnegative(),
  topics: z.array(TopicSchema).default([]),
  stancePatterns: z.array(StanceSummarySchema).default([]),
  expertiseAreas: z.array(z.string()).default([]),
  notableQuotes: z.array(NotableQuoteSchema).default([]),
  profileSummary: z.string().optional(),
  estimatedCostUsd: z.number().nonnegative().default(0),
  partial: z.boolean().default(false),
  errors: z.array(z.string()).default([]),
  generatedAt: z.string().datetime(),
});
export type ProfileReport = z.infer<typeof ProfileReportSchema>;
```

---

## 7. Architecture Changes

### 7.1 New Files

| File | Purpose |
|------|---------|
| `src/embeddings/provider.ts` | MiniLM-L6-v2 bootstrap via `@xenova/transformers`. Lazy singleton pipeline. `embed()` and `embedBatch()` exports. Model download progress bar. |
| `src/embeddings/store.ts` | sqlite-vec virtual table management. `upsert()`, `search()`, `remove()`. Pure-JS cosine fallback when extension unavailable. |
| `src/embeddings/index.ts` | Re-exports + `embedAllCached()` orchestrator that scans cache tables and embeds un-embedded items. |
| `src/search/search.ts` | Semantic search orchestrator: lazy embed -> query embed -> vector search -> optional rerank -> `SearchResponse`. |
| `src/intelligence/profile.ts` | Profile analysis orchestrator: cache query -> embed -> cluster -> Kyma synthesize -> `ProfileReport`. |
| `src/cli/commands/search.ts` | CLI handler for `xray search "<query>"`. |
| `src/cli/commands/profile.ts` | CLI handler for `xray profile @<handle>`. |
| `src/render/search-markdown.ts` | Markdown renderer for `SearchResponse`. |
| `src/render/profile-markdown.ts` | Markdown renderer for `ProfileReport`. |
| `src/models/embedding.ts` | Zod schemas: `EmbeddingEntityType`, `EmbeddingMeta`. |
| `src/models/search.ts` | Zod schemas: `SearchResult`, `SearchResponse`. |
| `src/models/profile.ts` | Zod schemas: `Topic`, `StanceSummary`, `NotableQuote`, `ProfileReport`. |
| `tests/unit/embedding-provider.test.ts` | MiniLM bootstrap, embed, embedBatch with mock transformer pipeline. |
| `tests/unit/embedding-store.test.ts` | sqlite-vec upsert, search, fallback to JS cosine. Content hash dedup. |
| `tests/unit/search.test.ts` | End-to-end search with mock embeddings. Threshold, type filter, rerank. |
| `tests/unit/profile.test.ts` | Profile orchestrator with mock cache data. Cache-only vs fresh. Partial results. |
| `tests/unit/search-markdown.test.ts` | Search result Markdown rendering. |
| `tests/unit/profile-markdown.test.ts` | Profile report Markdown rendering. |
| `tests/unit/embedding-model.test.ts` | Zod schema validation for embedding, search, profile types. |

### 7.2 Modified Files

| File | Changes |
|------|---------|
| `src/cache/db.ts` | Add `embedding_meta` and `profile_cache` table migrations. Add `vec_embeddings` virtual table creation (runtime, after sqlite-vec load). |
| `src/cli/index.ts` | Register `xray search "<query>"` and `xray profile @<handle>` commands. Register `xray cache embed` sub-command. |
| `src/cli/commands/cache.ts` | Add `--profiles` flag to `cache clear`. Add `embed` sub-action to `cache`. Update `cacheInfoCommand` to show embedding count. |
| `src/mcp/server.ts` | Register `xray_search` and `xray_profile` tools. |
| `src/mcp/schemas.ts` | Add `SearchInput` and `ProfileInput` Zod schemas for MCP tool validation. |
| `src/models/index.ts` | Re-export embedding, search, and profile model types. |
| `src/render/index.ts` | Re-export search and profile markdown renderers. |
| `package.json` | Add `@xenova/transformers` and `sqlite-vec` dependencies. Version bump to `0.5.0`. |

---

## 8. Embedding Bootstrap UX

### 8.1 First-Time Experience

When a user runs `xray search` or `xray profile` for the first time:

1. MiniLM-L6-v2 model is not yet downloaded.
2. XRay displays a progress bar:
   ```
   First-time setup: downloading MiniLM-L6-v2 embedding model (~100MB)...
   [████████████░░░░░░░░] 62% (62/100 MB)
   ```
3. Model files are cached at `~/.xray/models/all-MiniLM-L6-v2/` (following `@xenova/transformers` convention).
4. Subsequent runs skip the download — model loads from local cache in ~1-2 seconds.

### 8.2 Download Failure Handling

```
Error: Failed to download MiniLM-L6-v2 embedding model.

Possible causes:
  - No internet connection
  - HuggingFace CDN is unreachable
  - Disk space insufficient (~100MB needed)

Retry with: xray search "<query>"
Manual download: https://huggingface.co/Xenova/all-MiniLM-L6-v2
Cache location: ~/.xray/models/all-MiniLM-L6-v2/
```

### 8.3 Environment Variable Override

```bash
# Override model cache location
XRAY_MODEL_DIR=~/my-models xray search "..."

# Force re-download
rm -rf ~/.xray/models/all-MiniLM-L6-v2 && xray search "..."
```

---

## 9. sqlite-vec Extension Loading

### 9.1 Production Path

```typescript
import * as sqliteVec from 'sqlite-vec';

function loadVecExtension(db: Database): boolean {
  try {
    sqliteVec.load(db);
    logger.debug('sqlite-vec extension loaded');
    return true;
  } catch (err) {
    logger.warn('sqlite-vec extension failed to load — using pure-JS cosine fallback', {
      error: String(err),
    });
    return false;
  }
}
```

### 9.2 Fallback Path (Pure-JS Cosine)

When `sqlite-vec` cannot load:
1. Embeddings are stored as BLOBs in a regular `embedding_vectors` table.
2. Search loads all vectors into memory and computes cosine similarity in JavaScript.
3. Performance degrades from O(log n) to O(n), but correctness is maintained.
4. This is documented in CHANGELOG as "degraded mode" and logged as WARN on every search.

### 9.3 Platform Compatibility

| Platform | sqlite-vec | Fallback |
|----------|-----------|----------|
| macOS arm64 | Supported | N/A |
| macOS x86_64 | Supported | N/A |
| Linux x86_64 | Supported | N/A |
| Linux arm64 | Supported | N/A |
| Windows x86_64 | May fail | Pure-JS cosine |

---

## 10. Cost Surfacing

### 10.1 Cost Reference Table

| Stage | Per-call cost |
|---|---|
| Embed (local MiniLM) | $0 |
| Vector search (sqlite-vec) | $0 |
| Vector search (JS fallback) | $0 |
| LLM rerank (optional, `--rerank`) | ~$0.005 |
| Profile: topic labeling (Kyma) | ~$0.01-0.03 |
| Profile: stance analysis (Kyma) | ~$0.02-0.05 |
| Profile: expertise extraction (Kyma) | ~$0.01-0.03 |
| Profile: notable quotes (Kyma) | ~$0.01-0.03 |
| Profile: summary (Kyma, >20 items) | ~$0.01-0.04 |
| **Profile total (3-5 calls)** | **$0.05-0.20** |

### 10.2 Cost Logging

```
DEBUG search cost=$0.00 results=7 time=45ms
DEBUG search:rerank cost=$0.005 model=gemini-2.5-flash

DEBUG profile:synthesis cost=$0.12 calls=4 model=gemini-2.5-flash
DEBUG profile:total cost=$0.12 cachedItems=87
```

### 10.3 WARN on Large Profiles

```
WARN profile @{handle} has 87 cached items — synthesis may cost >$0.20
```

This is informational. The pipeline does NOT pause or prompt. Consistent with P2/P3 design.

---

## 11. Caching Strategy

### 11.1 Embeddings (Long-Lived)

- Embeddings stored in `vec_embeddings` + `embedding_meta` tables.
- Embeddings do NOT expire — they remain valid as long as the source content hasn't changed.
- Content change is detected via `content_hash` in `embedding_meta`. If the source content changes (rare — posts don't edit on X), the embedding is re-computed.
- `xray cache clear` removes all embeddings along with other cached data.
- `xray cache embed` is idempotent — re-running skips already-embedded items.

### 11.2 Profile Cache (24h TTL)

```sql
-- P4.2: Profile report cache. 24h TTL matches existing cache behavior.
CREATE TABLE IF NOT EXISTS profile_cache (
  handle TEXT PRIMARY KEY,
  report_json TEXT NOT NULL,
  scope TEXT NOT NULL,         -- 'cache' | 'fresh'
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_cache_created
  ON profile_cache(created_at);
```

- `xray profile @handle` checks this cache first. If hit and within TTL, return cached report.
- `--no-cache` bypasses the profile cache (re-synthesizes).
- `xray cache clear --profiles` clears only this table.
- `xray cache clear` clears everything including profiles.

### 11.3 Cache Behavior Matrix

| Scenario | Behavior |
|---|---|
| `xray search` — embeddings exist | Search directly. Lazy-embed any new cache items first. |
| `xray search` — no embeddings | Trigger full `embedAllCached()`, then search. |
| `xray profile @x` — profile cached, within 24h | Return cached `ProfileReport`. |
| `xray profile @x` — profile expired / not cached | Re-query cache, re-synthesize, cache result. |
| `xray profile @x --no-cache` | Skip profile cache. Re-synthesize. |
| `xray profile @x --fresh 20` | Fetch 20 threads first, then profile. Scope = `fresh`. |
| `xray cache embed` | Embed all un-embedded cached items. Idempotent. |
| `xray cache clear` | Clear ALL cache tables including embeddings + profiles. |
| `xray cache clear --profiles` | Clear `profile_cache` only. Embeddings preserved. |

---

## 12. Failure Modes & Partial Results

### 12.1 Search Failures

| Failure | Result | Recovery |
|---|---|---|
| MiniLM download fails (offline) | Error with retry instructions. No results. | Retry when online. |
| sqlite-vec load fails | WARN log. Fall back to pure-JS cosine. Search works but slower. | Install sqlite-vec for platform, or accept degraded mode. |
| Empty cache (no embedded items) | `"No cached content to search. Run xray thread on some URLs first."` | Run `xray thread` to populate cache. |
| No results above threshold | `"No matches found above threshold {threshold}. Try a lower threshold or broader query."` | Lower `--threshold` or broaden query. |
| Rerank Kyma call fails | Return un-reranked results with warning. | Results still useful, just not reranked. |

### 12.2 Profile Failures

| Failure | Result | `partial` | `errors[]` entry |
|---|---|---|---|
| No cached data for handle | Error message with instructions. No report. | - | - |
| Kyma API key not set | Raw aggregation (cluster-based topics, raw quotes). No synthesis. | true | `"KYMA_API_KEY not set — returning raw profile without synthesis"` |
| Kyma rate limit (after 3 retries) | Partial synthesis (whatever completed before rate limit). | true | `"Kyma rate limit — partial synthesis"` |
| Very large cache (>200 items) | Sample to 100 most recent. Note in report. | false | `"Sampled 100 of {count} items for synthesis"` |
| Clustering fails (< 3 items) | Skip clustering. Treat all items as one topic. | false | - |
| `--fresh N` thread fetch fails | Profile from existing cache only. Note the failure. | true | `"Failed to fetch fresh threads: {reason}"` |

---

## 13. Test Plan

### 13.1 New Test Files

| File | What it covers | Est. test count |
|------|---------------|----------------|
| `tests/unit/embedding-provider.test.ts` | MiniLM initialization (mocked), embed single text, embedBatch, truncation behavior, error on download failure. | ~8 |
| `tests/unit/embedding-store.test.ts` | Upsert with content hash dedup, search with sqlite-vec (mocked), fallback to JS cosine, type filtering, author filtering. | ~10 |
| `tests/unit/search.test.ts` | End-to-end search pipeline with mock embeddings. Threshold filtering, type filtering, top-K limit, rerank prompt construction, empty results. | ~8 |
| `tests/unit/profile.test.ts` | Profile orchestrator: cache-only mode, fresh mode, empty cache handling, large cache sampling, partial results (no Kyma key), clustering. | ~10 |
| `tests/unit/search-markdown.test.ts` | Markdown rendering: results table, empty results, reranked indicator. | ~4 |
| `tests/unit/profile-markdown.test.ts` | Markdown rendering: full report, partial report, empty topics, long quotes. | ~5 |
| `tests/unit/embedding-model.test.ts` | Zod schema validation: EmbeddingMeta, SearchResult, SearchResponse, ProfileReport — valid/invalid inputs. | ~6 |

### 13.2 Existing Test Survival

All existing ~538 tests remain untouched. Phase 4 is purely additive — no existing schemas, CLI flags, or behavior change.

### 13.3 Target Test Count After P4

- Existing after P3: ~538
- New: ~51
- **Target: ~589 tests across ~37 files**

### 13.4 Testing Strategy for Native Dependencies

- `@xenova/transformers` is mocked in all unit tests. A mock `embed()` function returns deterministic 384-dim vectors based on input text hash.
- `sqlite-vec` is tested via the JS cosine fallback path in unit tests. The sqlite-vec native path is verified via a single integration test.
- Profile orchestrator tests use pre-populated mock cache data (no real threads fetched).

### 13.5 Integration Testing (Manual Smoke Tests)

```bash
# 1. First-time model download
rm -rf ~/.xray/models && xray search "test"
# Expect: model download progress, then results (or empty)

# 2. Embed all cached content
xray cache embed
# Expect: progress bar, count of embedded items

# 3. Semantic search
xray search "transformer architecture" --json | jq '.results | length'
# Expect: >= 0

# 4. Search with type filter
xray search "scaling laws" --type comment
# Expect: only comment-type results

# 5. Search with rerank
xray search "AI safety" --rerank --json | jq '.reranked'
# Expect: true

# 6. Profile (cache-only)
xray profile @karpathy --json | jq '.samplingScope'
# Expect: "cache"

# 7. Profile (fresh)
xray profile @elonmusk --fresh 5 --json | jq '.cachedThreads'
# Expect: >= 5

# 8. Profile with no cached data
xray profile @nonexistent_user_xyz
# Expect: clear error message

# 9. Cache info shows embedding count
xray cache info
# Expect: "embeddings: N items"

# 10. Cache clear profiles
xray cache clear --profiles
xray profile @karpathy --json | jq '.generatedAt'
# Expect: fresh timestamp (not from cache)
```

---

## 14. Sub-Phase Delivery

### P4.0 — Embedding Infrastructure (~6-8h)

**Scope:** MiniLM-L6-v2 provider, sqlite-vec store with JS fallback, `embedAllCached()` pipeline, `xray cache embed` command.

**Files:**
- NEW: `src/models/embedding.ts` (EmbeddingEntityType, EmbeddingMeta schemas)
- NEW: `src/embeddings/provider.ts` (MiniLM bootstrap, embed, embedBatch)
- NEW: `src/embeddings/store.ts` (sqlite-vec table, upsert, search, JS fallback)
- NEW: `src/embeddings/index.ts` (re-exports, embedAllCached orchestrator)
- MOD: `src/cache/db.ts` (add `embedding_meta` + `profile_cache` migrations)
- MOD: `src/cli/index.ts` (register `xray cache embed` sub-command)
- MOD: `src/cli/commands/cache.ts` (add `embed` action, show embedding count in `info`)
- MOD: `package.json` (add `@xenova/transformers`, `sqlite-vec` — no version bump yet)
- NEW: `tests/unit/embedding-provider.test.ts`
- NEW: `tests/unit/embedding-store.test.ts`
- NEW: `tests/unit/embedding-model.test.ts`

**Acceptance criteria:**
```bash
# Model downloads on first use
xray cache embed
# Expect: "Downloading MiniLM-L6-v2..." then "Embedding cached content... N/N items"

# Second run is idempotent
xray cache embed
# Expect: "Embedding cached content... 0 new, N skipped"

# Cache info shows embeddings
xray cache info
# Expect: "embeddings: N items" line

# All tests pass
bun test
```

### P4.1 — Semantic Search (~5-7h)

**Scope:** Search orchestrator, CLI command, MCP tool, markdown renderer.

**Files:**
- NEW: `src/models/search.ts` (SearchResult, SearchResponse schemas)
- NEW: `src/search/search.ts` (search orchestrator)
- NEW: `src/cli/commands/search.ts` (CLI handler)
- NEW: `src/render/search-markdown.ts` (markdown renderer)
- MOD: `src/cli/index.ts` (register `xray search`)
- MOD: `src/mcp/server.ts` (register `xray_search` tool)
- MOD: `src/mcp/schemas.ts` (add `SearchInput` schema)
- MOD: `src/models/index.ts` (re-export search types)
- NEW: `tests/unit/search.test.ts`
- NEW: `tests/unit/search-markdown.test.ts`

**Acceptance criteria:**
```bash
# Basic search returns results
xray search "transformer" --json | jq '.results | length'
# Must output >= 0

# Type filter works
xray search "scaling" --type comment --json | jq '.results[0].entityType'
# Must output "comment"

# Threshold filter works
xray search "test" --threshold 0.9 --json | jq '.results | length'
# May output 0 (high threshold)

# Rerank works
xray search "AI safety" --rerank --json | jq '.reranked'
# Must output true

# Cost is $0 without rerank
xray search "test" --json | jq '.estimatedCostUsd'
# Must output 0

# MCP tool registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | grep xray_search
# Must appear

# Markdown rendering
xray search "transformer" | head -3
# Must start with "# Search Results"

bun test
```

### P4.2 — Profile Analysis + Polish + Release (~8-10h)

**Scope:** Profile orchestrator, CLI command, MCP tool, markdown renderer, `cache clear --profiles`, version bump to v0.5.0.

**Files:**
- NEW: `src/models/profile.ts` (Topic, StanceSummary, NotableQuote, ProfileReport schemas)
- NEW: `src/intelligence/profile.ts` (profile orchestrator)
- NEW: `src/cli/commands/profile.ts` (CLI handler)
- NEW: `src/render/profile-markdown.ts` (markdown renderer)
- MOD: `src/cli/index.ts` (register `xray profile`)
- MOD: `src/cli/commands/cache.ts` (add `--profiles` flag to clear)
- MOD: `src/mcp/server.ts` (register `xray_profile` tool)
- MOD: `src/mcp/schemas.ts` (add `ProfileInput` schema)
- MOD: `src/models/index.ts` (re-export profile types)
- MOD: `package.json` (version -> 0.5.0)
- NEW: `tests/unit/profile.test.ts`
- NEW: `tests/unit/profile-markdown.test.ts`

**Acceptance criteria:**
```bash
# Profile with cached data
xray profile @karpathy --json | jq '.handle'
# Must output "karpathy"

# Profile shows topics
xray profile @karpathy --json | jq '.topics | length'
# Must output >= 1 (if cached data exists)

# Profile shows expertise
xray profile @karpathy --json | jq '.expertiseAreas | length'
# Must output >= 1

# Profile cost surfaced
xray profile @karpathy --json | jq '.estimatedCostUsd'
# Must output a number > 0

# Profile sampling scope
xray profile @karpathy --json | jq '.samplingScope'
# Must output "cache" (default)

# Fresh mode
xray profile @karpathy --fresh 5 --json | jq '.samplingScope'
# Must output "fresh"

# Empty cache error
xray profile @nonexistent_xyz 2>&1 | grep "No cached data"
# Must match

# Cache clear --profiles
xray cache clear --profiles
# Must clear only profile_cache table

# MCP tool registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | grep xray_profile
# Must appear

# Markdown rendering
xray profile @karpathy | head -3
# Must start with "# Profile"

# Version bump
grep '"version"' package.json
# Must show "0.5.0"

# Full test suite
bun test
# All ~589 tests pass
```

### Total Effort Estimate

| Sub-phase | Hours | Cumulative |
|-----------|-------|------------|
| P4.0 Embedding infra (provider + store + embedAllCached + cache embed) | 6-8 | 6-8 |
| P4.1 Semantic search (orchestrator + CLI + MCP + render) | 5-7 | 11-15 |
| P4.2 Profile analysis + polish + release | 8-10 | 19-25 |
| **Total** | **19-25 hours** |

---

## 15. Acceptance Criteria — Phase 4 Overall

All of the following must pass before Phase 4 is considered complete:

```bash
# 1. All tests pass (existing ~538 + new ~51)
bun test

# 2. Embedding infrastructure works
xray cache embed
# Must complete without error, report item count

# 3. Semantic search works
xray search "transformer architecture" --json | jq '.results | length'
# Must output >= 0 (results depend on cached content)

# 4. Search type filter works
xray search "test" --type comment --json | jq '.results[0].entityType // "none"'
# Must output "comment" or "none" (if no comments match)

# 5. Search threshold filter works
xray search "test" --threshold 0.5 --json | jq '.results | all(.similarityScore >= 0.5)'
# Must output true

# 6. Search reranking works
xray search "AI safety" --rerank --json | jq '.reranked'
# Must output true

# 7. Profile analysis works
xray profile @<handle-with-cached-data> --json | jq '.handle'
# Must output the handle

# 8. Profile shows structured output
xray profile @<handle> --json | \
  jq '[.topics | length, .expertiseAreas | length, .notableQuotes | length] | all(. >= 0)'
# Must output true

# 9. Profile cost surfaced
xray profile @<handle> --json | jq '.estimatedCostUsd'
# Must output a number >= 0

# 10. Empty cache handling
xray profile @nonexistent_handle_xyz 2>&1
# Must show clear "no cached data" message

# 11. Cache info shows embeddings
xray cache info | grep "embeddings"
# Must show embedding count

# 12. Cache clear --profiles works
xray cache clear --profiles
# Must succeed

# 13. Default thread behavior unchanged
xray thread "https://x.com/user/status/123" --json | jq 'has("embeddings")'
# Must output false (no embedding fields on ResearchReport)

# 14. MCP tools registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | jq '.result.tools[].name' | grep -E 'xray_search|xray_profile'
# Both must appear

# 15. Version bump
grep '"version"' package.json
# Must show "0.5.0"

# 16. Markdown rendering (search)
xray search "test" | head -1
# Must start with "# Search Results"

# 17. Markdown rendering (profile)
xray profile @<handle> | head -1
# Must start with "# Profile"
```

---

## 16. Migration & Backward Compatibility

### 16.1 No Breaking Changes

Phase 4 is fully additive. No existing CLI flags, MCP args, or data model fields change. Specifically:

- `xray thread <url>` (no flags) behaves identically to v0.4.0.
- `ResearchReport` gains NO new fields. Search and profile are independent commands, not extensions of thread research.
- All existing MCP tools (`xray_thread`, `xray_video`, `xray_article`) remain unchanged.
- All existing ~538 tests pass without modification.
- New SQLite tables (`embedding_meta`, `profile_cache`) are created via migrations alongside existing tables.

### 16.2 New Dependencies

| Dependency | Size | Purpose | Native binaries? |
|---|---|---|---|
| `@xenova/transformers` | ~5MB (library) + ~100MB (model, downloaded on first use) | Local MiniLM-L6-v2 embedding inference via ONNX Runtime | ONNX Runtime WASM — no native compilation needed |
| `sqlite-vec` | ~2MB | SQLite extension for vector similarity search | Native binary per platform (pre-built binaries available for macOS/Linux arm64/x86_64) |

### 16.3 Install Size Impact

- **Without model:** ~7MB additional node_modules.
- **With model (first run):** ~107MB additional in `~/.xray/models/` (one-time, outside project directory).
- The model download happens lazily — `npm install` / `bun install` does NOT trigger it. Only the first `xray search`, `xray profile`, or `xray cache embed` does.

### 16.4 CHANGELOG Entry Suggestion

```markdown
## [0.5.0] - 2026-XX-XX

### Added
- **Semantic search** — `xray search "<query>"` searches across all cached XRay
  content by meaning using local MiniLM-L6-v2 embeddings. Zero API cost.
  Optional `--rerank` flag for LLM-powered result reranking (~$0.005).
- **Profile analysis** — `xray profile @<handle>` aggregates cached threads,
  comments, and articles for an X user and synthesizes topics, stance patterns,
  expertise areas, and notable quotes via Kyma.
- **`xray_search` MCP tool** — semantic search for AI agents.
- **`xray_profile` MCP tool** — profile analysis for AI agents.
- **`xray cache embed` command** — explicitly embed all cached content (runs
  lazily on first search/profile if not done manually).
- **`xray cache clear --profiles` flag** — clear only profile cache,
  preserving embeddings and thread data.
- **Local embedding infrastructure** — MiniLM-L6-v2 via `@xenova/transformers`
  (~100MB one-time download). All embeddings computed on-device, no data
  leaves the machine.
- **sqlite-vec vector search** — native SQLite extension for fast cosine
  similarity. Automatic fallback to pure-JS cosine on unsupported platforms.

### Dependencies
- **@xenova/transformers** (new) — local ONNX inference for MiniLM-L6-v2.
- **sqlite-vec** (new) — SQLite vector search extension.
```

---

## 17. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **MiniLM model size (~100MB) in install footprint** — users may balk at a 100MB download for a CLI tool that was previously lightweight. | Medium | Medium | Download is lazy (first use, not install). Clear progress bar + messaging. Model cached permanently. Size is comparable to yt-dlp + ffmpeg from P2. |
| **sqlite-vec native binary compatibility** — pre-built binaries may not be available for all platform/arch combinations. Windows support is uncertain. | Medium | Low | Pure-JS cosine fallback works on all platforms. Performance degraded (~10-50x slower for large vector stores) but correctness maintained. Documented as "degraded mode." |
| **Profile inference accuracy** — LLM-generated biographical claims (stance, expertise) may be inaccurate or misleading, especially with limited cached data. | Medium | Medium | Surface `samplingScope`, `cachedThreads`, and `cachedComments` counts so the consumer knows the evidence base. Confidence scores on stance claims. Clear "based on N cached items" disclaimer in Markdown. |
| **"No data" UX when running profile on uncached author** — default cache-only behavior means first-time users get an error unless they've already run `xray thread`. First-use friction. | High | Low | Clear error message with actionable instructions: `"Run xray thread on their content first, or use --fresh 20"`. The `--fresh` flag is the escape hatch. |
| **Embedding drift over time** — if the user upgrades `@xenova/transformers` or the MiniLM model, existing embeddings become incompatible with new ones. Cosine similarity breaks across model versions. | Low | Medium | Store model version in `embedding_meta` (or a metadata row). On model version mismatch, trigger re-embedding of all cached content. WARN log when this happens. |
| **Memory pressure from pure-JS cosine fallback** — loading all embeddings into memory for JS cosine similarity could exhaust RAM for users with very large caches (>100k items). | Low | Low | In P4, no handling for very large stores (defer to P5 polish). Practically, most users will have <10k items. At 384 dims x 4 bytes x 10k items = ~15MB — manageable. |
| **@xenova/transformers Bun compatibility** — `@xenova/transformers` is designed for Node.js. Bun compatibility is good but not officially supported. ONNX Runtime WASM should work. | Low | Medium | Test on Bun early in P4.0. If incompatible, evaluate `onnxruntime-node` as alternative. Both use the same ONNX model files. |

### Open Questions

1. **Model version tracking** — Should `embedding_meta` include a `model_version` column? Recommend: yes, store `'minilm-l6-v2-onnx-quantized'` as a string. On mismatch, prompt re-embedding.

2. **Lazy vs. explicit embedding** — Current spec: lazy embedding on first `xray search` / `xray profile` (embed any un-embedded cache items). Alternative: require explicit `xray cache embed` before search works. Recommend: lazy (current spec) with `xray cache embed` as an optional explicit trigger for users who want to control timing.

3. **Profile caching granularity** — Should the profile cache key include the count of cached items? If a user runs `xray thread` on 5 more threads and then re-runs `xray profile`, should the cache be invalidated? Recommend: yes, include `cachedItemCount` in the cache key so new data triggers re-synthesis.

---

## 18. Out of Scope (Explicit Deferrals)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Narrative / controversy tracking | Phase 5 | Temporal analysis of how stance/topics change over time. Requires timestamp-aware embeddings and drift detection. |
| Batch research (multiple threads/profiles at once) | Phase 5 | `xray batch` command for parallel processing. Orchestration complexity. |
| Custom embedding models (BYOM) | Phase 5+ | Configuration surface for alternative models. MiniLM-L6-v2 is sufficient for P4. |
| API-based embedding providers (OpenAI, Cohere, Voyage) | Phase 5+ | Adds cost + privacy concerns. Local-only in P4 is a deliberate privacy choice. |
| Profile comparison (A vs B) | Phase 5 | Side-by-side analysis of two profiles. Higher-level orchestration. |
| Cross-platform profile (X + GitHub + LinkedIn) | Phase 6+ | XRay is X-focused. Cross-platform identity resolution is out of scope. |
| Multi-user collaboration / shared vector stores | Phase 6+ | Different architecture (cloud storage, access control). |
| Real-time alerts / monitoring | Phase 6+ | "Notify me when someone tweets about X." Requires polling infrastructure. |
| Very large embedding store handling (>100k items) | Phase 5 | Pagination, streaming, approximate nearest neighbors. |
| Embedding model fine-tuning | Not planned | MiniLM-L6-v2 works well for general semantic similarity. Fine-tuning for X-specific content is overkill. |

---

**End of PHASE_4_PLAN.md**
