import OAuthProvider, { GrantType, getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type {
  OAuthProviderOptions,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { DurableObject } from "cloudflare:workers";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RobynnClient } from "./robynn-client";
import { getProtectedResourceMetadata, robynnAuthHandler } from "./auth-handler";
import { withMcpPreflight } from "./authorization/mcp-preflight";
import {
  isCanonicalRequestPath,
  isUnservedApiPath,
  MCP_API_PATH,
  SUPPORTED_OAUTH_SCOPES,
} from "./authorization/oauth-policy";
import {
  refreshCoordinatorName,
  refreshRequestKey,
  SerializedRunner,
} from "./authorization/refresh-coordinator";
import {
  admitStartProps,
  admitUpgrade,
  bindingFromProps,
  readSessionBinding,
  sameBinding,
  SESSION_BINDING_HEADER,
  shouldAdoptProps,
  type SessionBinding,
} from "./authorization/session-binding";
import {
  enforceAuthorizationCodeRedirect,
  grantTypeForLog,
  readTokenRequestContext,
  RedirectUriMismatchError,
  type TokenRequestContext,
} from "./authorization/token-binding";
import {
  RefreshRequestMismatchError,
  RefreshScopeError,
  refreshUpstreamGrant,
  UpstreamGrantRevokedError,
  UpstreamUnavailableError,
} from "./authorization/upstream-refresh";
import { createVaultGate } from "./authorization/vault-gate";
import { readPreflightStamp } from "./authorization/preflight-stamp";
import { errorKind, safeLog } from "./safe-log";
import { registerContextTools } from "./tools/context";
import { connectionFromStamp, registerStatusTools, registerUnauthenticatedStatusTool } from "./tools/status";
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
import { SERVER_INSTRUCTIONS } from "./server-instructions";
import { APP_VERSION } from "./version";

/** partyserver's internal naming request (carries the caller's props). */
const PARTYSERVER_SET_NAME_PATH = "/cdn-cgi/partyserver/set-name/";

/**
 * RobynnMCP — Durable Object that hosts one MCP session.
 *
 * The session is bound, once and for good, to the identity of its
 * `initialize` caller (P10; contract D7). The Worker preflight checks that
 * binding before any request reaches the session; this class enforces it
 * again: mismatching props are never adopted, and the transport upgrade is
 * refused unless the Worker's binding header matches. It never refreshes
 * upstream credentials itself (D6): a newer upstream token arrives with the
 * host's next request after the host refreshed through `/token`.
 */
export class RobynnMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer(
    {
      name: "Robynn",
      version: APP_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  private client: RobynnClient | undefined;
  private sessionStarted = false;

  /**
   * Read by the Worker preflight over DO RPC before `RobynnMCP.serve`
   * addresses this session. Reads storage directly: no `onStart`, no props.
   */
  async getSessionBinding(): Promise<SessionBinding | null> {
    return readSessionBinding(this.ctx.storage);
  }

  async onStart(props?: Props) {
    const { adopt, outcome } = await admitStartProps(this.ctx.storage, props);
    if (outcome === "refused") safeLog.warn("mcp.session.props_refused", { phase: "start" });
    await super.onStart(adopt);
    this.sessionStarted = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PARTYSERVER_SET_NAME_PATH) {
      // A warm session ignores later props (F17); adopt a newer upstream
      // token only for the bound identity.
      if (this.sessionStarted) await this.adoptWarmProps(request.headers.get("x-partykit-props"));
      return super.fetch(request);
    }
    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      !(await admitUpgrade(this.ctx.storage, request.headers.get(SESSION_BINDING_HEADER)))
    ) {
      safeLog.warn("mcp.session.upgrade_refused", {});
      return new Response("Session not found", { status: 404 });
    }
    return super.fetch(request);
  }

  private async adoptWarmProps(raw: string | null) {
    if (!raw) return;
    let incoming: Partial<Props>;
    try {
      incoming = JSON.parse(raw) as Partial<Props>;
    } catch {
      return;
    }
    const binding = await readSessionBinding(this.ctx.storage);
    if (!sameBinding(binding, bindingFromProps(incoming))) {
      safeLog.warn("mcp.session.props_refused", { phase: "warm" });
      return;
    }
    if (!shouldAdoptProps(this.props, incoming)) return;
    await this.updateProps(incoming as Props);
    this.client?.setAccessToken((incoming as Props).accessToken);
  }

  async init() {
    const accessToken = this.props?.accessToken;
    if (!accessToken || this.props?.authVersion !== 2) {
      safeLog.error("mcp.session.unauthenticated", {
        reason: accessToken ? "legacy_props" : "access_token_missing",
      });
      registerUnauthenticatedStatusTool(this.server);
      return;
    }

    // No refresh hook: an upstream 401 surfaces as authorization_expired.
    const client = new RobynnClient(this.env.ROBYNN_API_BASE_URL, accessToken, {
      authLogContext: "hosted-mcp",
    });
    this.client = client;
    const publicBaseUrl = getPublicBaseUrl(this.env.MCP_PUBLIC_BASE_URL);

    registerReportAppResources(this.server, publicBaseUrl);

    registerContextTools(this.server, client);
    // robynn_status reports the organization and permissions the preflight
    // verified for this very call (stamp), never the session's stored props.
    registerStatusTools(this.server, client, {
      connection: (extra) => connectionFromStamp(readPreflightStamp(extra), this.props?.appGrantId),
    });
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

    // Vault tools read R2 directly: every call needs the Worker preflight's
    // stamp for this tool and grant (createVaultGate), so a revoked or
    // unverified connection never reaches R2. Skipped without the binding.
    const organizationId = this.props.organizationId;
    const vaultBucket = this.env.VAULT;
    if (organizationId && vaultBucket) {
      registerVaultTools(this.server, new VaultR2(vaultBucket, organizationId), createVaultGate(() => this.props));
    } else {
      safeLog.warn("mcp.vault.skipped", {
        reason: !vaultBucket ? "vault_binding_missing" : "organization_missing",
      });
    }
  }
}

/**
 * Provider token-exchange hook.
 *
 * - authorization_code: the host's `redirect_uri` must equal the one it used
 *   at /authorize (P01 F10, P06). Throwing here leaves the code unconsumed;
 *   the Worker answers `400 invalid_grant`.
 * - refresh_token: refresh the upstream credential, fail-closed (P10,
 *   contract §6.3). Every failure throws a typed error that
 *   `handleTokenRequest` maps; nothing is ever renewed with stale props (F12).
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

  // P10 review B1: the only grant the Worker may ever revoke is the one the
  // provider just validated. The Worker's parse of `refresh_token` (same
  // bytes, same `formData()` parser) must name the provider-validated user.
  const grant = tokenRequest?.refreshGrant;
  if (!grant || grant.userId !== options.userId) throw new RefreshRequestMismatchError();
  try {
    return await refreshUpstreamGrant(options, env);
  } catch (err) {
    if (err instanceof UpstreamGrantRevokedError) err.revokeTarget = grant;
    throw err;
  }
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
    // Every /mcp request is re-authorized before it reaches a session (P10).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiHandler: withMcpPreflight(RobynnMCP.serve(MCP_API_PATH) as any) as any,
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

/**
 * Run a `/token` request through the provider and map the Worker's typed
 * failures (P06 F10, P10 F12) to OAuth errors. Used in-process for code
 * exchange and inside `RefreshCoordinator` for refresh.
 */
export async function handleTokenRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tokenRequest: TokenRequestContext | undefined,
): Promise<Response> {
  const options = createOAuthProviderOptions(env, tokenRequest);
  try {
    return await new OAuthProvider(options).fetch(request, env, ctx);
  } catch (err) {
    if (err instanceof RedirectUriMismatchError) {
      safeLog.warn("oauth.token.rejected", { reason: "redirect_uri_mismatch" });
      return oauthErrorResponse(request, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (err instanceof UpstreamGrantRevokedError) {
      // Permanent: end the provider grant so no host token outlives it. Only
      // the provider-validated identity bound in tokenExchangeCallback.
      const grant = err.revokeTarget;
      if (grant) {
        try {
          await getOAuthApi(options, env).revokeGrant(grant.grantId, grant.userId);
        } catch (revokeErr) {
          safeLog.error("oauth.refresh.revoke_failed", { errorKind: errorKind(revokeErr) });
        }
      }
      safeLog.warn("oauth.refresh.rejected", { reason: err.reason, revoked: Boolean(grant) });
      return oauthErrorResponse(request, 400, "invalid_grant", "The grant is no longer valid");
    }
    if (err instanceof RefreshRequestMismatchError) {
      safeLog.warn("oauth.refresh.rejected", { reason: "refresh_request_mismatch", revoked: false });
      return oauthErrorResponse(request, 400, "invalid_grant", "Invalid refresh token");
    }
    if (err instanceof UpstreamUnavailableError) {
      // Transient: the grant is not rotated; the same refresh token works later.
      safeLog.warn("oauth.refresh.unavailable", { reason: err.reason });
      return oauthErrorResponse(request, 503, "temporarily_unavailable", "Token service temporarily unavailable");
    }
    if (err instanceof RefreshScopeError) {
      safeLog.warn("oauth.refresh.rejected", { reason: "scope_unavailable" });
      return oauthErrorResponse(request, 400, "invalid_scope", "The requested scope is not available on this grant");
    }
    safeLog.error("oauth.token.failed", { errorKind: errorKind(err) });
    return oauthErrorResponse(request, 500, "server_error", "Token request failed");
  }
}

/** The wrapper's answer to a `/token` body it refuses to hand the provider. */
function tokenReadErrorResponse(
  request: Request,
  reason: Exclude<Awaited<ReturnType<typeof readTokenRequestContext>>, { ok: true }>["reason"],
): Response {
  switch (reason) {
    case "length_required":
      return oauthErrorResponse(request, 411, "invalid_request", "Content-Length is required");
    case "body_too_large":
      return oauthErrorResponse(request, 413, "invalid_request", "Token request body too large");
    case "unsupported_media_type":
      return oauthErrorResponse(request, 400, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");
    case "repeated_parameter":
      return oauthErrorResponse(request, 400, "invalid_request", "Token request parameters must not be repeated");
    default:
      return oauthErrorResponse(request, 400, "invalid_request", "Malformed token request");
  }
}

/**
 * RefreshCoordinator — one Durable Object per provider grant
 * (`refresh:{grantId}`) that runs that grant's refreshes one at a time and
 * hands an identical in-flight request the same result (contract §6.3
 * step 2). Strongly consistent, unlike a KV lease.
 */
export class RefreshCoordinator extends DurableObject<Env> {
  private readonly runner = new SerializedRunner();

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/token") return notFound();
    const read = await readTokenRequestContext(request);
    if (!read.ok) return tokenReadErrorResponse(request, read.reason);
    if (read.context.grantType !== "refresh_token" || !read.context.refreshGrant) {
      return oauthErrorResponse(request, 400, "invalid_request", "Unsupported token request");
    }
    const tokenRequest = read.context;
    const key = await refreshRequestKey(request);
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      passThroughOnException: () => undefined,
      props: undefined,
    } as unknown as ExecutionContext;
    return this.runner.run(key, () => handleTokenRequest(request, this.env, ctx, tokenRequest));
  }
}

/** Local development only (`http://localhost`, `127.0.0.1`, `[::1]`). */
function isLoopbackOrigin(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
}

const TRACED_PATHS = new Set(["/register", "/authorize", "/callback", "/token", MCP_API_PATH]);

/**
 * Worker entry point — OAuthProvider wraps everything.
 *
 * - /mcp → preflight (P10) → McpAgent Durable Object; SSE is not served
 * - /token → provider; refreshes go through the grant's RefreshCoordinator
 * - /authorize, /register → handled by OAuthProvider
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
    const shouldTrace = TRACED_PATHS.has(path);
    let tokenRequest: TokenRequestContext | undefined;
    let response: Response;

    if (path === "/token") {
      const read = await readTokenRequestContext(rewrittenRequest);
      if (!read.ok) {
        // The body was never read: refused on the declared length alone.
        safeLog.warn("oauth.token.rejected", { reason: read.reason });
        return tokenReadErrorResponse(request, read.reason);
      }
      tokenRequest = read.context;
      const refreshGrant = tokenRequest.grantType === "refresh_token" ? tokenRequest.refreshGrant : null;
      const coordinators = env.REFRESH_COORDINATOR;
      if (refreshGrant && coordinators) {
        const stub = coordinators.get(coordinators.idFromName(refreshCoordinatorName(refreshGrant.grantId)));
        response = await stub.fetch(rewrittenRequest);
      } else if (refreshGrant && !isLoopbackOrigin(publicOrigin)) {
        // P10 review N3: a deployed Worker without the coordinator would
        // refresh unserialized; refuse instead (grant not rotated).
        safeLog.error("oauth.refresh.rejected", { reason: "coordinator_binding_missing" });
        return oauthErrorResponse(request, 503, "temporarily_unavailable", "Token service temporarily unavailable");
      } else {
        if (refreshGrant) safeLog.warn("oauth.refresh.unserialized", { reason: "coordinator_binding_missing" });
        response = await handleTokenRequest(rewrittenRequest, env, ctx, tokenRequest);
      }
    } else {
      response = await createOAuthProvider(env).fetch(rewrittenRequest, env, ctx);
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
