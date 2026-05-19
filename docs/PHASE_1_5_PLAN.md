# Phase 1.5 — Invisible Auth Escalation

**Status:** Draft
**Date:** 2026-05-18
**Owner:** sonpiaz
**Version target:** v0.2.0 (ships together with Phase 1)
**Depends on:** Phase 0 (Foundation) + Phase 1 (Deep Conversation) — both must be complete on `feat/phase-1` before P1.5 work begins. P1 + P1.5 merge together as v0.2.0.

---

## 0. The Principle

> "auth la buoc cuoi cung, neu bi han che. con ko thi UI nen vo hinh, users ko can lam gi."
> — Son, 2026-05-18

**The rule:** `xray thread <url>` should produce output without the user doing anything. The escalation chain runs silently underneath. The user is only ever asked to authenticate when literally every other path has been exhausted AND the request still cannot be served.

This is not a convenience feature. It is a design axiom: **the default behavior must require zero setup, zero auth, zero flags.** Auth UI is the absolute last resort, surfaced only after all silent fallbacks have failed. The tool should "just work" on first invocation.

See: `~/.claude/projects/-Users-sonpiaz/memory/feedback_invisible_auth_escalation.md`

---

## 1. Goals

1. Make `xray thread <url>` (no flags) produce useful output without the user doing anything — try Chrome/Brave/Edge cookies silently first (full data), fall back to SSR scrape (root post only) if no cookies, surface auth instruction only when both invisible paths fail.
2. Implement a 3-tier escalation chain (Cookie+PW → SSR fallback → saved `xray auth`) that runs transparently. The user never chooses a tier.
3. Silently read existing Chromium-family browser cookies (Chrome, Brave, Edge) on macOS, decrypt via Keychain, and inject into Playwright context — zero user interaction beyond one-time macOS "Always Allow" Keychain prompt.
4. Add `xray auth --status` diagnostics subcommand so users can inspect what cookie sources are available and whether `storageState.json` exists.
5. Surface a `coverage.tier` field in every report so downstream agents know how the data was obtained.

## 2. Non-Goals (deferred)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| `xray_parse` MCP tool | Phase 2+ | P1.5 stays focused on tiered fetch only |
| Safari cookie support | v0.3+ | SIP/FDA blocks programmatic access to Safari cookies |
| Firefox cookie support | v0.3+ | Different encryption (NSS / key4.db), distinct implementation |
| Linux cookie support (libsecret/kwallet) | v0.3+ | Different keyring, different paths |
| Windows cookie support (DPAPI) | v0.3+ | Different OS, different decrypt |
| Streaming/progressive tier escalation UI | Not planned | Escalation is already fast enough to be invisible |
| User-selectable tier (e.g., `--tier cookie`) | Not planned | Defeats the purpose; auto-detect only |

---

## 3. User-Facing Changes

### 3.1 CLI Surface

| Flag / Command | Type | Default | Behavior (P1.5) | Change from P1 |
|---|---|---|---|---|
| `xray thread <url>` (no flags) | - | Auto escalation: Cookie+PW → SSR → saved auth | Default tries Chrome/Brave/Edge cookies first; falls back to SSR if no cookies; surfaces `xray auth` instruction only if both fail. | **BREAKING**: Phase 1 default was unconditional Playwright (and failed on auth wall). |
| `--depth <N>` | integer | `3` | Reply tree depth. Only meaningful when Tier 1 (cookies) succeeds — SSR ignores this. | Unchanged |
| `--max-replies <N>` | integer | `50` | Max replies. Same Tier 1 caveat as above. | Unchanged |
| `--deep` | boolean | `false` | Triggers per-subtree synthesis. Tier 1 only. | Unchanged |
| `--mode auto` | string | `auto` | Run the 3-tier escalation chain (cookie → SSR → saved auth). | **NEW behavior** vs P1's auto |
| `--mode ssr` | string | - | Force SSR only — never touch cookies/browser/auth. Useful for headless servers, CI, debugging. | **NEW** |
| `--mode cookie` | string | - | Force Cookie+PW — no SSR fallback. Fails hard if cookies unavailable. | **NEW** |
| `--mode auth` | string | - | Force authenticated Playwright via saved `storageState.json`. | Unchanged |
| `--mode anon` | (removed) | - | — | **REMOVED**: anonymous Playwright tier dropped; same data as SSR but slower. |
| `--no-cache` | boolean | `false` | Bypass cache. | Unchanged |
| `--raw` | boolean | `false` | Skip LLM analysis. | Unchanged |
| `--json` | boolean | `false` | JSON output. | Unchanged |
| `xray auth` | command | - | Interactive Playwright login, save storageState. | Unchanged (Tier 3 last resort). |
| `xray auth --status` | command | - | Print detected cookie sources + storageState presence. | **NEW** |

### 3.2 MCP Surface

| Arg | Type | Default | Change |
|---|---|---|---|
| `url` | `z.string().url()` | required | Unchanged |
| `mode` | `z.enum(['auto','ssr','cookie','auth'])` | `'auto'` | `auto` = 3-tier escalation (cookie → SSR → saved auth). `'anon'` REMOVED. |
| `noCache` | `z.boolean().optional()` | `false` | Unchanged |
| `raw` | `z.boolean().optional()` | `false` | Unchanged |
| `depth` | `z.number()` | `3` | Unchanged |
| `maxReplies` | `z.number()` | `50` | Unchanged |
| `deep` | `z.boolean()` | `false` | Unchanged |
| `format` | `z.enum(...)` | `'markdown'` | Unchanged |

No new MCP tools. `xray_thread` behavior changes only in how `mode: 'auto'` escalates.

### 3.3 Markdown Output Changes

New line in the Conversation Analysis section:

```markdown
## Conversation Analysis
**Tier:** ssr · **Coverage:** 12/50 replies fetched · ...
```

When no Conversation Analysis section exists (e.g., SSR-only with no classification), a minimal coverage line appears:

```markdown
**Fetched via:** SSR (Tier 1) · 1 root post + 12 visible replies
```

---

## 4. Tier Architecture

**Architecture revision (post-P1.5.0 finding):** Empirical testing showed that X in 2026 strips replies, quote tweets, and engagement metrics from logged-out SSR HTML — only the OG card (root post text + author + 1 image) survives. The "anonymous Playwright" tier became redundant (same data as SSR, just slower). The tier ordering is therefore **inverted from the initial spec**: the richest invisible path (cookie inject) runs first; SSR becomes a thin fallback when no cookies are available.

```
                        xray thread <url>
                              |
                    +---------+---------+
                    |                   |
              mode = auto          mode = ssr/cookie/auth
                    |                   |
                    v                   v
         +------------------------+ (direct override — skip chain)
         |   TIER 1: COOKIE+PW   |
         |  read Chrome/Brave/   |
         |  Edge SQLite cookies, |
         |  decrypt via Keychain,|
         |  inject into          |
         |  Playwright context   |
         +-----------+-----------+
                     |
            cookies found
            & fetch succeeds?
              /         \
            YES          NO (no browser / no X cookies
             |              / cookies expired
        return result        / Keychain access denied)
        tier = 'cookie'      |
                       +-----v---------------+
                       |   TIER 2: SSR       |
                       |  (FALLBACK)         |
                       |  cheerio static     |
                       |  HTML scrape — OG   |
                       |  card only (root +  |
                       |  author + 1 image)  |
                       +-----+---------------+
                             |
                  root post found?
                    /         \
                  YES          NO (login wall, deleted tweet)
                   |              |
              return result       |
              tier = 'ssr'        |
              partial = true      |
                          +-------v---------------+
                          |   TIER 3: AUTH        |
                          |  (LAST RESORT)        |
                          |  check storageState   |
                          |  .json (saved by      |
                          |  `xray auth`)         |
                          +-------+---------------+
                                  |
                       storageState exists?
                          /         \
                        YES          NO
                         |            |
                    fetch with    throw FetchError
                    storageState  "This content needs login.
                    tier = 'auth' Run `xray auth`"
```

### 4.1 Escalation Trigger Conditions

| From Tier | Escalates to | Trigger |
|-----------|-------------|---------|
| Cookie+PW (1) | SSR (2) | No Chromium browsers installed; OR no `host_key LIKE '%x.com'` rows in any Cookies DB; OR Keychain access denied by user; OR cookies present but fetch still hits auth wall (expired session); OR Chrome `os_crypt` decrypt error |
| SSR (2) | Auth (3) | Root post not parsed (login wall, deleted tweet, age-gated, protected account, HTML structure broken) |
| Auth (3) | Error | `storageState.json` missing → throw `FetchError` with explicit "Run `xray auth`" guidance |

### 4.2 Why Cookie+PW is the Primary Tier

The original spec assumed SSR would carry replies and metrics, making it the natural zero-friction default. P1.5.0 empirical testing disproved this — X 2026 SSR returns OG card only. The principle (invisible default per [[feedback_invisible_auth_escalation]]) still holds, but the *implementation* of "invisible" must now mean "use cookies the user already has in Chrome silently."

Cookie+PW is invisible in the same way SSR was supposed to be:
- User already logged into X on Chrome (95% of target users)
- Chrome stores `auth_token` + `ct0` cookies persistently
- XRay reads them silently (one-time macOS Keychain "Always Allow" prompt)
- Playwright fetches with cookies injected → full GraphQL TweetDetail response → all data

The user does nothing. They get full thread data (replies, metrics, quote tweets) on first invocation. Auth UI never appears.

### 4.3 When SSR Fallback Kicks In

SSR is the fallback when Tier 1 cannot serve the request:
- User has no Chromium browser installed (Linux server, headless CI, Firefox-only user)
- User has Chrome but is not logged into X
- User denied Keychain access
- Cookies are expired (session ended) and X still returns auth wall

In these cases, SSR returns whatever it can — typically just the root post text + author + image. The result is marked `partial=true` with a clear `partialReason`. The agent caller (Grok/Claude) sees the partial flag and decides whether to surface the limitation to its user.

For root-only use cases ("what does this tweet say?"), SSR is sufficient. For anything requiring replies/metrics, SSR is degraded mode.

### 4.4 Direct-Mode Overrides

Users can bypass the escalation chain with explicit `--mode` flags:
- `--mode ssr` — SSR only, never touch cookies/browser/auth. Useful for headless servers, CI, or debugging.
- `--mode cookie` — Cookie+PW only, no SSR fallback. Fails hard if cookies unavailable. Useful for guaranteeing full data.
- `--mode auth` — Use saved `storageState.json` directly, skip cookies. Useful when storageState is fresher than Chrome cookies.
- `--mode auto` (default) — Run the 3-tier escalation chain above.

---

## 5. Per-Tier Specification

### 5.1 Tier 1 — Cookie+Playwright (PRIMARY)

**Files:**
- `src/auth/cookie-reader.ts` (NEW) — read + decrypt Chromium SQLite cookies
- `src/auth/browsers.ts` (NEW) — detect installed browsers + profile paths
- `src/fetcher/thread.ts` (MOD) — uses cookies via `context.addCookies()` then runs the existing Playwright GraphQL flow

**Trigger:** Default path for `mode: 'auto'`. The orchestrator tries this first on every fetch.

**What it does:**
1. Detect installed Chromium-family browsers (Chrome, Brave, Edge) via `browsers.ts`
2. For each browser (in order Chrome → Brave → Edge), open its `Cookies` SQLite DB (lock-safe — copy WAL-locked DB to temp before reading)
3. Read cookies with SQL `WHERE host_key LIKE '%x.com'` (privacy-scoped filter)
4. Decrypt cookie values using macOS Keychain — fetch the `${Browser} Safe Storage` password from Keychain, derive AES key via PBKDF2 (1003 iterations, salt `saltysalt`, 16-byte output), AES-128-CBC decrypt the `v10`-prefixed cookie value with PKCS7 padding
5. Filter to the cookies XRay actually needs: `auth_token`, `ct0`, `twid` (others stay out of memory)
6. Inject into a fresh Playwright `BrowserContext` via `context.addCookies(...)`
7. Run the existing TweetDetail GraphQL fetch flow (Phase 1 code) — pagination, cursor replay, full reply tree

**Capabilities:**
- Full authenticated fetch — replies, quote tweets, nested trees, real-time metrics
- Pagination via cursor replay (depth N up to maxReplies)
- All Phase 1 features active: classification, deep mode, synthesis
- **Zero user interaction after one-time macOS Keychain "Always Allow" prompt**
- Reuses the user's existing browser session — no fresh login

**Limitations:**
- macOS only in v0.2.0. Linux (libsecret/kwallet) and Windows (DPAPI) deferred to v0.3.
- Requires user to be logged into X in Chrome/Brave/Edge (95% of target users)
- First run triggers one macOS Keychain dialog per browser (one-time per binary)

**Cache strategy:** Same `{root_id}` key. Overwrites Tier 2/3 results (richest data wins).

**Error modes (each falls through to Tier 2 SSR, never blocks):**
- No Chromium browsers installed → fall through silently
- No `x.com` cookies in any browser → fall through silently
- Keychain access denied → fall through silently (no retry)
- Decrypt error / corrupted cookie → log debug, fall through silently
- Cookies present but X returns auth wall (session expired) → fall through silently
- Playwright launch failure → propagate error (system-level problem)

**Escalation criteria:** Any non-fatal failure above. Fatal errors (Playwright not installed) propagate.

### 5.2 Tier 2 — SSR Scrape (FALLBACK)

**File:** `src/fetcher/ssr.ts` (NEW — already implemented in P1.5.0, commit `a0c9d79`)

**Trigger:** Tier 1 cookie+PW failed/unavailable. Last invisible path before user must act.

**What it fetches:**
- HTTP GET to `https://x.com/{user}/status/{id}` via `undici` with a Safari User-Agent
- Parse with `cheerio`
- Extract from OG meta tags:
  - Root post: author handle (canonical URL), display name (`og:title`), text (`og:description`), image (`og:image` filtered to `pbs.twimg.com/media`)

**Capabilities:**
- Sub-second fetch (no browser launch)
- Works behind corporate proxies that block WebSocket
- Zero local state, zero Keychain access
- Works in CI/CD without Playwright installed

**Limitations (empirically verified P1.5.0):**
- No replies (X SSR strips them for logged-out clients in 2026)
- No engagement metrics (likes/reposts/views/replies count all absent)
- No quote tweets
- No nested data
- No `createdAt` (no reliable SSR field)
- Only the OG card survives

In short: SSR answers "what does this tweet say?" — nothing more.

**Cache strategy:** Same `{root_id}` key. Overwritten by Tier 1 result on the next fetch with cookies available.

**Error modes:**
- HTTP 4xx/5xx → escalate to Tier 3 (Auth)
- No `og:*` tags in HTML (login wall, deleted tweet, age-gated) → escalate to Tier 3
- HTML structure change → escalate to Tier 3 + log warning for future fixture refresh

**Escalation criteria:** No root post extractable from HTML.

### 5.3 Tier 3 — Interactive Auth (LAST RESORT)

**File:** `src/auth/login.ts` (existing)

**Trigger:** Both invisible tiers (cookie+PW, SSR) failed. The user must now act.

**What it does:**
- In `auto` mode: checks for existing `~/.xray/storageState.json` (from a previous `xray auth` run). If present, runs Playwright with that storageState. If missing, throws `FetchError` with a clear message — does NOT auto-launch interactive login.
- When the user explicitly runs `xray auth`: opens a non-headless Playwright browser to `x.com/login`, waits up to 5 minutes for the user to sign in, saves `storageState.json`.

**Capabilities:** Full authenticated access for any X account.

**Limitations:**
- Requires user to run a separate command (`xray auth`) one time
- Requires `XRAY_HEADLESS=false` for the interactive login
- Future improvement: replace fresh-Chromium login with a way to leverage the user's existing browser session (out of scope for v0.2.0 — track in [[feedback_browser_auth_reuse]])

**Cache strategy:** Same `{root_id}` key. Overwritten only by Tier 1 on subsequent fetches.

**Error modes:**
- `storageState.json` missing in `auto` mode → throw `FetchError`: "This content requires authentication. Run `xray auth` to save login cookies."
- User doesn't log in within 5 minutes during `xray auth` → timeout error.

**Note:** This tier never opens a browser in `auto` mode. The interactive browser flow only runs when the user explicitly types `xray auth`. This preserves the invisible-default principle — auto mode never surprises the user with a browser popup.

---

## 6. Data Model Deltas

### 6.1 coverage.tier on ThreadCoverage

File: `src/models/report.ts` (P1.5.0 already landed this with the broader enum — narrow it now).

```typescript
// Update ThreadCoverageSchema:
export const ThreadCoverageSchema = z.object({
  // ... existing fields ...
  tier: z.enum(['ssr', 'cookie', 'auth']).optional(),
});
```

`tier` is optional so all existing P0/P1 outputs remain valid without migration. The `'anon'` value from P1.5.0's initial enum is **removed** (no anonymous Playwright tier in the revised architecture). When present, `tier` indicates which escalation tier produced the data.

### 6.2 coverage on ResearchReport (existing)

The existing `coverage: ThreadCoverageSchema.optional()` field on `ResearchReportSchema` already exists. P1.5 populates `coverage.tier` in addition to the existing fields.

For SSR-only fetches where no pagination ran:
```typescript
coverage: {
  targetDepth: 1,
  achievedDepth: 1,
  targetReplies: opts.maxReplies ?? 50,
  fetchedReplies: ssrCommentCount,
  classifiedReplies: 0,
  paginationCursors: [],
  status: ssrCommentCount > 0 ? 'ok' : 'partial',
  tier: 'ssr',
}
```

### 6.3 FetchMode enum revision

File: `src/fetcher/thread.ts`

```typescript
// Existing (Phase 1):
// export type FetchMode = 'auto' | 'anon' | 'auth';

// Revised (P1.5):
export type FetchMode = 'auto' | 'ssr' | 'cookie' | 'auth';
```

**Breaking change** vs Phase 1: `'anon'` is removed (no longer a meaningful tier). Added `'ssr'` and `'cookie'` as direct-mode overrides for power users and debugging. `'auto'` (default) now means "3-tier escalation: cookie → SSR → saved auth".

CLI `--mode` flag and MCP `mode` arg surface the same enum. CHANGELOG must call out the `'anon'` removal explicitly.

### 6.4 FetchResult extension

```typescript
export type FetchResult = {
  thread: XThread;
  coverage?: WalkCoverage;
  tier?: 'ssr' | 'cookie' | 'auth';
};
```

---

## 7. Architecture Changes

### 7.1 New Files

| File | Purpose |
|------|---------|
| `src/fetcher/ssr.ts` | Cheerio-based SSR HTML scraper. `fetchSSR(url): Promise<FetchResult>`. Extracts root post + visible replies from static HTML. |
| `src/auth/cookie-reader.ts` | Read Chromium family SQLite cookie DBs, decrypt via macOS Keychain. `readXCookies(): Promise<Cookie[]>`. Returns only X-domain cookies. |
| `src/auth/browsers.ts` | Detect installed Chromium browsers. `detectBrowsers(): BrowserInfo[]`. Returns paths to Cookie DB + Keychain service name per browser. |
| `src/cli/commands/auth-status.ts` | `xray auth --status` handler. Lists detected browsers, cookie presence, storageState existence. |
| `tests/unit/ssr.test.ts` | SSR parser tests with HTML fixture. |
| `tests/unit/cookie-extract.test.ts` | Cookie reader tests with mock SQLite DB. |
| `tests/unit/escalation.test.ts` | Escalation state machine tests (tier transitions, error handling). |
| `tests/fixtures/x-ssr-page.html` | Snapshot of X SSR HTML for a public thread. |

### 7.2 Modified Files

| File | Changes |
|------|---------|
| `src/fetcher/thread.ts` | Rewrite `fetchThread()` to implement 3-tier escalation: Cookie+PW first (Tier 1), SSR fallback (Tier 2), saved auth last resort (Tier 3). Add `tier` to `FetchResult`. Drop anonymous mode entirely. |
| `src/cli/index.ts` | Wire `xray auth --status` subcommand. |
| `src/cli/commands/auth.ts` | Add `--status` flag routing to `auth-status.ts`. |
| `src/models/report.ts` | Add `tier` field to `ThreadCoverageSchema`. |
| `src/render/markdown.ts` | Show `coverage.tier` in Conversation Analysis section. |
| `src/intelligence/analyze-thread.ts` | Pass `tier` from `FetchResult` into `coverage` on `ResearchReport`. |
| `src/mcp/server.ts` | No schema changes needed. `auto` mode behavior change is transparent. |
| `src/cache/threads.ts` | No changes. Single `{root_id}` key, upsert on conflict (existing behavior). Tier 2+ result naturally overwrites Tier 1. |
| `package.json` | Add `cheerio` dependency. Add `better-sqlite3` (or use Bun's built-in `bun:sqlite`) for reading Chrome cookie DBs. |

---

## 8. Escalation Orchestration Algorithm

### 8.1 State Machine (pseudocode)

```
async function fetchThread(rawUrl, opts):
  parsed = parseXUrl(rawUrl)
  cfg = loadConfig()
  mode = opts.mode ?? cfg.fetcher.mode

  // Direct mode overrides — skip escalation
  if mode == 'ssr':    return fetchSSR(parsed) with tier='ssr'
  if mode == 'cookie': return fetchWithCookies(parsed, opts) with tier='cookie' (no fallback)
  if mode == 'auth':   return fetchWithStorageState(parsed, opts) with tier='auth'

  // AUTO mode: 3-tier escalation, cookie+PW first
  // ---- TIER 1: COOKIE+PW (PRIMARY) ----
  try:
    browsers = detectChromiumBrowsers()  // Chrome, Brave, Edge in that order
    for browser in browsers:
      try:
        cookies = await readXCookies(browser)  // SQL-filtered to x.com, Keychain decrypt
        if cookies.length == 0:
          continue  // try next browser
        result = await fetchWithCookies(parsed, cookies, opts)
        return { ...result, tier: 'cookie' }
      catch err:
        if err is KeychainDeniedError:
          log.debug('Keychain denied for ' + browser.name + ', trying next')
          continue
        if err is AuthWallError:
          log.debug('cookies expired for ' + browser.name + ', trying next')
          continue
        log.debug('cookie path failed for ' + browser.name, err)
        continue
    log.debug('no Chromium browser yielded usable X cookies, falling back to SSR')
  catch err:
    log.debug('cookie tier failed entirely, falling back to SSR', err)

  // ---- TIER 2: SSR (FALLBACK) ----
  try:
    result = await fetchSSR(parsed.canonical)
    if result.thread.rootPost:
      // SSR found root; mark partial because no replies/metrics
      return { ...result, tier: 'ssr' }
    log.info('SSR returned no root post — likely login wall')
  catch err:
    log.warn('SSR fetch failed', err)

  // ---- TIER 3: SAVED AUTH (LAST RESORT) ----
  if existsSync(cfg.fetcher.storageStatePath):
    try:
      result = await fetchWithStorageState(parsed, opts)
      return { ...result, tier: 'auth' }
    catch err:
      log.error('saved auth fetch failed', err)

  // All tiers exhausted — surface clear actionable error
  throw FetchError(
    'This content requires authentication. ' +
    'Possible causes: not logged into X in Chrome/Brave/Edge, cookies expired, ' +
    'or protected/age-gated content. Run `xray auth` to save a login session.'
  )
```

### 8.2 fetchWithCookies (new core path)

```
async function fetchWithCookies(parsed, cookies, opts):
  browser = await getBrowser()
  ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  })
  await ctx.addCookies(cookies)  // Playwright API — accepts the decrypted Chrome cookies
  try:
    // Same navigateAndCapture flow as Phase 1's 'auth' mode,
    // but using injected cookies instead of storageState.json
    detail = await navigateAndCapture(ctx, parsed.canonical, parsed.id, opts)
    if NOT detail.rootPost:
      throw AuthWallError('cookie-injected fetch returned no root post')
    return buildThread(detail, opts)
  finally:
    await ctx.close()
```

### 8.3 Retry / Timeout Policy

- Tier 1 cookie+PW: one attempt per browser (Chrome → Brave → Edge), 30s timeout each. First success wins.
- Tier 2 SSR: single attempt, 10s HTTP timeout.
- Tier 3 saved auth: single attempt, 30s timeout.
- No global escalation budget. Worst-case full escalation ≈ 3×30s (cookies) + 10s (SSR) + 30s (auth) = ~130s. In practice, Tier 1 success on Chrome ends the chain in ~10s for cached threads or ~30s cold.

---

## 9. Privacy & Threat Model

### 9.1 What We Read

| Data source | What we read | Scope filter |
|---|---|---|
| Chrome Cookies SQLite | Rows where `host_key LIKE '%.x.com'` OR `host_key = 'x.com'` | SQL WHERE clause — never reads non-X cookies |
| Brave Cookies SQLite | Same filter | Same |
| Edge Cookies SQLite | Same filter | Same |
| macOS Keychain | Encryption key for "Chrome Safe Storage" / "Brave Safe Storage" / "Microsoft Edge Safe Storage" | Single key per browser, used only for PBKDF2 derivation |

### 9.2 Specific Cookies Extracted

Only these cookies are used (others matching `%.x.com` are read from SQLite but discarded before injection):

| Cookie name | Purpose | Why needed |
|---|---|---|
| `auth_token` | Session authentication | Required for authenticated X API access |
| `ct0` | CSRF token | Required by X's GraphQL API — sent as `x-csrf-token` header |
| `twid` | Twitter user ID | Session binding |
| `guest_id` | Guest session | Fallback for semi-authenticated requests |
| `guest_id_ads` | Ad tracking guest ID | Sometimes required by X's API validation |
| `guest_id_marketing` | Marketing guest ID | Sometimes required by X's API validation |

### 9.3 Where Cookies Go in Memory

1. `readXCookies()` returns a `Cookie[]` array (Playwright-compatible format)
2. Cookies are passed to `ctx.addCookies()` — Playwright stores them in its in-memory browser context
3. Browser context is closed after the fetch completes (`finally { await ctx.close() }`)
4. Cookie values are NEVER logged (not even at debug level)
5. Cookie values are NEVER written to disk (no persistence)
6. Cookie values are NEVER included in the `XThread` or `ResearchReport` output

### 9.4 What We Never Persist

- Raw cookie values (never written to cache, logs, or output)
- Cookie SQLite DB contents (read-only, in-memory only)
- Keychain encryption keys (used transiently for PBKDF2, then discarded)
- Non-X-domain cookies (filtered at SQL query level, never loaded into memory)

### 9.5 What Users Can Audit

- `xray auth --status` shows WHICH browsers were detected and WHETHER X cookies exist — but never shows cookie VALUES
- `XRAY_LOG_LEVEL=debug` logs tier transitions and escalation reasons — but never cookie values
- No telemetry, no remote calls. XRay is fully offline except for X.com and Kyma API.

### 9.6 Threat Model

| Threat | Mitigation |
|---|---|
| XRay leaks cookies to Kyma API | Cookies are never included in any Kyma request. Only thread text/comments are sent. |
| XRay persists cookies in cache DB | Cookie values are never stored. Only `XThread` JSON (text, metrics, IDs) is cached. |
| Malicious thread content exfiltrates cookies | No eval/exec on thread content. Cheerio and JSON parsing only. |
| Keychain access prompt fatigue | Single prompt per browser, per application lifetime. macOS caches the decision. |
| Cookie DB locked by browser | Open SQLite with `SQLITE_OPEN_READONLY`. If locked (WAL mode), copy DB to temp file first. |

---

## 10. Per-Platform Cookie Reader Implementation Notes

### 10.1 macOS (v0.2.0 — full support)

#### Cookie DB Paths

| Browser | Default Profile Cookies Path | Keychain Service Name |
|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome/Default/Cookies` | `Chrome Safe Storage` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies` | `Brave Safe Storage` |
| Edge | `~/Library/Application Support/Microsoft Edge/Default/Cookies` | `Microsoft Edge Safe Storage` |

All three use the same SQLite schema and encryption format (Chromium shared code).

#### Decryption Algorithm

```
1. Read encryption key from macOS Keychain:
   security find-generic-password -s "Chrome Safe Storage" -w

2. Derive AES key via PBKDF2:
   key = PBKDF2(password=keychainPassword, salt="saltysalt", iterations=1003, keyLen=16, hash=SHA1)

3. For each cookie row where encrypted_value starts with b'v10':
   iv = 16 bytes of 0x20 (space character)
   ciphertext = encrypted_value[3:]  // strip 'v10' prefix
   plaintext = AES-128-CBC-decrypt(key, iv, ciphertext)
   value = pkcs7_unpad(plaintext)
```

#### SQLite Read Strategy

```sql
SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly
FROM cookies
WHERE host_key LIKE '%.x.com' OR host_key = 'x.com'
```

- Open with `SQLITE_OPEN_READONLY` to avoid WAL lock conflicts with the running browser
- If the DB is locked (browser holding a write lock), copy to a temp file and read from the copy
- Use Bun's built-in `bun:sqlite` — no additional dependency needed

#### Keychain Access

- `security find-generic-password -s "Chrome Safe Storage" -w` prompts macOS Keychain dialog on first use
- User clicks "Allow" or "Always Allow" — macOS caches the decision
- If user clicks "Deny" → command returns non-zero → `readXCookies()` returns empty array → fall through to Tier 2 (SSR) silently

### 10.2 Linux (deferred to v0.3)

- Chrome: `~/.config/google-chrome/Default/Cookies`
- Brave: `~/.config/BraveSoftware/Brave-Browser/Default/Cookies`
- Edge: `~/.config/microsoft-edge/Default/Cookies`
- Encryption: libsecret (GNOME Keyring) or kwallet (KDE). If neither, Chromium uses a hardcoded key `peanuts`.
- Different PBKDF2 iteration count (1 on Linux vs 1003 on macOS).

### 10.3 Windows (deferred to v0.3)

- Chrome: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies`
- Encryption: DPAPI (`CryptUnprotectData`). Cookie values prefixed with `v10` use AES-GCM with key from `Local State` JSON file.
- Completely different decrypt path.

---

## 11. Cache Strategy

### 11.1 Single-Key Upsert

Cache key: `{root_id}` (existing behavior, unchanged).

When a thread is fetched at any tier:
- `putCachedThread(thread)` is called with the same `INSERT ... ON CONFLICT(root_id) DO UPDATE` SQL
- A Tier 2 fetch naturally overwrites a Tier 1 cache entry because it produces a richer `XThread` (more comments, nested replies, real-time metrics)
- The cache does NOT store which tier produced the data (that's in `coverage.tier` on the report, which is computed at read time)

### 11.2 TTL

- All tiers: existing 24h TTL (`cfg.cache.ttlSeconds = 86400`)
- `--no-cache` bypasses all tiers' cache reads (existing behavior)
- Partial results: existing 1h TTL logic applies regardless of tier

### 11.3 Cache-Then-Fetch

The existing flow in `analyze-thread.ts` already checks cache before fetch:
```
thread = getCachedThread(parsed.id)  // cache hit? use it
if !thread: result = await fetchThread(...)  // cache miss → fetch
```

P1.5 does not change this. If a cached thread exists (from any prior tier), it's used. If the user wants fresher data, they use `--no-cache`.

---

## 12. Test Plan

### 12.1 Existing Tests (89 tests, 10 files — all green, all survive untouched)

| File | Tests | Status |
|------|-------|--------|
| `tests/unit/parser.test.ts` | - | Unchanged |
| `tests/unit/models.test.ts` | - | Unchanged |
| `tests/unit/markdown.test.ts` | - | Unchanged |
| `tests/unit/markdown-p1.test.ts` | - | Unchanged |
| `tests/unit/markdown-deep.test.ts` | - | Unchanged |
| `tests/unit/url.test.ts` | - | Unchanged |
| `tests/unit/pagination.test.ts` | - | Unchanged |
| `tests/unit/classify.test.ts` | - | Unchanged |
| `tests/unit/deep.test.ts` | - | Unchanged |
| `tests/unit/coverage.test.ts` | - | Unchanged |

### 12.2 New Test Files

| File | What it covers | Est. test count |
|------|---------------|----------------|
| `tests/unit/ssr.test.ts` | SSR HTML parsing: root post extraction, comment extraction, metrics parsing, edge cases (empty replies, deleted tweet HTML, login wall HTML). Uses `tests/fixtures/x-ssr-page.html`. | ~15 |
| `tests/unit/cookie-extract.test.ts` | Cookie reader: SQLite query with host_key filter, decryption (mock Keychain output), cookie format conversion to Playwright format, empty DB, no X cookies, expired cookies. Uses mock SQLite DB. | ~12 |
| `tests/unit/escalation.test.ts` | Escalation state machine: cookies present → stops at Tier 1; no Chromium → falls to Tier 2 SSR; Tier 1 + Tier 2 fail → Tier 3 if storageState exists; all tiers fail → throws actionable error. `coverage.tier` set correctly per path. | ~10 |

### 12.3 New Fixtures

| Fixture | Description |
|---------|-------------|
| `tests/fixtures/x-ssr-page.html` | Captured SSR HTML from a public X thread page. Includes root post, several visible replies, meta tags. Scrubbed of any real user data. |
| (mock Chrome SQLite DB) | Created programmatically in `cookie-extract.test.ts` setup — a temporary SQLite file with the Chrome cookies schema and test rows. Not a fixture file. |

### 12.4 Target Test Count After P1.5

- Existing: 89
- New: ~37
- **Target: ~126 tests across 13 files**

---

## 13. Sub-Phase Delivery

### P1.5.0 — SSR Scrape (Foundation)

**Scope:** Add cheerio dependency. Build `src/fetcher/ssr.ts`. Wire into `fetchThread()` as Tier 1 for `auto` mode. Change default `xray thread <url>` (no flags) to use SSR. Add `coverage.tier` to data model and markdown output.

**Files touched:**
- NEW: `src/fetcher/ssr.ts`
- MOD: `src/fetcher/thread.ts` (add SSR as first tier in auto mode, add tier to FetchResult)
- MOD: `src/models/report.ts` (add `tier` to ThreadCoverageSchema)
- MOD: `src/render/markdown.ts` (show tier in output)
- MOD: `src/intelligence/analyze-thread.ts` (pass tier to coverage)
- MOD: `package.json` (add cheerio)
- NEW: `tests/unit/ssr.test.ts`
- NEW: `tests/fixtures/x-ssr-page.html`

**Acceptance criteria:**
```bash
# Default invocation uses SSR (no Playwright launch)
XRAY_LOG_LEVEL=debug xray thread https://x.com/karpathy/status/XXXX 2>&1 | grep "tier"
# Should show tier=ssr

# Root post and some replies returned
xray thread https://x.com/karpathy/status/XXXX --json | jq '.coverage.tier'
# Should output "ssr"

# SSR is fast (no browser overhead)
time xray thread https://x.com/karpathy/status/XXXX --raw > /dev/null
# Should complete in <3s (network dependent)

# Explicit --mode anon still uses Playwright
xray thread https://x.com/karpathy/status/XXXX --mode anon --raw --json | jq '.coverage.tier'
# Should output "anon"

bun test
```

**Effort:** ~6-8 hours

---

### P1.5.1 — Chromium Cookie Reader

**Scope:** Build `src/auth/cookie-reader.ts` and `src/auth/browsers.ts`. Read Chrome/Brave/Edge cookies on macOS, decrypt via Keychain, convert to Playwright cookie format. Unit tests with mock SQLite DB.

**Files touched:**
- NEW: `src/auth/cookie-reader.ts`
- NEW: `src/auth/browsers.ts`
- NEW: `tests/unit/cookie-extract.test.ts`

**Acceptance criteria:**
```bash
# Unit tests pass for cookie reading + decryption
bun test tests/unit/cookie-extract.test.ts

# Manual verification: if logged into X in Chrome
# (debug log shows cookie count — never values)
XRAY_LOG_LEVEL=debug bun run src/auth/cookie-reader.ts 2>&1 | grep "cookies found"
# Should output "X cookies found: N" (N > 0 if logged in)
```

**Effort:** ~8-10 hours (Keychain integration + SQLite decrypt is the hardest part of P1.5)

---

### P1.5.2 — Escalation Orchestrator

**Scope:** Rewrite `fetchThread()` auto mode to implement the 3-tier state machine (Cookie+PW → SSR → saved auth). Wire `fetchWithCookies()` as primary path. Drop the existing anonymous-Playwright code path. Escalation unit tests.

**Files touched:**
- MOD: `src/fetcher/thread.ts` (major rewrite of `fetchThread`; remove `fetchInMode('anon')` path)
- MOD: `src/fetcher/browser.ts` (add `newContextWithCookies()` helper)
- NEW: `tests/unit/escalation.test.ts`

**Acceptance criteria:**
```bash
# Auto mode on a public thread with logged-in Chrome cookies returns Tier 1
xray thread https://x.com/karpathy/status/XXXX --raw --json | jq '.coverage.tier'
# "cookie"

# Same thread with cookies removed/expired falls back to SSR
XRAY_FORCE_NO_COOKIES=1 xray thread https://x.com/karpathy/status/XXXX --raw --json | jq '.coverage.tier'
# "ssr"

# Direct override to SSR
xray thread https://x.com/karpathy/status/XXXX --mode ssr --raw --json | jq '.coverage.tier'
# "ssr"

# Escalation tests pass
bun test tests/unit/escalation.test.ts

# All 126+ tests pass
bun test
```

**Effort:** ~6-8 hours

---

### P1.5.3 — `auth --status` + Polish

**Scope:** Add `xray auth --status` subcommand. Polish markdown output for tier display. Final integration testing across all tiers. Version bump to 0.2.0.

**Files touched:**
- NEW: `src/cli/commands/auth-status.ts`
- MOD: `src/cli/index.ts` (wire `auth --status`)
- MOD: `src/cli/commands/auth.ts` (route `--status` flag)
- MOD: `package.json` (version → 0.2.0)

**Acceptance criteria:**
```bash
# Auth status shows detected browsers
xray auth --status
# Output like:
#   Browser sources:
#     Chrome: cookies found (x.com: 6 cookies)
#     Brave: not installed
#     Edge: not installed
#   storageState.json: not found
#   Recommendation: Tier 3 (cookie inject) available

# Version bump
grep '"version"' package.json
# "0.2.0"

# Full test suite
bun test
```

**Effort:** ~3-4 hours

---

### Total Effort Estimate

| Sub-phase | Hours |
|-----------|-------|
| P1.5.0 SSR Scrape | 6-8 |
| P1.5.1 Cookie Reader | 8-10 |
| P1.5.2 Escalation Orchestrator | 6-8 |
| P1.5.3 Auth Status + Polish | 3-4 |
| **Total** | **23-30 hours** |

---

## 14. Acceptance Criteria — Phase 1.5 Overall

All of the following must pass before Phase 1.5 is considered complete:

```bash
# 1. All tests pass (existing 89 + new ~37)
bun test

# 2. Default invocation = SSR, no Playwright
xray thread https://x.com/karpathy/status/XXXX --raw --json | jq '.coverage.tier'
# Must output "ssr"

# 3. Tier escalation works (--depth triggers Playwright)
xray thread https://x.com/karpathy/status/XXXX --depth 3 --raw --json | jq '.coverage.tier'
# Must output "anon" (or "cookie"/"auth" if auth wall hit)

# 4. coverage.tier present in markdown output
xray thread https://x.com/karpathy/status/XXXX | grep -i "tier"
# Must show tier info

# 5. Auth status subcommand works
xray auth --status
# Must list browsers + cookie status + storageState status

# 6. Phase 1 regression: --deep still works
xray thread https://x.com/karpathy/status/XXXX --deep --json | jq '.subtreeSummaries | length'
# Must be > 0

# 7. MCP backward compatibility
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"xray_thread","arguments":{"url":"https://x.com/karpathy/status/XXXX"}},"id":1}' \
  | bun run src/mcp/index.ts
# Must return valid response with tier in coverage

# 8. No cookie values in any log level
XRAY_LOG_LEVEL=debug xray thread https://x.com/karpathy/status/XXXX 2>&1 | grep -i "auth_token\|ct0\|twid"
# Must return empty (no cookie values logged)

# 9. Version bump
grep '"version"' package.json
# Must show "0.2.0"
```

---

## 15. Migration & Backward Compatibility

### 15.1 Breaking Change

**Phase 1.5 introduces a deliberate breaking change in default behavior:**

- **Before (P0/P1):** `xray thread <url>` launches Playwright in anonymous mode, captures full GraphQL response
- **After (P1.5):** `xray thread <url>` does an SSR HTML scrape (no browser), returns fewer replies but is much faster

This is a hard break at v0.2.0. Users who relied on the Playwright-powered default can restore it with `--mode anon` or `--depth 3`.

### 15.2 CHANGELOG Entry Suggestion

```markdown
## [0.2.0] - 2026-XX-XX

### Breaking Changes
- **Default fetch behavior changed:** `xray thread <url>` now silently reads your
  Chrome/Brave/Edge X cookies (one-time macOS Keychain "Always Allow") and runs an
  authenticated Playwright fetch — full thread, replies, metrics. If no cookies are
  found, falls back to SSR HTML scrape (root post only). Phase 1 default was
  unauthenticated Playwright and failed on auth wall.
- **`--mode anon` removed.** The anonymous Playwright tier was dropped (X strips
  reply/metric data from logged-out responses — same content as SSR but slower).
  Use `--mode ssr` for no-auth fetch, or `--mode cookie` to force cookie path.
- **MCP `mode` enum** is now `'auto'|'ssr'|'cookie'|'auth'`. Callers passing
  `mode: 'anon'` will get a Zod parse error.

### Added
- 3-tier invisible auth escalation: Cookie+PW (Chrome/Brave/Edge, silent) → SSR fallback → saved `xray auth` (last resort)
- `coverage.tier` field (`'ssr'|'cookie'|'auth'`) in reports shows which tier produced the data
- `xray auth --status` subcommand for diagnosing available auth sources
- Silent Chromium cookie reading (Chrome, Brave, Edge on macOS) — zero-interaction authentication
- `--mode ssr` and `--mode cookie` direct-mode overrides for debugging and headless environments
- SSR fetcher: sub-second thread fetch without Playwright dependency
- Phase 1 features: deep reply tree pagination, comment classification (stance/quality/score), deep mode analysis

### Fixed
- Anonymous Playwright failures no longer dead-end — escalation chain tries cookies automatically
```

### 15.3 What Phase 1 Callers See

| Caller pattern | Before (P1) | After (P1.5) |
|---|---|---|
| `xray thread <url>` | Playwright anon (no cookies) — fails on auth wall | Cookie+PW silently → SSR fallback → useful output either way |
| `xray thread <url> --depth 3` | Playwright anon, paginated — fails on auth wall | Cookie+PW paginated (silent) |
| `xray thread <url> --deep` | Playwright anon + deep Kyma — fails on auth wall | Cookie+PW + deep Kyma (silent) |
| `xray_thread({ url })` MCP | Playwright anon — fails on auth wall | Cookie+PW silently → SSR fallback |
| `xray_thread({ url, depth: 3 })` MCP | Playwright paginated — fails on auth wall | Cookie+PW paginated (silent) |
| `xray_thread({ url, mode: 'anon' })` MCP | Playwright anon (the previous `'anon'` value) | **BREAKING**: `'anon'` removed from enum. Use `mode: 'ssr'` for no-auth or `mode: 'cookie'` to force cookie path. |

---

## 16. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Keychain decrypt complexity** — PBKDF2 + AES-128-CBC implementation in pure JS may have edge cases (encoding, padding) | Medium | High | Test against known Chrome cookie values. Use established crypto patterns. Bun has native `node:crypto` support. |
| **X SSR HTML structure changes** — Cheerio selectors break on X redesign | Medium | Medium | SSR failure gracefully escalates to Tier 2. Log warning for broken selectors. Selectors are isolated in `ssr.ts` for easy update. |
| **Chrome Cookies DB locked by running browser** — WAL mode prevents concurrent read | Medium | Low | Copy DB to temp file before reading. This is the standard pattern used by other tools (1Password, browser-cookie3). |
| **Keychain "Always Allow" not clicked** — User gets prompted every run | Low | Low | macOS caches Keychain decisions per app. If user clicks "Allow" (not "Always Allow"), they get prompted once per session. Document in `xray auth --status` output. |
| **X removes SSR rendering** — All content becomes client-side JS only | Low | High | Escalation chain falls through to Tier 2 automatically. SSR tier becomes a no-op. |
| **Cookie format changes in Chromium updates** — `v10` prefix or encryption algo changes | Low | Medium | Chromium is open source; encryption format has been stable since 2013. Monitor Chromium commits to `os_crypt/`. |

### Open Questions

1. **Should SSR extract engagement metrics from HTML or just `og:description`?** X's SSR includes structured data (JSON-LD?) and various meta tags. Cheerio can parse both. Recommend extracting whatever is available, with fallback to og tags.
2. **Should `xray auth --status` attempt a test fetch?** Current plan: no. Just detect browsers + cookies + storageState. A test fetch would add latency and might trigger rate limits. Users can test with `xray thread <url> --raw` instead.
3. **Multi-profile support?** Chrome supports multiple profiles (`Profile 1`, `Profile 2`, etc.). Current plan: read Default profile only. Multi-profile support deferred to v0.3.

---

## 17. Out of Scope (Explicit Deferrals)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| `xray_parse` MCP tool | Phase 2+ | P1.5 is fetch-tier only |
| Safari cookie support | v0.3+ | macOS SIP/FDA blocks programmatic access |
| Firefox cookie support | v0.3+ | NSS key4.db encryption, different implementation |
| Linux cookie support | v0.3+ | libsecret/kwallet, different keyring |
| Windows cookie support | v0.3+ | DPAPI, completely different decrypt |
| Multi-profile browser support | v0.3+ | Default profile covers 95% of users |
| Cookie refresh/rotation | v0.3+ | Current approach reads once per fetch |
| Playwright browser reuse across tiers | v0.3+ | Current approach creates new context per tier; optimization later |
| SSR streaming/progressive output | Not planned | SSR is already fast enough |
| User-selectable tier | Not planned | Defeats the invisible-auth principle |

---

**End of PHASE_1_5_PLAN.md**
