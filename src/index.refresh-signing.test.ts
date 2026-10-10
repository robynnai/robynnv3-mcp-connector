import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COS-PLUGIN-001 P03 (review N1), updated by P10: the only upstream refresh
// call site left in src/index.ts (the provider tokenExchangeCallback) must
// send a v2-signed refresh_token request using MCP_INTERNAL_AUTH_SECRET only,
// and the session Durable Object must not refresh at all (contract D6). The
// Cloudflare runtime modules are mocked; the real index.ts wiring
// (createOAuthProvider -> tokenExchangeCallback, RobynnMCP.init ->
// RobynnClient options) is exercised.

const providerOptions = vi.hoisted(() => ({ current: undefined as undefined | Record<string, any> }));
const clientOptions = vi.hoisted(() => ({ current: undefined as undefined | Record<string, any> }));

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, env: {} }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class {
    constructor(options: Record<string, any>) {
      providerOptions.current = options;
    }
    fetch() {
      return Promise.resolve(new Response("ok"));
    }
  },
  getOAuthApi: () => ({ revokeGrant: async () => undefined }),
  GrantType: { AUTHORIZATION_CODE: "authorization_code", REFRESH_TOKEN: "refresh_token" },
}));

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    props: unknown;
    env: unknown;
    static serve() {
      return { fetch: () => new Response("ok") };
    }
  },
}));

vi.mock("./robynn-client", () => ({
  RobynnClient: class {
    constructor(_baseUrl: string, _token: string, options: Record<string, any>) {
      clientOptions.current = options;
    }
  },
}));

import worker, { RobynnMCP } from "./index";

const API = "https://app.test";
const REFRESH = "rrt_" + "ab".repeat(32);

function expectSigned(call: [string, RequestInit], secret: string) {
  const [url, init] = call;
  expect(url).toBe(`${API}/api/oauth/token`);
  const body = init.body as string;
  expect(JSON.parse(body)).toEqual({
    grant_type: "refresh_token",
    refresh_token: REFRESH,
    client_id: "robynn-mcp-worker",
  });
  const headers = init.headers as Record<string, string>;
  const payload = [
    "v2",
    headers["x-robynn-mcp-timestamp"],
    headers["x-robynn-mcp-nonce"],
    "POST",
    "/api/oauth/token",
    createHash("sha256").update(body).digest("base64url"),
  ].join(".");
  expect(headers["x-robynn-mcp-signature"]).toBe(
    `v2.${createHmac("sha256", secret).update(payload).digest("base64url")}`,
  );
}

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "6f0c0000-0000-4000-8000-00000000000a";

function appJwt() {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: "robynn.ai",
    aud: "robynn-api:mcp",
    type: "access",
    sub: USER,
    org: ORG,
    gid: GRANT,
    ver: 1,
    cid: "robynn-mcp-worker",
    scope: "brand:read",
    iat: now,
    exp: now + 3600,
    jti: "j",
  })}.c2ln`;
}

const okTokens = () =>
  new Response(JSON.stringify({ access_token: appJwt(), refresh_token: "rrt_new", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const activeIntrospection = () =>
  Response.json({
    active: true,
    grant_id: GRANT,
    user_id: USER,
    organization_id: ORG,
    client_id: "robynn-mcp-worker",
    credential_version: 1,
    scopes: ["brand:read"],
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  providerOptions.current = undefined;
  clientOptions.current = undefined;
  fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/api/oauth/introspect") ? activeIntrospection() : okTokens()));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function captureTokenExchangeCallback(env: Record<string, unknown>) {
  await worker.fetch(new Request("https://mcp.test/"), env as never, {} as never);
  const callback = providerOptions.current?.tokenExchangeCallback;
  expect(typeof callback).toBe("function");
  return callback as (options: Record<string, unknown>) => Promise<unknown>;
}

const props = {
  accessToken: "old",
  refreshToken: REFRESH,
  userId: USER,
  organizationId: ORG,
  appGrantId: GRANT,
  credentialVersion: 1,
  scopes: ["brand:read"],
  authVersion: 2,
};
const refreshOptions = { grantType: "refresh_token", userId: USER, requestedScope: ["brand:read"], props };

describe("provider tokenExchangeCallback (host refresh path)", () => {
  it("signs the upstream refresh with MCP_INTERNAL_AUTH_SECRET", async () => {
    const callback = await captureTokenExchangeCallback({
      MCP_INTERNAL_AUTH_SECRET: "internal-secret",
      CONNECTOR_STATE_SECRET: "legacy-secret",
      MCP_PUBLIC_BASE_URL: "https://mcp.test",
      ROBYNN_API_BASE_URL: API,
    });
    const result = (await callback(refreshOptions)) as { newProps: { accessToken: string } };

    expect(fetchMock).toHaveBeenCalledTimes(2); // refresh, then introspection
    expectSigned(fetchMock.mock.calls[0] as [string, RequestInit], "internal-secret");
    const claims = JSON.parse(Buffer.from(result.newProps.accessToken.split(".")[1], "base64url").toString());
    expect(claims.gid).toBe(GRANT);
  });

  it("sends nothing and fails closed when only CONNECTOR_STATE_SECRET is configured", async () => {
    const callback = await captureTokenExchangeCallback({
      CONNECTOR_STATE_SECRET: "legacy-secret",
      MCP_PUBLIC_BASE_URL: "https://mcp.test",
      ROBYNN_API_BASE_URL: API,
    });
    await expect(callback(refreshOptions)).rejects.toMatchObject({ name: "UpstreamUnavailableError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call upstream for authorization_code grants", async () => {
    const callback = await captureTokenExchangeCallback({ MCP_INTERNAL_AUTH_SECRET: "internal-secret" });
    // P06: without a matching token-request redirect_uri the code grant is
    // refused (F10); either way the upstream app is never called.
    await expect(callback({ grantType: "authorization_code", props })).rejects.toThrow(
      "redirect_uri does not match",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RobynnMCP has no in-session refresh (contract D6)", () => {
  it("creates its RobynnClient without a refresh hook and never calls the token endpoint", async () => {
    const agent = new RobynnMCP({} as never, {} as never) as unknown as {
      props: unknown;
      env: unknown;
      init(): Promise<void>;
    };
    agent.props = props;
    agent.env = { ROBYNN_API_BASE_URL: API, MCP_PUBLIC_BASE_URL: "https://mcp.test", MCP_INTERNAL_AUTH_SECRET: "internal-secret" };
    await agent.init();
    expect(clientOptions.current).toBeDefined();
    expect(clientOptions.current?.refreshAccessToken).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
