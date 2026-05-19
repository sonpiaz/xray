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

**v0.2.0 — Phase 1 + 1.5 (Deep threads + invisible auth escalation).** First "just works" release. See [CHANGELOG.md](./CHANGELOG.md) for full history.

| Phase | What it adds | Status |
|---|---|---|
| 0 | Thread fetch + comments + Kyma summary + MCP | Done (v0.0.1) |
| 1 | Deep reply trees + classification + `--deep` synthesis | Done (v0.2.0) |
| 1.5 | Invisible 3-tier auth (cookie → SSR → saved auth) + `--mode` overrides + `xray auth --status` | Done (v0.2.0) |
| 2 | Video understanding (frames + transcript) | Planned |
| 3 | External article cross-reference | Planned |
| 4 | Semantic search + narrative tracking | Planned |
| 5 | Polish + OSS readiness | Planned |

**v0.2.0 highlights:**

- Default `xray thread <url>` requires zero flags, zero setup, zero login for public threads.
- Reads your Chrome/Brave/Edge X cookies silently — one-time macOS Keychain "Always Allow" — to fetch the full reply tree.
- Falls back to SSR HTML scrape (root post only) when no cookies are available.
- New `xray auth --status` diagnostic to inspect what the orchestrator would do, without prompting Keychain.
- See [CHANGELOG.md](./CHANGELOG.md) for the full v0.2.0 entry and breaking changes (`--mode anon` removed).

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

# cache controls
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

The agent gets one tool: `xray_thread({ url })` → `ResearchReport`.

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
