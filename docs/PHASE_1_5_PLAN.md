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

1. Make `xray thread <url>` (no flags) produce useful output via SSR HTML scraping — no Playwright launch, no cookies, no auth. Sub-2s latency for cached-or-fast-network hits.
2. Implement a 4-tier escalation chain (SSR -> anonymous Playwright -> silent cookie inject -> interactive auth) that runs transparently. The user never chooses a tier.
3. Silently read existing Chromium-family browser cookies (Chrome, Brave, Edge) on macOS, decrypt via Keychain, and inject into Playwright context — zero user interaction.
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
| `xray thread <url>` (no flags) | - | SSR-only (Tier 1) | Cheerio-based static HTML parse. No Playwright. `coverage.tier = 'ssr'`. | **BREAKING**: P1 default was anonymous Playwright. |
| `--depth <N>` | integer | `3` | Triggers Tier 2+ escalation if SSR insufficient. | Unchanged |
| `--max-replies <N>` | integer | `50` | Triggers Tier 2+ escalation. | Unchanged |
| `--deep` | boolean | `false` | Triggers Tier 2+ (needs full reply tree). | Unchanged |
| `--mode auto` | string | `auto` | 4-tier escalation chain (SSR -> anon PW -> cookie -> auth). | **NEW behavior**: `auto` now starts at SSR, not anon Playwright. |
| `--mode anon` | string | - | Force anonymous Playwright (Tier 2 only, skip SSR). | Unchanged |
| `--mode auth` | string | - | Force authenticated Playwright (Tier 4 storageState). | Unchanged |
| `--no-cache` | boolean | `false` | Bypass cache. | Unchanged |
| `--raw` | boolean | `false` | Skip LLM analysis. | Unchanged |
| `--json` | boolean | `false` | JSON output. | Unchanged |
| `xray auth` | command | - | Interactive Playwright login, save storageState. | Unchanged (Tier 4 last resort). |
| `xray auth --status` | command | - | Print detected cookie sources + storageState presence. | **NEW** |

### 3.2 MCP Surface

| Arg | Type | Default | Change |
|---|---|---|---|
| `url` | `z.string().url()` | required | Unchanged |
| `mode` | `z.enum(['auto','anon','auth'])` | `'auto'` | `auto` now means 4-tier escalation starting at SSR |
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

```
                        xray thread <url>
                              |
                    +---------+---------+
                    |                   |
              mode = auto          mode = anon/auth
                    |                   |
                    v                   v
         +-------------------+    (skip to Tier 2 or 4)
         |    TIER 1: SSR    |
         |  cheerio scrape   |
         |  no browser, no   |
         |  cookies, no auth |
         +--------+----------+
                  |
        result sufficient?
         (root post found +
          enough replies for
          the requested depth)
           /            \
         YES             NO
          |               |
     return result   +----v--------------+
     tier = 'ssr'    |   TIER 2: ANON    |
                     | Playwright headless|
                     | no cookies injected|
                     +--------+----------+
                              |
                    result sufficient?
                     (no auth wall,
                      replies returned)
                       /            \
                     YES             NO (AuthRequiredError)
                      |               |
                 return result   +----v-----------------+
                 tier = 'anon'   |   TIER 3: COOKIE     |
                                 | read Chrome/Brave/Edge|
                                 | SQLite cookies, decrypt|
                                 | via Keychain, inject  |
                                 | into Playwright context|
                                 +--------+-------------+
                                          |
                                cookies found
                                 & injected?
                                   /        \
                                 YES         NO (no browser
                                  |           installed or
                                  |           no X cookies)
                             return result    |
                             tier = 'cookie'  |
                                          +---v-----------------+
                                          |   TIER 4: AUTH      |
                                          | storageState.json   |
                                          | from `xray auth`    |
                                          | (interactive login) |
                                          +---------+-----------+
                                                    |
                                           storageState exists?
                                             /            \
                                           YES             NO
                                            |               |
                                       return result   throw FetchError
                                       tier = 'auth'   "Run `xray auth`"
```

### 4.1 Escalation Trigger Conditions

| From Tier | Escalates to | Trigger |
|-----------|-------------|---------|
| SSR (1) | Anon PW (2) | Root post not found in HTML, OR user requested `--depth > 1` / `--max-replies > SSR_VISIBLE_LIMIT` / `--deep`, OR SSR returned zero replies |
| Anon PW (2) | Cookie (3) | `AuthRequiredError` thrown (login wall / 401 / 403 / redirect to `/i/flow/login`) |
| Cookie (3) | Auth (4) | No Chromium cookies found, OR cookies expired, OR cookie-injected fetch still hit auth wall |
| Auth (4) | Error | `storageState.json` missing → throw `FetchError` with "Run `xray auth`" message |

### 4.2 When SSR is Sufficient (no escalation)

SSR is sufficient when ALL of these are true:
- `depth` is 1 (default) or unset AND `maxReplies` <= SSR visible count AND `--deep` is false
- The root post was found in the static HTML
- At least some replies were parsed from the SSR HTML

In practice: `xray thread <url>` with no flags will almost always stop at Tier 1 because the default behavior only needs the root post + whatever replies X renders in SSR.

### 4.3 SSR Visible Limit

X's SSR HTML typically includes the root post and 5-20 top-level replies (varies). Define constant `SSR_VISIBLE_LIMIT = 15`. If `maxReplies > SSR_VISIBLE_LIMIT` or `depth > 1`, auto-escalate to Tier 2.

---

## 5. Per-Tier Specification

### 5.1 Tier 1 — SSR Scrape

**File:** `src/fetcher/ssr.ts` (NEW)

**Trigger:** Default path for `mode: 'auto'` when no depth/reply escalation flags are set.

**What it fetches:**
- HTTP GET to `https://x.com/{user}/status/{id}` with standard browser User-Agent
- Parse the returned HTML with `cheerio` (new dependency)
- Extract from server-rendered HTML:
  - Root post: author handle, display name, text, timestamp, engagement metrics (likes/reposts/replies/views)
  - Visible replies: author, text, basic metrics (X SSR renders a subset of replies)
  - Quote tweets (if visible in SSR)
  - `og:*` meta tags for supplemental metadata

**Capabilities:**
- Sub-second fetch (no browser launch overhead)
- Works behind corporate proxies that block WebSocket (Playwright needs WS)
- Zero local state required
- Works in CI/CD environments without Playwright installed

**Limitations:**
- Cannot paginate (no cursor-based GraphQL)
- Limited reply count (5-20 depending on X's SSR rendering)
- No nested replies (only top-level visible)
- X may serve a login wall for some content (protected accounts, age-gated, NSFW)
- Metrics may be slightly stale (SSR vs real-time GraphQL)

**Cache strategy:** Same `{root_id}` key in threads table. Upsert overwrites if richer (Tier 2+ result replaces Tier 1).

**Error modes:**
- HTTP 4xx/5xx → escalate to Tier 2
- No root post found in HTML (login wall, deleted tweet) → escalate to Tier 2
- HTML structure changed (cheerio selectors broken) → escalate to Tier 2 + log warning

**Escalation criteria:** Root post not parsed OR user requested more data than SSR can provide.

### 5.2 Tier 2 — Anonymous Playwright

**File:** `src/fetcher/thread.ts` (existing — current `anon` mode)

**Trigger:** SSR failed or insufficient, AND no auth needed yet.

**What it fetches:** Full GraphQL TweetDetail via Playwright response interception. Cursor-based pagination for reply tree.

**Capabilities:** Full reply tree (depth N, up to maxReplies), quote tweets, nested replies, real-time metrics.

**Limitations:** X may throw auth wall (login redirect, 401, 403) for some content.

**Cache strategy:** Same `{root_id}` key. Overwrites SSR result (always richer).

**Error modes:** Auth wall → escalate to Tier 3.

**Escalation criteria:** `AuthRequiredError` thrown.

### 5.3 Tier 3 — Silent Cookie Inject

**Files:**
- `src/auth/cookie-reader.ts` (NEW) — read + decrypt Chromium SQLite cookies
- `src/auth/browsers.ts` (NEW) — detect installed browsers + profile paths

**Trigger:** Tier 2 hit auth wall, AND user has a Chromium browser with X cookies.

**What it does:**
1. Detect installed Chromium browsers (Chrome, Brave, Edge) via `browsers.ts`
2. Find the `Cookies` SQLite DB for each browser's default profile
3. Read cookies with `host_key LIKE '%x.com'` (privacy-scoped SQL filter)
4. Decrypt cookie values using macOS Keychain (PBKDF2 + AES-128-CBC)
5. Inject decrypted cookies into a fresh Playwright `BrowserContext` via `context.addCookies()`
6. Re-run the fetch with the injected context

**Capabilities:** Authenticated fetch without any user interaction. Reuses the user's existing browser session.

**Limitations:**
- macOS only (v0.2.0). Linux/Windows deferred.
- Only works if user is logged into X in Chrome/Brave/Edge
- Cookies may be expired → falls through to Tier 4
- Requires Keychain access prompt (one-time macOS dialog: "XRay wants to access Keychain")

**Cache strategy:** Same `{root_id}` key. Overwrites.

**Error modes:**
- No Chromium browsers found → escalate to Tier 4
- No X cookies in any browser → escalate to Tier 4
- Keychain access denied → escalate to Tier 4 (silent, no retry)
- Cookies expired / still auth wall → escalate to Tier 4

**Escalation criteria:** No viable cookies found, or cookie-injected fetch still fails auth.

### 5.4 Tier 4 — Interactive Auth (`xray auth`)

**File:** `src/auth/login.ts` (existing)

**Trigger:** All silent paths exhausted.

**What it does:** Opens a non-headless Playwright browser to `x.com/login`, waits for user to sign in, saves `storageState.json`.

**Capabilities:** Full authenticated access. Works for any account.

**Limitations:** Requires user interaction. Requires `XRAY_HEADLESS=false`.

**Cache strategy:** Same `{root_id}` key.

**Error modes:** User doesn't log in within 5 minutes → timeout error.

**Note:** In `auto` mode, Tier 4 does NOT automatically open a browser. Instead, it checks for an existing `storageState.json` (from a previous `xray auth` run). If missing, it throws `FetchError` with the message "Run `xray auth` to save login cookies." The interactive browser flow only runs when the user explicitly invokes `xray auth`.

---

## 6. Data Model Deltas

### 6.1 coverage.tier on ThreadCoverage

File: `src/models/report.ts`

```typescript
// Add to ThreadCoverageSchema:
export const ThreadCoverageSchema = z.object({
  // ... existing fields ...
  tier: z.enum(['ssr', 'anon', 'cookie', 'auth']).optional(),
});
```

`tier` is optional so all existing P0/P1 outputs remain valid without migration. When present, it indicates which escalation tier produced the data.

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

### 6.3 FetchMode enum extension

File: `src/fetcher/thread.ts`

```typescript
// Existing:
export type FetchMode = 'auto' | 'anon' | 'auth';

// Unchanged. 'auto' now means "4-tier escalation starting at SSR".
// No new enum values needed — the tier is an internal routing detail.
```

### 6.4 FetchResult extension

```typescript
export type FetchResult = {
  thread: XThread;
  coverage?: WalkCoverage;
  tier?: 'ssr' | 'anon' | 'cookie' | 'auth';
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
| `src/fetcher/thread.ts` | Rewrite `fetchThread()` to implement 4-tier escalation orchestrator. SSR first, then anon PW, then cookie inject, then auth fallback. Add `tier` to `FetchResult`. |
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
  if mode == 'anon': return fetchAnon(parsed, opts) with tier='anon'
  if mode == 'auth': return fetchAuth(parsed, opts) with tier='auth'

  // AUTO mode: 4-tier escalation
  // ---- TIER 1: SSR ----
  needsEscalation = (opts.depth > 1) OR (opts.maxReplies > SSR_VISIBLE_LIMIT) OR opts.deep
  if NOT needsEscalation:
    try:
      result = await fetchSSR(parsed.canonical, parsed.id)
      if result.thread.rootPost AND result.thread.comments.length > 0:
        return { ...result, tier: 'ssr' }
      // SSR returned root but no comments — still usable for root-only requests
      if result.thread.rootPost AND opts.maxReplies == 0:
        return { ...result, tier: 'ssr' }
      log.debug('SSR insufficient, escalating to Tier 2')
    catch err:
      log.debug('SSR failed, escalating to Tier 2', err)

  // ---- TIER 2: ANON PLAYWRIGHT ----
  try:
    result = await fetchInMode(parsed, 'anon', opts)
    return { ...result, tier: 'anon' }
  catch err:
    if NOT (err instanceof AuthRequiredError):
      throw err  // non-auth error = fatal
    log.info('anon fetch hit auth wall, trying cookie inject')

  // ---- TIER 3: COOKIE INJECT ----
  try:
    cookies = await readXCookies()  // from Chrome/Brave/Edge
    if cookies.length > 0:
      result = await fetchWithCookies(parsed, cookies, opts)
      return { ...result, tier: 'cookie' }
    log.debug('no X cookies found in any browser')
  catch err:
    log.debug('cookie inject failed', err)

  // ---- TIER 4: SAVED AUTH (storageState.json) ----
  if existsSync(cfg.fetcher.storageStatePath):
    result = await fetchInMode(parsed, 'auth', opts)
    return { ...result, tier: 'auth' }

  // All tiers exhausted
  throw FetchError(
    'This content requires authentication. Run `xray auth` to save login cookies.'
  )
```

### 8.2 fetchWithCookies (new)

```
async function fetchWithCookies(parsed, cookies, opts):
  browser = await getBrowser()
  ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  })
  await ctx.addCookies(cookies)  // Playwright API
  // ... same navigateAndCapture flow as fetchInMode('auth')
  // but using injected cookies instead of storageState
```

### 8.3 Retry / Timeout Policy

- SSR: single attempt, 10s HTTP timeout
- Tier 2 (anon): single attempt, existing `cfg.fetcher.timeoutMs` (30s default)
- Tier 3 (cookie): single attempt per browser (try Chrome first, then Brave, then Edge). First success wins. 30s timeout per attempt.
- Tier 4 (saved auth): single attempt, 30s timeout
- Total escalation budget: no global timeout. Each tier is independently timed. In practice, worst-case full escalation takes ~2 minutes (SSR timeout + anon timeout + 3 cookie attempts + auth attempt).

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
- If user clicks "Deny" → command returns non-zero → `readXCookies()` returns empty array → fall through to Tier 4 silently

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
| `tests/unit/escalation.test.ts` | Escalation state machine: SSR-sufficient stops at Tier 1, SSR-fail escalates to Tier 2, auth wall escalates to Tier 3, no cookies escalates to Tier 4, all tiers fail throws error. `coverage.tier` set correctly per path. | ~10 |

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

**Scope:** Rewrite `fetchThread()` auto mode to implement the 4-tier state machine. Wire cookie reader into Tier 3. Add `fetchWithCookies()`. Escalation unit tests.

**Files touched:**
- MOD: `src/fetcher/thread.ts` (major rewrite of `fetchThread` and `fetchInMode`)
- MOD: `src/fetcher/browser.ts` (add `newContextWithCookies()` helper)
- NEW: `tests/unit/escalation.test.ts`

**Acceptance criteria:**
```bash
# Auto mode with a public thread stops at SSR (Tier 1)
xray thread https://x.com/karpathy/status/XXXX --raw --json | jq '.coverage.tier'
# "ssr"

# Auto mode with --depth 3 escalates to Tier 2 (Playwright)
xray thread https://x.com/karpathy/status/XXXX --depth 3 --raw --json | jq '.coverage.tier'
# "anon"

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
- **Default fetch behavior changed:** `xray thread <url>` now uses SSR HTML scraping
  (no browser launch) instead of anonymous Playwright. This is significantly faster but
  returns fewer replies. Use `--depth 3` or `--mode anon` to get the previous behavior
  with full reply tree pagination.

### Added
- 4-tier invisible auth escalation: SSR -> anonymous Playwright -> silent cookie inject -> interactive auth
- `coverage.tier` field in reports shows which tier produced the data
- `xray auth --status` subcommand for diagnosing available auth sources
- Silent Chromium cookie reading (Chrome, Brave, Edge on macOS) — zero-interaction authentication
- SSR fetcher: sub-second thread fetch without Playwright dependency
- Phase 1 features: deep reply tree pagination, comment classification (stance/quality/score), deep mode analysis

### Fixed
- Anonymous Playwright failures no longer dead-end — escalation chain tries cookies automatically
```

### 15.3 What Phase 1 Callers See

| Caller pattern | Before (P1) | After (P1.5) |
|---|---|---|
| `xray thread <url>` | Playwright anon, full GraphQL | SSR scrape, fewer replies |
| `xray thread <url> --depth 3` | Playwright anon, paginated | Playwright anon, paginated (same) |
| `xray thread <url> --deep` | Playwright anon + deep Kyma | SSR → escalate to Playwright → deep Kyma (same final result) |
| `xray_thread({ url })` MCP | Playwright anon | SSR scrape |
| `xray_thread({ url, depth: 3 })` MCP | Playwright paginated | Playwright paginated (same) |
| `xray_thread({ url, mode: 'anon' })` MCP | Playwright anon | Playwright anon (same) |

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
