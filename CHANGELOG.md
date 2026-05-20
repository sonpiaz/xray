# Changelog

All notable changes to XRay will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-05-19

Patch release that fixes two silent regressions surfaced by the v1.0.0
launch smoke test on `https://x.com/AnatoliKopadze/status/2056362875195686927`.
No CLI / MCP schema changes — drop-in upgrade.

### Fixed

- **X Article card extraction was silently broken in v1.0.0.** `xray thread <url> --articles` returned `articleSummaries: undefined` for tweets with an embedded X Article. The parser stashed the raw `tweet.card` blob under `XPost.raw.card` (preserved by `z.unknown()` on construction) but `collectArticleCandidates` only inspected `rootPost.raw`, and downstream code couldn't introspect the shape without re-walking `binding_values`. The candidate collector therefore emitted the silent debug log "articles flag set but no article candidates found on root/author posts" and the article pipeline never ran.
- **`coverage` field dropped to `undefined` on cache-hit paths.** The cache layer only persisted `XThread` (not `ThreadCoverage`), so every cache-hit run silently lost `report.coverage` even though classification + the report-level fields still ran. The catch-all `xray thread <url> --video --articles --json` smoke test surfaced this as `coverage: null` in the output despite `"classified top 40 of 75 replies"` sitting in `warnings`.

### Added

- **`XPost.card: XArticleCard` typed field.** Structured representation of an X tweet card (`url`, optional `title` / `byline` / `bodyText` / `publishedAt` / `raw`). Backward compatible — absent on tweets without a card. Populated at parse time by `parseTweetCard()`, surfaced to consumers without re-walking `binding_values`.
- **`parseTweetCard()` parser helper** (`src/fetcher/parser.ts`). Lifts `tweet.card` into a structured `XArticleCard` with URL-precedence fallback (`card.url` → `binding_values[card_url]` → `[url]` → `[article_url]`). Defensive — non-article cards (`summary_large_image`, `video_app`) get a URL + title but no body text.
- **Article candidate collector extended to scan author posts.** `collectArticleCandidates` now walks both `rootPost` AND `authorPosts` for the card channels (v1.0.0 only walked `rootPost.raw`). Articles dropped into 2/N or 3/N follow-ups are no longer missed.
- **Structured-card fast path in the article orchestrator.** When `analyze-thread.ts` passes a v1.0.1 `XArticleCard` with pre-extracted `bodyText`, the orchestrator skips `parseXArticle` (which would re-walk `binding_values`) AND skips the standalone Playwright round-trip.

### Tests

- +18 tests covering parser card surfacing on `XPost.card`, `parseTweetCard` URL precedence, non-article card fallback, candidate collector Channel 2 root+author scan with dedup against links, structured-card fast path in the orchestrator, and coverage preservation on cache-hit paths including the `--video --articles` interaction. Total: 703 → **721 passing**.

## [1.0.0] — 2026-05-19

**XRay v1.0 — first public release.**

This is the launch tag. XRay ships ready for production agent + human use, with full documentation, hardening, and community files. v1.0 is built in a single arc on top of the work shipped in v0.0.1 → v0.5.0; the entry below summarises everything that's in the release rather than only the P5-incremental delta.

### Phases included in v1.0

- **Phase 0** (`v0.0.1`) — scaffold, CLI, MCP server, SQLite cache.
- **Phase 1** (`v0.2.0`) — deep conversation: pagination, nested replies, stance/quality classification, deep mode. Default fetch became invisible-auth (breaking-change tracked in v0.2.0 entry).
- **Phase 1.5** (`v0.2.0`) — invisible 3-tier auth escalation (cookie → SSR → saved).
- **Phase 1.6** (`v0.2.1`, `v0.2.2`) — self-thread reconstruction + author-priority pagination.
- **Phase 2** (`v0.3.0`, `v0.3.1`) — video understanding (X-native + YouTube + TikTok + Vimeo + LinkedIn).
- **Phase 3** (`v0.4.0`) — external articles + cross-reference attribution.
- **Phase 4** (`v0.5.0`, partial) — semantic search + profile analysis (narrative + batch deferred to Phase 7).
- **Phase 5** (`v1.0.0`) — polish: docs rewrite, CONTRIBUTING, CoC, issue/PR templates, retry + warmup + MCP versioning, version bump.

### v1.0 stability commitments

- CLI flags + MCP tool schemas are stable. Breaking changes bump MAJOR per [`CONTRIBUTING.md`](./CONTRIBUTING.md) `## Breaking-change protocol`.
- All 5 MCP tools ship with `_meta: { version: "1.0" }`. **Per-tool version is independent of project semver** — it tracks tool schema compatibility (major.minor) and bumps only when an MCP tool's input/output shape changes. The package semver (`1.0.0`) tracks the CLI + package + cache shape.
- `xray thread <url>` default behavior is locked: cookie tier → SSR fallback → saved auth.
- Version-constant lockstep guarded by `tests/unit/version.test.ts` — future bumps must touch `package.json`, `src/cli/index.ts`, and `src/mcp/server.ts` together or the suite fails.

### Added (P5-specific delta from v0.5.0)

- **`xray warmup` command** — preheat the MiniLM embedding model + Playwright Chromium + SQLite so the first real `xray thread` doesn't pay cold-start tax in front of the user. `--json` for machine-readable output. Each step is best-effort: a downstream failure doesn't mask upstream success.
- **Rate-limit retry with exponential backoff + jitter** — new `src/core/retry.ts` shared utility wraps the Kyma API client and the X cookie-tier Playwright fetch. Retries on HTTP 429, 5xx, network timeouts, and empty-body rate-limit responses. Respects `Retry-After`. Surfaces clean user-facing errors after the final attempt — no stack traces for expected failures.
- **MCP `_meta.version: "1.0"`** stamped on all 5 tool registrations (`xray_thread`, `xray_video`, `xray_article`, `xray_search`, `xray_profile`). Callers can read `_meta.version` from `tools/list` for stable contract negotiation. Format documented in `CONTRIBUTING.md`.
- **CONTRIBUTING.md** — dev setup, test/lint commands, commit convention, PR process, breaking-change protocol, MCP tool versioning, release process.
- **CODE_OF_CONDUCT.md** — short project-specific covenant with positive framing.
- **GitHub issue templates** — `.github/ISSUE_TEMPLATE/{bug,feature,security}.md`. Security report routes to private email.
- **GitHub PR template** — `.github/PULL_REQUEST_TEMPLATE.md` with breaking-change + CHANGELOG checkboxes.
- **README rewrite** for v1.0 launch — tagline, install, 5-command quickstart, MCP setup snippet, architecture overview, contributing link. Pinned at ~165 lines (under the 400-line cap from the Phase 5 spec).
- **Demo assets** — `docs/demo.tape` (VHS source for the launch GIF), `docs/demo.sh` (asciinema-compatible script), `docs/DEMO.md` (plain-text walkthrough with real sample outputs). README links to the static walkthrough until the animated cast is rendered + uploaded.
- **`tests/unit/version.test.ts`** — guards that `package.json`, `src/cli/index.ts` VERSION, and `src/mcp/server.ts` VERSION never drift; asserts per-tool `TOOL_VERSION` stays in major.minor form (decoupled).

### Changed (P5-specific delta from v0.5.0)

- Version bumped to `1.0.0` across `package.json`, `src/cli/index.ts`, `src/mcp/server.ts`, and the `xray profile` markdown footer (`src/render/profile-markdown.ts`).
- `VERSION` constants in `src/cli/index.ts` and `src/mcp/server.ts` are now `export const` so the alignment test can read them; `TOOL_VERSION` likewise exported.
- README test-count badge bumped 669 → 702 (live count 703 incl. the new version guards).
- README "Phases shipped" paragraph rewritten — v1.0.0 now covers all five phases instead of "Phase 5 in progress".

### Test count

**703** unit tests passing across 44 test files (699 carried in from v0.5.0 + 4 new version-alignment guards). Live integration verified against real X content (cookie tier, video pipeline on the Anatoli Kopadze "Claude Code" talk, semantic search).

### Dependencies summary (final v1.0 baseline)

- **Runtime:** [Bun](https://bun.sh) ≥ 1.1, TypeScript.
- **Fetch:** [Playwright](https://playwright.dev) (Chromium), [undici](https://github.com/nodejs/undici), [cheerio](https://cheerio.js.org/).
- **Storage:** `bun:sqlite` + [sqlite-vec](https://github.com/asg017/sqlite-vec) (optional; pure-JS cosine fallback when extension can't load).
- **LLM:** [Kyma API](https://kymaapi.com) (chat + multimodal + Whisper audio).
- **Embeddings:** [@xenova/transformers](https://github.com/xenova/transformers.js) (local MiniLM-L6-v2, ~23 MB int8).
- **Article extraction:** [@mozilla/readability](https://github.com/mozilla/readability) + [linkedom](https://github.com/WebReflection/linkedom).
- **Video (optional):** [ffmpeg](https://ffmpeg.org/) (audio + frames), [yt-dlp](https://github.com/yt-dlp/yt-dlp) (external platforms).
- **MCP:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk).

### Known deferred work

- **Phase 7**: narrative / controversy tracking, batch research (`xray batch`), `--fresh N` profile fetching (real X timeline fetcher), comparison mode (A vs B). See [`docs/ROADMAP.md`](./docs/ROADMAP.md).
- **Phase 6**: launch ceremony — ProductHunt / HackerNews / Reddit announcement, optional brew tap formula, optional npm publish. Separate from this code release.

### Acknowledgements

Built in a tight 2-day sprint (2026-05-18 → 2026-05-19) via heavy use of Claude agents (executor / planner / explore) under the orchestration of [oh-my-claudecode](https://github.com/sonpiaz/oh-my-claudecode). Spec-first workflow plus tight feedback loops between human + agent.

## [0.5.0] — 2026-05-19

### Added
- **Advanced research (Phase 4 — partial).** Local-first semantic search + LLM-synthesized profile reports across all cached content. Opt-in commands; no change to existing `xray thread` behavior.
- **Local embeddings via @xenova/transformers** (`Xenova/all-MiniLM-L6-v2`, ~23 MB int8 model, one-time download). 384-dim vectors stored in SQLite. Zero API cost, no data exfiltration. Bun-compatible (validated via spike before P4.0).
- **`xray cache embed` command** — walk all cached posts, threads, comments, and article bodies; embed any unembedded or content-drifted items. Idempotent. Reports `{ embedded, skipped, durationMs }`.
- **`xray search "<query>"` standalone command** with `--limit`, `--threshold`, `--type`, `--rerank` flags. Returns top-K cached matches sorted by cosine similarity. Optional Kyma rerank for ~$0.005 extra.
- **`xray_search` MCP tool** for agent callers.
- **`xray profile @<handle>` standalone command** — cache-only aggregation; builds topics + stance + expertise areas + notable quotes from cached content. 3 Kyma calls (~$0.05-0.20 per profile). 24h cache via `profile_cache` table. Lenient JSON repair on the 3 synthesis calls — drops unrepairable rows, keeps valid (P1.6 / P3.2 pattern).
- **`xray_profile` MCP tool**.
- **`xray cache clear --profiles`** for purging profile cache only (preserves posts/threads/embeddings).
- **`sqlite-vec` extension** loaded when available; pure-JS cosine fallback when not (Bun's extension loading is limited). JS fallback is fast for <10k vectors and is what most users will run.

### Changed
- `package.json`, CLI, and MCP server version bumped to `0.5.0`.

### Dependencies
- `@xenova/transformers` (~23 MB MiniLM model downloaded on first use, cached at `~/.xray/models/`). First introduced in P4.0.
- `sqlite-vec` (optional — runtime loadable extension; falls back to pure-JS cosine when not loadable, e.g., on this Bun build). First introduced in P4.0.

### Out of scope (deferred to P5+)
- Narrative / controversy tracking (temporal stance drift).
- Batch research (`xray batch`).
- `--fresh N` profile fetching (would require an X timeline fetcher). The `--fresh` flag is present on the CLI + MCP shape today but silently degrades to cache-only with a `warnings[]` entry.
- Custom embedding models (BYOM).
- Profile comparison (A vs B).

## [0.4.0] — 2026-05-19

### Added
- **External content understanding (Phase 3).** Opt-in `--articles` flag on `xray thread` + new standalone `xray article <url>` + `xray_article` MCP tool. Fetches X Articles (native long-form) AND external HTML (Substack, Medium, dev.to, GitHub, generic blogs) via 3-tier fetch (undici + cheerio meta → Mozilla Readability → Playwright SPA fallback).
- **Cross-reference attribution.** When called from a thread context, maps tweet claims to specific article passages with relationship (`supports` | `extends` | `contradicts` | `unrelated`) and confidence (0-1). Cached separately per `(url_canonical, tweet_context_hash)` so the same article cross-referenced against two different threads gets two distinct cache rows.
- **Paywall detection** with `partial: true` + clear errors so callers know coverage is limited.
- **URL canonicalization** — strips tracking params (`utm_*`, `fbclid`, etc.), resolves `t.co` shorteners, sorts query params for stable cache keys.
- **`ResearchReport.articleSummaries[]`** optional field — populated when `--articles` runs and at least one article is detected. Capped at 5 articles per thread (defensive cost cap, mirrors the 3-video cap pattern).
- **Markdown article section** embedded into `xray thread` output (and full standalone document for `xray article`). Renders title, author/published/word-count meta, summary, key points, cross-reference table (top 8 by confidence). Long bodies (>20k chars) ship a clipped excerpt block.
- **`xray_article` MCP tool** with input shape `{ url, noCache?, tweetContext?, tweetPostId?, model?, synthesize?, format? }`. Defaults `synthesize=true` (opposite of `xray_video`) because article summaries are surfaced to humans more often than raw video transcripts; agents can opt out.
- **`articles` arg on `xray_thread` MCP tool** — boolean, defaults false. Independent and composable with `video` and `deep`.

### Changed
- `package.json`, CLI, and MCP server version bumped to `0.4.0`.

### Dependencies
- `@mozilla/readability` + `linkedom` for HTML article extraction. Both pure JS, no native binaries.

## [0.3.1] — 2026-05-19

### Fixed
- **X-native video pipeline was completely broken in v0.3.0.** Every tweet with a direct video failed with "Unsupported platform" because the parser passes the raw `video.twimg.com` CDN URL into the video pipeline (not the tweet page URL), and platform detection only recognised `x.com`/`twitter.com` hosts. Surfaced by the first live `--video` test on 2026-05-19. Two fixes: (1) `downloadVideo` now trusts a caller-supplied `mediaHint: { type: 'video' }` as authoritatively X-native regardless of URL host; (2) `detectPlatform` recognises `video.twimg.com` and `pbs.twimg.com` defensively.
- Live test after fix: 27m52s Claude Code talk transcribed (28K chars), 8 key moments, $0.108 cost, full summary.

## [0.3.0] — 2026-05-19

### Added

- **Video understanding pipeline (Phase 2).** Analyze X-native videos + YouTube + TikTok + Vimeo + LinkedIn with full transcript (Whisper-large-v3-turbo), hybrid scene-detect frame extraction, batched Kyma vision, and structured synthesis. Every report ships with `transcript`, `frames.analyses[]`, `keyMoments[]`, `visualContext[]`, `summary`, and `topic`.
- **`xray video <url>` standalone command** for direct video analysis. Flags: `--json`, `-o <path>`, `--no-cache`, `--raw`, `--model <name>`, `--frames <n>`.
- **`xray_video` MCP tool** for agent callers. Returns a `VideoReport` as both `structuredContent` and Markdown. **Default skips XRay-side Kyma synthesis** — caller agents (Grok/Claude) typically summarise better with their own context. Set `synthesize: true` if you want a pre-built summary (~$0.02/video). CLI `xray video` keeps synthesis on by default for human readers.
- **`--video` flag on `xray thread`** to embed video analysis when the root post or author follow-ups contain `type === 'video'` media. Capped at 3 videos per thread to avoid runaway cost. Failures degrade into `warnings[]`; the rest of the report still ships.
- **`ResearchReport.videoAnalysis: VideoReport[]`** optional field — populated when `--video` runs and at least one video is detected.
- **Markdown video section** embedded into `xray thread` output (and full standalone document for `xray video`). Renders `Source`, `Duration`, `Estimated cost`, `Summary`, `Key Moments`, `Visual Context`, and a truncated `Transcript` excerpt.
- **LRU video cache** at `~/.xray/cache/video/`, default 5 GB cap (configurable via `XRAY_VIDEO_CACHE_MAX_GB` env var). Transcript + vision results cached separately in SQLite by canonical URL and SURVIVE mp4 eviction — re-runs hit the intelligence cache without re-downloading.
- **Per-video cost surfacing** via `estimatedCostUsd` + `costBreakdown` fields on every `VideoReport`. Debug-level per-stage cost logs (`stage: transcribe|vision|synthesis|total`). WARN-level log when a downloaded video exceeds 10 minutes.

### Changed

- `package.json`, CLI, and MCP server version bumped to `0.3.0`.

### Dependencies

- `yt-dlp` required for external platforms (YouTube, TikTok, Vimeo, LinkedIn) — optional, X-native videos work without it. Install: `brew install yt-dlp` or `pipx install yt-dlp`.
- `ffmpeg` required for all video features (audio extract + frame extraction).

## [0.2.2] — 2026-05-19

### Added
- **Author-priority pagination.** `ShowMore` sub-cursors whose parent comment is an OP-reply-to-commenter (`isAuthorReply` from v0.2.1) now jump to the front of the Phase B queue, so the highest-signal nested conversations expand before random sub-threads.
- **Adaptive request budget.** Threads with self-thread continuations (`authorPosts.length >= 2`) or very busy comment sections (`>200` comments) get the pagination budget bumped 2× (capped at 3× ceiling). Surfaced via debug log.
- **Early-stop at 5 author replies.** Phase B exits once `≥5` `isAuthorReply` comments are fetched — enough context, stop burning budget.

### Fixed
- Karpathy-class threads previously reported `depth 1/3` because Phase A (top-level pagination) consumed the request budget before Phase B (nested) could run. The adaptive bump + author-first queue together let Phase B reach the high-signal sub-threads within budget.

## [0.2.1] — 2026-05-19

### Added
- **Self-thread reconstruction.** Parser now detects same-author continuation tweets (Karpathy-style 2/N, 3/N) inside X's `VerticalConversation` GraphQL modules and routes them into `XThread.authorPosts` instead of dropping them as flat comments.
- **Author-engagement flag.** New `isAuthorReply: boolean` on `XComment` marks comments where the OP is replying to another commenter. Surfaced as a dedicated "Author engagement" Markdown section.
- **Unified author-thread render.** When the thread has follow-ups, Markdown output now shows a single numbered `[1/N]`, `[2/N]` narrative block under `## Source — Author Thread` instead of the previous root-only quote + separate follow-ups list.
- **LLM prompt sharpening.** System prompt explicitly states "root + authorPosts form a single thesis" and "author replies are HIGH-SIGNAL"; user prompt now tags author-engagement replies with `[AUTHOR REPLY]` so the model weighs them appropriately.

### Fixed
- Karpathy-style threads previously reported `authorPosts.length === 0` even when X returned the continuation tweets — readers concluded the OP posted only one tweet.

## [0.2.0] — 2026-05-19

### Breaking Changes

- **Default fetch is now invisible-auth, not anonymous Playwright.** `xray thread <url>` (no flags) silently reads your Chrome / Brave / Edge X cookies, decrypts them via macOS Keychain (one-time "Always Allow" prompt), and runs an authenticated fetch — full reply tree, metrics, quote tweets. When no cookies are available it falls back to an SSR HTML scrape (root post only). The Phase 1 default was unauthenticated Playwright and failed on every login wall.
- **`--mode anon` removed.** The anonymous-Playwright tier returned the same content as SSR but slower. Replace with `--mode ssr` (no-auth) or `--mode cookie` (force cookie injection, no fallback).
- **MCP `mode` enum** is now `'auto' | 'ssr' | 'cookie' | 'auth'`. Callers still passing `mode: 'anon'` will get a Zod parse error.

### Added

- **3-tier invisible auth escalation** (Cookie+Playwright → SSR fallback → saved `xray auth`). The user picks no tiers; the orchestrator runs the chain silently. Spec: `docs/PHASE_1_5_PLAN.md`.
- **Silent Chromium cookie reader** for Chrome, Brave, and Edge on macOS — opens the Cookies SQLite DB read-only, decrypts only the X-domain rows via PBKDF2 + AES-128-CBC, never logs or persists values.
- **`xray auth --status`** diagnostic subcommand: shows detected browsers, X cookie counts, storageState presence, and the active tier — without ever triggering a Keychain dialog.
- **`--mode ssr` and `--mode cookie`** direct-mode overrides for headless servers, CI, debugging, or guaranteeing the cookie path.
- **`coverage.tier`** field (`'ssr' | 'cookie' | 'auth'`) on every ResearchReport so downstream agents can see how the data was obtained.
- **SSR fetcher** — cheerio-based sub-second fetch with no Playwright dependency. Extracts the root post (text, author, OG image) from logged-out HTML.
- **Deep reply trees** — cursor-based pagination through "Show more replies" branches up to `--depth` / `--max-replies`.
- **Reply classification** — Kyma-scored stance + quality labels for every comment in the tree.
- **Engagement pre-filter** with "Top Quality" and "Dissenting" sections in the markdown report.
- **`--deep` mode** — per-subtree Kyma calls plus a cross-subtree synthesis pass (~10× cost, much richer analysis).

### Changed

- `xray thread <url>` no longer requires login for public threads — the cookie tier covers most users invisibly, SSR covers the rest.
- Markdown output now surfaces the tier and coverage status so users know whether they got the full thread or just the root post.

### Fixed

- Anonymous Playwright dead-ending on auth walls — the escalation chain now tries cookies automatically and only surfaces an auth prompt as a last resort.
- `XRAY_HEADLESS` env var no longer flips truthy on the literal string `"false"`.

## [0.0.1] — 2026-05-18

### Added
- Initial scaffold — CLI, MCP server, basic thread fetching, SQLite cache.
