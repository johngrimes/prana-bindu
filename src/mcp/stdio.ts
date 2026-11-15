import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type McpDeps } from "./server.js";

/** Serves the MCP tools over stdin/stdout until the client disconnects. */
export async function runMcpStdio(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
