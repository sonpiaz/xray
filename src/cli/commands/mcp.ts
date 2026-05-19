import { startMcpServer } from '../../mcp/server.ts';

export async function mcpCommand(): Promise<void> {
  await startMcpServer();
}
