# XRay — Design Specification

**Status:** Draft v0.2
**Project:** XRay
**Type:** Open Source CLI Tool + MCP Server
**Primary Backend:** Kyma API
**Target Audience:** Grok CLI, AI Agents, Power Users
**Date:** May 2026

---

## 1. Project Overview

**XRay** is a high-quality research tool focused on deep analysis of content on X (Twitter).

Its primary purpose is to help AI agents (especially Grok CLI) and advanced users understand posts, threads, videos, and discussions on X at a much deeper level than what current tools provide.

XRay is **not** a Twitter client or a mass scraping tool. It is a **research engine** that prioritizes depth, structure, and reliability.

**Core Philosophy:**
- Quality over speed
- Structured data first
- Intelligence should come from strong models (Kyma API as primary)
- Built to be consumed by other AI agents

---

## 2. Goals and Non-Goals

### Goals

- Provide deep, structured understanding of X content (threads, comments, videos, linked articles).
- Become a reliable research tool that Grok CLI and other agents can depend on.
- Deliver high-quality, structured output that LLMs can easily consume.
- Support both **Kyma API** (recommended) and local/limited modes.
- Be maintainable and high-quality as an open-source project.

### Non-Goals (at least in early phases)

- Real-time monitoring / streaming of X
- Mass data collection or scraping at scale
- Building a general-purpose Twitter client
- Supporting every possible X feature from day one

---

## 3. Positioning & Target Users

| Priority | User Type              | Main Use Case                              | Expectation |
|---------|------------------------|--------------------------------------------|-----------|
| 1       | Grok CLI & AI Agents   | Deep research before answering or deciding | Structured, reliable data + insights |
| 2       | Power users            | In-depth research on narratives & debates  | High-quality summaries + context |
| 3       | Developers             | Building X-related agent workflows         | Good APIs and structured output |

---

## 4. Architecture

### Core Principle

**Separation between Data Collection and Intelligence.**

- **Fetching Layer**: Responsible for reliably collecting raw data from X (using Playwright).
- **Intelligence Layer**: Responsible for understanding and extracting insights (primarily powered by Kyma API).

### High-Level Architecture

```
┌──────────────────────────────┐
│         XRay CLI             │
└──────────────┬───────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│           Research Engine                   │
│  ┌──────────────────────┐   ┌─────────────┐ │
│  │   Fetching Layer     │   │  Cache      │ │
│  │   (Playwright)       │   │  (SQLite)   │ │
│  └──────────┬───────────┘   └─────────────┘ │
│             │                               │
│             ▼                               │
│  ┌──────────────────────┐                   │
│  │  Processing Layer    │                   │
│  │  - Thread Builder    │                   │
│  │  - Comment Tree      │                   │
│  │  - Media Processor   │                   │
│  └──────────┬───────────┘                   │
│             │                               │
│             ▼                               │
│  ┌──────────────────────┐                   │
│  │ Intelligence Layer   │ ◄── Kyma API      │
│  │ (Analysis & Insight) │                   │
│  └──────────────────────┘                   │
└─────────────────────────────────────────────┘
               │
               ▼
        Structured Output
     (JSON + Markdown + MCP)
```

---

## 5. Tech Stack

| Layer                    | Technology                     | Reason |
|--------------------------|--------------------------------|--------|
| Runtime                  | Bun + TypeScript               | Fast, modern, good ecosystem fit |
| CLI                      | `cac`                          | Lightweight and full control |
| Browser Automation       | Playwright                     | Most stable way to interact with X |
| Local Storage            | `bun:sqlite`                   | Zero-config, native to Bun (SPEC deviation: was `better-sqlite3` — switched to avoid native-binding pain) |
| Schema Validation        | Zod                            | Excellent for structured output |
| HTTP                     | Undici                         | Native and high performance |
| Testing                  | Vitest + Playwright Test       | Fast and capable |
| MCP Support              | `@modelcontextprotocol/sdk`    | Required for Grok CLI integration |
| Configuration            | Zod + dotenv                   | Type-safe configuration |

**Key Decisions:**
- Playwright is used **only for data collection**, not for analysis.
- Heavy analysis (summarization, video understanding, insight extraction) goes through **Kyma API**.
- SQLite is used for caching and local persistence.

---

## 6. Core Principles

1. **Structured Output First** — Every major feature returns typed data before rendering Markdown.
2. **Kyma API as Primary Brain** — Prefer Kyma for understanding tasks.
3. **Fetch Once, Understand Many Times** — Aggressive caching so different questions don't re-fetch.
4. **Quality over Completeness** — Better to deeply understand a smaller set than skim more.
5. **Agent-First Design** — Easy and natural to use from Grok CLI via MCP.

---

## 7. Data Models (Core)

Foundational models:

- `XPost` — single post (id, author, text, media, metrics, timestamp)
- `XThread` — root post + replies-from-same-author chain + quote tweets
- `XComment` — reply node with tree structure
- `XMedia` — image / video / gif with metadata
- `XExternalLink` — article, YouTube, etc.
- `ResearchReport` — final structured output (summary, key insights, sources)

All models serialize cleanly to JSON and Markdown.

---

## 8. Phase Breakdown

See [ROADMAP.md](./ROADMAP.md) for the full phased plan.

---

## 9. Integration with Grok CLI

XRay supports two usage modes:

1. **Direct CLI** — for humans.
2. **MCP Tool** — for Grok CLI and other compatible agents (stdio transport).

Returned data must be structured so Grok can reason over it effectively.

---

## 10. Key Technical Decisions

- **Playwright vs Alternatives** — Chosen for stability against X's anti-bot measures.
- **Caching Strategy** — Aggressive caching at post / thread / kyma-response level.
- **Error Handling** — Clear distinction between transient errors (retry) and permanent failures (surface to user).
- **Output Philosophy** — Always prioritize structured data over pretty text.
- **Auth Mode** — Hybrid: anonymous first, fall back to user-supplied cookies (`xray auth`) when needed.

---

## 11. Open Source Considerations

- **License:** MIT
- Usable without a Kyma API key (reduced capabilities — raw fetch + cache only).
- Clear separation between core engine and CLI.
- High-quality documentation and examples required before v1.0.

---

## 12. Open Questions

- How aggressive should caching be by default? *(current: 24h TTL)*
- Should we support multi-key / multi-model routing in Kyma?
- Long-term strategy for handling X's UI changes? *(probably: pinned Playwright + DOM selectors module + integration tests run weekly)*
- Lightweight local model fallback for summarization? *(deferred to Phase 5)*

---

**End of SPEC.md**
