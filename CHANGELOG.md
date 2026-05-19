# Changelog

All notable changes to XRay will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Dependencies (optional)

- `yt-dlp` required for external platforms (YouTube, TikTok, Vimeo, LinkedIn). X-native videos work without it. Install: `brew install yt-dlp` or `pipx install yt-dlp`.
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

- Initial scaffold — CLI, MCP server, basic thread fetching, SQLite cache.
