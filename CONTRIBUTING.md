# Contributing to XRay

Thanks for the interest! XRay is an OSS research tool for X (Twitter), built for AI agents first and humans second. Bug reports, feature ideas, and PRs are all welcome.

## Dev setup

- [Bun](https://bun.sh) ≥ 1.1 required (the toolchain assumes Bun for run + test + bundler-free TypeScript).
- macOS or Linux. Windows is untested.
- `ffmpeg` required for video features. `yt-dlp` optional (only needed for non-X video platforms).

```bash
git clone https://github.com/sonpiaz/xray.git
cd xray
bun install
bunx playwright install chromium   # one-time
cp .env.example .env               # then set KYMA_API_KEY
```

Get a Kyma key (free tier): `curl -X POST https://kymaapi.com/v1/auth/register -H 'Content-Type: application/json' -d '{"email":"you@example.com"}'`.

## Project structure

```
src/
  cli/          CLI entrypoint + per-command handlers
  mcp/          MCP server (stdio) + tool schemas
  fetcher/      Playwright + cookie + SSR fetchers
  intelligence/ Kyma-driven analysis (thread / video / article / profile)
  embeddings/   Local MiniLM-L6-v2 provider
  search/       Semantic search over the cache
  cache/        SQLite cache layer (posts, threads, comments, articles, embeddings, profiles)
  core/         Errors, logger, retry, shared utilities
  render/       Markdown renderers for each report shape
tests/
  unit/         Vitest unit tests
  fixtures/     Recorded API responses, HTML samples, etc.
bin/xray.ts     CLI entrypoint (passed to `bun run`)
docs/           Phase plans, roadmap, spec
```

## Commands

| Command | Purpose |
|---|---|
| `bun run test` | Run all unit tests (currently ~670). |
| `bun run test:watch` | Vitest in watch mode. |
| `bun run typecheck` | TypeScript strict check (`tsc --noEmit`). |
| `bun run lint` | Biome lint + format check. |
| `bun run format` | Biome auto-format. |
| `bun run dev` | Local CLI dev with file watch. |
| `bun run xray <command>` | Invoke the CLI via the package script. |

## Commit convention

XRay follows [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): subject` — new capability
- `fix(scope): subject` — bug fix
- `chore(scope): subject` — housekeeping (deps, CI, formatting)
- `docs(scope): subject` — documentation only
- `refactor(scope): subject` — internals only, no behavior change
- `test(scope): subject` — test-only changes

Scope is the sub-phase identifier where applicable (e.g., `feat(p5.0): README rewrite for v1.0-track`). Keep the subject in imperative mood under 70 chars.

## PR process

1. Branch from `main`: `git checkout -b feat/your-feature` (or `fix/bug-description`).
2. Implement + add tests. Aim for "no regression" — keep the green test count or grow it.
3. Run the full local gate before pushing:
   ```bash
   bun run typecheck && bun run lint && bun run test
   ```
4. Open a PR against `main`; fill out [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md).
5. The maintainer (currently [@sonpiaz](https://github.com/sonpiaz)) reviews + merges.
6. Squash-merge is the default; rebase-merge is OK when the history is genuinely useful.

## Breaking-change protocol

XRay is pre-1.0 until Phase 5 ships. Once v1.0.0 lands, full semver applies. ANY of the following counts as a breaking change:

- Renamed, removed, or semantically changed CLI flag.
- Renamed or removed CLI command.
- Renamed, removed, or semantically changed MCP tool input/output field.
- Changed persisted cache shape (SQLite schema or stored JSON).
- Changed default behavior of an existing command.

Breaking changes MUST:

1. Bump the MAJOR version (e.g., 1.x.y → 2.0.0).
2. Add a `### Breaking Changes` section to the new CHANGELOG entry.
3. Document the migration path (old → new) in that section.

## MCP tool versioning

Each MCP tool ships with `_meta: { version: "1.0" }` in its `registerTool` config (added in P5.1). Bump the tool version when its schema changes incompatibly:

- **Additive change** (new optional input or output field) → minor bump (`1.0` → `1.1`).
- **Breaking change** (renamed/removed/retyped field) → major bump (`1.0` → `2.0`).

All tools move in **lockstep**: when bumping MAJOR on any tool, every tool jumps to that MAJOR (unchanged tools just publish the new version number). The CHANGELOG entry documents the old → new migration so MCP callers can adapt.

## Test guidelines

- Unit tests live in `tests/unit/*.test.ts` and use [Vitest](https://vitest.dev).
- Fixtures live in `tests/fixtures/`.
- **No live network in unit tests.** Use the test-seam pattern (e.g., `_orchestratorDeps`, injected `fetch`) to swap in mocks.
- Integration tests against real X / Kyma are **manual** — run them before releases. They are not part of CI.
- Aim for one test per externally-visible behavior. Prefer end-to-end-ish tests that exercise the orchestrator over micro-mocked unit tests on internal helpers.

## Release process

1. Make sure every sub-phase merged into `main` is green (`bun run typecheck && bun run lint && bun run test`).
2. Bump the version in **three** places (kept in lockstep by convention):
   - `package.json` → `"version"`
   - `src/cli/index.ts` → `const VERSION`
   - `src/mcp/server.ts` → `const VERSION`
3. Prepend a CHANGELOG entry: `## [X.Y.Z] — YYYY-MM-DD`. Group under `### Added`, `### Changed`, `### Fixed`, `### Breaking Changes`, `### Dependencies` as needed.
4. Update the README version badge if it's pinned to a specific version.
5. Commit: `chore(release): vX.Y.Z`.
6. Tag + push: `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push origin main --tags`.
7. Create the GitHub release: `gh release create vX.Y.Z --notes-file <changelog-slice>`.

## Security policy

If you discover a security issue (cookie handling, decrypt path, code execution via crafted input, etc.), **do NOT open a public issue**. Email the maintainer privately at the address listed in [`.github/ISSUE_TEMPLATE/security.md`](./.github/ISSUE_TEMPLATE/security.md). We aim to respond within 72 hours and coordinate disclosure responsibly.

## Code of Conduct

XRay follows a short, project-specific Code of Conduct — see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). By contributing, you agree to its guidelines. Report concerns privately to **sonxpiaz@gmail.com**.
