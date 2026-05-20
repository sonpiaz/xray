# XRay

> Deep research on X (Twitter) for AI agents and humans who want to understand, not just scroll.

<!-- demo.gif lands in v1.0 (P5.2) -->

![version](https://img.shields.io/badge/version-0.5.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![tests](https://img.shields.io/badge/tests-669%20passing-brightgreen)
![runtime](https://img.shields.io/badge/runtime-bun%20%E2%89%A5%201.1-black)

XRay turns an X thread (or video, or linked article, or your entire research archive) into a structured, agent-readable report. Ships as a CLI **and** an MCP server, so the same tool drops cleanly into Grok CLI, Claude Code, or your terminal.

## Why XRay

- **Structured first.** Every output is typed (Zod) so agents can reliably reason over it. Markdown is a render of the JSON, never the source of truth.
- **Fetch once, understand many times.** Aggressive local SQLite cache means second runs are free and instant.
- **Strong-model brain.** Defaults to Kyma API (`gemini-2.5-flash`, 1M context); pluggable per command via `--model`.
- **Agent-native.** One MCP config and Grok / Claude can research threads, videos, articles, and your cache without leaving the chat.
- **Invisible auth.** No login flow for the common case — XRay silently borrows your browser's X cookies, falls back to logged-out HTML when it has to.

## Install

While XRay is pre-1.0 the install path is from source:

```bash
git clone https://github.com/sonpiaz/xray.git
cd xray
bun install
bunx playwright install chromium   # one-time, ~150 MB
cp .env.example .env               # then set KYMA_API_KEY
```

Requirements: [Bun](https://bun.sh) ≥ 1.1, macOS or Linux. `ffmpeg` is required for `xray video`. `yt-dlp` is only needed for non-X video platforms.

Get a Kyma key (free tier, no card):

```bash
curl -X POST https://kymaapi.com/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com"}'
```

## Quick Start

Five commands cover most usage:

```bash
# Research an X thread end-to-end (no flags = invisible auth, full reply tree)
bun run xray thread https://x.com/karpathy/status/1234567890

# Also analyze embedded video + any linked articles
bun run xray thread https://x.com/karpathy/status/1234567890 --video --articles

# Semantic search across everything you've ever researched (zero API cost)
bun run xray search "transformer scaling laws"

# Build a profile from cached threads for any handle you've researched
bun run xray profile @karpathy

# Start the MCP server (for Grok CLI / Claude Code)
bun run xray mcp
```

Sample output (`xray thread <url>`):

```markdown
# Thread Research — @karpathy · 2026-05-19

**Topic:** Why transformer scaling is decelerating
**Engagement:** 12.4k likes · 1.8k reposts · 423 replies
**Quote tweets:** 38
**Coverage:** tier=cookie · 47/50 replies fetched · depth 3 reached

## Summary
Karpathy argues that compute scaling alone is no longer producing
proportional capability gains. Three replies (Sutskever, Le, an anon
practitioner) push back with concrete counter-examples...

## Notable replies (top quality)
- @ilyasut (supports): "the regime change happened ~ GPT-4o, agreed"
- @quocvle (extends): "data quality is the new compute"
- @anon (dissents): "this is just Chinchilla rediscovered"
```

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

The agent gets five tools:

| Tool | What it does |
|---|---|
| `xray_thread` | Researches an X thread; optional embedded video + article analysis. |
| `xray_video` | Standalone video analysis (X-native, YouTube, TikTok, Vimeo, LinkedIn). |
| `xray_article` | Standalone article analysis (X Articles + external HTML + cross-reference). |
| `xray_search` | Semantic search across cached XRay content. Zero API cost; optional rerank. |
| `xray_profile` | Builds a topic/stance/expertise profile for an X handle from cached threads. |

All tools return both a Markdown rendering and a typed `structuredContent` JSON payload.

## How it works

`xray thread <url>` runs a silent 3-tier auth escalation — the user picks nothing:

```
Tier 1 — Cookie + Playwright (primary)
  Detect Chrome/Brave/Edge, read x.com cookies from their SQLite DB,
  decrypt via macOS Keychain, inject into a fresh Playwright context,
  fetch the full TweetDetail GraphQL — reply tree, metrics, quote tweets.
         │
         ▼  (no cookies / Keychain denied / no Chromium)
Tier 2 — SSR fallback
  Cheerio scrape of logged-out HTML. Sub-second. Root post only;
  X strips replies for logged-out clients in 2026.
         │
         ▼  (SSR also failed)
Tier 3 — Saved auth (last resort)
  Use ~/.xray/storageState.json from a previous `xray auth` run.
  If absent, surface a clear "run xray auth" message.
```

Every report carries `coverage.tier` (`'cookie' | 'ssr' | 'auth'`) so agents know which tier produced the data. `xray auth --status` shows the full picture without ever fetching or prompting Keychain.

## Phases shipped

v0.5.0 covers Phase 0–4: thread research, deep conversation, invisible auth, video understanding, external content, semantic search, and profile analysis. Phase 5 (polish + v1.0 launch) is in progress. See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the full table.

## Commands

| Command | Purpose |
|---|---|
| `xray thread <url>` | Research an X thread (default). `--video`, `--articles`, `--deep`, `--mode`. |
| `xray video <url>` | Standalone video analysis (X-native + YouTube + TikTok + Vimeo + LinkedIn). |
| `xray article <url>` | Standalone article analysis (X Articles + any HTML). |
| `xray search "<q>"` | Semantic search across cached content. `--rerank` for LLM rerank. |
| `xray profile @<h>` | Profile from cached threads (topics + stance + expertise). |
| `xray auth` | Log in once + save session; `--status` for diagnostics (never prompts Keychain). |
| `xray cache` | `info` / `clear` / `embed`. `clear --profiles` purges profile cache only. |
| `xray mcp` | Start MCP server over stdio. |

Run `bun run xray <command> --help` for flags.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bugs and feature ideas → [GitHub issues](https://github.com/sonpiaz/xray/issues). PRs welcome on `feat/*` or `fix/*` branches against `main`.

## License

MIT © Son Piaz
