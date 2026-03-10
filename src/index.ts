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
import { registerBrandBookTools } from "./tools/brand-book";
import { registerWebsiteTools } from "./tools/website";
import type { Env, Props } from "./types";
import { getPublicBaseUrl, registerReportAppResources } from "./ui/report-app";

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
    const publicBaseUrl = getPublicBaseUrl(this.env.MCP_PUBLIC_BASE_URL);

    registerReportAppResources(this.server, publicBaseUrl);

    // Register the existing tools plus the Phase 1 intelligence-first tools
    registerContextTools(this.server, client);
    registerStatusTools(this.server, client);
    registerContentTools(this.server, client);
    registerResearchTools(this.server, client);
    registerConversationTools(this.server, client);
    registerGeoTools(this.server, client);
    registerBattlecardTools(this.server, client);
    registerSeoTools(this.server, client);
    registerBrandBookTools(this.server, client);
    registerWebsiteTools(this.server, client);
  }
}

const oauthProvider = new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: RobynnMCP.serve("/mcp") as any,
  defaultHandler: robynnAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
})

/**
 * Worker entry point — OAuthProvider wraps everything.
 *
 * - /mcp and /sse → routed to McpAgent Durable Object (authenticated)
 * - /authorize, /token, /register → handled by OAuthProvider
 * - All other paths → routed to robynnAuthHandler (Hono app)
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const publicBaseUrl = getPublicBaseUrl(env.MCP_PUBLIC_BASE_URL);
    const originalUrl = new URL(request.url);
    const rewrittenPath =
      originalUrl.pathname === "/" && request.method !== "GET"
        ? "/mcp"
        : originalUrl.pathname;
    const rewrittenUrl = new URL(
      `${rewrittenPath}${originalUrl.search}`,
      publicBaseUrl,
    );
    const rewrittenRequest = new Request(rewrittenUrl.toString(), request);

    const shouldTrace =
      originalUrl.pathname === "/register" ||
      originalUrl.pathname === "/authorize" ||
      originalUrl.pathname === "/callback" ||
      originalUrl.pathname === "/token" ||
      originalUrl.pathname === "/mcp" ||
      (originalUrl.pathname === "/" && request.method !== "GET") ||
      originalUrl.pathname === "/sse";

    if (shouldTrace) {
      console.log("[OAuthTrace] request", {
        method: request.method,
        path: originalUrl.pathname,
        rewrittenPath,
        hasAuthHeader: request.headers.has("authorization"),
      });
    }

    const response = await oauthProvider.fetch(rewrittenRequest, env, ctx);

    if (shouldTrace) {
      console.log("[OAuthTrace] response", {
        method: request.method,
        path: originalUrl.pathname,
        rewrittenPath,
        status: response.status,
        location: response.headers.get("location"),
        wwwAuthenticate: response.headers.get("www-authenticate"),
      });
    }

    return response;
  },
};
