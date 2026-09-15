import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createTestLeaseMcpServer, type TestLeaseMcpOptions } from './server.js';

export interface StdioServerHandle {
  close(): Promise<void>;
  /** Resolves when the transport closes (stdin EOF or client disconnect). */
  closed: Promise<void>;
}

/**
 * Serves MCP over stdio. Intended for agent hosts that spawn `testlease mcp --url ...`:
 * the process talks to the TestLease HTTP server through the normal client, so there is a
 * single source of truth for lease state no matter how many agents connect.
 */
export async function serveStdio(options: TestLeaseMcpOptions): Promise<StdioServerHandle> {
  const server = createTestLeaseMcpServer(options);
  const transport = new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  transport.onclose = () => resolveClosed();
  await server.connect(transport);
  return {
    closed,
    close: async () => {
      await server.close();
      resolveClosed();
    },
  };
}
