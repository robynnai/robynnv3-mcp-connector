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
  | { ok: false; reason: "body_too_large" };

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

/** Read at most `maxBytes` of a body; null if it is larger. */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: cancelling one branch of a cloned (tee'd) body can wait
      // on the other branch, which nobody reads once we refuse the request.
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read grant_type/redirect_uri from a clone of a form-encoded token request.
 * Bodies over MAX_TOKEN_BODY_BYTES are refused before any parsing.
 */
export async function readTokenRequestContext(
  request: Request,
  maxBytes = MAX_TOKEN_BODY_BYTES,
): Promise<TokenRequestRead> {
  const empty = { ok: true as const, context: { grantType: null, redirectUri: null } };
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method !== "POST" || !contentType.includes("application/x-www-form-urlencoded")) {
    return empty;
  }
  let text: string | null;
  try {
    text = await readBoundedText(request.clone(), maxBytes);
  } catch {
    return empty;
  }
  if (text === null) return { ok: false, reason: "body_too_large" };
  const params = new URLSearchParams(text);
  return {
    ok: true,
    context: { grantType: single(params, "grant_type"), redirectUri: single(params, "redirect_uri") },
  };
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
