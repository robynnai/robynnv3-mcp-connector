/**
 * Host refresh ⇒ upstream (app) refresh, fail-closed (COS-PLUGIN-001 P10;
 * authorization contract §6.3; facts F11–F13).
 *
 * This runs inside the provider's `tokenExchangeCallback` for
 * `grant_type=refresh_token`. Returning nothing would let the provider renew
 * the host token with stale props (F12), so every failure throws a typed
 * error instead; the provider then neither rotates the grant nor issues a
 * token, and the Worker maps the error:
 *
 * - `UpstreamGrantRevokedError` ⇒ revoke the provider grant, `400 invalid_grant`
 * - `UpstreamUnavailableError`  ⇒ `503 temporarily_unavailable` (un-rotated)
 * - `RefreshScopeError`         ⇒ `400 invalid_scope` (nothing left to grant)
 *
 * Only the provider `/token` path refreshes; the session DO never does (D6).
 */
import type {
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { buildSignedTokenRequest, getInternalAuthSecret } from "../internal-mcp-auth";
import { safeLog } from "../safe-log";
import type { Env, Props } from "../types";
import { canonicalScopes, isOAuthScope, type OAuthScope } from "./oauth-policy";
import {
  introspectUpstreamGrant,
  isUuid,
  parseUpstreamTokenResponse,
  readUpstreamGrantCandidate,
} from "./upstream-grant";

const MAX_ACCESS_TOKEN_TTL_SECONDS = 3600;
const ACCESS_TOKEN_TTL_MARGIN_SECONDS = 60;
const MIN_ACCESS_TOKEN_TTL_SECONDS = 60;
const MAX_ERROR_BODY_BYTES = 2048;

export class UpstreamGrantRevokedError extends Error {
  constructor(readonly reason: string) {
    super(`upstream grant revoked: ${reason}`);
    this.name = "UpstreamGrantRevokedError";
  }
}

export class UpstreamUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`upstream refresh unavailable: ${reason}`);
    this.name = "UpstreamUnavailableError";
  }
}

export class RefreshScopeError extends Error {
  constructor() {
    super("no requested scope remains on the grant");
    this.name = "RefreshScopeError";
  }
}

export interface RefreshDeps {
  introspect?: typeof introspectUpstreamGrant;
  fetchImpl?: typeof fetch;
}

function scopeList(value: unknown): OAuthScope[] {
  if (!Array.isArray(value)) return [];
  return canonicalScopes(value.filter((s): s is OAuthScope => typeof s === "string" && isOAuthScope(s)));
}

function intersect(a: OAuthScope[], b: OAuthScope[]): OAuthScope[] {
  return canonicalScopes(a.filter((scope) => b.includes(scope)));
}

/** The app's OAuth error code from a small JSON error body, or null. */
async function readOAuthErrorCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_BYTES) return null;
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Refresh the upstream credential for a hardened (authVersion 2) grant and
 * return the provider callback result. Never returns `undefined`.
 */
export async function refreshUpstreamGrant(
  options: TokenExchangeCallbackOptions,
  env: Env,
  deps: RefreshDeps = {},
): Promise<TokenExchangeCallbackResult> {
  const props = options.props as Partial<Props> | undefined;
  // Legacy cutover (contract §6.3 step 5): old grants never refresh into new ones.
  if (
    !props ||
    props.authVersion !== 2 ||
    !isUuid(props.appGrantId) ||
    !isUuid(props.userId) ||
    !isUuid(props.organizationId) ||
    typeof props.refreshToken !== "string" ||
    props.refreshToken.length === 0 ||
    props.userId !== options.userId
  ) {
    throw new UpstreamGrantRevokedError("legacy_grant");
  }

  const secret = getInternalAuthSecret(env);
  if (!secret) throw new UpstreamUnavailableError("secret_unset");

  // The app base URL comes from configuration only, never from props.
  const tokenRequest = await buildSignedTokenRequest(secret, env.ROBYNN_API_BASE_URL, {
    grant_type: "refresh_token",
    refresh_token: props.refreshToken,
  });

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(tokenRequest.url, tokenRequest.init);
  } catch {
    throw new UpstreamUnavailableError("network");
  }

  if (response.status !== 200) {
    if (response.status === 400 && (await readOAuthErrorCode(response)) === "invalid_grant") {
      throw new UpstreamGrantRevokedError("upstream_invalid_grant");
    }
    // 401 here means the Worker's own signature was refused (configuration),
    // and 429/5xx are transient: neither proves the grant is gone.
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamUnavailableError(`upstream_http_${response.status}`);
  }

  let tokens: ReturnType<typeof parseUpstreamTokenResponse>;
  try {
    tokens = parseUpstreamTokenResponse(await response.json());
  } catch {
    tokens = null;
  }
  // The app has already rotated: an unusable answer cannot be retried
  // safely, so the connection ends here.
  if (!tokens) throw new UpstreamGrantRevokedError("upstream_token_malformed");

  const candidate = readUpstreamGrantCandidate(tokens.accessToken);
  if (!candidate.ok) throw new UpstreamGrantRevokedError(candidate.reason);
  if (
    candidate.candidate.userId !== props.userId ||
    candidate.candidate.organizationId !== props.organizationId ||
    candidate.candidate.grantId !== props.appGrantId
  ) {
    throw new UpstreamGrantRevokedError("identity_mismatch");
  }

  // Never widen: the consented scopes captured at /callback bound everything.
  let scopes = intersect(scopeList(props.scopes), candidate.candidate.scopes);
  const outcome = await (deps.introspect ?? introspectUpstreamGrant)({
    apiBaseUrl: env.ROBYNN_API_BASE_URL,
    secret,
    candidate: candidate.candidate,
  });
  if (outcome.status === "inactive") {
    throw new UpstreamGrantRevokedError(outcome.reason);
  }
  if (outcome.status === "active") {
    scopes = intersect(scopes, outcome.grant.scopes);
  } else {
    // The app has just authorized the refresh itself, and every tool call is
    // re-introspected before it runs, so an introspection outage here only
    // loses role-based narrowing until the next call. Failing would strand
    // the rotated upstream token and later trip refresh-reuse revocation.
    safeLog.warn("oauth.refresh.introspection_unavailable", { reason: outcome.reason });
  }
  if (scopes.length === 0) throw new UpstreamGrantRevokedError("scope_empty");

  const accessTokenScope = intersect(scopeList(options.requestedScope), scopes);
  if (accessTokenScope.length === 0) throw new RefreshScopeError();

  const upstreamTtl = Math.min(tokens.expiresIn ?? MAX_ACCESS_TOKEN_TTL_SECONDS, MAX_ACCESS_TOKEN_TTL_SECONDS);
  const accessTokenTTL = Math.max(MIN_ACCESS_TOKEN_TTL_SECONDS, Math.floor(upstreamTtl) - ACCESS_TOKEN_TTL_MARGIN_SECONDS);

  const { _apiBaseUrl: _unused, ...rest } = props as Props;
  const newProps: Props = {
    ...rest,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    credentialVersion: candidate.candidate.credentialVersion,
    scopes,
  };
  safeLog.info("oauth.refresh.upstream_refreshed", { accessTokenTTL, scopeCount: scopes.length });
  return { newProps, accessTokenTTL, accessTokenScope };
}
