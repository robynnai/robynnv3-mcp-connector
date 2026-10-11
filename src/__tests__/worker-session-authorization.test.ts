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
 * Synthetic identities only; no network. The fakes live in
 * `./harness/` (shared with the P16 suites).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => import("./harness/cloudflare-workers-stub"));
vi.mock("agents/mcp", () => import("./harness/agents-mcp-emulation"));

import worker, { handleTokenRequest, RobynnMCP } from "../index";
import { PREFLIGHT_HEADER, SESSION_BINDING_HEADER, SESSION_BINDING_STORAGE_KEY } from "../authorization/session-binding";
import { doEvents } from "./harness/agents-mcp-emulation";
import {
  APP_GRANT_A,
  APP_GRANT_A2,
  APP_GRANT_B,
  ORG_A,
  ORG_B,
  ORIGIN,
  USER_A,
  USER_B,
  businessCalls,
  callTool,
  connect,
  createHarness,
  executionContext,
  initialize,
  introspections,
  mcp,
  refreshHost,
  sessionName,
  type Harness,
} from "./harness/worker-harness";

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

  it("GET (standalone stream) with another user's token on an existing session id ⇒ 404 before the session (review N5)", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const b = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"] });
    const { sessionId } = await initialize(h, a.access);
    doEvents.length = 0;
    const res = await h.fetch("/mcp", {
      method: "GET",
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${b.access}`, "mcp-session-id": sessionId },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect(doEvents).toEqual([]);
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
    expect(out.json.result.content[0].text).toMatch(/^authorization_unavailable: /);
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
      // Text-only hosts (Claude Code) must still see the code the server instructions name.
      expect(out.json.result.content[0].text).toMatch(/^insufficient_scope: This connection is read-only\./);
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
    expect(session.json.result.content[0].text).toMatch(/^unsupported_memory_scope: /);
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

  // --- P10 review B1: a refresh can only ever revoke the grant the provider validated ---

  const grantAlive = (h: Harness, userId: string, hostGrantId: string) =>
    [...h.kv.store.keys()].some((k) => k === `grant:${userId}:${hostGrantId}`);

  it("B1: a /token body whose media type is not exactly form-urlencoded is refused before the provider, touching no grant or coordinator", async () => {
    const h = await createHarness();
    const victim = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const attacker = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"], legacy: true });
    const boundary = "p10b1";
    // Read as urlencoded text this names the victim; read by formData() as
    // multipart it names the attacker's own (legacy, revocable) grant.
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="pad"\r\n\r\n&refresh_token=${encodeURIComponent(victim.refresh)}&z=\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="grant_type"\r\n\r\nrefresh_token\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="refresh_token"\r\n\r\n${attacker.refresh}\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="client_id"\r\n\r\n${h.clientId}\r\n--${boundary}--\r\n`;
    h.app.calls.length = 0;
    for (const contentType of [
      `multipart/form-data; boundary=${boundary}; x=application/x-www-form-urlencoded`,
      "text/plain; charset=application/x-www-form-urlencoded",
      "application/x-www-form-urlencoded-evil",
    ]) {
      const res = await h.fetch("/token", { method: "POST", headers: { "Content-Type": contentType }, body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    expect(grantAlive(h, USER_A, victim.hostGrantId)).toBe(true);
    expect(grantAlive(h, USER_B, attacker.hostGrantId)).toBe(true);
    expect(h.coordinators.instances.size).toBe(0);
    expect(h.app.calls).toEqual([]);
    // Parameters on the right type are still accepted.
    const ok = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: victim.refresh, client_id: h.clientId }).toString(),
    });
    expect(ok.status).toBe(200);
  });

  it("B1: the Worker reads the body with the provider's parser, so a BOM-prefixed body cannot route to another grant's coordinator", async () => {
    const h = await createHarness();
    const victim = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    h.app.calls.length = 0;
    // text() strips a leading BOM; formData() (the provider's parser) keeps
    // it in the first key, so the provider sees no refresh_token at all.
    const res = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `\uFEFFrefresh_token=${encodeURIComponent(victim.refresh)}&grant_type=refresh_token&client_id=${h.clientId}`,
    });
    expect(res.status).toBe(400);
    expect(h.coordinators.instances.size).toBe(0);
    expect(h.app.calls).toEqual([]);
    expect(grantAlive(h, USER_A, victim.hostGrantId)).toBe(true);
  });

  it("B1: a repeated refresh_token (or grant_type) is refused before the provider", async () => {
    const h = await createHarness();
    const victim = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const attacker = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"], legacy: true });
    for (const body of [
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(victim.refresh)}&refresh_token=${encodeURIComponent(attacker.refresh)}&client_id=${h.clientId}`,
      `grant_type=refresh_token&grant_type=authorization_code&refresh_token=${encodeURIComponent(attacker.refresh)}&client_id=${h.clientId}`,
    ]) {
      const res = await h.fetch("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      expect(res.status).toBe(400);
    }
    expect(grantAlive(h, USER_A, victim.hostGrantId)).toBe(true);
    expect(grantAlive(h, USER_B, attacker.hostGrantId)).toBe(true);
    expect(h.coordinators.instances.size).toBe(0);
  });

  it("B1: even if the Worker's view named another grant, a permanent failure revokes only the provider-validated one", async () => {
    const h = await createHarness();
    const victim = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    const attacker = await connect(h, { userId: USER_B, organizationId: ORG_B, appGrantId: APP_GRANT_B, scopes: ["brand:read"], legacy: true });
    const request = () =>
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: attacker.refresh, client_id: h.clientId }).toString(),
      });

    // A forged context naming the victim: the callback refuses, nothing is revoked.
    const forged = await handleTokenRequest(request(), h.env, executionContext(), {
      grantType: "refresh_token",
      redirectUri: null,
      refreshGrant: { userId: USER_A, grantId: victim.hostGrantId },
    });
    expect(forged.status).toBe(400);
    expect(grantAlive(h, USER_A, victim.hostGrantId)).toBe(true);
    expect(grantAlive(h, USER_B, attacker.hostGrantId)).toBe(true);
    const ok = await callTool(h, victim.access, (await initialize(h, victim.access)).sessionId, "robynn_status");
    expect(ok.json.result.isError).toBeFalsy();

    // No Worker view at all: refused, nothing revoked.
    const none = await handleTokenRequest(request(), h.env, executionContext(), {
      grantType: "refresh_token",
      redirectUri: null,
      refreshGrant: null,
    });
    expect(none.status).toBe(400);
    expect(grantAlive(h, USER_B, attacker.hostGrantId)).toBe(true);

    // The honest path revokes exactly the caller's own legacy grant.
    const own = await h.fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: attacker.refresh, client_id: h.clientId }).toString(),
    });
    expect(own.status).toBe(400);
    expect(grantAlive(h, USER_B, attacker.hostGrantId)).toBe(false);
    expect(grantAlive(h, USER_A, victim.hostGrantId)).toBe(true);
    expect([...h.coordinators.instances.keys()]).toEqual([`refresh:${attacker.hostGrantId}`]);
  });

  it("N3: a deployed (non-loopback) Worker without REFRESH_COORDINATOR refuses refreshes with 503, un-rotated", async () => {
    const h = await createHarness();
    const a = await connect(h, { userId: USER_A, organizationId: ORG_A, appGrantId: APP_GRANT_A, scopes: ["brand:read"] });
    delete (h.env as unknown as Record<string, unknown>).REFRESH_COORDINATOR;
    const res = await refreshHost(h, a.refresh);
    expect(res.status).toBe(503);
    expect(h.app.calls.filter((c) => c.path === "/api/oauth/token")).toEqual([]);
    (h.env as unknown as Record<string, unknown>).REFRESH_COORDINATOR = h.coordinators;
    expect((await refreshHost(h, a.refresh)).status).toBe(200);
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
