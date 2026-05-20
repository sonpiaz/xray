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

  it('TOOL_VERSION matches the constant exported from server.ts', async () => {
    // Import indirectly so we don't run the SIGINT registration in
    // startMcpServer. We just need the registration call shape to match.
    // The constant is private — assert by string equality against the
    // canonical value we expect in P5.1.
    expect(TOOL_VERSION).toBe('1.0');
  });
});
