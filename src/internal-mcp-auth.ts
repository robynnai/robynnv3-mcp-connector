const TRUSTED_MCP_CLIENT_ID = "robynn-mcp-worker";
const SIGNATURE_VERSION = "v1";
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export const MCP_SIGNATURE_HEADER = "x-robynn-mcp-signature";
export const MCP_TIMESTAMP_HEADER = "x-robynn-mcp-timestamp";

interface TokenExchangeSignatureParams {
  code: string;
  clientId: string;
  grantType: string;
  redirectUri: string;
  timestamp: string;
}

function buildSignaturePayload(params: TokenExchangeSignatureParams): string {
  return [
    SIGNATURE_VERSION,
    params.timestamp,
    params.grantType,
    params.clientId,
    params.redirectUri,
    params.code,
  ].join(".");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function signTrustedMcpTokenExchange(
  secret: string,
  params: Omit<TokenExchangeSignatureParams, "timestamp"> & { timestamp?: string },
): Promise<{ signature: string; timestamp: string }> {
  const timestamp = params.timestamp ?? Date.now().toString();
  const payload = buildSignaturePayload({
    ...params,
    timestamp,
  });
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );

  return {
    signature: `${SIGNATURE_VERSION}.${encodeBase64Url(new Uint8Array(signature))}`,
    timestamp,
  };
}

export function shouldSignTrustedMcpTokenExchange(
  secret: string | undefined,
  clientId: string,
): secret is string {
  return Boolean(secret?.trim()) && clientId === TRUSTED_MCP_CLIENT_ID;
}

export { MAX_TIMESTAMP_SKEW_MS, SIGNATURE_VERSION, TRUSTED_MCP_CLIENT_ID };
