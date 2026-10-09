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

function single(form: FormData, key: string): string | null {
  const values = form.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

/** Read grant_type/redirect_uri from a cloned token request (form-encoded only). */
export async function readTokenRequestContext(request: Request): Promise<TokenRequestContext> {
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method !== "POST" || !contentType.includes("application/x-www-form-urlencoded")) {
    return { grantType: null, redirectUri: null };
  }
  try {
    const form = await request.clone().formData();
    return { grantType: single(form, "grant_type"), redirectUri: single(form, "redirect_uri") };
  } catch {
    return { grantType: null, redirectUri: null };
  }
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
