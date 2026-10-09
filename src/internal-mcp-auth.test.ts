import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignaturePayload,
  buildSignedTokenRequest,
  getInternalAuthSecret,
  InternalAuthSecretMissingError,
  internalMcpRequestHeaders,
  MCP_NONCE_HEADER,
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
  signInternalMcpRequest,
} from "./internal-mcp-auth";

// Shared with robynnv3 `src/lib/server/oauth/internal-mcp-auth.test.ts`; both
// repos must produce exactly this signature for exactly these inputs.
const VECTOR = {
  secret: "cos-plugin-p03-test-vector-secret",
  method: "POST",
  target: "/api/oauth/token",
  body: '{"grant_type":"refresh_token","refresh_token":"rrt_abababababababababababababababababababababababababababababababab","client_id":"robynn-mcp-worker"}',
  timestamp: "1700000000000",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  payload:
    "v2.1700000000000.AAECAwQFBgcICQoLDA0ODw.POST./api/oauth/token.uTZuJBwfPNNmG6090dbWyoPvjxvBhaEk8j9nQ2d117M",
  signature: "v2.3eKBtY6kjLAIwzF5xtl4mCSeJJpbMG5XbNrHQ8FSrZQ",
};

// Independent reference implementation (node:crypto) of the app-side check.
function referenceSignature(
  secret: string,
  parts: { method: string; target: string; body: string; timestamp: string; nonce: string },
): string {
  const digest = createHash("sha256").update(parts.body).digest("base64url");
  const payload = ["v2", parts.timestamp, parts.nonce, parts.method, parts.target, digest].join(".");
  return `v2.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("internal MCP signing contract v2", () => {
  it("matches the shared cross-repo test vector", async () => {
    expect(await buildSignaturePayload(VECTOR)).toBe(VECTOR.payload);
    expect(await signInternalMcpRequest(VECTOR.secret, VECTOR)).toBe(VECTOR.signature);
  });

  it("binds method, target, body, timestamp and nonce", async () => {
    const base = await signInternalMcpRequest(VECTOR.secret, VECTOR);
    const variants = [
      { ...VECTOR, method: "GET" },
      { ...VECTOR, target: "/api/oauth/introspect" },
      { ...VECTOR, target: "/api/oauth/token?x=1" },
      { ...VECTOR, body: VECTOR.body.replace("abab", "abac") },
      { ...VECTOR, timestamp: "1700000000001" },
      { ...VECTOR, nonce: "AAECAwQFBgcICQoLDA0OEA" },
    ];
    for (const variant of variants) {
      expect(await signInternalMcpRequest(VECTOR.secret, variant)).not.toBe(base);
    }
    expect(await signInternalMcpRequest("another-secret", VECTOR)).not.toBe(base);
  });

  it("emits signature, timestamp and a fresh nonce per request", async () => {
    const request = { method: "POST", url: "https://robynn.ai/api/oauth/token", body: "{}" };
    const first = await internalMcpRequestHeaders("s", request);
    const second = await internalMcpRequestHeaders("s", request);
    expect(first[MCP_SIGNATURE_HEADER]).toMatch(/^v2\.[A-Za-z0-9_-]{43}$/);
    expect(first[MCP_TIMESTAMP_HEADER]).toMatch(/^\d{13}$/);
    expect(first[MCP_NONCE_HEADER]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second[MCP_NONCE_HEADER]).not.toBe(first[MCP_NONCE_HEADER]);
  });

  it("exports stable header names", () => {
    expect(MCP_SIGNATURE_HEADER).toBe("x-robynn-mcp-signature");
    expect(MCP_TIMESTAMP_HEADER).toBe("x-robynn-mcp-timestamp");
    expect(MCP_NONCE_HEADER).toBe("x-robynn-mcp-nonce");
  });
});

describe("getInternalAuthSecret", () => {
  it("reads MCP_INTERNAL_AUTH_SECRET only, never CONNECTOR_STATE_SECRET", () => {
    expect(getInternalAuthSecret({ MCP_INTERNAL_AUTH_SECRET: "  s  " })).toBe("s");
    expect(getInternalAuthSecret({ MCP_INTERNAL_AUTH_SECRET: "  " })).toBeNull();
    const onlyLegacy = { CONNECTOR_STATE_SECRET: "legacy" } as {
      MCP_INTERNAL_AUTH_SECRET?: string;
    };
    expect(getInternalAuthSecret(onlyLegacy)).toBeNull();
  });
});

describe("buildSignedTokenRequest", () => {
  it.each([
    ["authorization_code", { grant_type: "authorization_code", code: "c-1", redirect_uri: "https://mcp.robynn.ai/callback" }],
    ["refresh_token", { grant_type: "refresh_token", refresh_token: "rrt_abc" }],
  ])("signs %s grants over the exact body sent", async (_name, params) => {
    const { url, init } = await buildSignedTokenRequest("shared", "https://robynn.ai/", params);
    expect(url).toBe("https://robynn.ai/api/oauth/token");
    expect(init.method).toBe("POST");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ ...params, client_id: "robynn-mcp-worker" });

    const headers = headersOf(init);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[MCP_SIGNATURE_HEADER]).toBe(
      referenceSignature("shared", {
        method: "POST",
        target: "/api/oauth/token",
        body,
        timestamp: headers[MCP_TIMESTAMP_HEADER],
        nonce: headers[MCP_NONCE_HEADER],
      }),
    );
  });

  it("forces the trusted client id even if a caller passes another one", async () => {
    const { init } = await buildSignedTokenRequest("shared", "https://robynn.ai", {
      grant_type: "refresh_token",
      refresh_token: "rrt_abc",
      client_id: "robynn-writer",
    });
    expect(JSON.parse(init.body as string).client_id).toBe("robynn-mcp-worker");
  });

  it("reproduces the shared vector for a refresh request", async () => {
    const { init } = await buildSignedTokenRequest(VECTOR.secret, "https://robynn.ai", {
      grant_type: "refresh_token",
      refresh_token: "rrt_abababababababababababababababababababababababababababababababab",
    });
    expect(init.body).toBe(VECTOR.body);
  });

  it("refuses to build an unsigned request when the secret is missing", async () => {
    await expect(
      buildSignedTokenRequest(null, "https://robynn.ai", { grant_type: "refresh_token", refresh_token: "r" }),
    ).rejects.toBeInstanceOf(InternalAuthSecretMissingError);
  });
});
