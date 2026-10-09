import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { robynnAuthHandler } from "./auth-handler";
import {
  MCP_NONCE_HEADER,
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
} from "./internal-mcp-auth";

// COS-PLUGIN-001 P03: the /callback code exchange is always signed with
// MCP_INTERNAL_AUTH_SECRET and never with CONNECTOR_STATE_SECRET.

const STATE = "state-123";
const CALLBACK_URL = "https://mcp.robynn.ai/callback";

function kv(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

function env(secrets: { MCP_INTERNAL_AUTH_SECRET?: string; CONNECTOR_STATE_SECRET?: string }) {
  const state = JSON.stringify({
    workerCallbackUrl: CALLBACK_URL,
    oauthRequest: { responseType: "code", clientId: "host", redirectUri: "http://localhost/cb", state: "s", scope: ["brand:read"] },
  });
  return {
    ...secrets,
    ROBYNN_API_BASE_URL: "https://robynn.ai",
    MCP_PUBLIC_BASE_URL: "https://mcp.robynn.ai",
    OAUTH_KEY: kv({ [`oauth_state:${STATE}`]: state }),
    OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
  };
}

function callback() {
  return new Request(`${CALLBACK_URL}?code=app-code-1&state=${STATE}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/callback internal auth", () => {
  it("signs the code exchange with MCP_INTERNAL_AUTH_SECRET over the exact body", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await robynnAuthHandler.fetch(callback(), env({ MCP_INTERNAL_AUTH_SECRET: "internal-secret" }) as never);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://robynn.ai/api/oauth/token");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      grant_type: "authorization_code",
      code: "app-code-1",
      redirect_uri: CALLBACK_URL,
      client_id: "robynn-mcp-worker",
    });

    const headers = init.headers as Record<string, string>;
    const payload = [
      "v2",
      headers[MCP_TIMESTAMP_HEADER],
      headers[MCP_NONCE_HEADER],
      "POST",
      "/api/oauth/token",
      createHash("sha256").update(body).digest("base64url"),
    ].join(".");
    expect(headers[MCP_SIGNATURE_HEADER]).toBe(
      `v2.${createHmac("sha256", "internal-secret").update(payload).digest("base64url")}`,
    );
  });

  it("never signs with CONNECTOR_STATE_SECRET and fails closed without the internal secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await robynnAuthHandler.fetch(callback(), env({ CONNECTOR_STATE_SECRET: "legacy-state-secret" }) as never);
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
