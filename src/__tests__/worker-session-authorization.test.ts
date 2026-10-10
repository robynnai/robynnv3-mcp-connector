/**
 * COS-PLUGIN-001 P10 — Worker session binding, per-call reauthorization,
 * Vault gating and fail-closed refresh, end to end.
 *
 * Real: the Worker's default export (src/index.ts), the real
 * `@cloudflare/workers-oauth-provider` 0.3.0 with the Worker's options, the
 * P10 preflight, the real `RobynnMCP` class (its onStart/fetch overrides,
 * init, tool handlers, Vault gate) and the real `RefreshCoordinator`.
 *
 * Faked: `agents/mcp`'s `McpAgent` base is replaced by a small emulation of
 * the facts P01 proved against the installed agents 0.7.5 / partyserver
 * 0.3.3 (provider-contract.test.ts F15–F18): the session DO is addressed by
 * `streamable-http:{mcp-session-id}` only, each request first sends a
 * set-name request carrying the caller's props, `onStart(props)` runs once
 * per activation with the latest props, and the request itself arrives as a
 * websocket-upgrade request carrying the client's headers. Durable Object
 * namespaces, KV and R2 are in memory; the Robynn app is a fake `fetch`.
 * Synthetic identities only; no network.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));

const doEvents = vi.hoisted(
  () =>
    [] as Array<{
      session: string;
      kind: "set-name" | "start" | "upgrade" | "upgrade-refused";
      propsUserId?: unknown;
      accessToken?: unknown;
      headers?: Record<string, string>;
    }>,
);

vi.mock("agents/mcp", () => {
  const SET_NAME = "/cdn-cgi/partyserver/set-name/";

  /** Captures the server's JSON-RPC responses (stands in for the WS transport). */
  class CaptureTransport {
    onmessage?: (message: unknown, extra?: unknown) => void;
    onclose?: () => void;
    onerror?: (error: unknown) => void;
    private waiters = new Map<unknown, (message: unknown) => void>();
    async start() {}
    async close() {}
    async send(message: { id?: unknown }) {
      const waiter = this.waiters.get(message.id);
      if (waiter) {
        this.waiters.delete(message.id);
        waiter(message);
      }
    }
    request(message: { id: unknown }, extra: unknown) {
      const reply = new Promise((resolve) => this.waiters.set(message.id, resolve));
      this.onmessage?.(message, extra);
      return reply;
    }
  }

  class McpAgent {
    ctx: any;
    env: any;
    props: any;
    server: any;
    private status = "zero";
    private pendingProps: unknown;
    private transport: CaptureTransport | undefined;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    get sessionName(): string {
      return this.ctx.name;
    }

    async updateProps(props: unknown) {
      await this.ctx.storage.put("props", props ?? {});
      this.props = props;
    }

    // McpAgent.onStart (F18): persist given props, else reload; then init.
    async onStart(props?: unknown) {
      doEvents.push({ session: this.sessionName, kind: "start", propsUserId: (props as any)?.userId });
      if (props) await this.updateProps(props);
      this.props = await this.ctx.storage.get("props");
      await (this as any).init();
      this.transport = new CaptureTransport();
      await this.server.connect(this.transport);
    }

    async getInitializeRequest() {
      return this.ctx.storage.get("initializeRequest");
    }

    async setInitializeRequest(request: unknown) {
      await this.ctx.storage.put("initializeRequest", request);
    }

    async destroy() {
      await this.ctx.storage.deleteAll();
    }

    // partyserver Server.fetch (F17): the latest props win, onStart once.
    async fetch(request: Request): Promise<Response> {
      const raw = request.headers.get("x-partykit-props");
      if (raw) this.pendingProps = JSON.parse(raw);
      if (this.status !== "started") {
        await this.onStart(this.pendingProps as never);
        this.status = "started";
      }
      if (new URL(request.url).pathname === SET_NAME) {
        doEvents.push({ session: this.sessionName, kind: "set-name", propsUserId: (this.pendingProps as any)?.userId });
        return Response.json({ ok: true });
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      doEvents.push({
        session: this.sessionName,
        kind: "upgrade",
        propsUserId: this.props?.userId,
        accessToken: this.props?.accessToken,
        headers,
      });
      const messages = JSON.parse(Buffer.from(request.headers.get("cf-mcp-message")!, "base64").toString("utf8"));
      const requestInfo = { headers: { ...headers } };
      delete (requestInfo.headers as Record<string, string>)["cf-mcp-message"];
      const replies: unknown[] = [];
      for (const message of messages) {
        if (message.id === undefined) {
          this.transport!.onmessage?.(message, { requestInfo });
        } else {
          replies.push(await this.transport!.request(message, { requestInfo }));
        }
      }
      return Response.json(replies, { status: 200 });
    }

    /** agents createStreamingHttpHandler, POST and DELETE paths (F15, F16). */
    static serve(path: string) {
      return {
        async fetch(request: Request, env: any, ctx: { props?: unknown }) {
          if (new URL(request.url).pathname !== path) {
            return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Not found" }, id: null }, { status: 404 });
          }
          const namespace = env.MCP_OBJECT;
          const sessionHeader = request.headers.get("mcp-session-id");
          const getAgent = async (sessionId: string) => {
            const name = `streamable-http:${sessionId}`;
            const stub = namespace.get(namespace.idFromName(name));
            const setName = new Request(`http://dummy-example.cloudflare.com${SET_NAME}`);
            setName.headers.set("x-partykit-room", name);
            if (ctx.props) setName.headers.set("x-partykit-props", JSON.stringify(ctx.props));
            await stub.fetch(setName);
            return stub;
          };
          if (request.method === "DELETE") {
            const agent = await getAgent(sessionHeader!);
            if (!(await agent.getInitializeRequest())) return new Response(null, { status: 404 });
            await agent.destroy();
            return new Response(null, { status: 204 });
          }
          const raw = await request.json();
          const messages = Array.isArray(raw) ? raw : [raw];
          const initialize = messages.find((m: any) => m.method === "initialize");
          if (initialize && sessionHeader) return new Response(null, { status: 400 });
          if (!initialize && !sessionHeader) return new Response(null, { status: 400 });
          const sessionId = sessionHeader ?? namespace.newUniqueId().toString();
          const agent = await getAgent(sessionId);
          const initialized = await agent.getInitializeRequest();
          if (initialize) await agent.setInitializeRequest(initialize);
          else if (!initialized) {
            return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
          }
          const headers: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            headers[key] = value;
          });
          const upgrade = new Request(request.url, {
            headers: {
              ...headers,
              "cf-mcp-method": "POST",
              "cf-mcp-message": Buffer.from(JSON.stringify(messages)).toString("base64"),
              Upgrade: "websocket",
            },
          });
          const response = await agent.fetch(upgrade);
          if (response.status !== 200) {
            doEvents.push({ session: `streamable-http:${sessionId}`, kind: "upgrade-refused" });
            return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Failed to establish WebSocket connection" }, id: null }, { status: 500 });
          }
          const replies = (await response.json()) as unknown[];
          return Response.json(Array.isArray(raw) ? replies : replies[0] ?? null, {
            status: 200,
            headers: { "mcp-session-id": sessionId },
          });
        },
      };
    }
  }
  return { McpAgent };
});

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import worker, { createOAuthProviderOptions, RefreshCoordinator, RobynnMCP } from "../index";
import { PREFLIGHT_HEADER, SESSION_BINDING_HEADER, SESSION_BINDING_STORAGE_KEY } from "../authorization/session-binding";
import type { Env } from "../types";

const ORIGIN = "https://mcp.test";
const API = "https://app.test";
const CALLBACK = "http://127.0.0.1:43123/callback";
const SECRET = "p10-test-internal-secret";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP_GRANT_A = "6f0c0000-0000-4000-8000-00000000000a";
const APP_GRANT_A2 = "6f0c0000-0000-4000-8000-0000000000a2";
const APP_GRANT_B = "6f0c0000-0000-4000-8000-00000000000b";

type Scope = "brand:read" | "tools:execute";

// ---------------------------------------------------------------------------
// In-memory platform fakes
// ---------------------------------------------------------------------------

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
}

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    const value = this.data.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async deleteAll() {
    this.data.clear();
  }
}

/** DO namespace: one live instance per name; eviction keeps storage only. */
class FakeNamespace<T> {
  readonly storages = new Map<string, MemoryStorage>();
  readonly instances = new Map<string, T>();
  readonly rpcCalls: Array<{ name: string; method: string }> = [];
  private counter = 0;
  constructor(
    private readonly create: (ctx: unknown) => T,
  ) {}
  newUniqueId() {
    const value = `session-${++this.counter}`;
    return { toString: () => value };
  }
  idFromName(name: string) {
    return { name, toString: () => name };
  }
  instance(name: string): T {
    let inst = this.instances.get(name);
    if (!inst) {
      let storage = this.storages.get(name);
      if (!storage) {
        storage = new MemoryStorage();
        this.storages.set(name, storage);
      }
      inst = this.create({ name, storage, waitUntil() {} });
      this.instances.set(name, inst);
    }
    return inst;
  }
  get(id: { name: string }) {
    return new Proxy(
      {},
      {
        // Not a thenable: `await stub` must not call into the DO.
        get: (_target, method: string) => method === "then" ? undefined : (...args: unknown[]) => {
          this.rpcCalls.push({ name: id.name, method });
          const inst = this.instance(id.name) as Record<string, (...a: unknown[]) => unknown>;
          return inst[method](...args);
        },
      },
    );
  }
  evict(name: string) {
    this.instances.delete(name);
  }
}

function fakeBucket(objects: Record<string, string>) {
  const calls: string[] = [];
  const bucket = {
    async list(opts: { prefix?: string }) {
      calls.push(`list:${opts.prefix}`);
      const objectsList = Object.keys(objects)
        .filter((key) => key.startsWith(opts.prefix ?? ""))
        .map((key) => ({ key, size: objects[key].length, uploaded: new Date(0), etag: '"e"' }));
      return { objects: objectsList, truncated: false };
    },
    async get(key: string) {
      calls.push(`get:${key}`);
      if (!(key in objects)) return null;
      return {
        size: objects[key].length,
        uploaded: new Date(0),
        etag: '"e"',
        httpMetadata: { contentType: "text/markdown" },
        body: { cancel: async () => undefined },
        text: async () => objects[key],
      };
    },
  };
  return { bucket, calls };
}

// ---------------------------------------------------------------------------
// Fake Robynn app
// ---------------------------------------------------------------------------

interface AppGrant {
  userId: string;
  organizationId: string;
  scopes: Scope[];
  credentialVersion: number;
  status: "active" | "revoked" | "membership_removed";
}

function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

let jwtCounter = 0;
function appJwt(grantId: string, grant: AppGrant, scopes = grant.scopes) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    iss: "robynn.ai",
    aud: "robynn-api:mcp",
    type: "access",
    sub: grant.userId,
    org: grant.organizationId,
    gid: grantId,
    ver: grant.credentialVersion,
    cid: "robynn-mcp-worker",
    scope: scopes.join(" "),
    iat: now,
    exp: now + 3600 + ++jwtCounter, // strictly increasing: fresher tokens sort later
    jti: `jti-${jwtCounter}`,
  })}.c2ln`;
}

interface App {
  grants: Map<string, AppGrant>;
  refreshTokens: Map<string, string>; // upstream refresh token -> app grant id
  introspection: "normal" | "unavailable";
  refreshPlan: "normal" | { status: number; body: unknown };
  calls: Array<{ path: string; body?: Record<string, unknown>; authorization?: string | null }>;
  refreshDelayMs: number;
}

function createApp(): App {
  return {
    grants: new Map(),
    refreshTokens: new Map(),
    introspection: "normal",
    refreshPlan: "normal",
    calls: [],
    refreshDelayMs: 0,
  };
}

function installAppFetch(app: App) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
      app.calls.push({ path: url.pathname, body, authorization: headers.get("authorization") });
      if (url.origin !== API) throw new Error(`unexpected outbound fetch: ${url.origin}`);

      if (url.pathname === "/api/oauth/introspect") {
        expect(headers.get("x-robynn-mcp-signature")).toMatch(/^v2\./);
        if (app.introspection === "unavailable") return new Response("{}", { status: 503 });
        const grant = app.grants.get(body.grant_id);
        if (!grant) return Response.json({ active: false, reason: "grant_not_found" });
        if (grant.userId !== body.user_id || grant.organizationId !== body.organization_id) {
          return Response.json({ active: false, reason: "identity_mismatch" });
        }
        if (grant.status === "revoked") return Response.json({ active: false, reason: "grant_revoked" });
        if (grant.status === "membership_removed") return Response.json({ active: false, reason: "membership_inactive" });
        if (grant.credentialVersion !== body.credential_version) {
          return Response.json({ active: false, reason: "credential_version_stale" });
        }
        return Response.json({
          active: true,
          grant_id: body.grant_id,
          user_id: grant.userId,
          organization_id: grant.organizationId,
          client_id: "robynn-mcp-worker",
          scopes: grant.scopes,
          role: "collaborator",
          membership_status: "active",
          credential_version: grant.credentialVersion,
        });
      }

      if (url.pathname === "/api/oauth/token") {
        expect(headers.get("x-robynn-mcp-signature")).toMatch(/^v2\./);
        if (app.refreshDelayMs) await new Promise((r) => setTimeout(r, app.refreshDelayMs));
        if (app.refreshPlan !== "normal") {
          return Response.json(app.refreshPlan.body, { status: app.refreshPlan.status });
        }
        const grantId = app.refreshTokens.get(body.refresh_token);
        const grant = grantId ? app.grants.get(grantId) : undefined;
        if (!grantId || !grant || grant.status !== "active") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        app.refreshTokens.delete(body.refresh_token);
        const next = `rrt_${randomBytes(8).toString("hex")}`;
        app.refreshTokens.set(next, grantId);
        return Response.json({ access_token: appJwt(grantId, grant), refresh_token: next, expires_in: 3600 });
      }

      if (url.pathname === "/api/cli/context/summary") {
        return Response.json({ success: true, data: { name: "Synthetic Org" } });
      }
      if (url.pathname === "/api/cli/mcp/memory" || url.pathname.startsWith("/api/cli/")) {
        return Response.json({ success: true, data: {} });
      }
      throw new Error(`unexpected app path in test: ${url.pathname}`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  env: Env;
  kv: MemoryKV;
  app: App;
  sessions: FakeNamespace<RobynnMCP>;
  coordinators: FakeNamespace<RefreshCoordinator>;
  vaultCalls: string[];
  clientId: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const executionContext = () =>
  ({ waitUntil() {}, passThroughOnException() {}, props: undefined }) as unknown as ExecutionContext;

function withWireLength(init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  if (!headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(init.body)));
  return { ...init, headers };
}

async function createHarness(): Promise<Harness> {
  const kv = new MemoryKV();
  const app = createApp();
  const { bucket, calls: vaultCalls } = fakeBucket({
    [`orgs/${ORG_A}/brand/voice/direct.md`]: "Org A voice",
    [`orgs/${ORG_B}/brand/voice/direct.md`]: "Org B voice",
  });
  const env = {
    OAUTH_KV: kv,
    OAUTH_KEY: kv,
    ROBYNN_API_BASE_URL: API,
    MCP_PUBLIC_BASE_URL: ORIGIN,
    MCP_INTERNAL_AUTH_SECRET: SECRET,
    MCP_SERVER_NAME: "Robynn",
    MCP_SERVER_VERSION: "test",
    VAULT: bucket,
  } as unknown as Env;
  const sessions = new FakeNamespace<RobynnMCP>((ctx) => new RobynnMCP(ctx as never, env as never));
  const coordinators = new FakeNamespace<RefreshCoordinator>((ctx) => new RefreshCoordinator(ctx as never, env as never));
  (env as unknown as Record<string, unknown>).MCP_OBJECT = sessions;
  (env as unknown as Record<string, unknown>).REFRESH_COORDINATOR = coordinators;
  installAppFetch(app);

  const fetchWorker = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, withWireLength(init)), env, executionContext());

  const reg = await fetchWorker("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Test Host", token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  return { env, kv, app, sessions, coordinators, vaultCalls, clientId, fetch: fetchWorker };
}

interface Connection {
  access: string;
  refresh: string;
  hostGrantId: string;
  userId: string;
  appGrantId: string;
}

/**
 * A completed connection as P06's /callback would create it: the app grant
 * exists, and the provider grant carries v2 props. Then the host exchanges
 * its code at the Worker's real /token.
 */
async function connect(
  h: Harness,
  opts: { userId: string; organizationId: string; appGrantId: string; scopes: Scope[]; legacy?: boolean },
): Promise<Connection> {
  const grant: AppGrant = {
    userId: opts.userId,
    organizationId: opts.organizationId,
    scopes: opts.scopes,
    credentialVersion: 1,
    status: "active",
  };
  h.app.grants.set(opts.appGrantId, grant);
  const upstreamRefresh = `rrt_${randomBytes(8).toString("hex")}`;
  h.app.refreshTokens.set(upstreamRefresh, opts.appGrantId);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const helpers = getOAuthApi(createOAuthProviderOptions(h.env), h.env);
  const authRequest = await helpers.parseAuthRequest(
    new Request(
      `${ORIGIN}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: h.clientId,
        redirect_uri: CALLBACK,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: opts.scopes.join(" "),
      })}`,
    ),
  );
  const props = opts.legacy
    ? { accessToken: appJwt(opts.appGrantId, grant), refreshToken: upstreamRefresh, userId: opts.userId, organizationId: opts.organizationId, authorizeRedirectUri: CALLBACK }
    : {
        accessToken: appJwt(opts.appGrantId, grant),
        refreshToken: upstreamRefresh,
        userId: opts.userId,
        organizationId: opts.organizationId,
        appGrantId: opts.appGrantId,
        credentialVersion: 1,
        scopes: opts.scopes,
        authVersion: 2,
        authorizeRedirectUri: CALLBACK,
      };
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: opts.userId,
    metadata: { organizationId: opts.organizationId, appGrantId: opts.appGrantId, authVersion: 2 },
    scope: opts.scopes,
    props,
  });
  const code = new URL(redirectTo).searchParams.get("code")!;
  const res = await h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: h.clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    }).toString(),
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    hostGrantId: tokens.access_token.split(":")[1],
    userId: opts.userId,
    appGrantId: opts.appGrantId,
  };
}

const MCP_HEADERS = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
let rpcId = 100;

async function mcp(h: Harness, access: string, message: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await h.fetch("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}`, ...extraHeaders },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { res, status: res.status, json: text ? JSON.parse(text) : null };
}

async function initialize(h: Harness, access: string) {
  const out = await mcp(h, access, {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  expect(out.status).toBe(200);
  const sessionId = out.res.headers.get("mcp-session-id")!;
  expect(sessionId).toBeTruthy();
  return { sessionId, result: out.json };
}

function callTool(h: Harness, access: string, sessionId: string, name: string, args: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  return mcp(
    h,
    access,
    { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
    { "mcp-session-id": sessionId, ...extraHeaders },
  );
}

const sessionName = (sessionId: string) => `streamable-http:${sessionId}`;
const businessCalls = (h: Harness) => h.app.calls.filter((c) => !c.path.startsWith("/api/oauth/"));
const introspections = (h: Harness) => h.app.calls.filter((c) => c.path === "/api/oauth/introspect");

async function refreshHost(h: Harness, refreshToken: string, scope?: string) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: h.clientId });
  if (scope) body.set("scope", scope);
  return h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

beforeEach(() => {
  doEvents.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session binding (D7; F15–F17 attack)", () => {
  it("binds a session to its initialize caller and serves that caller's tools with its own credentials", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId, result } = await initialize(h, a.access);
    expect(result.result.instructions).toMatch(/one organization chosen when this connection was made/);

    const binding = h.sessions.storages.get(sessionName(sessionId))!.data.get(SESSION_BINDING_STORAGE_KEY);
    expect(binding).toEqual({ hostGrantId: a.hostGrantId, userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A });

    const status = await callTool(h, a.access, sessionId, "robynn_status");
    expect(status.status).toBe(200);
    expect(status.json.result.isError).toBeFalsy();
    const summary = businessCalls(h).find((c) => c.path === "/api/cli/context/summary")!;
    expect(summary.authorization).toMatch(/^Bearer ey/);
    const claims = JSON.parse(Buffer.from(summary.authorization!.split(".")[1], "base64url").toString());
    expect(claims.sub).toBe(USER_A);
    expect(introspections(h)).toHaveLength(1);
    expect(introspections(h)[0].body).toMatchObject({
      grant_id: APP_GRANT_A,
      user_id: USER_A,
      organization_id: ORG_A,
      client_id: "robynn-mcp-worker",
      credential_version: 1,
      host_grant_id: a.hostGrantId,
      operation: { tool: "robynn_status", required_scope: "brand:read" },
    });
  });

  it("refuses another user's valid token on an existing session id (404) before the session sees its props", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read", "tools:execute"] });
    const b = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read", "tools:execute"] });
    const { sessionId } = await initialize(h, a.access);
    doEvents.length = 0;
    h.app.calls.length = 0;

    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "robynn_vault_read", arguments: { path: "brand/voice/direct.md" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "robynn_status", arguments: {} } },
    ]) {
      const out = await mcp(h, b.access, message, { "mcp-session-id": sessionId });
      expect(out.status).toBe(404);
      expect(out.json.error).toEqual({ code: -32001, message: "Session not found" });
    }
    const del = await h.fetch("/mcp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${b.access}`, "mcp-session-id": sessionId },
    });
    expect(del.status).toBe(404);

    // The victim's session was only read (RPC), never handed B's props.
    expect(doEvents.filter((e) => e.kind !== "start")).toEqual([]);
    expect(h.app.calls).toEqual([]);
    expect(h.vaultCalls).toEqual([]);
    // ...and A's session still works.
    const ok = await callTool(h, a.access, sessionId, "robynn_status");
    expect(ok.json.result.isError).toBeFalsy();
  });

  it("after eviction the binding still comes from DO storage: B is refused, A's cold start adopts A's props", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const b = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.sessions.evict(sessionName(sessionId));
    doEvents.length = 0;

    const refused = await callTool(h, b.access, sessionId, "robynn_status");
    expect(refused.status).toBe(404);
    expect(doEvents).toEqual([]);

    const ok = await callTool(h, a.access, sessionId, "robynn_status");
    expect(ok.status).toBe(200);
    const upgrade = doEvents.find((e) => e.kind === "upgrade")!;
    expect(upgrade.propsUserId).toBe(USER_A);
  });

  it("defense in depth: a session DO never adopts mismatching props on cold start and refuses a foreign upgrade", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    const name = sessionName(sessionId);
    h.sessions.evict(name);

    // Simulate a request that bypassed the Worker preflight.
    const intruderProps = {
      accessToken: "intruder",
      userId: USER_B,
      organizationId: ORG_B,
      appGrantId: APP_GRANT_B,
      hostGrantId: "intruder-grant",
      authVersion: 2,
      credentialVersion: 1,
    };
    const stub = h.sessions.get(h.sessions.idFromName(name)) as unknown as RobynnMCP;
    const setName = new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/", {
      headers: { "x-partykit-room": name, "x-partykit-props": JSON.stringify(intruderProps) },
    });
    await stub.fetch(setName);
    const storage = h.sessions.storages.get(name)!;
    expect((storage.data.get("props") as { userId: string }).userId).toBe(USER_A);
    expect(storage.data.get(SESSION_BINDING_STORAGE_KEY)).toMatchObject({ userId: USER_A, hostGrantId: a.hostGrantId });

    const upgrade = await stub.fetch(
      new Request(`${ORIGIN}/mcp`, {
        headers: {
          Upgrade: "websocket",
          [SESSION_BINDING_HEADER]: JSON.stringify(intruderProps),
          "cf-mcp-message": Buffer.from("[]").toString("base64"),
        },
      }),
    );
    expect(upgrade.status).toBe(404);
    const noHeader = await stub.fetch(
      new Request(`${ORIGIN}/mcp`, { headers: { Upgrade: "websocket", "cf-mcp-message": Buffer.from("[]").toString("base64") } }),
    );
    expect(noHeader.status).toBe(404);
  });

  it("reconnect: a new grant cannot reuse the old session id, and re-initializing works", async () => {
    const h = await createHarness();
    const first = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, first.access);

    // Same user and client: completeAuthorization revokes the earlier grant (F14).
    const second = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A2, scopes: ["brand:read"] });
    expect((await callTool(h, first.access, sessionId, "robynn_status")).status).toBe(401);
    expect((await callTool(h, second.access, sessionId, "robynn_status")).status).toBe(404);

    const fresh = await initialize(h, second.access);
    expect(fresh.sessionId).not.toBe(sessionId);
    const ok = await callTool(h, second.access, fresh.sessionId, "robynn_status");
    expect(ok.json.result.isError).toBeFalsy();
  });

  it("strips client-supplied x-robynn-*, x-partykit-* and cf-mcp-* headers before the session", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    doEvents.length = 0;
    await callTool(h, a.access, sessionId, "robynn_status", {}, {
      "x-partykit-props": JSON.stringify({ userId: USER_B }),
      "x-robynn-session-binding": JSON.stringify({ userId: USER_B }),
      "x-robynn-extra": "1",
      "cf-mcp-message": "forged",
    });
    const upgrade = doEvents.find((e) => e.kind === "upgrade")!;
    expect(upgrade.headers!["x-partykit-props"]).toBeUndefined();
    expect(upgrade.headers!["x-robynn-extra"]).toBeUndefined();
    expect(JSON.parse(upgrade.headers![SESSION_BINDING_HEADER]).userId).toBe(USER_A);
    expect(upgrade.propsUserId).toBe(USER_A);
  });

  it("legacy grants (no authVersion 2) are revoked and never reach a session", async () => {
    const h = await createHarness();
    const legacy = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"], legacy: true });
    const out = await mcp(h, legacy.access, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(out.status).toBe(401);
    expect(out.res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(h.sessions.instances.size).toBe(0);
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:`))).toBe(false);
  });
});

describe("per-call reauthorization (contract §6.4 step 5)", () => {
  it("revocation mid-session: the next tools/call gets 401, the provider grant is revoked and nothing runs", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read", "tools:execute"] });
    const { sessionId } = await initialize(h, a.access);
    expect((await callTool(h, a.access, sessionId, "robynn_status")).json.result.isError).toBeFalsy();

    h.app.grants.get(APP_GRANT_A)!.status = "revoked";
    h.app.calls.length = 0;
    doEvents.length = 0;
    const denied = await callTool(h, a.access, sessionId, "robynn_status");
    expect(denied.status).toBe(401);
    expect(denied.res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(businessCalls(h)).toEqual([]);
    expect(doEvents.filter((e) => e.kind === "upgrade")).toEqual([]);
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:${a.hostGrantId}`))).toBe(false);

    // The host token is dead at the provider now, even for tools/list.
    const list = await mcp(h, a.access, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { "mcp-session-id": sessionId });
    expect(list.status).toBe(401);
    // ...and refresh cannot resurrect it.
    expect((await refreshHost(h, a.refresh)).status).toBe(400);
  });

  it("removed membership is treated like revocation", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.grants.get(APP_GRANT_A)!.status = "membership_removed";
    const denied = await callTool(h, a.access, sessionId, "robynn_status");
    expect(denied.status).toBe(401);
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:`))).toBe(false);
  });

  it("a stale credential version gets 401 without revoking the grant, so the host's refresh renews it", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.grants.get(APP_GRANT_A)!.credentialVersion = 2;

    const denied = await callTool(h, a.access, sessionId, "robynn_status");
    expect(denied.status).toBe(401);
    expect(businessCalls(h)).toEqual([]);
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:${a.hostGrantId}`))).toBe(true);

    const refreshed = await refreshHost(h, a.refresh);
    expect(refreshed.status).toBe(200);
    const { access_token: access2 } = (await refreshed.json()) as { access_token: string };
    const ok = await callTool(h, access2, sessionId, "robynn_status");
    expect(ok.status).toBe(200);
    expect(ok.json.result.isError).toBeFalsy();
    expect(introspections(h).at(-1)!.body!.credential_version).toBe(2);
  });

  it("introspection unavailable fails closed with a retryable tool error and forwards nothing", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.introspection = "unavailable";
    doEvents.length = 0;
    const out = await callTool(h, a.access, sessionId, "robynn_status");
    expect(out.status).toBe(200);
    expect(out.json.result.isError).toBe(true);
    expect(out.json.result.structuredContent.error).toMatchObject({ code: "authorization_unavailable", retryable: true });
    expect(businessCalls(h)).toEqual([]);
    expect(doEvents.filter((e) => e.kind === "upgrade")).toEqual([]);
    // Not revoked: a transient outage must not end the connection.
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:${a.hostGrantId}`))).toBe(true);
  });

  it("a read-only grant is denied every tools:execute tool before the app is called; brand:read tools still run", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.calls.length = 0;

    for (const [name, args] of [
      ["robynn_memory_write", { scope: "user", key: "k", content: "v" }],
      ["robynn_query_connected_app", { app: "hubspot", question: "q" }],
      ["robynn_conversations", { action: "create", title: "t" }],
      ["robynn_website_audit", { url: "https://example.com" }],
    ] as const) {
      const out = await callTool(h, a.access, sessionId, name, args);
      expect(out.json.result.isError).toBe(true);
      expect(out.json.result.structuredContent.error).toMatchObject({ code: "insufficient_scope", required_scope: "tools:execute" });
    }
    expect(businessCalls(h)).toEqual([]);

    const list = await callTool(h, a.access, sessionId, "robynn_conversations", { action: "list" });
    expect(list.json.result.structuredContent?.error).toBeUndefined();
  });

  it("argument and catalog policy: session-scoped memory and unknown tools are refused", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read", "tools:execute"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.calls.length = 0;
    const session = await callTool(h, a.access, sessionId, "robynn_memory_get", { scope: "session", key: "k" });
    expect(session.json.result.structuredContent.error.code).toBe("unsupported_memory_scope");
    const unknown = await callTool(h, a.access, sessionId, "robynn_admin_everything");
    expect(unknown.json.result.structuredContent.error.code).toBe("tool_not_permitted");
    expect(businessCalls(h)).toEqual([]);
  });

  it("intersects host-token, grant and current app scopes: a narrower role or a downscoped host token denies execute", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read", "tools:execute"] });
    const { sessionId } = await initialize(h, a.access);

    // App now reports a narrower effective set (e.g. role change).
    h.app.grants.get(APP_GRANT_A)!.scopes = ["brand:read"];
    const narrowed = await callTool(h, a.access, sessionId, "robynn_memory_write", { scope: "user", key: "k", content: "v" });
    expect(narrowed.json.result.structuredContent.error.code).toBe("insufficient_scope");

    // Host token downscoped at refresh while the grant still has both.
    h.app.grants.get(APP_GRANT_A)!.scopes = ["brand:read", "tools:execute"];
    const refreshed = await refreshHost(h, a.refresh, "brand:read");
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe("brand:read");
    const down = await callTool(h, body.access_token, sessionId, "robynn_memory_write", { scope: "user", key: "k", content: "v" });
    expect(down.json.result.structuredContent.error.code).toBe("insufficient_scope");
  });

  it("a batch with any denied tools/call forwards nothing", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.calls.length = 0;
    doEvents.length = 0;
    const out = await mcp(
      h,
      a.access,
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "robynn_status", arguments: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "robynn_memory_write", arguments: { scope: "user", key: "k", content: "v" } } },
        { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      ],
      { "mcp-session-id": sessionId },
    );
    expect(out.status).toBe(200);
    expect(out.json).toHaveLength(2);
    expect(out.json[0].error.code).toBe(-32000);
    expect(out.json[1].result.structuredContent.error.code).toBe("insufficient_scope");
    expect(businessCalls(h)).toEqual([]);
    expect(doEvents.filter((e) => e.kind === "upgrade")).toEqual([]);
  });

  it("tools/list and initialize need no introspection", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    const list = await mcp(h, a.access, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, { "mcp-session-id": sessionId });
    expect(list.status).toBe(200);
    expect(list.json.result.tools).toHaveLength(48);
    expect(h.app.calls).toEqual([]);
  });
});

describe("Vault (plan §5: no R2 access without current authorization)", () => {
  it("reads the bound org's vault after a successful preflight", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    const out = await callTool(h, a.access, sessionId, "robynn_vault_read", { path: "brand/voice/direct.md" });
    expect(out.json.result.isError).toBeFalsy();
    expect(out.json.result.structuredContent.text).toBe("Org A voice");
    expect(h.vaultCalls).toEqual([`get:orgs/${ORG_A}/brand/voice/direct.md`]);
  });

  it("never touches R2 after revocation", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.grants.get(APP_GRANT_A)!.status = "revoked";
    for (const [name, args] of [
      ["robynn_vault_read", { path: "brand/voice/direct.md" }],
      ["robynn_vault_list", { prefix: "brand/" }],
    ] as const) {
      const out = await callTool(h, a.access, sessionId, name, args);
      expect(out.status).toBe(401);
    }
    expect(h.vaultCalls).toEqual([]);
  });

  it("never touches R2 when authorization is unavailable, even with a forged preflight header", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.introspection = "unavailable";
    const out = await callTool(h, a.access, sessionId, "robynn_vault_read", { path: "brand/voice/direct.md" }, {
      [PREFLIGHT_HEADER]: JSON.stringify({ appGrantId: APP_GRANT_A, tools: ["robynn_vault_read"] }),
    });
    expect(out.json.result.structuredContent.error.code).toBe("authorization_unavailable");
    expect(h.vaultCalls).toEqual([]);
  });
});

describe("Vault gate inside the session (defense in depth behind the preflight)", () => {
  it("a correctly bound request that skipped the preflight stamp never reaches R2", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    const name = sessionName(sessionId);
    const stub = h.sessions.get(h.sessions.idFromName(name)) as unknown as RobynnMCP;
    const binding = JSON.stringify({ hostGrantId: a.hostGrantId, userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A });
    const call = (stamp?: unknown) =>
      stub.fetch(
        new Request(`${ORIGIN}/mcp`, {
          headers: {
            Upgrade: "websocket",
            [SESSION_BINDING_HEADER]: binding,
            ...(stamp ? { [PREFLIGHT_HEADER]: JSON.stringify(stamp) } : {}),
            "cf-mcp-message": Buffer.from(
              JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "robynn_vault_read", arguments: { path: "brand/voice/direct.md" } } }]),
            ).toString("base64"),
          },
        }),
      );

    for (const stamp of [undefined, { appGrantId: APP_GRANT_B, tools: ["robynn_vault_read"] }, { appGrantId: APP_GRANT_A, tools: ["robynn_status"] }]) {
      const res = await call(stamp);
      expect(res.status).toBe(200);
      const [reply] = (await res.json()) as Array<{ result: { isError: boolean; structuredContent: { error: { code: string } } } }>;
      expect(reply.result.isError).toBe(true);
      expect(reply.result.structuredContent.error.code).toBe("authorization_unavailable");
    }
    expect(h.vaultCalls).toEqual([]);

    // With the stamp the preflight would have set, the same call reads R2.
    const ok = await call({ appGrantId: APP_GRANT_A, tools: ["robynn_vault_read"] });
    const [reply] = (await ok.json()) as Array<{ result: { isError?: boolean } }>;
    expect(reply.result.isError).toBeFalsy();
    expect(h.vaultCalls).toEqual([`get:orgs/${ORG_A}/brand/voice/direct.md`]);
  });
});

describe("refresh (contract §6.3; F12, F13)", () => {
  it("success: the host gets a new token and the warm session adopts the newer upstream token", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    await callTool(h, a.access, sessionId, "robynn_status");
    const before = businessCalls(h).at(-1)!.authorization;

    const refreshed = await refreshHost(h, a.refresh);
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(body.expires_in).toBeLessThanOrEqual(3540);
    await callTool(h, body.access_token, sessionId, "robynn_status");
    const after = businessCalls(h).at(-1)!.authorization;
    expect(after).not.toBe(before);

    // An older host access token (still valid, F13) cannot roll the session back.
    await callTool(h, a.access, sessionId, "robynn_status");
    expect(businessCalls(h).at(-1)!.authorization).toBe(after);
  });

  it("a permanent upstream failure revokes the provider grant: invalid_grant, and the old access token stops working", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    h.app.refreshPlan = { status: 400, body: { error: "invalid_grant" } };
    const res = await refreshHost(h, a.refresh);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await callTool(h, a.access, sessionId, "robynn_status")).status).toBe(401);
  });

  it("a transient upstream failure is 503 and leaves the grant un-rotated (the same refresh token works later)", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    for (const plan of [{ status: 503, body: {} }, { status: 429, body: {} }, { status: 401, body: { error: "invalid_client" } }]) {
      h.app.refreshPlan = plan;
      const res = await refreshHost(h, a.refresh);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
    }
    h.app.refreshPlan = "normal";
    expect((await refreshHost(h, a.refresh)).status).toBe(200);
  });

  it("an inactive grant at refresh-time introspection revokes; a legacy grant is revoked on refresh", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    // The app rotates, but refresh-time introspection says inactive.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const impl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/oauth/introspect")) return Response.json({ active: false, reason: "membership_inactive" });
      return impl(input, init);
    });
    expect((await refreshHost(h, a.refresh)).status).toBe(400);
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_A}:${a.hostGrantId}`))).toBe(false);
    fetchMock.mockImplementation(impl);

    const legacy = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"], legacy: true });
    const before = h.app.calls.length;
    expect((await refreshHost(h, legacy.refresh)).status).toBe(400);
    expect(h.app.calls.length).toBe(before); // never asked the app
    expect([...h.kv.store.keys()].some((k) => k.startsWith(`grant:${USER_B}:${legacy.hostGrantId}`))).toBe(false);
  });

  it("concurrent refreshes of one grant run through its coordinator: one upstream refresh, no reuse revocation", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    h.app.refreshDelayMs = 20;
    const results = await Promise.all([refreshHost(h, a.refresh), refreshHost(h, a.refresh), refreshHost(h, a.refresh)]);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ access_token: string }>));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(bodies.map((b) => b.access_token)).size).toBe(1);
    expect(h.app.calls.filter((c) => c.path === "/api/oauth/token")).toHaveLength(1);
    expect([...h.coordinators.instances.keys()]).toEqual([`refresh:${a.hostGrantId}`]);
  });
});
