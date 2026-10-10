/**
 * COS-PLUGIN-001 P06 — the Worker's OAuth front door, end to end.
 *
 * Extends P01's provider contract (provider-contract.test.ts, facts F7, F9,
 * F10, F14, F19) from bare `OAuthProvider` options to the Worker's REAL
 * wiring: the default export of src/index.ts, `createOAuthProviderOptions`,
 * the real `@cloudflare/workers-oauth-provider` 0.3.0 and the real Hono
 * `/authorize` + `/callback` handler. Only the Durable Object (`agents/mcp`)
 * and the Robynn app (global `fetch`) are stubbed. In-memory KV, no network,
 * synthetic identities only.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {},
  env: {},
}));

const apiSeen = vi.hoisted(() => [] as Array<{ path: string; props: Record<string, unknown> }>);

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return {
        async fetch(request: Request, _env: unknown, ctx: { props?: Record<string, unknown> }) {
          apiSeen.push({ path: new URL(request.url).pathname, props: ctx.props ?? {} });
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
        },
      };
    }
  },
}));

import worker, { createOAuthProviderOptions } from "../index";
import type { Env } from "../types";

const ORIGIN = "https://mcp.test";
const API = "https://app.test";
const HOST_CALLBACK = "http://127.0.0.1:43123/callback";
const OTHER_CALLBACK = "http://127.0.0.1:43124/other";
const NATIVE_CALLBACK = "robynn-host-test://oauth/callback";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT_A = "6f0c0000-0000-4000-8000-00000000000a";
const SECRET = "p06-test-internal-secret";

// Canaries: none of these may ever appear in a log line.
const CANARY_APP_CODE = "appcode-CANARY-1c9e7d";
const CANARY_REFRESH = "apprefresh-CANARY-55aa";
const CANARY_BODY = "upstream-body-CANARY-0b0b";
const CANARY_HOST_STATE = "hoststate-CANARY-77";

class MemoryKV {
  readonly store = new Map<string, string>();
  async get(key: string, opts?: { type?: string } | string) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.store.set(key, String(value));
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string } = {}) {
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
  keys(prefix: string) {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appJwt(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "robynn.ai",
    aud: "robynn-api:mcp",
    type: "access",
    sub: USER_A,
    org: ORG_A,
    gid: GRANT_A,
    ver: 1,
    cid: "robynn-mcp-worker",
    scope: "brand:read",
    iat: now,
    exp: now + 3600,
    jti: "jti-1",
    ...claims,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete (payload as Record<string, unknown>)[k];
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;
}

interface AppPlan {
  tokenStatus: number;
  tokenBody: unknown;
  introspection: { status: number; body: unknown } | "network";
}

interface Harness {
  env: Env & { OAUTH_KV: MemoryKV; OAUTH_KEY: MemoryKV };
  kv: MemoryKV;
  plan: AppPlan;
  appCalls: Array<{ url: string; init: RequestInit }>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

function createHarness(): Harness {
  const kv = new MemoryKV();
  const env = {
    OAUTH_KV: kv,
    OAUTH_KEY: kv,
    ROBYNN_API_BASE_URL: API,
    MCP_PUBLIC_BASE_URL: ORIGIN,
    MCP_INTERNAL_AUTH_SECRET: SECRET,
    MCP_SERVER_NAME: "Robynn",
    MCP_SERVER_VERSION: "test",
  } as unknown as Harness["env"];
  const appCalls: Harness["appCalls"] = [];
  const harness: Harness = {
    env,
    kv,
    appCalls,
    plan: {
      tokenStatus: 200,
      tokenBody: { access_token: appJwt(), refresh_token: CANARY_REFRESH, expires_in: 3600, token_type: "Bearer" },
      introspection: {
        status: 200,
        body: {
          active: true,
          grant_id: GRANT_A,
          user_id: USER_A,
          organization_id: ORG_A,
          organization: { id: ORG_A, name: "Synthetic Org A", slug: "synthetic-a" },
          client_id: "robynn-mcp-worker",
          scopes: ["brand:read"],
          credential_version: 1,
        },
      },
    },
    fetch: (path, init) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, withWireLength(init)), env, {
        waitUntil() {},
        passThroughOnException() {},
        props: undefined,
      } as unknown as ExecutionContext),
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      appCalls.push({ url, init });
      if (url === `${API}/api/oauth/token`) {
        return new Response(JSON.stringify(harness.plan.tokenBody), {
          status: harness.plan.tokenStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${API}/api/oauth/introspect`) {
        const plan = harness.plan.introspection;
        if (plan === "network") throw new TypeError("fetch failed");
        return new Response(JSON.stringify(plan.body), {
          status: plan.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }),
  );
  return harness;
}

/**
 * Node's Request does not expose the Content-Length it will send; on the
 * wire (and in workerd) a fixed-size body always carries one. Add it so the
 * Worker sees what a real host sends.
 */
function withWireLength(init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  if (!headers.has("content-length")) {
    headers.set("content-length", String(Buffer.byteLength(init.body)));
  }
  return { ...init, headers };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(h: Harness, redirectUris = [HOST_CALLBACK, OTHER_CALLBACK], clientName = "Test Host") {
  const res = await h.fetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, overrides: Record<string, string | string[] | undefined> = {}) {
  const params = new URLSearchParams();
  const base: Record<string, string | string[] | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: HOST_CALLBACK,
    state: CANARY_HOST_STATE,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  }
  return `/authorize?${params.toString()}`;
}

/** Run /authorize and return the app consent URL plus the browser cookie. */
async function startAuthorization(h: Harness, clientId: string, overrides: Record<string, string | string[] | undefined> = {}) {
  const { verifier, challenge } = pkce();
  const res = await h.fetch(authorizeQuery(clientId, { code_challenge: challenge, ...overrides }));
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get("location")!);
  expect(consent.origin + consent.pathname).toBe(`${API}/oauth/authorize`);
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0];
  return { consent, cookie, setCookie, verifier, state: consent.searchParams.get("state")! };
}

async function callback(h: Harness, query: Record<string, string>, cookie?: string) {
  return h.fetch(`/callback?${new URLSearchParams(query).toString()}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function exchange(h: Harness, clientId: string, code: string, verifier: string, redirectUri: string | null = HOST_CALLBACK) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
  if (redirectUri !== null) body.set("redirect_uri", redirectUri);
  return h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/** Full happy path up to the host receiving its code. */
async function authorizeToHostCode(h: Harness, clientId: string, overrides: Record<string, string | string[] | undefined> = {}) {
  const started = await startAuthorization(h, clientId, overrides);
  const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
  expect(res.status).toBe(302);
  const hostRedirect = new URL(res.headers.get("location")!);
  return { ...started, hostRedirect, callbackResponse: res, code: hostRedirect.searchParams.get("code")! };
}

let logLines: string[];

beforeEach(() => {
  apiSeen.length = 0;
  logLines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createOAuthProviderOptions (the options the Worker actually runs)", () => {
  it("disables plain PKCE, implicit and token-exchange grants and serves only /mcp", () => {
    const options = createOAuthProviderOptions(createHarness().env);
    expect(options.allowPlainPKCE).toBe(false);
    expect(options.allowImplicitFlow).toBe(false);
    expect(options.allowTokenExchangeGrant).toBe(false);
    expect(options.apiRoute).toEqual(["/mcp"]);
    expect(options.scopesSupported).toEqual(["brand:read", "tools:execute"]);
  });

  it("advertises S256 as the only PKCE method", async () => {
    const h = createHarness();
    const meta = (await (await h.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.response_types_supported).toEqual(["code"]);
  });
});

describe("/authorize — PKCE and flow (F9)", () => {
  it("rejects a missing code_challenge even with code_challenge_method=S256, before any state is stored", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const res = await h.fetch(authorizeQuery(clientId));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(HOST_CALLBACK);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe(CANARY_HOST_STATE);
    expect(h.kv.keys("oauth_state:")).toEqual([]);
    expect(h.appCalls).toEqual([]);
  });

  it.each([
    ["plain method", { code_challenge_method: "plain", code_challenge: "a".repeat(43) }],
    ["omitted method (defaults to plain)", { code_challenge_method: undefined, code_challenge: "a".repeat(43) }],
    ["implicit flow", { response_type: "token", code_challenge: "a".repeat(43) }],
    ["unregistered redirect", { redirect_uri: "http://127.0.0.1:9/evil", code_challenge: "a".repeat(43) }],
  ])("refuses %s with a 400 page and no redirect", async (_label, overrides) => {
    const h = createHarness();
    const clientId = await register(h);
    const res = await h.fetch(authorizeQuery(clientId, overrides));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("invalid_request");
    expect(h.kv.keys("oauth_state:")).toEqual([]);
  });

  it("refuses a request with no client_id", async () => {
    const h = createHarness();
    const res = await h.fetch(authorizeQuery("", { code_challenge: "a".repeat(43) }));
    expect(res.status).toBe(400);
    expect(h.kv.keys("oauth_state:")).toEqual([]);
  });

  it.each([
    ["too short", "a".repeat(42)],
    ["too long", "a".repeat(44)],
    ["non-base64url", `${"a".repeat(42)}=`],
  ])("rejects a malformed S256 challenge (%s)", async (_label, challenge) => {
    const h = createHarness();
    const clientId = await register(h);
    const res = await h.fetch(authorizeQuery(clientId, { code_challenge: challenge }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a non-code response_type with unsupported_response_type", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const res = await h.fetch(authorizeQuery(clientId, { response_type: "id_token", code_challenge: "a".repeat(43) }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");
  });

  it("rejects an incorrect code_verifier at /token (provider) after a valid S256 authorization", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code } = await authorizeToHostCode(h, clientId);
    const res = await exchange(h, clientId, code, pkce().verifier);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("/authorize — scope is forwarded exactly, never widened (F7)", () => {
  it.each([
    ["omitted", undefined, "brand:read"],
    ["brand:read", "brand:read", "brand:read"],
    ["both", "brand:read tools:execute", "brand:read tools:execute"],
    ["both, reversed and duplicated", "tools:execute brand:read tools:execute", "brand:read tools:execute"],
    ["execute only", "tools:execute", "tools:execute"],
  ])("%s ⇒ consent scope %s", async (_label, scope, expected) => {
    const h = createHarness();
    const clientId = await register(h);
    const { consent } = await startAuthorization(h, clientId, { scope });
    expect(consent.searchParams.get("scope")).toBe(expected);
    expect(consent.searchParams.get("client_id")).toBe("robynn-mcp-worker");
    expect(consent.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(consent.searchParams.get("response_type")).toBe("code");
    expect(consent.searchParams.get("client_name")).toBe("Test Host");
    expect(consent.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([["admin:everything"], ["brand:read admin:everything"], ["cli:session"], ["brand:write"]])(
    "rejects unknown scope %s with invalid_scope",
    async (scope) => {
      const h = createHarness();
      const clientId = await register(h);
      const res = await h.fetch(authorizeQuery(clientId, { scope, code_challenge: "a".repeat(43) }));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(h.kv.keys("oauth_state:")).toEqual([]);
    },
  );

  it("sends a sanitized DCR client name, not a request-supplied one", async () => {
    const h = createHarness();
    const clientId = await register(h, [HOST_CALLBACK], "Evil‮Host\u0000 <b>x</b>");
    const { consent } = await startAuthorization(h, clientId, { client_name: "Spoofed" } as never);
    expect(consent.searchParams.get("client_name")).toBe("EvilHost <b>x</b>");
  });
});

describe("/authorize — resource allow-list (F14, D10)", () => {
  it.each([[ORIGIN], [`${ORIGIN}/`], [`${ORIGIN}/mcp`], [undefined]])("accepts %s", async (resource) => {
    const h = createHarness();
    const clientId = await register(h);
    await startAuthorization(h, clientId, { resource });
  });

  it.each([
    [`${ORIGIN}/sse`],
    [`${ORIGIN}/mcp/openai`],
    [`${ORIGIN}/mcp/`],
    [`${ORIGIN}/mcpx`],
    ["https://evil.test/mcp"],
    [`${ORIGIN}/mcp?x=1`],
    [[`${ORIGIN}/mcp`, "https://evil.test/"]],
  ])("rejects %s with invalid_target and does not merge aliases", async (resource) => {
    const h = createHarness();
    const clientId = await register(h);
    const res = await h.fetch(authorizeQuery(clientId, { resource, code_challenge: "a".repeat(43) }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    expect(h.kv.keys("oauth_state:")).toEqual([]);
  });

  it("issues a token whose audience is exactly the requested resource", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId, { resource: `${ORIGIN}/mcp` });
    const tokens = (await (await exchange(h, clientId, code, verifier)).json()) as Record<string, unknown>;
    expect(tokens.resource).toBe(`${ORIGIN}/mcp`);
  });
});

describe("full chain with a browser-bound transaction", () => {
  it("completes only after signed exchange + introspection; the host gets exactly the granted scope", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier, hostRedirect, callbackResponse, state } = await authorizeToHostCode(h, clientId);

    expect(hostRedirect.origin + hostRedirect.pathname).toBe(HOST_CALLBACK);
    expect(hostRedirect.searchParams.get("state")).toBe(CANARY_HOST_STATE);
    expect(callbackResponse.headers.get("cache-control")).toBe("no-store");
    expect(callbackResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(callbackResponse.headers.get("set-cookie")).toContain(`robynn_oauth_${state}=;`);
    expect(callbackResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    // Exchange then introspection, both signed; introspection carries no credential.
    expect(h.appCalls.map((c) => c.url)).toEqual([`${API}/api/oauth/token`, `${API}/api/oauth/introspect`]);
    const introspection = h.appCalls[1];
    const headers = introspection.init.headers as Record<string, string>;
    expect(headers["x-robynn-mcp-signature"]).toMatch(/^v2\./);
    expect(JSON.parse(introspection.init.body as string)).toEqual({
      grant_id: GRANT_A,
      user_id: USER_A,
      organization_id: ORG_A,
      client_id: "robynn-mcp-worker",
      credential_version: 1,
    });
    expect(introspection.init.body as string).not.toContain(CANARY_REFRESH);

    const tokenRes = await exchange(h, clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; scope: string };
    expect(tokens.scope).toBe("brand:read");

    const mcp = await h.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(200);
    expect(apiSeen).toHaveLength(1);
    expect(apiSeen[0].props).toMatchObject({
      userId: USER_A,
      organizationId: ORG_A,
      appGrantId: GRANT_A,
      credentialVersion: 1,
      scopes: ["brand:read"],
      authVersion: 2,
    });
    // The redirect binding is dropped once the code is redeemed.
    expect(apiSeen[0].props).not.toHaveProperty("authorizeRedirectUri");
  });

  it("uses the host-neutral launch page for a native custom-scheme redirect", async () => {
    const h = createHarness();
    const clientId = await register(h, [NATIVE_CALLBACK]);
    const started = await startAuthorization(h, clientId, { redirect_uri: NATIVE_CALLBACK });
    const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Returning to your app");
    expect(html).not.toMatch(/claude/i);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("marks the state cookie Secure + __Host- on https and plain on http loopback", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const secure = await startAuthorization(h, clientId);
    expect(secure.setCookie).toMatch(/^__Host-robynn_oauth_[A-Za-z0-9_-]{43}=/);
    expect(secure.setCookie).toContain("HttpOnly");
    expect(secure.setCookie).toContain("SameSite=Lax");
    expect(secure.setCookie).toContain("Secure");
    expect(secure.setCookie).toContain("Path=/");

    const local = createHarness();
    (local.env as { MCP_PUBLIC_BASE_URL: string }).MCP_PUBLIC_BASE_URL = "http://localhost:8787";
    const localClient = await register(local);
    const res = await local.fetch(authorizeQuery(localClient, { code_challenge: pkce().challenge }));
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^robynn_oauth_/);
    expect(cookie).not.toContain("Secure");
  });
});

describe("/callback — browser-bound, single-use state", () => {
  it("rejects a state presented without its browser cookie, and leaves it usable by its owner", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId);

    const attacker = await callback(h, { code: CANARY_APP_CODE, state: started.state });
    expect(attacker.status).toBe(400);
    expect(attacker.headers.get("location")).toBeNull();
    expect(h.appCalls).toEqual([]);

    const forged = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie.replace(/=.*/, "=forged-nonce"));
    expect(forged.status).toBe(400);
    expect(h.appCalls).toEqual([]);

    const owner = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
    expect(owner.status).toBe(302);
  });

  it("refuses a replayed state after success", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId);
    expect((await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie)).status).toBe(302);
    const calls = h.appCalls.length;
    const replay = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
    expect(replay.status).toBe(400);
    expect(h.appCalls.length).toBe(calls);
  });

  it("refuses an expired transaction", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId);
    const key = `oauth_state:${started.state}`;
    const record = JSON.parse(h.kv.store.get(key)!);
    record.createdAt -= 11 * 60 * 1000;
    h.kv.store.set(key, JSON.stringify(record));
    expect((await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie)).status).toBe(400);
    expect(h.appCalls).toEqual([]);
  });

  it.each([["unknown"], ["short"], ["<script>"], ["a".repeat(43)]])("refuses state %s with a static page", async (state) => {
    const h = createHarness();
    const res = await callback(h, { code: CANARY_APP_CODE, state });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain(CANARY_APP_CODE);
  });

  it("rejects when the registered client changed between /authorize and /callback", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId);
    const clientKey = `client:${clientId}`;
    const client = JSON.parse(h.kv.store.get(clientKey)!);
    client.clientName = "Different Host";
    h.kv.store.set(clientKey, JSON.stringify(client));
    const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(h.appCalls).toEqual([]);
  });
});

describe("/callback — fail closed on identity and scope", () => {
  async function runCallback(h: Harness, scope?: string) {
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId, { scope });
    const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
    return { res, loc: res.headers.get("location") ? new URL(res.headers.get("location")!) : null };
  }

  function expectNoGrant(h: Harness) {
    expect(h.kv.keys("grant:")).toEqual([]);
  }

  it.each([
    ["sub missing", { sub: undefined }],
    ["sub 'unknown'", { sub: "unknown" }],
    ["sub master-key sentinel", { sub: "organization_master_key" }],
    ["org 'unknown'", { org: "unknown" }],
    ["org nil uuid", { org: "00000000-0000-0000-0000-000000000000" }],
    ["gid missing (pre-P05 token)", { gid: undefined }],
    ["ver missing", { ver: undefined }],
    ["wrong audience", { aud: "robynn-api:agent-run" }],
    ["wrong client", { cid: "robynn-cli" }],
    ["expired", { exp: 1 }],
    ["unknown scope", { scope: "brand:read cli:session" }],
  ])("app token with %s ⇒ server_error, no grant, no introspection", async (_label, claims) => {
    const h = createHarness();
    h.plan.tokenBody = { access_token: appJwt(claims), refresh_token: CANARY_REFRESH, expires_in: 3600 };
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe("server_error");
    expect(loc!.searchParams.get("state")).toBe(CANARY_HOST_STATE);
    expect(h.appCalls.map((c) => c.url)).toEqual([`${API}/api/oauth/token`]);
    expectNoGrant(h);
  });

  it.each([
    ["non-JWT access token", { access_token: "opaque", refresh_token: CANARY_REFRESH }],
    ["missing refresh token", { access_token: appJwt() }],
    ["not an object", ["x"]],
  ])("malformed token response (%s) ⇒ server_error, no grant", async (_label, body) => {
    const h = createHarness();
    h.plan.tokenBody = body;
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe("server_error");
    expectNoGrant(h);
  });

  it.each([
    [400, "server_error"],
    [401, "server_error"],
    [429, "temporarily_unavailable"],
    [500, "temporarily_unavailable"],
  ])("upstream exchange %s ⇒ %s without reading the body", async (status, error) => {
    const h = createHarness();
    h.plan.tokenStatus = status;
    h.plan.tokenBody = { error: "invalid_grant", echo: CANARY_BODY };
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe(error);
    expectNoGrant(h);
  });

  it.each([
    ["introspection route absent (404, until P10)", { status: 404, body: { error: "not found" } }, "temporarily_unavailable"],
    ["introspection 401", { status: 401, body: { error: "invalid_client" } }, "temporarily_unavailable"],
    ["introspection 503", { status: 503, body: {} }, "temporarily_unavailable"],
    ["introspection malformed", { status: 200, body: { active: "yes" } }, "temporarily_unavailable"],
    ["introspection inactive", { status: 200, body: { active: false, reason: "grant_revoked" } }, "access_denied"],
    ["introspection other user", { status: 200, body: { active: true, grant_id: GRANT_A, user_id: USER_B, organization_id: ORG_A, client_id: "robynn-mcp-worker", scopes: ["brand:read"], credential_version: 1 } }, "access_denied"],
    ["introspection stale version", { status: 200, body: { active: true, grant_id: GRANT_A, user_id: USER_A, organization_id: ORG_A, client_id: "robynn-mcp-worker", scopes: ["brand:read"], credential_version: 2 } }, "access_denied"],
  ])("%s ⇒ %s, no grant", async (_label, introspection, error) => {
    const h = createHarness();
    h.plan.introspection = introspection;
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe(error);
    expectNoGrant(h);
  });

  it("introspection network failure ⇒ temporarily_unavailable, no grant", async () => {
    const h = createHarness();
    h.plan.introspection = "network";
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe("temporarily_unavailable");
    expectNoGrant(h);
  });

  it("missing MCP_INTERNAL_AUTH_SECRET ⇒ temporarily_unavailable and no outbound call", async () => {
    const h = createHarness();
    delete (h.env as { MCP_INTERNAL_AUTH_SECRET?: string }).MCP_INTERNAL_AUTH_SECRET;
    const { loc } = await runCallback(h);
    expect(loc!.searchParams.get("error")).toBe("temporarily_unavailable");
    expect(h.appCalls).toEqual([]);
    expectNoGrant(h);
  });

  it("granted ⊄ requested (consent hidden-field tampering) ⇒ invalid_scope, no grant", async () => {
    const h = createHarness();
    h.plan.tokenBody = { access_token: appJwt({ scope: "brand:read tools:execute" }), refresh_token: CANARY_REFRESH };
    (h.plan.introspection as { body: Record<string, unknown> }).body.scopes = ["brand:read", "tools:execute"];
    const { loc } = await runCallback(h, "brand:read");
    expect(loc!.searchParams.get("error")).toBe("invalid_scope");
    expectNoGrant(h);
  });

  it("JWT broader than requested, introspection within it ⇒ invalid_scope (stored upstream token broader than the host grant)", async () => {
    const h = createHarness();
    h.plan.tokenBody = { access_token: appJwt({ scope: "brand:read tools:execute" }), refresh_token: CANARY_REFRESH };
    (h.plan.introspection as { body: Record<string, unknown> }).body.scopes = ["brand:read"];
    const { loc } = await runCallback(h, "brand:read");
    expect(loc!.searchParams.get("error")).toBe("invalid_scope");
    expectNoGrant(h);
  });

  it("introspection narrower than the JWT (role downgrade) narrows the grant", async () => {
    const h = createHarness();
    h.plan.tokenBody = { access_token: appJwt({ scope: "brand:read tools:execute" }), refresh_token: CANARY_REFRESH };
    (h.plan.introspection as { body: Record<string, unknown> }).body.scopes = ["brand:read"];
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId, { scope: "brand:read tools:execute" });
    const tokens = (await (await exchange(h, clientId, code, verifier)).json()) as { scope: string };
    expect(tokens.scope).toBe("brand:read");
  });

  it("both scopes requested and granted ⇒ both", async () => {
    const h = createHarness();
    h.plan.tokenBody = { access_token: appJwt({ scope: "brand:read tools:execute" }), refresh_token: CANARY_REFRESH };
    (h.plan.introspection as { body: Record<string, unknown> }).body.scopes = ["brand:read", "tools:execute"];
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId, { scope: "brand:read tools:execute" });
    const tokens = (await (await exchange(h, clientId, code, verifier)).json()) as { scope: string };
    expect(tokens.scope).toBe("brand:read tools:execute");
  });

  it.each([
    ["access_denied", "access_denied"],
    ["invalid_scope", "invalid_scope"],
    ['"><script>alert(1)</script>', "server_error"],
    ["invalid_grant", "server_error"],
  ])("app error=%s ⇒ host error=%s, nothing reflected, no exchange", async (appError, expected) => {
    const h = createHarness();
    const clientId = await register(h);
    const started = await startAuthorization(h, clientId);
    const res = await callback(h, { error: appError, state: started.state }, started.cookie);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe(expected);
    expect(loc.searchParams.get("state")).toBe(CANARY_HOST_STATE);
    expect([...loc.searchParams.keys()].sort()).toEqual(
      expected === "invalid_scope" ? ["error", "error_description", "state"] : ["error", "state"],
    );
    expect(h.appCalls).toEqual([]);
  });
});

describe("/token — redirect_uri bound to the authorization transaction (F10)", () => {
  it("rejects a different registered redirect_uri without burning the code", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId);

    const wrong = await exchange(h, clientId, code, verifier, OTHER_CALLBACK);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });

    const right = await exchange(h, clientId, code, verifier);
    expect(right.status).toBe(200);
  });

  it("rejects an omitted redirect_uri (PKCE would otherwise allow it)", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId);
    const res = await exchange(h, clientId, code, verifier, null);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a repeated redirect_uri parameter", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
    body.append("redirect_uri", HOST_CALLBACK);
    body.append("redirect_uri", HOST_CALLBACK);
    const res = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });

  it("refresh works before a replay; a code replay is rejected and revokes the grant (provider)", async () => {
    const h = createHarness();
    const clientId = await register(h);
    const { code, verifier } = await authorizeToHostCode(h, clientId);
    const first = (await (await exchange(h, clientId, code, verifier)).json()) as { refresh_token: string };
    const refreshed = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { refresh_token: string };
    expect((await exchange(h, clientId, code, verifier)).status).toBe(400);
    // F14: replaying the code revoked the whole grant, so its refresh token is dead too.
    const afterReplay = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId }).toString(),
    });
    expect(afterReplay.status).toBe(400);
  });
});

describe("API-prefix path allow-list and SSE (D10, F14, F19)", () => {
  it.each([["/mcpx"], ["/mcp/"], ["/mcp/openai"], ["/mcp/lazy"], ["/sse"], ["/sse/message?sessionId=abc"]])(
    "%s ⇒ 404 before the provider (no auth challenge, no handler)",
    async (path) => {
      const h = createHarness();
      const res = await h.fetch(path, { method: path.startsWith("/sse") ? "GET" : "POST" });
      expect(res.status).toBe(404);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(apiSeen).toEqual([]);
    },
  );

  it("/mcp without a token still gets the provider's 401 challenge", async () => {
    const h = createHarness();
    const res = await h.fetch("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("does not advertise /sse in the landing JSON or protected-resource metadata", async () => {
    const h = createHarness();
    const landing = (await (await h.fetch("/")).json()) as { endpoints: Record<string, string>; description: string };
    expect(landing.endpoints).not.toHaveProperty("sse");
    expect(landing.description).not.toMatch(/claude/i);
    expect((await h.fetch("/.well-known/oauth-protected-resource/sse")).status).toBe(404);
    expect((await h.fetch("/.well-known/oauth-protected-resource/mcp")).status).toBe(200);
  });
});

describe("log canaries — no codes, state, tokens, query strings or bodies in logs", () => {
  it("success and failure paths log only redacted structured events", async () => {
    const h = createHarness();
    const clientId = await register(h);

    // Success, then token exchange, refresh and an MCP call.
    const ok = await authorizeToHostCode(h, clientId);
    const tokens = (await (await exchange(h, clientId, ok.code, ok.verifier)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
    });
    await h.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });

    // Failures: upstream error body, introspection down, mismatched redirect, bad state.
    h.plan.tokenStatus = 400;
    h.plan.tokenBody = { error: "invalid_grant", echo: CANARY_BODY, code: CANARY_APP_CODE };
    const failed = await startAuthorization(h, clientId);
    await callback(h, { code: CANARY_APP_CODE, state: failed.state }, failed.cookie);
    h.plan.tokenStatus = 200;
    h.plan.tokenBody = { access_token: appJwt(), refresh_token: CANARY_REFRESH };
    h.plan.introspection = { status: 500, body: { echo: CANARY_BODY } };
    const down = await startAuthorization(h, clientId);
    await callback(h, { code: CANARY_APP_CODE, state: down.state }, down.cookie);
    h.plan.introspection = createHarness().plan.introspection;
    const mismatch = await authorizeToHostCode(h, clientId);
    await exchange(h, clientId, mismatch.code, mismatch.verifier, OTHER_CALLBACK);
    await callback(h, { code: CANARY_APP_CODE, state: mismatch.state });

    expect(logLines.length).toBeGreaterThan(5);
    const joined = logLines.join("\n");
    const forbidden = [
      CANARY_APP_CODE,
      CANARY_REFRESH,
      CANARY_BODY,
      CANARY_HOST_STATE,
      ok.code,
      ok.state,
      ok.verifier,
      tokens.access_token,
      tokens.refresh_token,
      failed.state,
      down.state,
      mismatch.code,
      mismatch.state,
      ok.cookie.split("=")[1],
      appJwt().split(".")[1],
      SECRET,
      "code=",
      "state=",
      "?",
    ];
    for (const value of forbidden) {
      expect(joined, `log leaked ${value.slice(0, 12)}…`).not.toContain(value);
    }
    for (const line of logLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("P06 review round 1", () => {
  describe("B2: non-canonical paths never reach the provider", () => {
    async function validToken(h: Harness) {
      const clientId = await register(h);
      const { code, verifier } = await authorizeToHostCode(h, clientId, { resource: `${ORIGIN}/mcp` });
      return { clientId, ...((await (await exchange(h, clientId, code, verifier)).json()) as { access_token: string }) };
    }

    it.each([["//mcp.test/mcp/lazy"], ["//mcp.test/mcp"], ["//x/token"], ["//evil.test/authorize"], ["///mcp"]])(
      "%s ⇒ 404 before the provider (no challenge, no handler)",
      async (path) => {
        const h = createHarness();
        const { access_token } = await validToken(h);
        apiSeen.length = 0;
        const res = await h.fetch(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(404);
        // The wrapper's own 404 (not the provider's or Hono's): refused before routing.
        expect(await res.json()).toEqual({ error: "not_found" });
        expect(res.headers.get("www-authenticate")).toBeNull();
        expect(apiSeen).toEqual([]);
      },
    );

    it("/\\host/mcp (backslash, parsed like //) ⇒ 404", async () => {
      const h = createHarness();
      const res = await worker.fetch(new Request(`${ORIGIN}/\\mcp.test/mcp`, { method: "POST" }), h.env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(new URL(`${ORIGIN}/\\mcp.test/mcp`).pathname).toBe("//mcp.test/mcp");
      expect(res.status).toBe(404);
    });

    it("//x/token with a valid code does not reach the provider; the code still redeems at /token", async () => {
      const h = createHarness();
      const clientId = await register(h);
      const { code, verifier } = await authorizeToHostCode(h, clientId);
      const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: OTHER_CALLBACK });
      const res = await h.fetch("//x/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect((await exchange(h, clientId, code, verifier)).status).toBe(200);
    });

    it("the provider always sees the public origin, whatever Host the request used", async () => {
      const h = createHarness();
      const { access_token } = await validToken(h);
      apiSeen.length = 0;
      const res = await worker.fetch(
        new Request("https://other-host.test/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
          body: "{}",
        }),
        h.env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(200);
      expect(apiSeen).toHaveLength(1);
    });
  });

  describe("B1: oversized and hostile /token bodies", () => {
    it("refuses a body over 16 KB with 413 before parsing, quickly", async () => {
      const h = createHarness();
      const started = performance.now();
      const res = await h.fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=${"a".repeat(100_000)}`,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("refuses an over-limit declared Content-Length with 413 without reading the body", async () => {
      const h = createHarness();
      let pulled = 0;
      const body = new ReadableStream({
        pull(c) {
          pulled += 1;
          c.enqueue(new TextEncoder().encode("a".repeat(20_000)));
          if (pulled > 5) c.close();
        },
      });
      const res = await worker.fetch(
        new Request(`${ORIGIN}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "100000" },
          body,
          duplex: "half",
        } as RequestInit),
        h.env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(413);
      // At most the stream's initial high-water-mark pull; never read to the limit.
      expect(pulled).toBeLessThanOrEqual(1);
    });

    it("refuses a /token body without Content-Length (e.g. chunked) with 411, unread", async () => {
      const h = createHarness();
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("grant_type=authorization_code"));
          c.close();
        },
      });
      const res = await worker.fetch(
        new Request(`${ORIGIN}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          duplex: "half",
        } as RequestInit),
        h.env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(411);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    });

    it.each([
      ["word run", "a".repeat(15_000)],
      ["dotted", "a.".repeat(7_500)],
      ["colons", "aaaa:".repeat(2_000)],
    ])("an unauthenticated %s grant_type is handled quickly and logged as a closed enum", async (_l, grantType) => {
      const h = createHarness();
      const started = performance.now();
      const res = await h.fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: grantType }).toString(),
      });
      expect(res.status).toBe(401);
      expect(performance.now() - started).toBeLessThan(250);
      const trace = logLines.map((l) => JSON.parse(l)).find((e) => e.event === "oauth.trace");
      expect(trace.grantType).toBe("other");
      expect(logLines.join("\n")).not.toContain("aaaaaaaaaa");
    });

    it("logs the real grant types by name", async () => {
      const h = createHarness();
      const clientId = await register(h);
      const { code, verifier } = await authorizeToHostCode(h, clientId);
      await exchange(h, clientId, code, verifier);
      const trace = logLines.map((l) => JSON.parse(l)).filter((e) => e.event === "oauth.trace" && e.path === "/token");
      expect(trace.map((e) => e.grantType)).toEqual(["authorization_code"]);
    });
  });

  describe("N1: unusable host redirects are refused at /authorize", () => {
    it.each([["about:blank"], ["filesystem:robynn-host://x"], ["robynn-hôst://cb"], [`robynn-host://cb/${"x".repeat(4200)}`]])(
      "%s ⇒ 400 page, no state, no consent hand-off",
      async (redirect) => {
        const h = createHarness();
        const clientId = await register(h, [redirect]);
        const res = await h.fetch(authorizeQuery(clientId, { redirect_uri: redirect, code_challenge: pkce().challenge }));
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
        expect(h.kv.keys("oauth_state:")).toEqual([]);
      },
    );
  });

  describe("N3: errors are never redirected to the open web", () => {
    const WEB = "https://attacker.test/cb";

    it("/authorize error for a non-loopback https redirect ⇒ static page, no redirect", async () => {
      const h = createHarness();
      const clientId = await register(h, [WEB]);
      const res = await h.fetch(authorizeQuery(clientId, { redirect_uri: WEB, scope: "bad", code_challenge: pkce().challenge }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Error code: invalid_scope");
    });

    it("/callback error for a non-loopback https redirect ⇒ static page", async () => {
      const h = createHarness();
      const clientId = await register(h, [WEB]);
      const started = await startAuthorization(h, clientId, { redirect_uri: WEB });
      const res = await callback(h, { error: "access_denied", state: started.state }, started.cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Error code: access_denied");
    });

    it("a successful non-loopback https flow still redirects (registered redirect)", async () => {
      const h = createHarness();
      const clientId = await register(h, [WEB]);
      const started = await startAuthorization(h, clientId, { redirect_uri: WEB });
      const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")!.startsWith(`${WEB}?code=`)).toBe(true);
    });

    it("loopback and native-scheme redirects still receive errors", async () => {
      const h = createHarness();
      const clientId = await register(h, [HOST_CALLBACK, NATIVE_CALLBACK]);
      const loop = await h.fetch(authorizeQuery(clientId, { scope: "bad", code_challenge: pkce().challenge }));
      expect(new URL(loop.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
      const native = await h.fetch(
        authorizeQuery(clientId, { redirect_uri: NATIVE_CALLBACK, scope: "bad", code_challenge: pkce().challenge }),
      );
      expect(native.status).toBe(200);
      expect(await native.text()).toContain("error=invalid_scope");
    });
  });

  describe("N4: signed app calls never follow redirects", () => {
    it("sends redirect: manual on the code exchange and introspection; a 3xx is unavailable", async () => {
      const h = createHarness();
      h.plan.introspection = { status: 302, body: {} };
      const clientId = await register(h);
      const started = await startAuthorization(h, clientId);
      const res = await callback(h, { code: CANARY_APP_CODE, state: started.state }, started.cookie);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("temporarily_unavailable");
      expect(h.appCalls.map((c) => c.init.redirect)).toEqual(["manual", "manual"]);
      expect(h.kv.keys("grant:")).toEqual([]);
    });
  });

  describe("N5: wrapper /token errors carry CORS headers", () => {
    it("redirect mismatch and 413 responses echo the Origin", async () => {
      const h = createHarness();
      const clientId = await register(h);
      const { code, verifier } = await authorizeToHostCode(h, clientId);
      const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: OTHER_CALLBACK });
      const mismatch = await h.fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://host.example" },
        body: body.toString(),
      });
      expect(mismatch.status).toBe(400);
      expect(mismatch.headers.get("access-control-allow-origin")).toBe("https://host.example");
      const big = await h.fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://host.example" },
        body: "x".repeat(20_000),
      });
      expect(big.status).toBe(413);
      expect(big.headers.get("access-control-allow-origin")).toBe("https://host.example");
    });
  });
});
