# Changelog

All notable changes to XRay will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-19

### Breaking Changes

- **Default fetch is now invisible-auth, not anonymous Playwright.** `xray thread <url>` (no flags) silently reads your Chrome / Brave / Edge X cookies, decrypts them via macOS Keychain (one-time "Always Allow" prompt), and runs an authenticated fetch — full reply tree, metrics, quote tweets. When no cookies are available it falls back to an SSR HTML scrape (root post only). The Phase 1 default was unauthenticated Playwright and failed on every login wall.
- **`--mode anon` removed.** The anonymous-Playwright tier returned the same content as SSR but slower. Replace with `--mode ssr` (no-auth) or `--mode cookie` (force cookie injection, no fallback).
- **MCP `mode` enum** is now `'auto' | 'ssr' | 'cookie' | 'auth'`. Callers still passing `mode: 'anon'` will get a Zod parse error.

### Added

- **3-tier invisible auth escalation** (Cookie+Playwright → SSR fallback → saved `xray auth`). The user picks no tiers; the orchestrator runs the chain silently. Spec: `docs/PHASE_1_5_PLAN.md`.
- **Silent Chromium cookie reader** for Chrome, Brave, and Edge on macOS — opens the Cookies SQLite DB read-only, decrypts only the X-domain rows via PBKDF2 + AES-128-CBC, never logs or persists values.
- **`xray auth --status`** diagnostic subcommand: shows detected browsers, X cookie counts, storageState presence, and the active tier — without ever triggering a Keychain dialog.
- **`--mode ssr` and `--mode cookie`** direct-mode overrides for headless servers, CI, debugging, or guaranteeing the cookie path.
- **`coverage.tier`** field (`'ssr' | 'cookie' | 'auth'`) on every ResearchReport so downstream agents can see how the data was obtained.
- **SSR fetcher** — cheerio-based sub-second fetch with no Playwright dependency. Extracts the root post (text, author, OG image) from logged-out HTML.
- **Deep reply trees** — cursor-based pagination through "Show more replies" branches up to `--depth` / `--max-replies`.
- **Reply classification** — Kyma-scored stance + quality labels for every comment in the tree.
- **Engagement pre-filter** with "Top Quality" and "Dissenting" sections in the markdown report.
- **`--deep` mode** — per-subtree Kyma calls plus a cross-subtree synthesis pass (~10× cost, much richer analysis).

### Changed

- `xray thread <url>` no longer requires login for public threads — the cookie tier covers most users invisibly, SSR covers the rest.
- Markdown output now surfaces the tier and coverage status so users know whether they got the full thread or just the root post.

### Fixed

- Anonymous Playwright dead-ending on auth walls — the escalation chain now tries cookies automatically and only surfaces an auth prompt as a last resort.
- `XRAY_HEADLESS` env var no longer flips truthy on the literal string `"false"`.

## [0.0.1] — 2026-05-18

- Initial scaffold — CLI, MCP server, basic thread fetching, SQLite cache.
