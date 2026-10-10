/**
 * COS-PLUGIN-001 P16 — the whole host OAuth chain through the Worker's real
 * HTTP entry points, in process (plan §6 "Keep two token layers", §8 "Worker
 * integration"):
 *
 *   DCR → /authorize (S256) → app consent → /callback (signed exchange +
 *   introspection) → /token (PKCE) → /mcp initialize + tools/call → refresh →
 *   revocation
 *
 * No step is short-circuited: unlike the P10 suite, the provider grant is
 * created by the Worker's own /callback, not by `completeAuthorization` in
 * the test. The app is the harness's stateful fake (P05 code and refresh
 * semantics, P10 introspection); the same chain against the real app and
 * local Supabase is `src/__tests__/plugin-local/oauth-chain.live.test.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => import("./harness/cloudflare-workers-stub"));
vi.mock("agents/mcp", () => import("./harness/agents-mcp-emulation"));

import { doEvents } from "./harness/agents-mcp-emulation";
import {
  API,
  CALLBACK,
  ORG_A,
  ORG_B,
  ORIGIN,
  USER_A,
  USER_B,
  businessCalls,
  callTool,
  consentAtApp,
  createHarness,
  initialize,
  mcp,
  refreshHost,
  type Harness,
  type Scope,
} from "./harness/worker-harness";

interface HostAuthorization {
  verifier: string;
  appAuthorizeUrl: URL;
  cookie: string;
  status: number;
}

/** Host side of /authorize: S256 PKCE, the host's own state, the MCP resource. */
async function hostAuthorize(h: Harness, scope: string, clientId = h.clientId): Promise<HostAuthorization> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const res = await h.fetch(
    `/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "host-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope,
      resource: `${ORIGIN}/mcp`,
    })}`,
  );
  const location = res.headers.get("location");
  return {
    verifier,
    status: res.status,
    appAuthorizeUrl: new URL(location ?? `${API}/none`),
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
  };
}

/** The browser returns from the app's consent to the Worker's /callback. */
async function workerCallback(h: Harness, auth: HostAuthorization, appCode: string) {
  const state = auth.appAuthorizeUrl.searchParams.get("state")!;
  const res = await h.fetch(`/callback?${new URLSearchParams({ code: appCode, state })}`, {
    headers: { cookie: auth.cookie },
  });
  return { status: res.status, location: new URL(res.headers.get("location") ?? "http://none/") };
}

async function hostToken(h: Harness, code: string, verifier: string, clientId = h.clientId) {
  const res = await h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** The full chain for one user, org and consent; returns the host tokens. */
async function connectThroughFrontDoor(
  h: Harness,
  opts: { userId: string; organizationId: string; requested: string; granted: Scope[] },
) {
  const auth = await hostAuthorize(h, opts.requested);
  expect(auth.status).toBe(302);
  const { code: appCode, appGrantId } = consentAtApp(h.app, {
    userId: opts.userId,
    organizationId: opts.organizationId,
    scopes: opts.granted,
  });
  const back = await workerCallback(h, auth, appCode);
  expect(back.status).toBe(302);
  expect(back.location.origin + back.location.pathname).toBe(CALLBACK);
  expect(back.location.searchParams.get("state")).toBe("host-state");
  const hostCode = back.location.searchParams.get("code")!;
  expect(hostCode).toBeTruthy();
  const token = await hostToken(h, hostCode, auth.verifier);
  expect(token.status).toBe(200);
  return {
    access_token: token.body.access_token,
    refresh_token: token.body.refresh_token,
    appGrantId,
    hostCode,
    verifier: auth.verifier,
    appCode,
  };
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

describe("host OAuth chain through the real Worker entry points", () => {
  it("DCR → /authorize → consent → /callback → /token → /mcp → refresh → revocation", async () => {
    const h = await createHarness();

    // /authorize hands the browser to the app with the Worker's own client
    // and callback, exactly the requested scope, and a browser-bound state.
    const auth = await hostAuthorize(h, "brand:read tools:execute");
    expect(auth.status).toBe(302);
    expect(auth.appAuthorizeUrl.origin + auth.appAuthorizeUrl.pathname).toBe(`${API}/oauth/authorize`);
    expect(auth.appAuthorizeUrl.searchParams.get("client_id")).toBe("robynn-mcp-worker");
    expect(auth.appAuthorizeUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(auth.appAuthorizeUrl.searchParams.get("scope")).toBe("brand:read tools:execute");
    expect(auth.cookie).toMatch(/=/);

    // The user consents to read-only only (execution opt-in left unchecked).
    const { code: appCode, appGrantId } = consentAtApp(h.app, { userId: USER_A, organizationId: ORG_A, scopes: ["brand:read"] });
    const back = await workerCallback(h, auth, appCode);
    expect(back.status).toBe(302);
    const hostCode = back.location.searchParams.get("code")!;
    const exchange = h.app.calls.find((c) => c.path === "/api/oauth/token")!;
    expect(exchange.body).toMatchObject({ grant_type: "authorization_code", redirect_uri: `${ORIGIN}/callback`, client_id: "robynn-mcp-worker" });
    expect(h.app.calls.filter((c) => c.path === "/api/oauth/introspect")).toHaveLength(1);

    const token = await hostToken(h, hostCode, auth.verifier);
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe("brand:read");
    expect(token.body.refresh_token).toBeTruthy();

    // MCP: initialize binds the session; a brand:read tool runs with the
    // upstream credential; an execute tool is refused before the app.
    const { sessionId } = await initialize(h, token.body.access_token);
    const status = await callTool(h, token.body.access_token, sessionId, "robynn_status");
    expect(status.json.result.isError).toBeFalsy();
    // P17: the organization and permissions introspection verified for this call (non-ASCII survives the header).
    expect(status.json.result.structuredContent.connection).toEqual({
      organization: { id: ORG_A, name: "Harness Org ✓" },
      permissions: ["brand:read"],
      can_execute: false,
    });
    const summary = businessCalls(h).find((c) => c.path === "/api/cli/context/summary")!;
    expect(summary.authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    const before = businessCalls(h).length;
    const write = await callTool(h, token.body.access_token, sessionId, "robynn_memory_write", { scope: "user", key: "k", content: "v" });
    expect(write.json.result.structuredContent.error.code).toBe("insufficient_scope");
    expect(businessCalls(h).length).toBe(before);

    // Refresh renews both layers; the new host token works on the same session.
    const refreshed = await refreshHost(h, token.body.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, string>;
    expect(next.access_token).not.toBe(token.body.access_token);
    expect(h.app.calls.filter((c) => c.path === "/api/oauth/token")).toHaveLength(2);
    expect((await callTool(h, next.access_token, sessionId, "robynn_status")).json.result.isError).toBeFalsy();

    // Revocation at the app (the user's connected-apps DELETE): the next call
    // is 401 with a resource-metadata challenge, and nothing renews.
    h.app.grants.get(appGrantId)!.status = "revoked";
    const callsBefore = businessCalls(h).length;
    const revoked = await callTool(h, next.access_token, sessionId, "robynn_status");
    expect(revoked.status).toBe(401);
    expect(revoked.res.headers.get("www-authenticate")).toMatch(/invalid_token/);
    expect(businessCalls(h).length).toBe(callsBefore);
    expect((await mcp(h, next.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": sessionId })).status).toBe(401);
    const dead = await refreshHost(h, next.refresh_token);
    expect(dead.status).toBe(400);
    expect(((await dead.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("reconnecting the same host client to another org replaces the first grant (no dual org binding)", async () => {
    const h = await createHarness();
    const first = await connectThroughFrontDoor(h, { userId: USER_A, organizationId: ORG_A, requested: "brand:read", granted: ["brand:read"] });
    const second = await connectThroughFrontDoor(h, { userId: USER_A, organizationId: ORG_B, requested: "brand:read", granted: ["brand:read"] });
    expect((await mcp(h, first.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const { sessionId } = await initialize(h, second.access_token);
    expect((await callTool(h, second.access_token, sessionId, "robynn_status")).json.result.isError).toBeFalsy();
    const lastIntrospection = h.app.calls.filter((c) => c.path === "/api/oauth/introspect").at(-1)!;
    expect(lastIntrospection.body).toMatchObject({ organization_id: ORG_B, grant_id: second.appGrantId });
  });

  it("another user's valid token cannot use an existing session id", async () => {
    const h = await createHarness();
    const a = await connectThroughFrontDoor(h, { userId: USER_A, organizationId: ORG_A, requested: "brand:read", granted: ["brand:read"] });
    const b = await connectThroughFrontDoor(h, { userId: USER_B, organizationId: ORG_B, requested: "brand:read", granted: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access_token);
    const hijack = await callTool(h, b.access_token, sessionId, "robynn_status");
    expect(hijack.status).toBe(404);
    expect(hijack.json.error.code).toBe(-32001);
    expect((await callTool(h, a.access_token, sessionId, "robynn_status")).json.result.isError).toBeFalsy();
  });
});

describe("chain negatives that span both token layers", () => {
  it("an app code replayed through a second Worker transaction is refused and revokes the app grant", async () => {
    const h = await createHarness();
    const first = await connectThroughFrontDoor(h, { userId: USER_A, organizationId: ORG_A, requested: "brand:read", granted: ["brand:read"] });

    // The same app code carried back on a fresh /authorize transaction.
    const auth = await hostAuthorize(h, "brand:read");
    const replay = await workerCallback(h, auth, first.appCode);
    expect(replay.status).toBe(302);
    expect(replay.location.searchParams.get("error")).toBe("server_error");
    expect(replay.location.searchParams.get("code")).toBeNull();
    expect(h.app.grants.get(first.appGrantId)!.status).toBe("revoked");

    // The connection made from that code stops at its next tool call.
    const { sessionId } = await initialize(h, first.access_token);
    expect((await callTool(h, first.access_token, sessionId, "robynn_status")).status).toBe(401);
  });

  it("a host code is single use: a replay is refused and revokes the host grant", async () => {
    const h = await createHarness();
    const conn = await connectThroughFrontDoor(h, { userId: USER_A, organizationId: ORG_A, requested: "brand:read", granted: ["brand:read"] });
    const replay = await hostToken(h, conn.hostCode, conn.verifier);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcp(h, conn.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("a host code exchanged by another registered client, or with a wrong verifier, is refused", async () => {
    const h = await createHarness();
    const reg = await h.fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Other Host", token_endpoint_auth_method: "none" }),
    });
    const other = ((await reg.json()) as { client_id: string }).client_id;

    const auth = await hostAuthorize(h, "brand:read");
    const { code } = consentAtApp(h.app, { userId: USER_A, organizationId: ORG_A, scopes: ["brand:read"] });
    const back = await workerCallback(h, auth, code);
    const hostCode = back.location.searchParams.get("code")!;

    expect((await hostToken(h, hostCode, auth.verifier, other)).body.error).toBe("invalid_grant");
    expect((await hostToken(h, hostCode, randomBytes(32).toString("base64url"))).body.error).toBe("invalid_grant");
  });

  it("an app code bound to another redirect is refused by the app; the host gets an error, never a code", async () => {
    const h = await createHarness();
    const auth = await hostAuthorize(h, "brand:read");
    const { code, appGrantId } = consentAtApp(h.app, {
      userId: USER_A,
      organizationId: ORG_A,
      scopes: ["brand:read"],
      redirectUri: "https://attacker.example/callback",
    });
    const back = await workerCallback(h, auth, code);
    expect(back.location.searchParams.get("error")).toBe("server_error");
    expect(back.location.searchParams.get("code")).toBeNull();
    expect(h.app.codes.get(code)!.used).toBe(false);
    expect(h.app.grants.get(appGrantId)!.status).toBe("active");
  });

  it("consent that grants more than the host requested never completes", async () => {
    const h = await createHarness();
    const auth = await hostAuthorize(h, "brand:read");
    const { code } = consentAtApp(h.app, { userId: USER_A, organizationId: ORG_A, scopes: ["brand:read", "tools:execute"] });
    const back = await workerCallback(h, auth, code);
    expect(back.location.searchParams.get("error")).toBe("invalid_scope");
    expect(back.location.searchParams.get("code")).toBeNull();
  });

  it("a removed member's connection stops at the next tool call and cannot refresh", async () => {
    const h = await createHarness();
    const conn = await connectThroughFrontDoor(h, { userId: USER_B, organizationId: ORG_A, requested: "brand:read", granted: ["brand:read"] });
    const { sessionId } = await initialize(h, conn.access_token);
    expect((await callTool(h, conn.access_token, sessionId, "robynn_status")).json.result.isError).toBeFalsy();

    h.app.grants.get(conn.appGrantId)!.status = "membership_removed";
    const removed = await callTool(h, conn.access_token, sessionId, "robynn_status");
    expect(removed.status).toBe(401);
    expect((await refreshHost(h, conn.refresh_token)).status).toBe(400);
  });
});
