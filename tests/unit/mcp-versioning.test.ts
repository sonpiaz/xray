/**
 * P5.1 — Verify that every XRay MCP tool surfaces `_meta.version === '1.0'`
 * to clients via `tools/list`. We don't boot the full `startMcpServer()`
 * (which wires SIGINT / browser / db shutdown) — instead we mirror the
 * registration shape with an in-memory transport pair and assert on the
 * SDK's actual listTools output.
 *
 * If the SDK ever drops `_meta` passthrough from `registerTool`, these
 * tests fail and remind us to switch to the `annotations` shim.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import {
  ArticleInput,
  ProfileInput,
  SearchInput,
  ThreadInput,
  VideoInput,
} from '../../src/mcp/schemas.ts';

const TOOL_VERSION = '1.0';

// P5.2 — read TOOL_VERSION out of the server source file rather than
// importing src/mcp/server.ts (which transitively pulls in `bun:sqlite`
// via closeDb and breaks the Vitest/Node loader). Same drift-detection
// guarantee, no module side effects.
function readToolVersionFromSource(): string {
  const serverPath = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url));
  const source = readFileSync(serverPath, 'utf8');
  const match = source.match(/export const TOOL_VERSION = '([^']+)'/);
  if (!match) throw new Error('TOOL_VERSION constant not found in src/mcp/server.ts');
  return match[1] as string;
}

/**
 * Build a fresh server + client pair pre-wired with all 5 tools — but only
 * the metadata, no real handlers. Returns the client so each test can call
 * `listTools()` against it.
 */
async function bootMockedServer(): Promise<Client> {
  const server = new McpServer({ name: 'xray', version: 'test' });
  const noopHandler = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

  const registrations = [
    { name: 'xray_thread', schema: ThreadInput },
    { name: 'xray_video', schema: VideoInput },
    { name: 'xray_article', schema: ArticleInput },
    { name: 'xray_search', schema: SearchInput },
    { name: 'xray_profile', schema: ProfileInput },
  ];
  for (const { name, schema } of registrations) {
    server.registerTool(
      name,
      {
        title: name,
        description: `${name} test stub`,
        inputSchema: schema,
        _meta: { version: TOOL_VERSION },
      },
      noopHandler,
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP tool versioning (_meta.version)', () => {
  it('lists all 5 XRay tools via tools/list', async () => {
    const client = await bootMockedServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['xray_article', 'xray_profile', 'xray_search', 'xray_thread', 'xray_video'].sort(),
    );
    await client.close();
  });

  it('every tool exposes _meta.version === "1.0"', async () => {
    const client = await bootMockedServer();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const meta = (tool as { _meta?: Record<string, unknown> })._meta;
      expect(meta, `tool ${tool.name} should have _meta`).toBeDefined();
      expect(meta?.version, `tool ${tool.name} should have _meta.version`).toBe(TOOL_VERSION);
    }
    await client.close();
  });

  it('all tools share the same TOOL_VERSION (no drift)', async () => {
    const client = await bootMockedServer();
    const { tools } = await client.listTools();
    const versions = tools.map((t) => (t as { _meta?: { version?: string } })._meta?.version);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBe(TOOL_VERSION);
    await client.close();
  });

  it('TOOL_VERSION matches the canonical v1.0 string from server.ts', () => {
    // Parsed out of src/mcp/server.ts (P5.2). Can't import the module
    // because closeDb transitively loads bun:sqlite which Vitest/Node
    // can't resolve. Source-string parsing gives us the same drift
    // detection without the loader penalty.
    expect(readToolVersionFromSource()).toBe('1.0');
    expect(TOOL_VERSION).toBe('1.0');
  });
});
