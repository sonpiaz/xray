# Phase 5 — Polish & OSS-Readiness (Ship v1.0)

**Status:** Draft
**Date:** 2026-05-19
**Owner:** sonpiaz
**Version target:** v1.0.0
**Depends on:** v0.5.0 (Phase 0 + Phase 1 + Phase 1.5 + Phase 2 + Phase 3 + Phase 4 complete)

---

## 0. The Principle

> Phase 5 ships ZERO new features. It makes everything already built v1.0-launchable: documented, hardened, versioned, and demo-ready.

**What "v1.0-launchable" means:**
- A new user can go from `npm install -g xray-cli` to a working research report in under 2 minutes with no prior context.
- Contributors can set up a dev environment, run tests, and open a PR without messaging the maintainer.
- Rate limits and transient failures are handled gracefully — no stack traces for expected errors.
- MCP tools declare a stable `version: "1.0"` contract.
- A 30-second terminal demo makes the value proposition obvious.

**Design philosophy:**
- Zero new CLI commands, MCP tools, or data model fields (except `xray warmup` — a pure operational convenience).
- Every change is either documentation, error handling, or operational polish.
- If it adds a user-facing feature, it belongs in Phase 7, not here.

---

## 1. Goals

1. **README rewrite** — Transform the current developer-facing README into a compelling, scannable landing page: tagline, install, 5-command quickstart, use-case examples, MCP setup snippet, architecture overview, contributing link.
2. **Community files** — CONTRIBUTING.md, issue templates (bug/feature/security), PR template, CODE_OF_CONDUCT.md. Everything a first-time contributor needs.
3. **Rate-limit hardening** — Exponential backoff with jitter for Kyma API (HTTP 429, 5xx, network timeouts) and X cookie-tier fetching. Clean user-facing error messages, no stack traces.
4. **MCP v1 versioning** — Stamp `version: "1.0"` on all tool registrations via `_meta`. Document the breaking-change protocol in CONTRIBUTING.md.
5. **`xray warmup` command** — Pre-download the MiniLM embedding model and launch/close Playwright once, so the first real invocation is fast.
6. **v1.0 launch assets** — 30-second terminal recording (asciinema/VHS), GIF for README, comparison snippet, CHANGELOG v1.0.0 entry covering all P0-P5 work, version bump.

## 2. Non-Goals (Explicit Deferrals to Phase 7+)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Narrative / controversy tracking | Phase 7 | Temporal stance drift detection requires new data model + temporal embeddings. Feature, not polish. |
| Batch research (`xray batch`) | Phase 7 | Multi-thread/multi-profile parallel processing is orchestration complexity. Feature, not polish. |
| `--fresh N` profile fetching (real implementation) | Phase 7 | Requires an X timeline fetcher that doesn't exist yet. Currently degrades gracefully to cache-only. |
| New export formats (Obsidian, HTML, PDF) | Phase 7+ | Markdown + JSON covers all current use cases. New formats add maintenance surface. |
| Tutorial series / video walkthroughs | Phase 7+ | v1.0 ships with README + CONTRIBUTING. Tutorials are post-launch content marketing. |
| API reference docs site (Docusaurus/VitePress) | Phase 7+ | Inline JSDoc + README + CONTRIBUTING is sufficient for a CLI tool at launch. |
| Custom embedding models (BYOM) | Phase 7+ | MiniLM-L6-v2 works well. BYOM adds configuration surface without clear user demand yet. |
| Profile comparison (A vs B) | Phase 7 | Higher-level orchestration on top of single-profile analysis. Feature, not polish. |
| AI citation SEO landing pages | Phase 7+ | Post-launch growth. Not required for v1.0 ship. |
| Multi-user / shared vector stores | Phase 8+ | Different architecture entirely. |

---

## 3. User-Facing Changes

### 3.1 CLI Surface

| Command / Flag | Type | Behavior | Change from v0.5.0 |
|---|---|---|---|
| `xray warmup` | command | Pre-download MiniLM model + launch/close Playwright once. Reports timing for each step. | **NEW command** |
| All existing commands | - | Improved error messages on rate-limit / network failure. Retry with backoff instead of immediate crash. | **Improved errors** |
| `xray --version` | - | Reports `1.0.0`. | Version bump |

### 3.2 MCP Surface

| Change | Detail |
|---|---|
| `_meta.version` field | All 5 tools (`xray_thread`, `xray_video`, `xray_article`, `xray_search`, `xray_profile`) gain `_meta: { version: "1.0" }` in their `registerTool` config. |
| No new tools | Zero new MCP tools in Phase 5. |
| No schema changes | All existing input schemas remain identical. |

**Assumption:** The MCP SDK's `registerTool` config accepts `_meta?: Record<string, unknown>`. This field is present in the current SDK type definition (`@modelcontextprotocol/sdk`). The `_meta` value is opaque to the SDK and passed through to `tools/list` responses. Callers can read `_meta.version` to detect schema changes. If the SDK changes this behavior in a future release, the implementer should adjust accordingly.

### 3.3 New Community / Repo Files

| File | Purpose |
|---|---|
| `CONTRIBUTING.md` | Dev setup, test/lint commands, commit convention, PR process, breaking-change protocol (incl. MCP schema versioning), release process. |
| `.github/ISSUE_TEMPLATE/bug.md` | Bug report: steps to reproduce, expected/actual, version, cache info, OS/arch. |
| `.github/ISSUE_TEMPLATE/feature.md` | Feature request: use case, alternatives considered, willingness to implement. |
| `.github/ISSUE_TEMPLATE/security.md` | Security report: private disclosure instructions (email only, no public issue). |
| `.github/PULL_REQUEST_TEMPLATE.md` | Change summary, linked issue, test plan, breaking change y/n, CHANGELOG bump y/n. |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1. |

---

## 4. Documentation Plan

### 4.1 README Rewrite Outline

Target: ~250-400 lines. Sections in order:

1. **1-line tagline** — `Deep research on X for AI agents and humans who want to understand, not just scroll.`
2. **Hero GIF/cast** — 30-second terminal demo (linked from `docs/` or raw GitHub URL).
3. **Install** — `npm install -g xray-cli` (primary), `brew install sonpiaz/tap/xray` (optional/planned), requirements (Bun, ffmpeg, yt-dlp optional).
4. **Quick Start** — 5 commands max:
   ```
   xray thread <url>                     # research a thread
   xray thread <url> --video --articles  # include media + links
   xray search "scaling laws"            # semantic search across cached content
   xray profile @karpathy                # profile report from cached data
   xray cache info                       # see what's cached
   ```
5. **Use-Case Examples** — 3 concrete scenarios:
   - "Research a trending AI thread for your newsletter"
   - "Build a source profile before an interview"
   - "Search your research archive semantically"
6. **MCP Setup Snippet** — Copy-paste config for Claude Code (`settings.json` `mcpServers` block) and Grok CLI.
7. **Phase Table** — Compact status table (already exists, clean up).
8. **How It Works** — 1-paragraph + diagram: cookie/SSR auth tier → thread/video/article pipelines → Kyma LLM → cache → structured output. Diagram as ASCII art or linked image.
9. **Contributing** — Link to CONTRIBUTING.md + "Issues welcome" + "PRs reviewed within 48h" commitment.
10. **License** — MIT.
11. **Screenshot/GIF placeholder** — Space for the demo asset (created in P5.2).

### 4.2 CONTRIBUTING.md Outline

1. **Prerequisites** — Bun >= 1.x, Node >= 20, ffmpeg, yt-dlp (optional).
2. **Dev setup** — `git clone`, `bun install`, `cp .env.example .env`, set `KYMA_API_KEY`.
3. **Project structure** — Brief directory tree with 1-line descriptions.
4. **Running tests** — `bun test` (unit), `bun test:watch`, manual smoke tests.
5. **Linting** — `bun run lint` / `bun run format`.
6. **Commit convention** — `feat:` / `fix:` / `chore:` / `docs:` / `test:` prefix. 1-line summary, optional body.
7. **PR process** — Fork → branch → PR against `main` → review → merge. Link issue. Fill PR template.
8. **Breaking-change protocol** — Any change to MCP tool input/output schemas OR CLI flag semantics is a breaking change. Must: bump `_meta.version` on affected tools, add CHANGELOG `### Breaking` section, update README if CLI surface changed, notify in PR description.
9. **MCP schema versioning** — All tools carry `_meta: { version: "X.Y" }`. Minor bumps (1.0 → 1.1) for additive changes. Major bumps (1.0 → 2.0) for breaking changes. Document in CHANGELOG.
10. **Release process** — Update CHANGELOG → bump `package.json` + 2 `VERSION` constants (`src/cli/index.ts`, `src/mcp/server.ts`) → tag `vX.Y.Z` → push tag → GitHub Release.

### 4.3 Issue Templates

**`.github/ISSUE_TEMPLATE/bug.md`:**
```yaml
name: Bug Report
about: Something isn't working as expected
labels: bug
---
**XRay version:** (`xray --version`)
**OS / Arch:**
**Bun version:** (`bun --version`)

## Steps to reproduce
1.
2.
3.

## Expected behavior

## Actual behavior

## Cache state
(`xray cache info` output, if relevant)

## Additional context
(Logs, screenshots, error messages)
```

**`.github/ISSUE_TEMPLATE/feature.md`:**
```yaml
name: Feature Request
about: Suggest an enhancement or new capability
labels: enhancement
---
## Use case
What problem does this solve?

## Proposed solution

## Alternatives considered

## Would you be willing to submit a PR?
- [ ] Yes
- [ ] No
```

**`.github/ISSUE_TEMPLATE/security.md`:**
```yaml
name: Security Issue
about: Report a security vulnerability (DO NOT file publicly)
labels: security
---
**STOP.** Do not file security issues publicly.

Email security concerns to: sonxpiaz@gmail.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

We will respond within 72 hours.
```

### 4.4 PR Template

**`.github/PULL_REQUEST_TEMPLATE.md`:**
```markdown
## Summary
<!-- What does this PR do? Link the issue if applicable. -->

Closes #

## Changes
- 

## Test plan
- [ ] `bun test` passes
- [ ] Manual smoke test: 

## Breaking change?
- [ ] No
- [ ] Yes — describe: 

## CHANGELOG bump?
- [ ] No (internal / docs only)
- [ ] Yes — section added to CHANGELOG.md
```

---

## 5. Architecture Changes

### 5.1 New Files

| File | Purpose |
|------|---------|
| `src/cli/commands/warmup.ts` | `xray warmup` command handler. Bootstraps MiniLM model download + Playwright launch/close. Reports timing per step. |
| `CONTRIBUTING.md` | Contributor guide (dev setup, test, lint, commit convention, PR process, breaking-change protocol, release process). |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 (standard boilerplate). |
| `.github/ISSUE_TEMPLATE/bug.md` | Bug report template. |
| `.github/ISSUE_TEMPLATE/feature.md` | Feature request template. |
| `.github/ISSUE_TEMPLATE/security.md` | Security disclosure instructions. |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR template (summary, test plan, breaking change, changelog). |

### 5.2 Modified Files

| File | Changes |
|------|---------|
| `README.md` | Full rewrite per section 4.1 outline. |
| `CHANGELOG.md` | Add v1.0.0 entry covering P0-P5. Clean up formatting. |
| `src/cli/index.ts` | Register `xray warmup` command. Bump `VERSION` constant to `1.0.0`. |
| `src/cli/commands/warmup.ts` | **NEW.** Warmup handler. |
| `src/kyma/client.ts` | Add retry wrapper: detect HTTP 429 / 5xx / network timeout → exponential backoff (base 1s, 3 attempts, jitter +/-30%, max wait 30s). Surface final failure with provider name + suggestion. |
| `src/fetcher/thread.ts` | Add rate-limit detection for cookie-tier fetches (X returns 429 or empty responses on aggressive crawling). Backoff with same parameters as Kyma. |
| `src/mcp/server.ts` | Add `_meta: { version: '1.0' }` to all 5 `registerTool` config objects. Bump `VERSION` constant to `1.0.0`. |
| `package.json` | Bump `version` to `1.0.0`. |

---

## 6. Per-Stage Specification

### 6.1 Rate-Limit Handling (`src/kyma/client.ts` + `src/fetcher/thread.ts`)

**Retry triggers:**
- HTTP 429 (Too Many Requests)
- HTTP 5xx (server error)
- Network timeout (ECONNREFUSED, ETIMEDOUT, ECONNRESET, UND_ERR_HEADERS_TIMEOUT)
- Empty / malformed response body when HTTP status is 200 (X cookie-tier specific: sometimes returns empty HTML on rate limit)

**Retry parameters:**
- Max attempts: 3 (original + 2 retries)
- Base delay: 1000ms
- Backoff multiplier: 2x (1s → 2s → 4s)
- Jitter: +/-30% (randomized per attempt to avoid thundering herd)
- Max single wait: 30s (cap the exponential growth)
- Respect `Retry-After` header if present (use it as the delay instead of calculated backoff)

**Implementation approach — shared retry utility:**

```typescript
// src/core/retry.ts (NEW)
export type RetryOptions = {
  maxAttempts?: number;     // default 3
  baseDelayMs?: number;     // default 1000
  maxDelayMs?: number;      // default 30000
  jitterFraction?: number;  // default 0.3
  retryOn?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T>;
```

The `chat()` function in `src/kyma/client.ts` wraps its `request()` call with `withRetry()`. The `retryOn` predicate checks for transient errors (429, 5xx, network).

The cookie-tier fetch in `src/fetcher/thread.ts` wraps the Playwright navigation with `withRetry()`. The `retryOn` predicate checks for empty page content (X rate-limit response) and HTTP 429.

**User-facing error on final failure:**

```
Error: Kyma API rate limit exceeded after 3 attempts.

The Kyma API returned HTTP 429 (Too Many Requests). This usually means
you've hit the per-minute request cap.

Suggestions:
  - Wait 60 seconds and retry
  - Check your Kyma API plan limits
  - Use --no-cache to skip retrying cached analyses

Last attempt waited 4.2s before giving up.
```

```
Error: X rate limit detected after 3 attempts.

X returned empty content on the cookie-tier fetch, which typically indicates
rate limiting. This happens when making many requests in a short period.

Suggestions:
  - Wait 2-5 minutes before retrying
  - Use --mode ssr to fall back to the SSR tier (less data but no rate limit)
  - Reduce --max-replies to fetch fewer comments
```

### 6.2 MCP Versioning (`src/mcp/server.ts`)

**What changes:**

Every `registerTool` call adds `_meta: { version: '1.0' }` to its config object:

```typescript
server.registerTool(
  'xray_thread',
  {
    title: 'Research an X thread',
    description: '...',
    inputSchema: ThreadInput,
    _meta: { version: '1.0' },   // <-- NEW
  },
  async (args) => { /* ... */ },
);
```

This applies to all 5 tools: `xray_thread`, `xray_video`, `xray_article`, `xray_search`, `xray_profile`.

**How callers use it:**

When a caller sends `tools/list`, the response includes `_meta` on each tool:

```json
{
  "name": "xray_thread",
  "description": "...",
  "inputSchema": { ... },
  "_meta": { "version": "1.0" }
}
```

Callers can cache schemas and invalidate when `_meta.version` changes. The version is a string, not a number, following semver-light conventions (X.Y, no patch).

**Breaking-change protocol (documented in CONTRIBUTING.md):**

1. Any change to a tool's `inputSchema` (adding required fields, removing fields, changing types) or output shape is a breaking change.
2. Breaking changes MUST bump the tool's `_meta.version` (1.0 → 2.0).
3. Additive changes (new optional input fields, new optional output fields) bump minor (1.0 → 1.1).
4. The CHANGELOG MUST include a `### Breaking` section for any major version bump.
5. All tool versions move in lockstep (if one bumps to 2.0, all bump to 2.0) to keep things simple.

### 6.3 `xray warmup` Command (`src/cli/commands/warmup.ts`)

**What it does:**

1. Check if MiniLM-L6-v2 model files exist at `~/.xray/models/`. If not, download them (reuse the existing bootstrap from `src/embeddings/provider.ts`).
2. Launch Playwright Chromium, navigate to `about:blank`, close it. This forces the browser binary download if not present and warms the browser process pool.
3. Report timing for each step:

```
xray warmup

Warming up XRay...

  Embedding model (MiniLM-L6-v2)
    Status: already downloaded (23 MB at ~/.xray/models/)
    Time: 0.2s

  Playwright browser (Chromium)
    Status: launched and closed successfully
    Time: 3.1s

Done. Total: 3.3s
```

First-time output (model not yet downloaded):

```
xray warmup

Warming up XRay...

  Embedding model (MiniLM-L6-v2)
    Downloading... [████████████░░░░░░░░] 62%
    Status: downloaded (23 MB → ~/.xray/models/)
    Time: 12.4s

  Playwright browser (Chromium)
    Status: launched and closed successfully
    Time: 4.8s

Done. Total: 17.2s
```

**Inputs:** None (no flags).
**Outputs:** Console output with timing. Exit code 0 on success, 1 on failure.
**Dependencies:** Embedding provider (`src/embeddings/provider.ts`), Playwright browser (`src/fetcher/browser.ts`).
**Failure modes:**
- Model download fails (offline) → clear error with retry suggestion.
- Playwright not installed → `npx playwright install chromium` suggestion.
- Both steps are independent — if one fails, report the failure and continue with the other.

---

## 7. Demo Asset Specification

### 7.1 Terminal Recording

**Tool:** `vhs` (Charm.sh) or `asciinema` — VHS preferred for GIF output quality.

**Recording script (30 seconds):**

```
# Scene 1: Version (2s)
$ xray --version
1.0.0

# Scene 2: Thread research (8s)
$ xray thread https://x.com/karpathy/status/... 
# [markdown output scrolls — TL;DR, summary, insights, notable replies]

# Scene 3: Video analysis (6s)
$ xray thread https://x.com/.../status/... --video
# [video section appears — transcript excerpt, key moments]

# Scene 4: Semantic search (5s)
$ xray search "transformer scaling"
# [search results table — score, type, source, snippet]

# Scene 5: Profile (5s)
$ xray profile @karpathy
# [profile report — topics, stance, expertise, quotes]

# Scene 6: MCP (4s)
$ echo '{"method":"tools/list"}' | xray mcp | jq '.result.tools[].name'
# ["xray_thread", "xray_video", "xray_article", "xray_search", "xray_profile"]
```

**Output files:**
- `docs/demo.gif` — GIF for README inline display (~2-5 MB, optimized).
- `docs/demo.cast` — asciinema cast for web embedding (optional, if using asciinema).

**Hosting:** Referenced in README via relative path (`./docs/demo.gif`) which resolves to raw GitHub URL when viewed on GitHub.

### 7.2 Comparison Snippet

A concise "before XRay / with XRay" comparison for the README or launch post:

```
Without XRay:
  1. Open X, scroll through a 200-reply thread
  2. Click through 5 linked articles
  3. Watch a 30-minute embedded video
  4. Manually note who said what
  5. Spend 45 minutes, retain 20%

With XRay:
  $ xray thread <url> --video --articles
  → Structured report in 30 seconds
  → Every reply classified, every article summarized
  → Video transcribed + key moments extracted
  → Semantic search across everything you've ever researched
```

---

## 8. Sub-Phase Delivery

### P5.0 — Docs Polish (~5-7h)

**Scope:** README rewrite, CONTRIBUTING.md, issue/PR templates, CODE_OF_CONDUCT.md, CHANGELOG cleanup.

**Files:**
- MOD: `README.md` (full rewrite per section 4.1)
- NEW: `CONTRIBUTING.md` (per section 4.2)
- NEW: `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- NEW: `.github/ISSUE_TEMPLATE/bug.md` (per section 4.3)
- NEW: `.github/ISSUE_TEMPLATE/feature.md` (per section 4.3)
- NEW: `.github/ISSUE_TEMPLATE/security.md` (per section 4.3)
- NEW: `.github/PULL_REQUEST_TEMPLATE.md` (per section 4.4)
- MOD: `CHANGELOG.md` (formatting cleanup, prepare structure for v1.0.0 entry)

**Acceptance criteria:**
```bash
# README has new tagline + install + quickstart in first 30 lines
head -30 README.md
# Must show: tagline, install command, quickstart block

# CONTRIBUTING covers dev setup, test, commit, PR, breaking-change protocol
grep -c "##" CONTRIBUTING.md
# Must be >= 8 (at least 8 sections)

# Issue templates exist and render correctly
ls .github/ISSUE_TEMPLATE/
# Must show: bug.md, feature.md, security.md

# PR template exists
cat .github/PULL_REQUEST_TEMPLATE.md | head -5
# Must show "## Summary"

# CODE_OF_CONDUCT exists
head -1 CODE_OF_CONDUCT.md
# Must reference Contributor Covenant

# No broken internal links in README
grep -oP '\[.*?\]\(\.\/.*?\)' README.md | while read link; do
  path=$(echo "$link" | grep -oP '\(\.\/\K[^)]+')
  test -f "$path" || echo "BROKEN: $path"
done
# Must output nothing (no broken links)
```

### P5.1 — Hardening (~5-7h)

**Scope:** Rate-limit retry + clean errors for Kyma and X, MCP versioning, `xray warmup` command, tests for each.

**Files:**
- NEW: `src/core/retry.ts` (shared retry utility with exponential backoff + jitter)
- MOD: `src/kyma/client.ts` (wrap `request()` with `withRetry()`, clean error messages)
- MOD: `src/fetcher/thread.ts` (wrap cookie-tier fetch with `withRetry()`, detect empty-response rate limit)
- NEW: `src/cli/commands/warmup.ts` (warmup command handler)
- MOD: `src/cli/index.ts` (register `xray warmup`)
- MOD: `src/mcp/server.ts` (add `_meta: { version: '1.0' }` to all 5 tools)
- NEW: `tests/unit/retry.test.ts` (retry utility: backoff timing, jitter range, max attempts, Retry-After header)
- NEW: `tests/unit/warmup.test.ts` (warmup command: model check, browser launch/close, error handling)
- MOD: `tests/unit/kyma-client.test.ts` (add retry behavior tests: 429 retries, 500 retries, network error retries, non-retryable errors pass through)

**Acceptance criteria:**
```bash
# Simulated 429 retries (test seam)
bun test tests/unit/retry.test.ts
# Must pass — verifies 3 attempts with exponential backoff

# Kyma client retries on 429
bun test tests/unit/kyma-client.test.ts
# Must include retry-specific test cases

# xray warmup completes
xray warmup
# Must complete in <60s on a machine with model already downloaded
# Must report timing for embedding model + Playwright steps

# MCP tools/list includes version
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | jq '.result.tools[0]._meta.version'
# Must output "1.0"

# All 5 tools have version
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | jq '[.result.tools[]._meta.version] | all(. == "1.0")'
# Must output true

# All tests pass
bun test
```

### P5.2 — Demo + v1.0 Release (~5-6h)

**Scope:** Terminal recording/GIF, comparison snippet in README, version bump to 1.0.0, CHANGELOG v1.0.0 entry, tag v1.0.0.

**Files:**
- NEW: `docs/demo.gif` (or `docs/demo.cast`) — terminal recording
- MOD: `README.md` (embed GIF, add comparison snippet)
- MOD: `package.json` (version → `1.0.0`)
- MOD: `src/cli/index.ts` (VERSION constant → `1.0.0`)
- MOD: `src/mcp/server.ts` (VERSION constant → `1.0.0`)
- MOD: `CHANGELOG.md` (add v1.0.0 entry covering P0-P5)

**Acceptance criteria:**
```bash
# Version reports 1.0.0
xray --version
# Must output "1.0.0"

# package.json version matches
grep '"version"' package.json
# Must show "1.0.0"

# CLI VERSION constant matches
grep "VERSION = " src/cli/index.ts
# Must show '1.0.0'

# MCP VERSION constant matches
grep "VERSION = " src/mcp/server.ts
# Must show '1.0.0'

# Demo asset exists
test -f docs/demo.gif && echo "GIF exists" || echo "MISSING"
# Must output "GIF exists"

# README references demo
grep -c "demo.gif\|demo.cast" README.md
# Must be >= 1

# CHANGELOG has v1.0.0 entry
grep "## \[1.0.0\]" CHANGELOG.md
# Must match

# CHANGELOG v1.0.0 references all phases
grep -A 50 "## \[1.0.0\]" CHANGELOG.md | grep -c "Phase"
# Must be >= 5 (P0 through P5)

# Tag exists (after tagging)
git tag | grep "v1.0.0"
# Must match

# All tests pass
bun test
```

### Total Effort Estimate

| Sub-phase | Hours | Cumulative |
|-----------|-------|------------|
| P5.0 Docs polish (README + CONTRIBUTING + templates + CHANGELOG) | 5-7 | 5-7 |
| P5.1 Hardening (retry + rate-limit + MCP version + warmup + tests) | 5-7 | 10-14 |
| P5.2 Demo + v1.0 release (recording + GIF + version bump + tag) | 5-6 | 15-20 |
| **Total** | **15-20 hours** | |

---

## 9. Acceptance Criteria — Phase 5 Overall

All of the following must pass before Phase 5 is considered complete and v1.0.0 is tagged:

```bash
# 1. All tests pass (existing + new retry/warmup tests)
bun test

# 2. README is rewritten
head -5 README.md
# Must show new tagline (not the old developer-only header)

# 3. CONTRIBUTING.md exists and covers key topics
grep -c "breaking.change\|commit convention\|PR process" CONTRIBUTING.md
# Must be >= 3

# 4. Issue + PR templates exist
ls .github/ISSUE_TEMPLATE/bug.md .github/ISSUE_TEMPLATE/feature.md \
   .github/ISSUE_TEMPLATE/security.md .github/PULL_REQUEST_TEMPLATE.md
# All 4 must exist

# 5. Rate-limit retry works (unit tests)
bun test tests/unit/retry.test.ts
# Must pass

# 6. Kyma client has retry behavior
bun test tests/unit/kyma-client.test.ts
# Must pass (including retry test cases)

# 7. xray warmup works
xray warmup
# Must complete without error, report timing

# 8. MCP tools have version
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts \
  | jq '[.result.tools[]._meta.version] | all(. == "1.0")'
# Must output true

# 9. Demo asset exists and is linked in README
test -f docs/demo.gif && grep "demo.gif" README.md
# Both must succeed

# 10. Version is 1.0.0 everywhere
xray --version | grep "1.0.0"
grep '"1.0.0"' package.json
grep "'1.0.0'" src/cli/index.ts
grep "'1.0.0'" src/mcp/server.ts
# All 4 must match

# 11. CHANGELOG has v1.0.0 entry
grep "## \[1.0.0\]" CHANGELOG.md
# Must match

# 12. Default thread behavior unchanged
xray thread "https://x.com/user/status/123" --json 2>&1 | head -5
# Must still work identically to v0.5.0

# 13. CODE_OF_CONDUCT exists
test -f CODE_OF_CONDUCT.md
# Must succeed

# 14. No broken links in README
grep -oP '\]\(\./[^)]+\)' README.md | grep -oP '\./[^)]+' | while read p; do
  test -e "$p" || echo "BROKEN: $p"
done
# Must output nothing
```

---

## 10. Migration & Backward Compatibility

### 10.1 No Breaking Changes

Phase 5 is fully additive and non-breaking:

- All existing CLI commands and flags work identically.
- All existing MCP tool input schemas are unchanged. The only addition is `_meta: { version: "1.0" }` which is a new field that callers can safely ignore.
- `xray warmup` is a purely new command — does not affect any existing workflow.
- No database schema changes. No new tables. No migrations.
- All existing tests pass without modification.

### 10.2 Version Bump Strategy

Three files contain the VERSION constant. All three must be updated in lockstep:

| File | Constant | Current | P5 Target |
|------|----------|---------|-----------|
| `package.json` | `"version"` | `"0.5.0"` | `"1.0.0"` |
| `src/cli/index.ts` | `const VERSION` | `'0.5.0'` | `'1.0.0'` |
| `src/mcp/server.ts` | `const VERSION` | `'0.5.0'` | `'1.0.0'` |

### 10.3 CHANGELOG v1.0.0 Entry Structure

The v1.0.0 CHANGELOG entry should be a comprehensive summary of the entire project, not just P5 changes. Structure:

```markdown
## [1.0.0] - 2026-XX-XX

First stable release. XRay is a research engine for X that produces
structured, agent-readable insights from threads, videos, articles,
and cached content.

### Highlights (P0-P5)
- Thread research with full reply trees + classification (P0+P1)
- Invisible 3-tier auth escalation (P1.5)
- Video understanding: transcript + scene-detect + synthesis (P2)
- Article analysis: 3-tier fetch + cross-reference attribution (P3)
- Semantic search + profile analysis with local embeddings (P4)
- Rate-limit hardening with exponential backoff (P5)
- MCP v1.0 tool versioning (P5)
- `xray warmup` preheat command (P5)
- Comprehensive documentation + community files (P5)

### Added (P5-specific)
- `xray warmup` command
- Rate-limit retry with exponential backoff + jitter
- MCP `_meta.version: "1.0"` on all tools
- CONTRIBUTING.md, issue/PR templates, CODE_OF_CONDUCT.md
- README rewrite with quickstart + demo GIF
- 30-second terminal demo recording

### Changed (P5-specific)
- Version bumped to 1.0.0 across package.json, CLI, and MCP server
```

---

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **README rewrite scope creep** — temptation to add tutorial content, API reference, or detailed architecture docs. | Medium | Low | Cap at 400 lines. Tutorials and API docs are Phase 7+. Link to CONTRIBUTING for dev details. |
| **Demo cast quality** — 30-second window is tight. Bad pacing or errors during recording ruin the asset. | Medium | Low | Script the recording with VHS (deterministic). Pre-cache all data so no real API calls during recording. Multiple takes. |
| **MCP `_meta` field behavior change** — future MCP SDK versions might change how `_meta` is handled. | Low | Low | `_meta` is documented as opaque passthrough in the current SDK. If behavior changes, it's a minor fix (move version to `annotations` or a custom field). |
| **Retry logic masking real errors** — retrying on all 5xx could mask legitimate server errors that should fail fast. | Low | Medium | Only retry on codes known to be transient (429, 502, 503, 504). 500 and 501 fail immediately. Log each retry at WARN level for debugging. |
| **`xray warmup` Playwright binary size** — Playwright Chromium is ~150MB. First warmup on a clean machine could take a while. | Medium | Low | Report download progress. This is a one-time cost. Users who don't use Playwright features (SSR-only mode) can skip warmup. |

---

## 12. Out of Scope (Deferred to Phase 7+)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| Narrative / controversy tracking | Phase 7 | Temporal analysis of stance drift, topic evolution across threads. Requires new data model + temporal embeddings. |
| Batch research (`xray batch`) | Phase 7 | Processing multiple threads/profiles in parallel. Orchestration complexity. |
| `--fresh N` profile fetching (real X timeline fetcher) | Phase 7 | Requires building an X timeline scraper. Currently degrades gracefully. |
| Profile comparison (A vs B) | Phase 7 | Higher-level orchestration on top of single-profile analysis. |
| New export formats (Obsidian/HTML/PDF) | Phase 7+ | Markdown + JSON is sufficient. New formats add maintenance burden without clear demand. |
| Tutorial series / video walkthroughs | Phase 7+ | Post-launch content marketing. Not required for v1.0. |
| API reference docs site (Docusaurus/VitePress) | Phase 7+ | Overkill for a CLI tool at launch. Inline docs + README + CONTRIBUTING suffice. |
| Custom embedding models (BYOM) | Phase 7+ | MiniLM-L6-v2 works. No user demand for alternatives yet. |
| AI citation SEO landing pages | Phase 7+ | Growth optimization. Post-launch concern. |
| Multi-user / shared vector stores | Phase 8+ | Entirely different architecture. |
| Performance benchmarks | Phase 7+ | Nice-to-have for README but not blocking v1.0 launch. |

---

**End of PHASE_5_PLAN.md**
