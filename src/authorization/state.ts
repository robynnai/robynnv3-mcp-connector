/**
 * Browser-bound, single-use authorization transactions (COS-PLUGIN-001 P06,
 * contract §6.1 step 4 and §6.2 step 1).
 *
 * `/authorize` stores the validated host request under a random `state` and
 * sets a per-transaction cookie holding a random nonce; KV keeps only the
 * nonce's SHA-256. `/callback` accepts the state only from the browser that
 * holds the nonce, and deletes the record before using it. A state copied to
 * another browser (login CSRF / confused deputy) is rejected and left intact
 * for its owner.
 *
 * Workers KV is eventually consistent, so delete-before-use is best effort
 * across locations. Replays are still bounded: they need the browser cookie,
 * and the app consumes its authorization code atomically.
 */
import type { OAuthRequestInfo } from "../types";
import { isOAuthScope, type OAuthScope } from "./oauth-policy";

export const AUTHORIZATION_STATE_TTL_SECONDS = 600;
const STATE_KEY_PREFIX = "oauth_state:";
const STATE_BYTES = 32;
const TRANSACTION_VERSION = 2;

/** 32 random bytes, base64url: within the app's `[A-Za-z0-9._~-]{16,512}`. */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AuthorizationTransaction {
  v: typeof TRANSACTION_VERSION;
  oauthRequest: OAuthRequestInfo;
  /** Exactly what the host asked for (after omitted ⇒ brand:read). */
  requestedScopes: OAuthScope[];
  /** The normalized DCR client name sent to the consent page. */
  clientName: string | null;
  workerCallbackUrl: string;
  browserBindingHash: string;
  createdAt: number;
}

export type ConsumeFailureReason =
  | "state_malformed"
  | "state_unknown"
  | "state_corrupt"
  | "state_expired"
  | "browser_binding_missing"
  | "browser_binding_mismatch";

interface StateKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `__Host-` needs `Secure`, so plain-HTTP loopback dev uses the bare name. */
export function stateCookieName(state: string, secure: boolean): string {
  return `${secure ? "__Host-" : ""}robynn_oauth_${state}`;
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean) {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearStateCookie(state: string, secure: boolean): string {
  return serializeCookie(stateCookieName(state, secure), "", 0, secure);
}

function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    // A duplicated cookie name is ambiguous: refuse rather than pick one.
    if (found !== null) return null;
    found = part.slice(index + 1).trim();
  }
  return found;
}

export async function createAuthorizationTransaction(
  kv: StateKv,
  input: Omit<AuthorizationTransaction, "v" | "browserBindingHash" | "createdAt">,
  options: { secureCookie: boolean },
): Promise<{ state: string; setCookie: string }> {
  const state = randomToken();
  const browserNonce = randomToken();
  const transaction: AuthorizationTransaction = {
    v: TRANSACTION_VERSION,
    ...input,
    browserBindingHash: await sha256Hex(browserNonce),
    createdAt: Date.now(),
  };

  await kv.put(`${STATE_KEY_PREFIX}${state}`, JSON.stringify(transaction), {
    expirationTtl: AUTHORIZATION_STATE_TTL_SECONDS,
  });

  return {
    state,
    setCookie: serializeCookie(
      stateCookieName(state, options.secureCookie),
      browserNonce,
      AUTHORIZATION_STATE_TTL_SECONDS,
      options.secureCookie,
    ),
  };
}

function isTransaction(value: unknown): value is AuthorizationTransaction {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  const request = t.oauthRequest as Record<string, unknown> | undefined;
  return (
    t.v === TRANSACTION_VERSION &&
    typeof t.workerCallbackUrl === "string" &&
    typeof t.browserBindingHash === "string" &&
    /^[0-9a-f]{64}$/.test(t.browserBindingHash) &&
    typeof t.createdAt === "number" &&
    (t.clientName === null || typeof t.clientName === "string") &&
    Array.isArray(t.requestedScopes) &&
    t.requestedScopes.length > 0 &&
    t.requestedScopes.every((s) => typeof s === "string" && isOAuthScope(s)) &&
    !!request &&
    typeof request.clientId === "string" &&
    request.clientId.length > 0 &&
    typeof request.redirectUri === "string" &&
    request.redirectUri.length > 0 &&
    typeof request.state === "string"
  );
}

/**
 * Validate state + browser binding, then delete the record before returning
 * it. A missing or mismatched cookie leaves the record in place so that a
 * leaked state cannot be used to cancel the owner's flow.
 */
export async function consumeAuthorizationTransaction(
  kv: StateKv,
  state: string | undefined,
  cookieHeader: string | null | undefined,
  options: { secureCookie: boolean },
): Promise<
  | { ok: true; transaction: AuthorizationTransaction }
  | { ok: false; reason: ConsumeFailureReason }
> {
  if (!state || !STATE_PATTERN.test(state)) return { ok: false, reason: "state_malformed" };

  const key = `${STATE_KEY_PREFIX}${state}`;
  const raw = await kv.get(key);
  if (!raw) return { ok: false, reason: "state_unknown" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isTransaction(parsed)) {
    await kv.delete(key);
    return { ok: false, reason: "state_corrupt" };
  }
  // KV expiry is the primary bound; this guards a stale replica read.
  if (Date.now() - parsed.createdAt > AUTHORIZATION_STATE_TTL_SECONDS * 1000) {
    await kv.delete(key);
    return { ok: false, reason: "state_expired" };
  }

  const nonce = readCookie(cookieHeader, stateCookieName(state, options.secureCookie));
  if (!nonce) return { ok: false, reason: "browser_binding_missing" };
  if (!constantTimeEqual(await sha256Hex(nonce), parsed.browserBindingHash)) {
    return { ok: false, reason: "browser_binding_mismatch" };
  }

  await kv.delete(key);
  return { ok: true, transaction: parsed };
}
