import OAuthProvider, { GrantType } from "@cloudflare/workers-oauth-provider";
import type {
  OAuthProviderOptions,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RobynnClient } from "./robynn-client";
import { buildSignedTokenRequest, getInternalAuthSecret } from "./internal-mcp-auth";
import { getProtectedResourceMetadata, robynnAuthHandler } from "./auth-handler";
import {
  isCanonicalRequestPath,
  isUnservedApiPath,
  MCP_API_PATH,
  SUPPORTED_OAUTH_SCOPES,
} from "./authorization/oauth-policy";
import {
  enforceAuthorizationCodeRedirect,
  grantTypeForLog,
  readTokenRequestContext,
  RedirectUriMismatchError,
  type TokenRequestContext,
} from "./authorization/token-binding";
import { errorKind, safeLog } from "./safe-log";
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
import { registerCmoDecideTools } from "./tools/cmo-decide";
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
      safeLog.error("mcp.session.unauthenticated", { reason: "access_token_missing" });
      this.server.tool(
        "robynn_status",
        "Check Robynn connection status.",
        {},
        async () => ({
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Disconnect Robynn in your app's MCP or connector settings, then connect it again.",
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
            getInternalAuthSecret(this.env),
            this.env.ROBYNN_API_BASE_URL,
          );

          if (!refreshed) {
            safeLog.warn("oauth.refresh.unavailable", {
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
    registerCmoDecideTools(this.server, client);
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
      safeLog.warn("mcp.vault.skipped", {
        reason: !vaultBucket ? "vault_binding_missing" : "organization_missing",
      });
    }
  }
}

interface UpstreamTokenRefreshResult {
  accessToken: string;
  expiresIn?: number;
  props: Props;
}

async function refreshUpstreamAccessToken(
  props: Props | undefined,
  internalAuthSecret: string | null,
  fallbackApiBaseUrl?: string,
): Promise<UpstreamTokenRefreshResult | undefined> {
  const refreshToken = props?.refreshToken;
  const apiBaseUrl = props?._apiBaseUrl || fallbackApiBaseUrl;
  if (!props || !refreshToken || !apiBaseUrl) return undefined;

  try {
    // Signed like the code exchange; the app rejects unsigned refreshes.
    const tokenRequest = await buildSignedTokenRequest(
      internalAuthSecret,
      apiBaseUrl,
      { grant_type: "refresh_token", refresh_token: refreshToken },
    );
    const res = await fetch(tokenRequest.url, tokenRequest.init);

    if (!res.ok) {
      // Never read or log the body: it can echo credentials.
      await res.body?.cancel().catch(() => undefined);
      safeLog.warn("oauth.refresh.upstream_rejected", { upstreamStatus: res.status });
      return undefined;
    }

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    safeLog.info("oauth.refresh.upstream_refreshed", {
      rotated: Boolean(tokens.refresh_token),
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
    safeLog.error("oauth.refresh.failed", { errorKind: errorKind(err) });
    return undefined;
  }
}

/**
 * Provider token-exchange hook.
 *
 * - authorization_code: the host's `redirect_uri` must equal the one it used
 *   at /authorize (P01 F10, P06). Throwing here leaves the code unconsumed;
 *   the fetch wrapper answers `400 invalid_grant`.
 * - refresh_token: refresh the upstream robynn.ai JWT. Its fail-open "no
 *   result" branch (F12) is P10's to close.
 */
async function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  env: Env,
  tokenRequest?: TokenRequestContext,
): Promise<TokenExchangeCallbackResult | void> {
  if (options.grantType === GrantType.AUTHORIZATION_CODE) {
    return {
      newProps: enforceAuthorizationCodeRedirect(options.props as Props, tokenRequest),
    };
  }
  if (options.grantType !== GrantType.REFRESH_TOKEN) return;

  const props = options.props as Props;
  const refreshed = await refreshUpstreamAccessToken(
    props,
    getInternalAuthSecret(env),
  );
  if (!refreshed) return;

  return {
    newProps: refreshed.props,
    accessTokenTTL: refreshed.expiresIn,
  };
}

/**
 * The provider options the Worker actually runs with. Exported so the
 * provider-contract suite exercises these exact options (P06).
 *
 * - `allowPlainPKCE: false`, plus the S256 challenge check in `/authorize`
 *   (F9: the option alone still lets a challenge-less request through).
 * - Implicit and token-exchange grants are off.
 * - The API route is `/mcp` only; SSE is not served in v1 (D-C / D10). Other
 *   API-prefix paths are 404'd by the fetch wrapper before the provider (F14).
 */
export function createOAuthProviderOptions(
  env: Env,
  tokenRequest?: TokenRequestContext,
): OAuthProviderOptions {
  const publicBaseUrl = getPublicBaseUrl(env.MCP_PUBLIC_BASE_URL);

  return {
    apiRoute: [MCP_API_PATH],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiHandler: RobynnMCP.serve(MCP_API_PATH) as any,
    defaultHandler: robynnAuthHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [...SUPPORTED_OAUTH_SCOPES],
    resourceMetadata: getProtectedResourceMetadata(publicBaseUrl),
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    allowTokenExchangeGrant: false,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    tokenExchangeCallback: (options) => tokenExchangeCallback(options, env, tokenRequest),
    // The provider's default writes a raw console line; keep its logs
    // structured and redacted (status + OAuth code only, no description).
    onError: ({ status, code }) => {
      safeLog.warn("oauth.provider.error", { status, error: code });
    },
  };
}

export function createOAuthProvider(env: Env, tokenRequest?: TokenRequestContext) {
  return new OAuthProvider(createOAuthProviderOptions(env, tokenRequest));
}

/** Mirrors the provider's CORS behaviour for the wrapper's own responses. */
function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "*");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, *");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function oauthErrorResponse(
  request: Request,
  status: number,
  error: string,
  description: string,
) {
  return withCors(
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
    request,
  );
}

function notFound() {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

const TRACED_PATHS = new Set(["/register", "/authorize", "/callback", "/token", MCP_API_PATH]);

/**
 * Worker entry point — OAuthProvider wraps everything.
 *
 * - /mcp → routed to McpAgent Durable Object (authenticated); SSE is not served
 * - /authorize, /token, /register → handled by OAuthProvider
 * - All other paths → routed to robynnAuthHandler (Hono app)
 *
 * Every routing decision below is taken from `rewrittenUrl.pathname`, the
 * exact path the provider will see (P06 review B2).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const publicOrigin = new URL(getPublicBaseUrl(env.MCP_PUBLIC_BASE_URL)).origin;
    const originalUrl = new URL(request.url);

    // `//host/...` would be re-parsed as protocol-relative: refuse it.
    if (!isCanonicalRequestPath(originalUrl.pathname)) return notFound();

    // Build the provider URL structurally (never by string concatenation)
    // and pin it to the public origin.
    const rewrittenUrl = new URL(publicOrigin);
    rewrittenUrl.pathname =
      originalUrl.pathname === "/" && request.method !== "GET"
        ? MCP_API_PATH
        : originalUrl.pathname;
    rewrittenUrl.search = originalUrl.search;
    const path = rewrittenUrl.pathname;
    if (rewrittenUrl.origin !== publicOrigin || !isCanonicalRequestPath(path)) {
      return notFound();
    }

    // Only `/mcp` is served under the API prefixes (contract §6.4 step 1).
    if (isUnservedApiPath(path)) return notFound();

    const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
    const isTokenRequest = path === "/token";
    let tokenRequest: TokenRequestContext | undefined;
    if (isTokenRequest) {
      const read = await readTokenRequestContext(rewrittenRequest);
      if (!read.ok) {
        // The body was never read: refused on the declared length alone.
        safeLog.warn("oauth.token.rejected", { reason: read.reason });
        return read.reason === "length_required"
          ? oauthErrorResponse(request, 411, "invalid_request", "Content-Length is required")
          : oauthErrorResponse(request, 413, "invalid_request", "Token request body too large");
      }
      tokenRequest = read.context;
    }
    const oauthProvider = createOAuthProvider(env, tokenRequest);
    const shouldTrace = TRACED_PATHS.has(path);

    let response: Response;
    try {
      response = await oauthProvider.fetch(rewrittenRequest, env, ctx);
    } catch (err) {
      if (!isTokenRequest) throw err;
      if (err instanceof RedirectUriMismatchError) {
        safeLog.warn("oauth.token.rejected", { reason: "redirect_uri_mismatch" });
        return oauthErrorResponse(
          request,
          400,
          "invalid_grant",
          "redirect_uri does not match the authorization request",
        );
      }
      safeLog.error("oauth.token.failed", { errorKind: errorKind(err) });
      return oauthErrorResponse(request, 500, "server_error", "Token request failed");
    }

    if (shouldTrace) {
      // Method, path and status only: never Location (it carries the code
      // and state), query strings, bodies, WWW-Authenticate details or the
      // raw grant_type (a closed enum is logged instead).
      safeLog.info("oauth.trace", {
        method: request.method,
        path,
        status: response.status,
        hasAuthHeader: request.headers.has("authorization"),
        grantType: grantTypeForLog(tokenRequest),
      });
    }

    return response;
  },
};
