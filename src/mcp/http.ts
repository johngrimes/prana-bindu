import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { createMcpServer, type McpDeps } from "./server.js";

/** Stateless streamable HTTP (JSON response mode): a fresh server + transport per request. */
export async function handleMcpRequest(c: Context, deps: McpDeps): Promise<Response> {
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
