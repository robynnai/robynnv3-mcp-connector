/**
 * Bind the host's token-exchange `redirect_uri` to its authorization request
 * (COS-PLUGIN-001 P06; P01 F10).
 *
 * The provider accepts any *registered* `redirect_uri` at `/token` (or none,
 * with PKCE). `/callback` therefore stores the authorize-time redirect URI in
 * the grant props (`authorizeRedirectUri`), and the provider's
 * `tokenExchangeCallback` compares it with the `redirect_uri` the Worker read
 * from the same token request. The callback runs before the provider consumes
 * the code, so a mismatch throws without burning the code; the fetch wrapper
 * maps the throw to `400 invalid_grant`. Props live inside the encrypted grant,
 * so the comparison is strongly consistent (no extra KV lookup).
 */
import type { Props } from "../types";

export const AUTHORIZE_REDIRECT_PROP = "authorizeRedirectUri";

export interface TokenRequestContext {
  grantType: string | null;
  /** The single `redirect_uri` form value, or null if absent/repeated. */
  redirectUri: string | null;
  /**
   * `{userId}:{grantId}` parsed from a single `refresh_token` form value (P01
   * F1, F11), or null. The token itself is never kept. Untrusted until the
   * provider validates the token; used to route the refresh to its
   * per-grant coordinator and to revoke that grant on a permanent failure.
   */
  refreshGrant?: { userId: string; grantId: string } | null;
}

export class RedirectUriMismatchError extends Error {
  constructor() {
    super("redirect_uri does not match the authorization request");
    this.name = "RedirectUriMismatchError";
  }
}

/** Real token requests are well under 2 KB; anything larger is refused. */
export const MAX_TOKEN_BODY_BYTES = 16 * 1024;

export type TokenRequestRead =
  | { ok: true; context: TokenRequestContext }
  | { ok: false; reason: "body_too_large" | "length_required" };

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

/**
 * Read grant_type/redirect_uri from a form-encoded token request.
 *
 * The decision is made from `Content-Length` **before** the body is cloned or
 * read: a missing length is refused (411) and a length over
 * MAX_TOKEN_BODY_BYTES is refused (413) without touching the body. Only a
 * small, declared body is read (from a clone, so the provider can still read
 * the original). Partially reading a body and then abandoning it left the
 * connection in a bad state in local workerd/wrangler (P06 review round 1),
 * so the body is either read completely or not at all. Hosts always send a
 * length for these small form posts.
 */
export async function readTokenRequestContext(
  request: Request,
  maxBytes = MAX_TOKEN_BODY_BYTES,
): Promise<TokenRequestRead> {
  const empty = { ok: true as const, context: { grantType: null, redirectUri: null, refreshGrant: null } };
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method !== "POST" || !contentType.includes("application/x-www-form-urlencoded")) {
    // The provider rejects these itself without reading the body.
    return empty;
  }
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d{1,10}$/.test(declared.trim())) {
    return { ok: false, reason: "length_required" };
  }
  if (Number(declared) > maxBytes) return { ok: false, reason: "body_too_large" };

  let text: string;
  try {
    text = await request.clone().text();
  } catch {
    return empty;
  }
  // The runtime enforces the declared length; this is a backstop.
  if (text.length > maxBytes) return { ok: false, reason: "body_too_large" };
  const params = new URLSearchParams(text);
  return {
    ok: true,
    context: {
      grantType: single(params, "grant_type"),
      redirectUri: single(params, "redirect_uri"),
      refreshGrant: parseRefreshGrant(single(params, "refresh_token")),
    },
  };
}

const PROVIDER_ID_PART = /^[A-Za-z0-9_-]{1,128}$/;

function parseRefreshGrant(token: string | null): { userId: string; grantId: string } | null {
  if (!token) return null;
  const parts = token.split(":");
  if (parts.length !== 3 || !PROVIDER_ID_PART.test(parts[0]) || !PROVIDER_ID_PART.test(parts[1])) {
    return null;
  }
  return { userId: parts[0], grantId: parts[1] };
}

/** Closed set for logs: never the raw, attacker-controlled form value. */
export function grantTypeForLog(
  context: TokenRequestContext | undefined,
): "authorization_code" | "refresh_token" | "other" | undefined {
  if (!context) return undefined;
  if (context.grantType === "authorization_code" || context.grantType === "refresh_token") {
    return context.grantType;
  }
  return "other";
}

/**
 * Called from `tokenExchangeCallback` for `authorization_code`. Requires the
 * token request's `redirect_uri` to be present and identical (RFC 6749
 * §4.1.3) to the authorize-time value; returns props without the binding.
 */
export function enforceAuthorizationCodeRedirect(
  props: Props,
  context: TokenRequestContext | undefined,
): Props {
  const expected = props[AUTHORIZE_REDIRECT_PROP];
  if (
    typeof expected !== "string" ||
    expected.length === 0 ||
    !context ||
    context.redirectUri !== expected
  ) {
    throw new RedirectUriMismatchError();
  }
  const { [AUTHORIZE_REDIRECT_PROP]: _removed, ...rest } = props;
  return rest as Props;
}
