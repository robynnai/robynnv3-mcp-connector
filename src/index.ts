import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RobynnClient } from "./robynn-client";
import { robynnAuthHandler } from "./auth-handler";
import { registerContextTools } from "./tools/context";
import { registerStatusTools } from "./tools/status";
import { registerContentTools } from "./tools/content";
import { registerResearchTools } from "./tools/research";
import { registerConversationTools } from "./tools/conversations";
import { registerGeoTools } from "./tools/geo";
import { registerBattlecardTools } from "./tools/battlecard";
import { registerSeoTools } from "./tools/seo";
import type { Env, Props } from "./types";

/**
 * RobynnMCP — Durable Object that hosts the MCP server.
 * Each authenticated user gets their own DO instance with their
 * OAuth access token in `this.props`.
 */
export class RobynnMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Robynn",
    version: "0.1.0",
  });

  async init() {
    const accessToken = this.props?.accessToken;
    if (!accessToken) {
      console.error("[RobynnMCP] No access token in props — tools will fail");
    }

    // Create API client using the authenticated user's access token
    const client = new RobynnClient(
      this.env.ROBYNN_API_BASE_URL,
      accessToken || ""
    );

    // Register the existing tools plus the Phase 1 intelligence-first tools
    registerContextTools(this.server, client);
    registerStatusTools(this.server, client);
    registerContentTools(this.server, client);
    registerResearchTools(this.server, client);
    registerConversationTools(this.server, client);
    registerGeoTools(this.server, client);
    registerBattlecardTools(this.server, client);
    registerSeoTools(this.server, client);
  }
}

/**
 * Worker entry point — OAuthProvider wraps everything.
 *
 * - /mcp and /sse → routed to McpAgent Durable Object (authenticated)
 * - /authorize, /token, /register → handled by OAuthProvider
 * - All other paths → routed to robynnAuthHandler (Hono app)
 */
export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: RobynnMCP.serve("/mcp") as any,
  defaultHandler: robynnAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
