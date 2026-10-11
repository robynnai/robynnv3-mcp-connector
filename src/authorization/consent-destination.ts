/**
 * Signed consent destination (COS-PLUGIN-001 P19b, P19 RC review R3).
 *
 * With open DCR, any client can register an https redirect and a name such as
 * "Claude Code". The consent page now tells the user where the browser goes
 * after they approve. The destination comes from the redirect URI the provider
 * validated for this client (never from a raw request parameter), and the
 * Worker signs it, bound to the transaction `state`, so the app shows it only
 * if the Worker sent it.
 *
 * Contract v1, mirrored by the app's `src/lib/server/oauth/consent-destination.ts`
 * (see docs/plugin-v1/INTERNAL_AUTH_SIGNING.md, "Consent destination"):
 *
 *   redirect_origin = "<scheme>://<host[:port]>" for http(s), "<scheme>:" otherwise
 *   payload         = JSON.stringify(["robynn-consent-destination", "v1", exp, state, redirect_origin])
 *   consent_sig     = "v1.<exp>.<base64url(HMAC-SHA256(MCP_INTERNAL_AUTH_SECRET, payload))>"
 *
 * `exp` is Unix seconds, the transaction's own lifetime. The label keeps this
 * HMAC distinct from the v2 internal request signature that uses the same
 * secret.
 */
import { AUTHORIZATION_STATE_TTL_SECONDS } from "./state";

export const CONSENT_DESTINATION_PARAM = "redirect_origin";
export const CONSENT_SIGNATURE_PARAM = "consent_sig";
const PAYLOAD_LABEL = "robynn-consent-destination";
const VERSION = "v1";

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Where the host redirect URI sends the browser: scheme and host (with port)
 * for http(s), the scheme alone for a native app link. Path and query are not
 * shown. `null` if the URI does not parse.
 */
export function redirectOrigin(redirectUri: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.host ? `${url.protocol}//${url.host}` : null;
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? url.protocol : null;
}

export function consentDestinationPayload(exp: number, state: string, origin: string): string {
  return JSON.stringify([PAYLOAD_LABEL, VERSION, exp, state, origin]);
}

export async function signConsentDestination(
  secret: string,
  input: { state: string; origin: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + AUTHORIZATION_STATE_TTL_SECONDS;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(consentDestinationPayload(exp, input.state, input.origin)),
  );
  return `${VERSION}.${exp}.${encodeBase64Url(new Uint8Array(mac))}`;
}
