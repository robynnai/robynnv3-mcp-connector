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
import { registerAssistTools } from "./tools/assist";
import { registerConversationTools } from "./tools/conversations";
import { registerRunTools } from "./tools/runs";
import { registerGeoTools } from "./tools/geo";
import { registerBattlecardTools } from "./tools/battlecard";
import { registerSeoTools } from "./tools/seo";
import { registerBrandBookTools } from "./tools/brand-book";
import { registerCampaignTools } from "./tools/campaign";
import { registerCmoAgentTools } from "./tools/cmo-agent";
import { registerWebsiteTools } from "./tools/website";
import { registerContentPlanTools } from "./tools/content-plan";
import { registerWeeklyVisibilityTools } from "./tools/weekly-visibility";
import { registerConnectorTools } from "./tools/connectors";
import { registerCapabilityTools } from "./tools/capabilities";
import { registerBrandOperationTools } from "./tools/brand-operations";
import { registerHermesBridgeTools } from "./tools/hermes-bridge";
import { registerConnectorActionTools } from "./tools/connector-act";
import { registerVaultTools } from "./tools/vault";
import { registerStrapiTools } from "./tools/strapi";
import type { Env, Props } from "./types";
import { VaultR2 } from "./vault-r2";
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
      {
        authLogContext: "hosted-mcp",
        refreshAccessToken: async () => {
          const refreshed = await refreshUpstreamAccessToken(
            this.props,
            this.env.ROBYNN_API_BASE_URL,
          );

          if (!refreshed) {
            console.warn("[TokenRefresh] No refreshed upstream token available", {
              source: "hosted-mcp-tool-call",
              hasProps: Boolean(this.props),
              hasRefreshToken: Boolean(this.props?.refreshToken),
              hasApiBaseUrl: Boolean(
                this.props?._apiBaseUrl || this.env.ROBYNN_API_BASE_URL,
              ),
            });
            return undefined;
          }

          await this.updateProps(refreshed.props);
          return refreshed.accessToken;
        },
      },
    );
    const publicBaseUrl = getPublicBaseUrl(this.env.MCP_PUBLIC_BASE_URL);

    registerReportAppResources(this.server, publicBaseUrl);

    registerContextTools(this.server, client);
    registerStatusTools(this.server, client);
    registerContentTools(this.server, client);
    registerResearchTools(this.server, client);
    registerAssistTools(this.server, client);
    registerConversationTools(this.server, client);
    registerRunTools(this.server, client);
    registerGeoTools(this.server, client);
    registerBattlecardTools(this.server, client);
    registerSeoTools(this.server, client);
    registerBrandBookTools(this.server, client);
    registerCmoAgentTools(this.server, client);
    registerCampaignTools(this.server, client);
    registerWebsiteTools(this.server, client);
    registerContentPlanTools(this.server, client);
    registerWeeklyVisibilityTools(this.server, client);
    registerCapabilityTools(this.server, client);
    registerBrandOperationTools(this.server, client);
    registerConnectorTools(this.server, client);
    registerStrapiTools(this.server, client);
    registerHermesBridgeTools(this.server, client);
    registerConnectorActionTools(this.server, client);

    // Vault tools depend on the R2 binding + the OAuth-bound org id.
    // Skip silently when either is missing (e.g. local dev without the
    // binding, or a mis-issued token); other tools still work.
    const organizationId = this.props?.organizationId;
    const vaultBucket = this.env.VAULT;
    if (organizationId && vaultBucket) {
      registerVaultTools(this.server, new VaultR2(vaultBucket, organizationId));
    } else {
      console.warn(
        "[RobynnMCP] Vault tools skipped — " +
          (!vaultBucket ? "no VAULT binding" : "no organizationId in props"),
      );
    }
  }
}

const OAUTH_CLIENT_ID = "robynn-mcp-worker";
const SUPPORTED_OAUTH_SCOPES = ["brand:read", "tools:execute"];

interface UpstreamTokenRefreshResult {
  accessToken: string;
  expiresIn?: number;
  props: Props;
}

async function refreshUpstreamAccessToken(
  props: Props | undefined,
  fallbackApiBaseUrl?: string,
): Promise<UpstreamTokenRefreshResult | undefined> {
  const refreshToken = props?.refreshToken;
  const apiBaseUrl = props?._apiBaseUrl || fallbackApiBaseUrl;
  if (!props || !refreshToken || !apiBaseUrl) return undefined;

  try {
    const res = await fetch(`${apiBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!res.ok) {
      console.error(
        "[TokenRefresh] Upstream refresh failed:",
        res.status,
        await res.text(),
      );
      return undefined;
    }

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    console.log("[TokenRefresh] Upstream Robynn token refreshed", {
      hasRotatedRefreshToken: Boolean(tokens.refresh_token),
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      props: {
        ...props,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        _apiBaseUrl: apiBaseUrl,
      },
    };
  } catch (err) {
    console.error("[TokenRefresh] Failed to refresh upstream token:", err);
    return undefined;
  }
}

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
  const refreshed = await refreshUpstreamAccessToken(props);
  if (!refreshed) return;

  return {
    newProps: refreshed.props,
    accessTokenTTL: refreshed.expiresIn,
  };
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

    if (shouldTrace && response.status === 401) {
      console.warn("[OAuth401] Claude request rejected before MCP tool execution", {
        method: request.method,
        path: originalUrl.pathname,
        rewrittenPath,
        hasAuthHeader: request.headers.has("authorization"),
        wwwAuthenticate: response.headers.get("www-authenticate"),
      });
    }

    return response;
  },
};
