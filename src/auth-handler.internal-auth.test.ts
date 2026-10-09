import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { robynnAuthHandler } from "./auth-handler";
import {
  MCP_NONCE_HEADER,
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
} from "./internal-mcp-auth";
import { createAuthorizationTransaction } from "./authorization/state";

// COS-PLUGIN-001 P03: the /callback code exchange is always signed with
// MCP_INTERNAL_AUTH_SECRET and never with CONNECTOR_STATE_SECRET.
// P06: the transaction is now browser-bound (state + cookie), and failures
// after a valid state return an OAuth error to the host's redirect URI.

const CALLBACK_URL = "https://mcp.robynn.ai/callback";
const HOST_REDIRECT = "http://localhost/cb";

function kv(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

async function env(secrets: { MCP_INTERNAL_AUTH_SECRET?: string; CONNECTOR_STATE_SECRET?: string }) {
  const store = kv({});
  const { state, setCookie } = await createAuthorizationTransaction(
    store,
    {
      oauthRequest: { responseType: "code", clientId: "host", redirectUri: HOST_REDIRECT, state: "s", scope: ["brand:read"] },
      requestedScopes: ["brand:read"],
      clientName: "Host",
      workerCallbackUrl: CALLBACK_URL,
    },
    { secureCookie: true },
  );
  return {
    state,
    cookie: setCookie.split(";")[0],
    bindings: {
      ...secrets,
      ROBYNN_API_BASE_URL: "https://robynn.ai",
      MCP_PUBLIC_BASE_URL: "https://mcp.robynn.ai",
      OAUTH_KEY: store,
      OAUTH_PROVIDER: {
        completeAuthorization: vi.fn(),
        lookupClient: vi.fn(async () => ({ clientId: "host", clientName: "Host" })),
      },
    },
  };
}

function callback(state: string, cookie: string) {
  return new Request(`${CALLBACK_URL}?code=app-code-1&state=${state}`, { headers: { Cookie: cookie } });
}

function hostError(res: Response) {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(HOST_REDIRECT);
  return location.searchParams.get("error");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/callback internal auth", () => {
  it("signs the code exchange with MCP_INTERNAL_AUTH_SECRET over the exact body", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const e = await env({ MCP_INTERNAL_AUTH_SECRET: "internal-secret" });
    const res = await robynnAuthHandler.fetch(callback(e.state, e.cookie), e.bindings as never);
    // Upstream 4xx ⇒ OAuth `server_error` to the host (was a bare 500 before P06).
    expect(hostError(res)).toBe("server_error");
    expect(e.bindings.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
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
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const e = await env({ CONNECTOR_STATE_SECRET: "legacy-state-secret" });
    const res = await robynnAuthHandler.fetch(callback(e.state, e.cookie), e.bindings as never);
    // Fail closed: `temporarily_unavailable` to the host (was a bare 503 before P06).
    expect(hostError(res)).toBe("temporarily_unavailable");
    expect(e.bindings.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
