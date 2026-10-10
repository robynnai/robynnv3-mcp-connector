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
  | {
      ok: false;
      reason: "body_too_large" | "length_required" | "unsupported_media_type" | "malformed" | "repeated_parameter";
    };

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/**
 * Parameters that must appear at most once (RFC 6749 §3.2). The provider
 * turns a repeated key into an array; refusing repeats keeps the Worker and
 * the provider looking at the same single value. `resource` may legitimately
 * repeat (RFC 8707) and is not read here.
 */
const SINGLE_VALUED = ["grant_type", "code", "redirect_uri", "refresh_token", "code_verifier", "client_id", "scope"];

/** Media-type essence: the type/subtype before any parameter, lower-cased. */
export function mediaTypeEssence(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function single(form: FormData, key: string): string | null {
  const values = form.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

/**
 * Read the token request's form parameters exactly as the provider will.
 *
 * - The decision on size is made from `Content-Length` **before** the body
 *   is cloned or read: a missing length is refused (411) and a length over
 *   MAX_TOKEN_BODY_BYTES is refused (413) without touching the body.
 *   Partially reading a body and abandoning it left the connection in a bad
 *   state in local workerd/wrangler (P06 review round 1), so the body is
 *   read completely or not at all.
 * - P10 review B1: the body is parsed with `formData()`, the parser the
 *   provider uses, and only when the media-type essence is exactly
 *   `application/x-www-form-urlencoded` (the provider accepts any type that
 *   merely *contains* that string, which `formData()` would then parse by
 *   the real type). Anything else is refused before the provider, and so is
 *   a repeated single-valued parameter. The Worker therefore routes,
 *   serializes and (on a permanent refresh failure) revokes by the same
 *   `refresh_token` value the provider validates.
 */
export async function readTokenRequestContext(
  request: Request,
  maxBytes = MAX_TOKEN_BODY_BYTES,
): Promise<TokenRequestRead> {
  if (request.method !== "POST") {
    // The provider answers 405 itself without reading the body.
    return { ok: true, context: { grantType: null, redirectUri: null, refreshGrant: null } };
  }
  if (mediaTypeEssence(request.headers.get("content-type")) !== FORM_MEDIA_TYPE) {
    return { ok: false, reason: "unsupported_media_type" };
  }
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d{1,10}$/.test(declared.trim())) {
    return { ok: false, reason: "length_required" };
  }
  if (Number(declared) > maxBytes) return { ok: false, reason: "body_too_large" };

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (SINGLE_VALUED.some((key) => form.getAll(key).length > 1)) {
    return { ok: false, reason: "repeated_parameter" };
  }
  return {
    ok: true,
    context: {
      grantType: single(form, "grant_type"),
      redirectUri: single(form, "redirect_uri"),
      refreshGrant: parseRefreshGrant(single(form, "refresh_token")),
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
