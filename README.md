# XRay

> Deep research on X (Twitter) for AI agents and humans who want to understand, not just scroll.

XRay is a high-quality open-source research engine for X. It pulls full threads, comment trees, quote tweets, media and linked articles, then runs them through a strong LLM (default: **Kyma API**) to produce structured, agent-readable insights.

**Built for Grok CLI and other AI agents first. Pleasant for humans second.**

```bash
xray thread https://x.com/karpathy/status/1234567890
```

```text
# Thread Research — @karpathy · 2026-05-19

**Topic:** Why transformer scaling is decelerating
**Author:** Andrej Karpathy (@karpathy)
**Engagement:** 12.4k likes · 1.8k reposts · 423 replies
**Quote tweets:** 38
**Notable replies:** 12 (see below)

## Conversation Analysis
**Tier:** cookie · **Coverage:** 47/50 replies fetched · depth 3 reached

## Summary
...
```

---

## Status

**v0.4.0 — Phase 3 (External content understanding).** XRay now reads articles linked from threads + cross-references tweet claims to article passages. See [CHANGELOG.md](./CHANGELOG.md) for full history.

| Phase | What it adds | Status |
|---|---|---|
| 0 | Thread fetch + comments + Kyma summary + MCP | Done (v0.0.1) |
| 1 | Deep reply trees + classification + `--deep` synthesis | Done (v0.2.0) |
| 1.5 | Invisible 3-tier auth (cookie → SSR → saved auth) + `--mode` overrides + `xray auth --status` | Done (v0.2.0) |
| 2 | Video understanding (transcript + scene-detect frames + synthesis) | Done (v0.3.0) |
| 3 | External content (X Articles + external links + cross-reference) | Done (v0.4.0) |
| 4 | Semantic search + narrative tracking | Planned |
| 5 | Polish + OSS readiness | Planned |

**v0.4.0 highlights:**

- Opt-in `--articles` flag on `xray thread`; standalone `xray article <url>` + `xray_article` MCP tool.
- 3-tier fetch: undici + cheerio meta → Mozilla Readability → Playwright SPA fallback (handles SPAs like Notion / dev.to).
- Cross-reference attribution: maps tweet claims to article passages with `supports` / `extends` / `contradicts` / `unrelated` + confidence.
- Paywall detection (`partial: true`) + URL canonicalization (tracking params stripped, `t.co` resolved).
- Capped at 5 articles per thread; cost surfaced via `estimatedCostUsd`.
- See [CHANGELOG.md](./CHANGELOG.md) for the full v0.4.0 entry.

**v0.3.0 highlights:**

- `xray video <url>` — standalone command for any video (X-native, YouTube, TikTok, Vimeo, LinkedIn).
- `xray thread <url> --video` — embed video analysis directly in the thread report when the root post (or author follow-ups) contains video.
- `xray_video` MCP tool + `video` arg on `xray_thread` for agent callers.
- Per-video cost surfaced via `estimatedCostUsd` + `costBreakdown`; debug-level per-stage cost logs; WARN on videos over 10 minutes.
- LRU video cache (1 GB) at `~/.xray/cache/video/` keyed by canonical URL — second runs hit cache for transcript + vision.
- Requires `ffmpeg` for audio + frame extraction; `yt-dlp` only needed for external platforms (X-native works without it).
- See [CHANGELOG.md](./CHANGELOG.md) for the full v0.3.0 entry.

---

## Why XRay?

- **Structured first.** Every output is typed (Zod) so agents can reliably reason over it.
- **Fetch once, understand many times.** Aggressive local SQLite cache.
- **Strong-model brain.** Defaults to Kyma API (`gemini-2.5-flash` for 1M context); pluggable.
- **Agent-native.** Ships as a CLI *and* an MCP server. Drop into Grok CLI / Claude Code in one line.

---

## Quick start

### Install (from source, while pre-1.0)

```bash
git clone https://github.com/sonpiaz/xray.git
cd xray
bun install
bunx playwright install chromium
cp .env.example .env
# edit .env: set KYMA_API_KEY
```

### Get a Kyma key (30s, free tier)

```bash
curl -X POST https://kymaapi.com/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com"}'
```

### Use it

```bash
# research a thread — no flags needed (invisible auth escalation)
bun run xray thread https://x.com/karpathy/status/1234567890

# inspect what auth sources are available (never prompts Keychain)
bun run xray auth --status

# save a login session as a last-resort fallback
bun run xray auth

# force-mode overrides for headless / CI / debug
bun run xray thread https://x.com/karpathy/status/1234567890 --mode ssr
bun run xray thread https://x.com/karpathy/status/1234567890 --mode cookie

# start MCP server (for Grok CLI / Claude Code)
bun run xray mcp

# analyze a video (X-native, YouTube, TikTok, Vimeo, LinkedIn)
bun run xray video https://x.com/user/status/123
bun run xray video https://youtu.be/<id> --json
bun run xray video https://x.com/user/status/123 --raw   # transcript + frames, skip synthesis

# embed video analysis inside a thread report
bun run xray thread https://x.com/karpathy/status/1234567890 --video

# analyze a linked article (X Article, Substack, Medium, dev.to, any HTML)
bun run xray article https://some-substack.com/p/some-post
bun run xray article https://x.com/user/status/123  # tweet URL hosting an X Article
bun run xray article https://some-blog.com/post --raw  # body only, skip summary

# embed article analysis (+ cross-reference) inside a thread report
bun run xray thread https://x.com/karpathy/status/1234567890 --articles

# both video AND articles in one thread call
bun run xray thread https://x.com/karpathy/status/1234567890 --video --articles

# cache controls (now includes video cache stats)
bun run xray cache info
bun run xray cache clear
```

---

## How it works (3-tier invisible auth)

`xray thread <url>` runs a silent escalation chain — the user picks nothing.

1. **Tier 1 — Cookie+Playwright (primary).** Detect Chrome/Brave/Edge, read x.com cookies from their on-disk SQLite DB, decrypt via macOS Keychain (one-time "Always Allow" per browser), inject into a fresh Playwright context, fetch the full TweetDetail GraphQL response — reply tree, metrics, quote tweets, the works.
2. **Tier 2 — SSR fallback.** No Chromium installed, not logged in, or Keychain denied? Fall back to a cheerio-based scrape of the logged-out HTML. Sub-second; returns the root post (text, author, image) only — X strips replies for logged-out clients in 2026.
3. **Tier 3 — Saved auth (last resort).** Both tiers above failed and `~/.xray/storageState.json` exists from a previous `xray auth` run? Use it. If not, surface a clear "run `xray auth`" message.

Every report carries `coverage.tier` (`'cookie' | 'ssr' | 'auth'`) so agents know which tier produced the data. `xray auth --status` shows the full picture without ever fetching or prompting Keychain. See `docs/PHASE_1_5_PLAN.md` for the architecture spec.

---

## Use from Grok CLI / Claude Code (MCP)

Add to your MCP config:

```json
{
  "mcpServers": {
    "xray": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/xray/bin/xray.ts", "mcp"],
      "env": { "KYMA_API_KEY": "sk-..." }
    }
  }
}
```

The agent gets three tools:

- `xray_thread({ url, video?, articles?, ... })` → `ResearchReport` (with optional embedded `videoAnalysis[]` when `video: true`, and `articleSummaries[]` when `articles: true`).
- `xray_video({ url, raw?, format? })` → `VideoReport` (standalone video analysis).
- `xray_article({ url, tweetContext?, synthesize?, format? })` → `ArticleSummary` (standalone article analysis; defaults `synthesize: true`, opposite of `xray_video`).

---

## Architecture

```
CLI / MCP
    │
    ▼
Research Engine
├── Fetcher (Playwright)  ──── cache (SQLite) ────► raw XPost / XThread / XComment
│
└── Intelligence Layer
    └── Kyma client ─► summary + key insights + comment classification
                                   │
                                   ▼
                        ResearchReport (JSON + Markdown)
```

Hard separation between **fetching** and **understanding** — see [SPEC.md](./docs/SPEC.md).

---

## Design principles

1. **Quality over speed.** Caching makes the second call fast.
2. **Structured output first.** Markdown is a render; JSON is the source of truth.
3. **Kyma is the brain.** Local fallbacks exist for transcription/etc but the default is to ask a strong model.
4. **Don't be a scraper.** XRay is a research tool, not a data harvester. Be polite to X.

---

## Contributing

Pre-Phase-0; the API is unstable. Issues and discussion welcome — code PRs once Phase 0 lands.

---

## License

MIT © Son Piaz
