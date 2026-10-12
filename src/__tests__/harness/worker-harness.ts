/**
 * In-process Worker integration harness (COS-PLUGIN-001). Extracted from P10's
 * worker-session-authorization.test.ts so P16's suites drive the same fakes.
 *
 * Real: the Worker's default export (src/index.ts), the real
 * `@cloudflare/workers-oauth-provider` 0.3.0 with the Worker's options, the
 * P06 front door (/authorize, /callback), the P10 preflight, `RobynnMCP` and
 * `RefreshCoordinator`.
 *
 * Faked: Durable Object namespaces, KV and R2 are in memory; the Robynn app is
 * a stubbed global `fetch` with P05/P10 semantics (signed exchange and
 * refresh, introspection). A test file using this harness must also replace
 * the runtime modules:
 *
 *   vi.mock("cloudflare:workers", () => import("./harness/cloudflare-workers-stub"));
 *   vi.mock("agents/mcp", () => import("./harness/agents-mcp-emulation"));
 *
 * Synthetic identities only; no network.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import worker, { createOAuthProviderOptions, RefreshCoordinator, RobynnMCP } from "../../index";
import type { Env } from "../../types";

export const ORIGIN = "https://mcp.test";
export const API = "https://app.test";
/** The host's (e.g. Claude Code's) loopback callback, registered via DCR. */
export const CALLBACK = "http://127.0.0.1:43123/callback";
export const SECRET = "p10-test-internal-secret";

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";
export const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const APP_GRANT_A = "6f0c0000-0000-4000-8000-00000000000a";
export const APP_GRANT_A2 = "6f0c0000-0000-4000-8000-0000000000a2";
export const APP_GRANT_B = "6f0c0000-0000-4000-8000-00000000000b";

export type Scope = "brand:read" | "tools:execute";

// ---------------------------------------------------------------------------
// In-memory platform fakes
// ---------------------------------------------------------------------------

export class MemoryKV {
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

export class MemoryStorage {
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
export class FakeNamespace<T> {
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

export function fakeBucket(objects: Record<string, string>) {
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

export interface AppGrant {
  userId: string;
  organizationId: string;
  scopes: Scope[];
  credentialVersion: number;
  status: "active" | "revoked" | "membership_removed";
}

export function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

let jwtCounter = 0;
export function appJwt(grantId: string, grant: AppGrant, scopes = grant.scopes) {
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

/** An app authorization code as the consent action stores it (P05). */
export interface AppCode {
  grantId: string;
  redirectUri: string;
  used: boolean;
}

export interface App {
  grants: Map<string, AppGrant>;
  /** Authorization codes issued by {@link consentAtApp}. */
  codes: Map<string, AppCode>;
  refreshTokens: Map<string, string>; // upstream refresh token -> app grant id
  introspection: "normal" | "unavailable";
  refreshPlan: "normal" | { status: number; body: unknown };
  calls: Array<{ path: string; body?: Record<string, unknown>; authorization?: string | null }>;
  refreshDelayMs: number;
}

export function createApp(): App {
  return {
    grants: new Map(),
    codes: new Map(),
    refreshTokens: new Map(),
    introspection: "normal",
    refreshPlan: "normal",
    calls: [],
    refreshDelayMs: 0,
  };
}

export function installAppFetch(app: App) {
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
          organization: { id: grant.organizationId, name: "Harness Org ✓" },
          role: "collaborator",
          membership_status: "active",
          credential_version: grant.credentialVersion,
        });
      }

      if (url.pathname === "/api/oauth/token" && body?.grant_type === "authorization_code") {
        // P05 exchange semantics: Worker client and callback only, single use;
        // a replayed code revokes its grant.
        expect(headers.get("x-robynn-mcp-signature")).toMatch(/^v2\./);
        const code = app.codes.get(body.code);
        if (!code || body.client_id !== "robynn-mcp-worker" || body.redirect_uri !== code.redirectUri) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const grant = app.grants.get(code.grantId)!;
        if (code.used) {
          grant.status = "revoked";
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        code.used = true;
        if (grant.status !== "active") return Response.json({ error: "invalid_grant" }, { status: 400 });
        const refresh = `rrt_${randomBytes(8).toString("hex")}`;
        app.refreshTokens.set(refresh, code.grantId);
        return Response.json({ access_token: appJwt(code.grantId, grant), refresh_token: refresh, expires_in: 3600 });
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
      if (url.pathname.startsWith("/api/cli/mcp/discoverability/")) {
        // COS-PLUGIN-002 WP2-06: a valid bare "nothing stored" answer.
        return Response.json(discoverabilityNothingStored(url.pathname, body?.website_id));
      }
      if (url.pathname === "/api/cli/mcp/memory" || url.pathname.startsWith("/api/cli/")) {
        return Response.json({ success: true, data: {} });
      }
      throw new Error(`unexpected app path in test: ${url.pathname}`);
    }),
  );
}


const UNAVAILABLE = { generated_at: null, as_of: null, status: "unavailable", reason: "projection_missing" };
const EMPTY_INTERVAL = {
  estimate: null,
  lower90: null,
  upper90: null,
  unit: "fraction",
  method: "unavailable:projection_missing",
  evidence_label: "descriptive",
  expected_n: 0,
  observed_n: 0,
  clusters: 0,
};

/** Bare success objects of the three discoverability read routes with nothing stored. */
export function discoverabilityNothingStored(pathname: string, websiteId: unknown) {
  const website_id = typeof websiteId === "string" ? websiteId : "00000000-0000-4000-8000-000000000000";
  if (pathname.endsWith("/site-health")) {
    return {
      website_id,
      issues: [],
      seo: { ...EMPTY_INTERVAL, unit: "percent" },
      geo: { ...EMPTY_INTERVAL, unit: "percentage_points" },
      crawl: {
        treated_pages: 0,
        delivered_pages: 0,
        parity_pass_pages: 0,
        recrawled_pages: 0,
        exposure_eligible_pages: 0,
        status: "unknown",
        last_checked_at: null,
      },
      freshness: UNAVAILABLE,
    };
  }
  if (pathname.endsWith("/ai-visibility-trend")) {
    return { website_id, panel_id: null, series: [], provider_snapshots: [], freshness: UNAVAILABLE };
  }
  return { website_id, items: [], next_cursor: null, freshness: UNAVAILABLE };
}

/**
 * The app's consent action for a signed-in member (P04/P05): creates the
 * grant and a single-use code bound to the Worker's callback. Returns the
 * code the browser carries back to the Worker's /callback.
 */
export function consentAtApp(
  app: App,
  opts: { userId: string; organizationId: string; scopes: Scope[]; appGrantId?: string; redirectUri?: string },
): { code: string; appGrantId: string } {
  const appGrantId = opts.appGrantId ?? randomUUID();
  app.grants.set(appGrantId, {
    userId: opts.userId,
    organizationId: opts.organizationId,
    scopes: opts.scopes,
    credentialVersion: 1,
    status: "active",
  });
  const code = `${randomUUID()}-${randomBytes(16).toString("hex")}`;
  app.codes.set(code, { grantId: appGrantId, redirectUri: opts.redirectUri ?? `${ORIGIN}/callback`, used: false });
  return { code, appGrantId };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Harness {
  env: Env;
  kv: MemoryKV;
  app: App;
  sessions: FakeNamespace<RobynnMCP>;
  coordinators: FakeNamespace<RefreshCoordinator>;
  vaultCalls: string[];
  clientId: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export const executionContext = () =>
  ({ waitUntil() {}, passThroughOnException() {}, props: undefined }) as unknown as ExecutionContext;

export function withWireLength(init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  if (!headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(init.body)));
  return { ...init, headers };
}

export async function createHarness(
  options: { vaultObjects?: Record<string, string> } = {},
): Promise<Harness> {
  const kv = new MemoryKV();
  const app = createApp();
  const { bucket, calls: vaultCalls } = fakeBucket(
    options.vaultObjects ?? {
      [`orgs/${ORG_A}/brand/voice/direct.md`]: "Org A voice",
      [`orgs/${ORG_B}/brand/voice/direct.md`]: "Org B voice",
    },
  );
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

export interface Connection {
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
export async function connect(
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

export const MCP_HEADERS = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
let rpcId = 100;

export async function mcp(h: Harness, access: string, message: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await h.fetch("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}`, ...extraHeaders },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { res, status: res.status, json: text ? JSON.parse(text) : null };
}

export async function initialize(h: Harness, access: string) {
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

export function callTool(h: Harness, access: string, sessionId: string, name: string, args: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  return mcp(
    h,
    access,
    { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
    { "mcp-session-id": sessionId, ...extraHeaders },
  );
}

export const sessionName = (sessionId: string) => `streamable-http:${sessionId}`;
export const businessCalls = (h: Harness) => h.app.calls.filter((c) => !c.path.startsWith("/api/oauth/"));
export const introspections = (h: Harness) => h.app.calls.filter((c) => c.path === "/api/oauth/introspect");

export async function refreshHost(h: Harness, refreshToken: string, scope?: string) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: h.clientId });
  if (scope) body.set("scope", scope);
  return h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
