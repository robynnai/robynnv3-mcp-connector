/**
 * Upstream (app) grant validation for `/callback` (COS-PLUGIN-001 P06,
 * contract §6.2 step 3 and §5).
 *
 * The Worker cannot verify the app's JWT signature (it never holds
 * OAUTH_JWT_SECRET), so the decoded claims are only a *candidate* identity
 * used to address the grant. The app's introspection endpoint is the
 * authority: the Worker completes authorization only when introspection says
 * the grant is active and returns the same user, organization, grant, client
 * and credential version. Anything else fails closed. P10 reuses
 * `introspectUpstreamGrant` for the per-call preflight and at refresh.
 */
import { internalMcpRequestHeaders, TRUSTED_MCP_CLIENT_ID } from "../internal-mcp-auth";
import { canonicalScopes, isOAuthScope, type OAuthScope } from "./oauth-policy";

export const INTROSPECTION_PATH = "/api/oauth/introspect";
export const UPSTREAM_ACCESS_AUDIENCE = "robynn-api:mcp";
export const UPSTREAM_ACCESS_ISSUER = "robynn.ai";
const INTROSPECTION_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_TOKEN_LENGTH = 8192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const INACTIVE_REASONS = [
  "grant_not_found",
  "grant_revoked",
  "grant_expired",
  "identity_mismatch",
  "membership_inactive",
  "user_disabled",
  "credential_version_stale",
] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number] | "inactive_unknown";

export interface UpstreamTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface UpstreamGrantCandidate {
  userId: string;
  organizationId: string;
  grantId: string;
  credentialVersion: number;
  scopes: OAuthScope[];
}

export interface VerifiedUpstreamGrant extends UpstreamGrantCandidate {
  organizationName: string | null;
}

export type IntrospectionOutcome =
  | { status: "active"; grant: VerifiedUpstreamGrant }
  | { status: "inactive"; reason: InactiveReason }
  | { status: "unavailable"; reason: string };

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value) && !/^0{8}-/.test(value);
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_UPSTREAM_TOKEN_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Strictly shape-check the app's `/api/oauth/token` response. */
export function parseUpstreamTokenResponse(body: unknown): UpstreamTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isBoundedToken(b.access_token) || !isBoundedToken(b.refresh_token)) return null;
  if (b.expires_in !== undefined && !(typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0)) {
    return null;
  }
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    ...(typeof b.expires_in === "number" ? { expiresIn: b.expires_in } : {}),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const value: unknown = JSON.parse(atob(padded));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseScopeClaim(value: unknown): OAuthScope[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const items = value.split(" ");
  if (items.some((item) => !isOAuthScope(item))) return null;
  if (new Set(items).size !== items.length) return null;
  return canonicalScopes(items as OAuthScope[]);
}

/**
 * Read the candidate identity from the app access token. Untrusted until
 * introspection confirms it; absent, malformed or sentinel values reject.
 */
export function readUpstreamGrantCandidate(
  accessToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; candidate: UpstreamGrantCandidate } | { ok: false; reason: string } {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return { ok: false, reason: "upstream_token_malformed" };
  if (claims.type !== "access" || claims.aud !== UPSTREAM_ACCESS_AUDIENCE || claims.iss !== UPSTREAM_ACCESS_ISSUER) {
    return { ok: false, reason: "upstream_token_wrong_type" };
  }
  if (claims.cid !== TRUSTED_MCP_CLIENT_ID) return { ok: false, reason: "upstream_token_wrong_client" };
  if (!(typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > nowSeconds)) {
    return { ok: false, reason: "upstream_token_expired" };
  }
  if (!isUuid(claims.sub) || !isUuid(claims.org)) {
    return { ok: false, reason: "upstream_identity_invalid" };
  }
  if (claims.gid === undefined) return { ok: false, reason: "upstream_grant_id_missing" };
  if (!isUuid(claims.gid)) return { ok: false, reason: "upstream_grant_id_invalid" };
  if (!(Number.isSafeInteger(claims.ver) && (claims.ver as number) > 0)) {
    return { ok: false, reason: "upstream_credential_version_invalid" };
  }
  const scopes = parseScopeClaim(claims.scope);
  if (!scopes) return { ok: false, reason: "upstream_scope_invalid" };

  return {
    ok: true,
    candidate: {
      userId: claims.sub,
      organizationId: claims.org,
      grantId: claims.gid,
      credentialVersion: claims.ver as number,
      scopes,
    },
  };
}

function parseIntrospectionBody(
  body: unknown,
  candidate: UpstreamGrantCandidate,
): IntrospectionOutcome {
  if (!body || typeof body !== "object") {
    return { status: "unavailable", reason: "introspection_malformed" };
  }
  const b = body as Record<string, unknown>;
  if (b.active === false) {
    const reason = (INACTIVE_REASONS as readonly unknown[]).includes(b.reason)
      ? (b.reason as InactiveReason)
      : "inactive_unknown";
    return { status: "inactive", reason };
  }
  if (b.active !== true) return { status: "unavailable", reason: "introspection_malformed" };

  if (
    b.grant_id !== candidate.grantId ||
    b.user_id !== candidate.userId ||
    b.organization_id !== candidate.organizationId ||
    b.client_id !== TRUSTED_MCP_CLIENT_ID ||
    b.credential_version !== candidate.credentialVersion
  ) {
    return { status: "inactive", reason: "identity_mismatch" };
  }

  const scopes = b.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((s) => typeof s === "string" && isOAuthScope(s)) ||
    new Set(scopes).size !== scopes.length
  ) {
    return { status: "unavailable", reason: "introspection_malformed" };
  }

  const organization = b.organization as Record<string, unknown> | undefined;
  const organizationName =
    organization && typeof organization.name === "string" ? organization.name : null;

  return {
    status: "active",
    grant: {
      ...candidate,
      scopes: canonicalScopes(scopes as OAuthScope[]),
      organizationName,
    },
  };
}

/**
 * Ask the app whether the candidate grant is active (signed with
 * MCP_INTERNAL_AUTH_SECRET; contract §5). Network errors, non-200 statuses
 * (including 404 while the endpoint does not exist) and malformed bodies are
 * `unavailable` — the caller must fail closed.
 */
export async function introspectUpstreamGrant(params: {
  apiBaseUrl: string;
  secret: string;
  candidate: UpstreamGrantCandidate;
  /** Provider grant id, for the app's audit trail only (contract §5). */
  hostGrantId?: string;
  /** The tool call being authorized, for the app's audit trail only. */
  operation?: { tool: string; requiredScope: OAuthScope };
  timeoutMs?: number;
}): Promise<IntrospectionOutcome> {
  const url = `${params.apiBaseUrl.replace(/\/+$/, "")}${INTROSPECTION_PATH}`;
  const body = JSON.stringify({
    grant_id: params.candidate.grantId,
    user_id: params.candidate.userId,
    organization_id: params.candidate.organizationId,
    client_id: TRUSTED_MCP_CLIENT_ID,
    credential_version: params.candidate.credentialVersion,
    ...(params.hostGrantId ? { host_grant_id: params.hostGrantId } : {}),
    ...(params.operation
      ? { operation: { tool: params.operation.tool, required_scope: params.operation.requiredScope } }
      : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? INTROSPECTION_TIMEOUT_MS);
  try {
    const headers = await internalMcpRequestHeaders(params.secret, { method: "POST", url, body });
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: controller.signal,
      // A 3xx is "unavailable"; signed headers are never re-sent elsewhere.
      redirect: "manual",
    });
    if (response.status !== 200) {
      return { status: "unavailable", reason: `introspection_http_${response.status}` };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { status: "unavailable", reason: "introspection_malformed" };
    }
    return parseIntrospectionBody(json, params.candidate);
  } catch {
    return { status: "unavailable", reason: "introspection_network" };
  } finally {
    clearTimeout(timer);
  }
}
