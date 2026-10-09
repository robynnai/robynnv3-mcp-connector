/**
 * Worker -> Robynn app internal request signing (COS-PLUGIN-001 P03).
 *
 * Contract (v2), mirrored byte-for-byte by the app's
 * `src/lib/server/oauth/internal-mcp-auth.ts`; see
 * `docs/plugin-v1/INTERNAL_AUTH_SIGNING.md`:
 *
 *   payload   = "v2.<timestamp>.<nonce>.<METHOD>.<path+query>.<sha256-b64url(raw body)>"
 *   signature = "v2." + base64url(HMAC-SHA256(MCP_INTERNAL_AUTH_SECRET, payload))
 *
 * The secret is MCP_INTERNAL_AUTH_SECRET only. There is deliberately no
 * CONNECTOR_STATE_SECRET fallback: that value was committed to wrangler.toml
 * and must never authenticate the Worker. With the secret unset the Worker
 * refuses to call the app rather than sending an unsigned request.
 */

const TRUSTED_MCP_CLIENT_ID = "robynn-mcp-worker";
const SIGNATURE_VERSION = "v2";
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const NONCE_BYTES = 16;

export const MCP_SIGNATURE_HEADER = "x-robynn-mcp-signature";
export const MCP_TIMESTAMP_HEADER = "x-robynn-mcp-timestamp";
export const MCP_NONCE_HEADER = "x-robynn-mcp-nonce";

export interface InternalMcpSignatureInput {
  method: string;
  /** Request path plus query string, e.g. `/api/oauth/token`. */
  target: string;
  /** The exact request body that will be sent ("" for none). */
  body: string;
  timestamp: string;
  nonce: string;
}

export class InternalAuthSecretMissingError extends Error {
  constructor() {
    super("MCP_INTERNAL_AUTH_SECRET is not configured");
    this.name = "InternalAuthSecretMissingError";
  }
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return encodeBase64Url(new Uint8Array(digest));
}

export function getInternalAuthSecret(env: {
  MCP_INTERNAL_AUTH_SECRET?: string;
}): string | null {
  const secret = env.MCP_INTERNAL_AUTH_SECRET?.trim();
  return secret ? secret : null;
}

export async function buildSignaturePayload(
  input: InternalMcpSignatureInput,
): Promise<string> {
  return [
    SIGNATURE_VERSION,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.target,
    await sha256Base64Url(input.body),
  ].join(".");
}

export async function signInternalMcpRequest(
  secret: string,
  input: InternalMcpSignatureInput,
): Promise<string> {
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
    encoder.encode(await buildSignaturePayload(input)),
  );
  return `${SIGNATURE_VERSION}.${encodeBase64Url(new Uint8Array(mac))}`;
}

function generateNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/** Signature headers for one request. Each call uses a fresh nonce. */
export async function internalMcpRequestHeaders(
  secret: string,
  request: { method: string; url: string; body: string },
  options: { timestamp?: string; nonce?: string } = {},
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const timestamp = options.timestamp ?? Date.now().toString();
  const nonce = options.nonce ?? generateNonce();
  const signature = await signInternalMcpRequest(secret, {
    method: request.method,
    target: `${url.pathname}${url.search}`,
    body: request.body,
    timestamp,
    nonce,
  });

  return {
    [MCP_SIGNATURE_HEADER]: signature,
    [MCP_TIMESTAMP_HEADER]: timestamp,
    [MCP_NONCE_HEADER]: nonce,
  };
}

/**
 * Build the signed request for the app's `/api/oauth/token` endpoint. Both
 * `authorization_code` and `refresh_token` grants are signed; the app rejects
 * either one with `401 invalid_client` when the signature is missing.
 */
export async function buildSignedTokenRequest(
  secret: string | null,
  apiBaseUrl: string,
  params: Record<string, string>,
): Promise<{ url: string; init: RequestInit }> {
  if (!secret) {
    throw new InternalAuthSecretMissingError();
  }

  const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/oauth/token`;
  const body = JSON.stringify({ ...params, client_id: TRUSTED_MCP_CLIENT_ID });
  const headers = await internalMcpRequestHeaders(secret, {
    method: "POST",
    url,
    body,
  });

  return {
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    },
  };
}

export { MAX_TIMESTAMP_SKEW_MS, SIGNATURE_VERSION, TRUSTED_MCP_CLIENT_ID };
