import OAuthProvider, { GrantType } from "@cloudflare/workers-oauth-provider";
import type { TokenExchangeCallbackOptions, TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RobynnClient } from "./robynn-client";
import { getProtectedResourceMetadata, robynnAuthHandler } from "./auth-handler";
import { registerContextTools } from "./tools/context";
import { registerStatusTools } from "./tools/status";
import { registerContentTools } from "./tools/content";
import { registerResearchTools } from "./tools/research";
import { registerConversationTools } from "./tools/conversations";
import { registerRunTools } from "./tools/runs";
import { registerGeoTools } from "./tools/geo";
import { registerBattlecardTools } from "./tools/battlecard";
import { registerSeoTools } from "./tools/seo";
import { registerBrandBookTools } from "./tools/brand-book";
import { registerWebsiteTools } from "./tools/website";
import { registerConnectorTools } from "./tools/connectors";
import type { Env, Props } from "./types";
import { getPublicBaseUrl, registerReportAppResources } from "./ui/report-app";
import { APP_VERSION } from "./version";

/**
 * RobynnMCP — Durable Object that hosts the MCP server.
 * Each authenticated user gets their own DO instance with their
 * OAuth access token in `this.props`.
 */
export class RobynnMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Robynn",
    version: APP_VERSION,
  });

  async init() {
    const accessToken = this.props?.accessToken;
    if (!accessToken) {
      console.error("[RobynnMCP] No access token in props — tools will fail");
      this.server.tool(
        "robynn_status",
        "Check Robynn connection status.",
        {},
        async () => ({
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Please disconnect and reconnect the Robynn connector in your Claude settings.",
            },
          ],
          isError: true,
        }),
      );
      return;
    }

    const client = new RobynnClient(
      this.env.ROBYNN_API_BASE_URL,
      accessToken,
    );
    const publicBaseUrl = getPublicBaseUrl(this.env.MCP_PUBLIC_BASE_URL);

    registerReportAppResources(this.server, publicBaseUrl);

    registerContextTools(this.server, client);
    registerStatusTools(this.server, client);
    registerContentTools(this.server, client);
    registerResearchTools(this.server, client);
    registerConversationTools(this.server, client);
    registerRunTools(this.server, client);
    registerGeoTools(this.server, client);
    registerBattlecardTools(this.server, client);
    registerSeoTools(this.server, client);
    registerBrandBookTools(this.server, client);
    registerWebsiteTools(this.server, client);
    registerConnectorTools(this.server, client);
  }
}

const OAUTH_CLIENT_ID = "robynn-mcp-worker";
const SUPPORTED_OAUTH_SCOPES = ["brand:read", "tools:execute"];

/**
 * Refresh the upstream robynn.ai JWT when the OAuthProvider rotates tokens.
 * On authorization_code grant the props already contain a fresh JWT, so we
 * only act on refresh_token grants.
 */
async function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | void> {
  if (options.grantType !== GrantType.REFRESH_TOKEN) return;

  const props = options.props as Props;
  if (!props.refreshToken || !props._apiBaseUrl) return;

  try {
    const res = await fetch(`${props._apiBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: props.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!res.ok) {
      console.error("[TokenExchange] Upstream refresh failed:", res.status, await res.text());
      return;
    }

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      newProps: {
        ...props,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      },
      accessTokenTTL: tokens.expires_in,
    };
  } catch (err) {
    console.error("[TokenExchange] Failed to refresh upstream token:", err);
  }
}

function createOAuthProvider(env: Env) {
  const publicBaseUrl = getPublicBaseUrl(env.MCP_PUBLIC_BASE_URL);

  return new OAuthProvider({
    apiRoute: ["/mcp", "/sse"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiHandler: RobynnMCP.serve("/mcp") as any,
    defaultHandler: robynnAuthHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: SUPPORTED_OAUTH_SCOPES,
    resourceMetadata: getProtectedResourceMetadata(publicBaseUrl),
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    tokenExchangeCallback,
  });
}

/**
 * Worker entry point — OAuthProvider wraps everything.
 *
 * - /mcp and /sse → routed to McpAgent Durable Object (authenticated)
 * - /authorize, /token, /register → handled by OAuthProvider
 * - All other paths → routed to robynnAuthHandler (Hono app)
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const oauthProvider = createOAuthProvider(env);
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
