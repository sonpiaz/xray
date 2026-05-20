/**
 * P5.2 — Version-constant alignment guard.
 *
 * Version is tracked in three sources of truth (per CONTRIBUTING.md
 * `## Release process`):
 *
 *   - package.json "version"
 *   - src/cli/index.ts  VERSION
 *   - src/mcp/server.ts VERSION
 *
 * Historically these have drifted (release ships, two get bumped, the
 * third is forgotten — `xray --version` then lies). This test pins them
 * together so any future bump must touch all three or the suite fails.
 *
 * Separately, the per-tool MCP `TOOL_VERSION` is intentionally
 * DECOUPLED from the project semver — it tracks schema compatibility
 * only, in major.minor form. That decoupling is asserted here too so
 * someone who "fixes" the version test by unifying everything to
 * '1.0.0' gets a red light pointing at the docs.
 *
 * We read the constants out of the source files via regex rather than
 * importing them, because both src/cli/index.ts and src/mcp/server.ts
 * transitively load `bun:sqlite` (via the cache layer + closeDb), which
 * the Vitest/Node loader can't resolve. Source-string parsing gives
 * the same drift-detection guarantee without paying the loader cost.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readConst(relativeFile: string, constantName: string): string {
  const path = fileURLToPath(new URL(`../../${relativeFile}`, import.meta.url));
  const source = readFileSync(path, 'utf8');
  // Match: `export const NAME = '...'` OR `const NAME = '...'`
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${constantName}\\s*=\\s*['"]([^'"]+)['"]`);
  const match = source.match(pattern);
  if (!match) throw new Error(`Constant ${constantName} not found in ${relativeFile}`);
  return match[1] as string;
}

const PKG_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string }).version;
const CLI_VERSION = readConst('src/cli/index.ts', 'VERSION');
const MCP_VERSION = readConst('src/mcp/server.ts', 'VERSION');
const TOOL_VERSION = readConst('src/mcp/server.ts', 'TOOL_VERSION');

describe('version constants stay in lockstep', () => {
  it('package.json reports a valid semver', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('src/cli/index.ts VERSION matches package.json', () => {
    expect(CLI_VERSION).toBe(PKG_VERSION);
  });

  it('src/mcp/server.ts VERSION matches package.json', () => {
    expect(MCP_VERSION).toBe(PKG_VERSION);
  });

  it('per-tool MCP TOOL_VERSION stays in major.minor form (independent of package semver)', () => {
    // Per CONTRIBUTING.md `## MCP tool versioning`, the per-tool version
    // axis is decoupled from the project semver. It bumps only on tool
    // schema changes, in major.minor form. If someone unifies it with
    // the package version, this assertion catches it and points at the
    // docs.
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
