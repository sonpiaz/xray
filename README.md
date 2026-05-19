# XRay

> Deep research on X (Twitter) for AI agents and humans who want to understand, not just scroll.

XRay is a high-quality open-source research engine for X. It pulls full threads, comment trees, quote tweets, media and linked articles, then runs them through a strong LLM (default: **Kyma API**) to produce structured, agent-readable insights.

**Built for Grok CLI and other AI agents first. Pleasant for humans second.**

```bash
xray thread https://x.com/karpathy/status/1234567890
```

```text
# Thread Research — @karpathy · 2026-05-18

**Topic:** Why transformer scaling is decelerating
**Author:** Andrej Karpathy (@karpathy)
**Engagement:** 12.4k likes · 1.8k reposts · 423 replies
**Quote tweets:** 38
**Notable replies:** 12 (see below)

## Summary
...
```

---

## Status

**v0.0.x — Phase 0 (Foundation).** Usable but rough. See [ROADMAP.md](./docs/ROADMAP.md).

| Phase | What it adds | Status |
|---|---|---|
| 0 | Thread fetch + comments + Kyma summary + MCP | In progress |
| 1 | Deep reply trees + quality scoring | Planned |
| 2 | Video understanding (frames + transcript) | Planned |
| 3 | External article cross-reference | Planned |
| 4 | Semantic search + narrative tracking | Planned |
| 5 | Polish + OSS readiness | Planned |

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
# research a thread
bun run xray thread https://x.com/karpathy/status/1234567890

# log in once if X starts rate-limiting anonymous fetches
bun run xray auth

# start MCP server (for Grok CLI / Claude Code)
bun run xray mcp

# cache controls
bun run xray cache info
bun run xray cache clear
```

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
