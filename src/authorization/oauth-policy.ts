/**
 * Worker OAuth front-door policy (COS-PLUGIN-001 P06).
 *
 * Pure validation helpers for the host-facing authorization request. The
 * contract lives in docs/plugin-v1/AUTHORIZATION_CONTRACT.md §6.1 (P01) and
 * docs/plugin-v1/WORKER_OAUTH_FRONT_DOOR.md (P06).
 */
import type { OAuthRequestInfo } from "../types";

/**
 * D-C (orchestrator open decision): SSE is not served in v1, and it is not
 * advertised either. This single flag controls every advertisement: the
 * protected-resource aliases, `/.well-known/oauth-protected-resource/sse` and
 * `endpoints.sse` in the landing JSON. Flipping it does NOT serve SSE; that
 * needs a `?sessionId=` session binding plus per-call authorization (P01 F20).
 */
export const ADVERTISE_SSE = false;

/** Scope vocabulary (contract D3). Order is the canonical serialization. */
export const SUPPORTED_OAUTH_SCOPES = ["brand:read", "tools:execute"] as const;
export type OAuthScope = (typeof SUPPORTED_OAUTH_SCOPES)[number];

/** An omitted scope is a read-only request (contract D3, plan §6). */
export const DEFAULT_REQUESTED_SCOPES: readonly OAuthScope[] = ["brand:read"];

/** The only path the MCP API handler serves (contract §6.4 step 1, D10). */
export const MCP_API_PATH = "/mcp";

const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_NAME_MAX_LENGTH = 64;
// C0/C1 controls, zero-width and bidi override/isolate characters.
const UNSAFE_DISPLAY_CHARS =
  /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

export type AuthorizeRejection =
  | { error: "unsupported_response_type"; reason: string }
  | { error: "invalid_request"; reason: string }
  | { error: "invalid_scope"; reason: string }
  | { error: "invalid_target"; reason: string };

export function isOAuthScope(value: string): value is OAuthScope {
  return (SUPPORTED_OAUTH_SCOPES as readonly string[]).includes(value);
}

/** Deduplicate and order scopes canonically (`brand:read tools:execute`). */
export function canonicalScopes(scopes: Iterable<OAuthScope>): OAuthScope[] {
  const set = new Set(scopes);
  return SUPPORTED_OAUTH_SCOPES.filter((scope) => set.has(scope));
}

/**
 * Validate the host-requested scope list. Omitted ⇒ `brand:read`; any unknown
 * item ⇒ `invalid_scope`. The result is exactly what the host asked for (in
 * canonical order) and is never widened.
 */
export function parseRequestedScopes(
  requested: readonly string[] | undefined,
): { ok: true; scopes: OAuthScope[] } | { ok: false } {
  if (!requested || requested.length === 0) {
    return { ok: true, scopes: [...DEFAULT_REQUESTED_SCOPES] };
  }
  if (!requested.every((scope) => typeof scope === "string" && isOAuthScope(scope))) {
    return { ok: false };
  }
  return { ok: true, scopes: canonicalScopes(requested as OAuthScope[]) };
}

/** True when every item of `granted` is in `allowed`. */
export function isScopeSubset(
  granted: readonly string[],
  allowed: readonly string[],
): boolean {
  return granted.every((scope) => allowed.includes(scope));
}

/**
 * Approved RFC 8707 resource values for this single-service Worker. The
 * MCP TypeScript SDK sends `new URL(prm.resource).href`, i.e. `{base}/`, so
 * both spellings of the origin are accepted alongside `{base}/mcp`.
 */
export function getApprovedResources(
  workerBaseUrl: string,
  advertiseSse = ADVERTISE_SSE,
): string[] {
  const base = workerBaseUrl.replace(/\/+$/, "");
  return [
    base,
    `${base}/`,
    `${base}${MCP_API_PATH}`,
    ...(advertiseSse ? [`${base}/sse`] : []),
  ];
}

/**
 * Accept only approved aliases, compared as exact strings. The value is kept
 * as the host sent it: the provider later requires the token request's
 * `resource` to equal the authorize-time one, and audience matching is by
 * origin + path prefix, so foreign values are never merged in.
 */
export function validateRequestedResource(
  resource: OAuthRequestInfo["resource"],
  workerBaseUrl: string,
  advertiseSse = ADVERTISE_SSE,
): boolean {
  if (resource === undefined) return true;
  const values = Array.isArray(resource) ? resource : [resource];
  if (values.length === 0) return false;
  const approved = getApprovedResources(workerBaseUrl, advertiseSse);
  return values.every((value) => typeof value === "string" && approved.includes(value));
}

/**
 * Validate a parsed host authorization request (contract §6.1 steps 1–3).
 * Missing `code_challenge` must be rejected here because the provider still
 * issues a non-PKCE code for `code_challenge_method=S256` without a challenge
 * (P01 F9), even with `allowPlainPKCE: false`.
 */
export function validateAuthorizeRequest(
  request: OAuthRequestInfo,
  workerBaseUrl: string,
  advertiseSse = ADVERTISE_SSE,
): { ok: true; scopes: OAuthScope[] } | { ok: false; rejection: AuthorizeRejection } {
  if (request.responseType !== "code") {
    return {
      ok: false,
      rejection: { error: "unsupported_response_type", reason: "response_type_not_code" },
    };
  }
  if (request.codeChallengeMethod !== "S256") {
    return {
      ok: false,
      rejection: { error: "invalid_request", reason: "pkce_method_not_s256" },
    };
  }
  if (!request.codeChallenge || !S256_CHALLENGE_PATTERN.test(request.codeChallenge)) {
    return {
      ok: false,
      rejection: { error: "invalid_request", reason: "pkce_challenge_invalid" },
    };
  }

  const scopes = parseRequestedScopes(request.scope);
  if (!scopes.ok) {
    return { ok: false, rejection: { error: "invalid_scope", reason: "scope_unknown" } };
  }

  if (!validateRequestedResource(request.resource, workerBaseUrl, advertiseSse)) {
    return { ok: false, rejection: { error: "invalid_target", reason: "resource_not_approved" } };
  }

  return { ok: true, scopes: scopes.scopes };
}

/**
 * Display form of a DCR `client_name`: control, zero-width and bidi characters
 * removed, whitespace collapsed, length capped. HTML escaping still happens at
 * render time (the app escapes it on the consent page).
 */
export function normalizeClientName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/\s+/g, " ").replace(UNSAFE_DISPLAY_CHARS, "").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, CLIENT_NAME_MAX_LENGTH).join("");
}

/**
 * Paths under the API prefixes that are not the MCP endpoint. They are
 * answered with 404 before the provider, so `/mcpx`, `/mcp/openai`, `/mcp/`
 * and every `/sse*` path never reach the API handler (P01 F14, F19).
 */
export function isUnservedApiPath(pathname: string): boolean {
  if (pathname === MCP_API_PATH) return false;
  return pathname.startsWith(MCP_API_PATH) || pathname.startsWith("/sse");
}
