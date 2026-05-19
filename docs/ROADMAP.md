# XRay Roadmap

**Project:** XRay
**Status:** Draft
**Last Updated:** May 2026
**Vision:** A high-quality, open-source research tool that enables Grok CLI and AI agents to deeply understand content on X.

---

## Vision & Goals

XRay aims to become the best-in-class tool for **deep research on X**, with a strong focus on being usable and effective when called by AI agents (especially Grok CLI).

**Core Goals:**
- Deliver structured, high-quality insights from posts, threads, videos, and discussions on X.
- Make Kyma API the primary intelligence engine while remaining usable without it.
- Prioritize quality and reliability over speed and feature quantity.
- Be maintainable as a high-quality open source project.

---

## Overall Phased Approach

| Phase     | Name                         | Focus Area                          | Status          | Version   | Target  |
|-----------|------------------------------|-------------------------------------|-----------------|-----------|---------|
| Pre-Phase | Spec & Architecture          | Foundation, principles, decisions   | **Complete**    | -         | -       |
| **0**     | Foundation                   | Thread research + basic pipeline    | **Shipped**     | v0.0.1    | Q2 2026 |
| **1**     | Deep Conversation            | Full comment trees + analysis       | **Shipped**     | v0.2.0-v0.2.2 | Q2 2026 |
| **1.5**   | Invisible Auth Escalation    | SSR default + silent cookie inject  | **Shipped**     | v0.2.0    | Q2 2026 |
| **2**     | Video Understanding          | Video analysis on X                 | **Shipped**     | v0.3.0-v0.3.1 | Q2 2026 |
| **3**     | External Content             | Article & link understanding        | **Shipped**     | v0.4.0    | Q3 2026 |
| **4**     | Advanced Research            | Semantic search & narrative tools   | Planned         | -         | Q4 2026 |
| **5**     | Polish & OSS Readiness       | Hardening, docs, MCP, exports       | Planned         | -         | Q1 2027 |
| **6**     | Launch & Post-Launch         | Public release + iteration          | Planned         | v1.0      | Q1 2027 |

Phases 1–3 may run in parallel once Phase 0 is stable.

---

## Phase 0 — Foundation (most important)

**Goal:** Deliver a reliable base for researching X threads.

**Deliverables:**
- `xray thread <url>` command
- Full thread fetching (incl. quote tweets)
- Basic comment extraction
- Local SQLite caching
- Structured output (Zod)
- Basic Kyma API integration
- Basic MCP tool exposure
- Clean Markdown report generation
- Hybrid auth (anonymous → cookies fallback via `xray auth`)

**Success criteria:**
- `xray thread <url>` reliably returns a structured report.
- Output is directly usable by Grok CLI via MCP.
- Cache hits are <100 ms.

---

## Phase 1 — Deep Conversation ([Spec](./PHASE_1_PLAN.md))
- Full reply tree extraction via cursor pagination (top 50 x depth 3)
- Comment classification: stance (6 labels) + quality (5 labels) + qualityScore (0-1 float)
- Default shallow mode (heuristic filter + 2 Kyma calls) and deep mode (per-subtree + synthesis, ~11 calls)
- Partial-result handling with ThreadCoverage metadata
- Backward-compatible: existing CLI/MCP calls produce same output shape
- Ships as v0.2.0 in one PR with 4 internal sub-phases (P1.0 pagination → P1.1 classify → P1.2 scoring → P1.3 deep mode)

## Phase 1.5 — Invisible Auth Escalation ([Spec](./PHASE_1_5_PLAN.md))
- **Principle:** Auth is the last resort. Default invocation requires zero setup.
- 4-tier escalation: SSR scrape (Tier 1) -> anonymous Playwright (Tier 2) -> silent Chromium cookie inject (Tier 3) -> interactive auth (Tier 4)
- `xray thread <url>` (no flags) defaults to SSR-only (cheerio HTML parse, no browser launch, sub-2s)
- Silent cookie reader for Chrome, Brave, Edge on macOS (Keychain decrypt, PBKDF2 + AES-128-CBC)
- `xray auth --status` diagnostics subcommand
- `coverage.tier` field on every report
- Ships together with Phase 1 as v0.2.0 (hard break from Phase 0 default behavior, documented in CHANGELOG)
- 4 internal sub-phases (P1.5.0 SSR → P1.5.1 cookie reader → P1.5.2 escalation orchestrator → P1.5.3 auth --status)

## Phase 2 — Video Understanding ([Spec](./PHASE_2_PLAN.md))
- **Principle:** Video is a parallel-but-separate pipeline, always opt-in via `--video` flag (no surprise cost).
- Full pipeline: download (X-native direct / yt-dlp for YouTube+TikTok+Vimeo+LinkedIn) -> audio extract (ffmpeg) -> transcribe (Kyma Whisper) -> scene-detect frame extraction (ffmpeg, threshold 0.3, min 4 / max 12 clamp) -> vision analysis (Kyma multimodal) -> synthesis (Kyma chat) -> VideoReport
- Standalone `xray video <url>` command + `xray_video` MCP tool for direct video analysis
- `--video` flag on `xray thread` embeds `VideoReport` into `ResearchReport`
- No cost caps (deliberate decision) — cost surfaced via `estimatedCostUsd` field + debug logs + WARN on >10min videos
- Video cache: SQLite for transcript + vision, 1GB LRU eviction for downloaded files
- 4 internal sub-phases: P2.0 X-native skeleton -> P2.1 yt-dlp externals -> P2.2 caching -> P2.3 CLI+MCP+markdown
- Ships as v0.3.0 (fully additive, no breaking changes from v0.2.0)

## Phase 3 — External Content ([Spec](./PHASE_3_PLAN.md))
- **Principle:** External content is a parallel pipeline, always opt-in via `--articles` flag (no surprise cost).
- Full pipeline: URL classification (X Article / external-html) -> 3-tier fetch (undici+Readability -> cheerio fallback -> Playwright SPA fallback) -> Kyma summarization (summary + key points) -> cross-reference attribution (claim-passage mapping: supports/extends/contradicts/unrelated with confidence scores)
- Standalone `xray article <url>` command + `xray_article` MCP tool for direct article analysis
- `--articles` flag on `xray thread` embeds `ArticleSummary[]` into `ResearchReport`
- Covers both X Articles (native long-form) and external links (Substack, Medium, dev.to, personal blogs, any HTML page)
- No cost caps (carrying forward Son's P2 decision) — cost surfaced via `estimatedCostUsd` field + debug logs + WARN on >10k-word articles
- Article caching: SQLite for bodies (7-day TTL) + summaries (7-day TTL, keyed by tweet context hash for cross-reference isolation)
- Paywall graceful degradation: extract whatever is publicly available, flag `partial: true`
- New dependency: `@mozilla/readability` (Mozilla's article content extractor)
- 4 internal sub-phases: P3.0 X Article + simple summary + standalone -> P3.1 external link 3-tier fetch -> P3.2 full cross-reference attribution -> P3.3 MCP + CLI wiring + polish
- Ships as v0.4.0 (fully additive, no breaking changes from v0.3.1)

## Phase 4 — Advanced Research
- Semantic search over fetched content
- Profile analysis
- Narrative / controversy tracking
- Batch research & comparison

## Phase 5 — Polish & OSS Readiness
- Advanced caching + rate-limit handling
- Rich export formats (Markdown, JSON, Obsidian)
- Comprehensive documentation
- Stable, documented MCP tools
- Contribution guidelines

## Phase 6 — Launch
- v1.0 release
- GitHub release + announcement
- Grok CLI integration examples
- Community feedback loop

---

## Milestones

| Milestone | Target              | Description                          | Status |
|-----------|---------------------|--------------------------------------|--------|
| M0        | Pre-Phase           | Spec + Roadmap                       | Done   |
| M1        | End of Phase 0+1+1.5| First usable version (v0.2.0 = P0 + P1 + P1.5 combined) | Done (v0.2.2) |
| M2        | End of Phase 2      | Multimodal (thread + video) — v0.3.0 | Done (v0.3.1) |
| M2.5      | End of Phase 3      | Full content understanding (thread + video + articles) — v0.4.0 | Done (v0.4.0) |
| M3        | End of Phase 4      | Advanced research                    | Planned |
| M4        | End of Phase 5      | Production-ready OSS                 | Planned |
| M5        | Phase 6             | Public launch                        | Planned |

---

## Principles

- **Quality First** — Each phase must clear a quality bar before the next starts.
- **Agent-Centric** — Every feature considers Grok CLI consumption.
- **Kyma Preferred** — Heavy intelligence goes through Kyma.
- **Incremental Value** — Each phase ships usable value standalone.
- **OSS Sustainability** — Architecture + code support long-term contribution.

---

## Risks & Open Questions

- How fast does X change its UI? (Playwright selector module + weekly integration test)
- How much local intelligence (no Kyma) should we support? (Phase 5 decision)
- Right balance between cache aggressiveness and freshness?
- Should XRay long-term support multiple backends beyond Kyma?

---

**End of ROADMAP.md**
