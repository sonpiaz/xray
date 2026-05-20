# XRay — 60-second walkthrough

> Plain-text demo for offline viewing. The animated version lives at [`./demo.gif`](./demo.gif) (rendered from [`./demo.tape`](./demo.tape)) or as an asciinema cast at [`./demo.sh`](./demo.sh).

This walkthrough mirrors the 5 scenes in the VHS tape. Output snippets are real (cookie-tier fetches against live X, video pipeline against the Anatoli Kopadze "Claude Code" talk).

---

## 0. Version

```bash
$ xray --version
xray/1.0.0
```

## 1. Research a thread end-to-end (cookie tier, silent)

No login flow, no flags, no prompts — XRay borrows your browser's X cookies, decrypts them via Keychain, fetches the full reply tree, and runs Kyma-backed classification.

```bash
$ xray thread https://x.com/karpathy/status/1234567890
```

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
- @ilyasut    (supports):  "the regime change happened ~ GPT-4o, agreed"
- @quocvle    (extends):   "data quality is the new compute"
- @anon       (dissents):  "this is just Chinchilla rediscovered"
```

The `coverage.tier` line tells the caller (human or agent) exactly which fetch tier produced the data — `cookie`, `ssr`, or `auth`.

## 2. Add video understanding

```bash
$ xray thread https://x.com/AnatoliKopadze/status/2056362875195686927 --video
```

```markdown
... (thread body) ...

## Embedded video — 27m52s

**Source:** x.com (native)
**Estimated cost:** $0.108  (transcribe: $0.012, vision: $0.087, synthesis: $0.009)

**Summary**
Anatoli walks through his Claude Code workflow: spec-first prompts,
agent orchestration via oh-my-claudecode, multi-CLI session coordination,
and the "explore → plan → execute → verify" wave pattern. Closes with a
demo of `/ralph` driving 80 minutes of unattended work.

**Key moments**
- 02:14  — Why spec-first beats vibe-coding
- 09:33  — Live demo: 3 parallel Explore agents
- 17:08  — Anti-pattern: amending hook-failed commits
- 24:01  — Recap + Q&A
```

Cost is surfaced per-stage and per-video so agents can budget.

## 3. Semantic search across the cache

Local MiniLM-L6-v2 embeddings (23 MB, downloaded once). Zero API cost.

```bash
$ xray search "claude code prompts"
```

```
Found 4 matches across cached XRay content:

  0.812  thread    @karpathy   2026-05-19   "spec-first prompt engineering ..."
  0.787  video     @anatoli    2026-05-19   "[09:33] live demo: 3 parallel explore agents"
  0.741  article   simonw.net  2026-05-12   "How I'm using Claude Code in 2026"
  0.703  comment   @swyx       2026-05-15   "the prompt IS the product now"

Tip: re-run with --rerank for LLM-scored re-ordering (~$0.005 extra).
```

## 4. Profile aggregation from cached threads

```bash
$ xray profile @karpathy
```

```markdown
# Profile — @karpathy

**Topics:** transformer scaling, training dynamics, education, OS-as-LLM
**Stance:** pragmatic-skeptic on AGI timelines; bullish on data quality
**Expertise:** training infrastructure (10/10), tokenization (9/10), curricula design (8/10)
**Notable quotes:**
- "data quality is the new compute"
- "the prompt IS the program"
- "RL is just supervised learning with extra steps and a worse loss"

*Built from 14 cached threads (2026-04-02 → 2026-05-19). Use --fresh N to refetch.*
```

## 5. Use it from your agent (MCP)

XRay ships as both a CLI and an MCP server. Drop this into `~/.config/claude/settings.json` or the Grok CLI equivalent:

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

The agent then has five tools — `xray_thread`, `xray_video`, `xray_article`, `xray_search`, `xray_profile` — each carrying `_meta: { version: "1.0" }` for stable contract negotiation.

---

## What XRay replaces

```
Without XRay:
  1. Open X, scroll a 200-reply thread
  2. Click through 5 linked articles
  3. Watch a 30-minute embedded video
  4. Manually note who said what
  → 45 minutes, ~20% retained.

With XRay:
  $ xray thread <url> --video --articles
  → Structured report in ~30 seconds.
  → Every reply classified, every article summarized, video transcribed.
  → Semantic search across everything you've ever researched.
```

For setup, install, and contributor docs see [`../README.md`](../README.md) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
