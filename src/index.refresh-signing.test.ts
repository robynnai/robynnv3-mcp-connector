import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COS-PLUGIN-001 P03 (review N1): both upstream refresh call sites in
// src/index.ts must send a v2-signed refresh_token request using
// MCP_INTERNAL_AUTH_SECRET only. The Cloudflare runtime modules are mocked;
// the real index.ts wiring (createOAuthProvider -> tokenExchangeCallback, and
// RobynnMCP.init -> RobynnClient refreshAccessToken) is exercised.

const providerOptions = vi.hoisted(() => ({ current: undefined as undefined | Record<string, any> }));
const clientOptions = vi.hoisted(() => ({ current: undefined as undefined | Record<string, any> }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class {
    constructor(options: Record<string, any>) {
      providerOptions.current = options;
    }
    fetch() {
      return Promise.resolve(new Response("ok"));
    }
  },
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

const okTokens = () =>
  new Response(JSON.stringify({ access_token: "new-access", refresh_token: "rrt_new", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  providerOptions.current = undefined;
  clientOptions.current = undefined;
  fetchMock = vi.fn(async () => okTokens());
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

const props = { accessToken: "old", refreshToken: REFRESH, userId: "u", organizationId: "o", _apiBaseUrl: API };

describe("provider tokenExchangeCallback (host refresh path)", () => {
  it("signs the upstream refresh with MCP_INTERNAL_AUTH_SECRET", async () => {
    const callback = await captureTokenExchangeCallback({
      MCP_INTERNAL_AUTH_SECRET: "internal-secret",
      CONNECTOR_STATE_SECRET: "legacy-secret",
      MCP_PUBLIC_BASE_URL: "https://mcp.test",
    });
    const result = (await callback({ grantType: "refresh_token", props })) as { newProps: { accessToken: string } };

    expect(fetchMock).toHaveBeenCalledOnce();
    expectSigned(fetchMock.mock.calls[0] as [string, RequestInit], "internal-secret");
    expect(result.newProps.accessToken).toBe("new-access");
  });

  it("sends nothing when only CONNECTOR_STATE_SECRET is configured", async () => {
    const callback = await captureTokenExchangeCallback({
      CONNECTOR_STATE_SECRET: "legacy-secret",
      MCP_PUBLIC_BASE_URL: "https://mcp.test",
    });
    await callback({ grantType: "refresh_token", props });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call upstream for authorization_code grants", async () => {
    const callback = await captureTokenExchangeCallback({ MCP_INTERNAL_AUTH_SECRET: "internal-secret" });
    await callback({ grantType: "authorization_code", props });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RobynnMCP tool-call refresh path", () => {
  async function initAgent(env: Record<string, unknown>) {
    const agent = new RobynnMCP({} as never, {} as never) as unknown as {
      props: unknown;
      env: unknown;
      updateProps: ReturnType<typeof vi.fn>;
      init(): Promise<void>;
    };
    agent.props = props;
    agent.env = { ROBYNN_API_BASE_URL: API, MCP_PUBLIC_BASE_URL: "https://mcp.test", ...env };
    agent.updateProps = vi.fn(async () => {});
    await agent.init();
    const refresh = clientOptions.current?.refreshAccessToken;
    expect(typeof refresh).toBe("function");
    return { agent, refresh: refresh as () => Promise<string | undefined> };
  }

  it("signs the upstream refresh with MCP_INTERNAL_AUTH_SECRET", async () => {
    const { agent, refresh } = await initAgent({
      MCP_INTERNAL_AUTH_SECRET: "internal-secret",
      CONNECTOR_STATE_SECRET: "legacy-secret",
    });
    await expect(refresh()).resolves.toBe("new-access");
    expect(fetchMock).toHaveBeenCalledOnce();
    expectSigned(fetchMock.mock.calls[0] as [string, RequestInit], "internal-secret");
    expect(agent.updateProps).toHaveBeenCalledOnce();
  });

  it("sends nothing when only CONNECTOR_STATE_SECRET is configured", async () => {
    const { agent, refresh } = await initAgent({ CONNECTOR_STATE_SECRET: "legacy-secret" });
    await expect(refresh()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agent.updateProps).not.toHaveBeenCalled();
  });
});
