import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { createMcpServer, type McpDeps } from "./server.js";

/**
 * Stateless streamable HTTP (JSON response mode): a fresh server + transport per request.
 * Only POST is served: without sessions there are no server-initiated messages (GET SSE stream) and nothing to
 * terminate (DELETE), so the transport spec's 405 applies. A 200 stream that closes at once makes clients drop the connection.
 */
export async function handleMcpRequest(c: Context, deps: McpDeps): Promise<Response> {
  if (c.req.method !== "POST") {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { Allow: "POST" });
  }
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    await transport.close();
    await server.close();
  }
}
