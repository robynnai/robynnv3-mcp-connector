/**
 * COS-PLUGIN-001 P10 — the session-binding assumptions, checked against the
 * INSTALLED agents 0.7.5 code (not the emulation used by
 * worker-session-authorization.test.ts):
 *
 * - `McpAgent.serve` copies every request header into the DO's upgrade
 *   request. So the Worker's binding header reaches the DO (which checks
 *   it), and a client's `x-partykit-props` would too (the preflight strips
 *   it).
 * - `RobynnMCP.onStart` sits in front of the real `McpAgent.onStart`:
 *   refused props are never persisted, matching props are.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));

import { McpAgent } from "agents/mcp";
import { RobynnMCP } from "../index";
import { SESSION_BINDING_HEADER, SESSION_BINDING_STORAGE_KEY } from "../authorization/session-binding";

const ORIGIN = "https://mcp.test";
const A = { hostGrantId: "hostA", userId: "user-a", organizationId: "org-a", appGrantId: "grant-a" };

function ensureUrlPattern() {
  if (!("URLPattern" in globalThis)) {
    vi.stubGlobal(
      "URLPattern",
      class {
        constructor(private readonly init: { pathname: string }) {}
        test(url: URL | string) {
          return new URL(String(url)).pathname === this.init.pathname;
        }
      },
    );
  }
}

describe("installed agents 0.7.5: what reaches the session DO", () => {
  beforeEach(ensureUrlPattern);

  it("copies every request header (including x-robynn-* and x-partykit-props) into the DO upgrade request", async () => {
    const upgrades: Record<string, string>[] = [];
    const namespace = {
      newUniqueId: () => ({ toString: () => "s1" }),
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        async fetch(req: Request) {
          if (req.headers.get("upgrade")) {
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => (headers[k] = v));
            upgrades.push(headers);
          }
          return new Response(null, { status: 200 });
        },
        async getInitializeRequest() {
          return { jsonrpc: "2.0", id: 0, method: "initialize" };
        },
      }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await McpAgent.serve("/mcp").fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "mcp-session-id": "s1",
          [SESSION_BINDING_HEADER]: JSON.stringify(A),
          "x-partykit-props": JSON.stringify({ userId: "intruder" }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { MCP_OBJECT: namespace },
      { props: {} } as never,
    );
    expect(upgrades).toHaveLength(1);
    expect(JSON.parse(upgrades[0][SESSION_BINDING_HEADER])).toEqual(A);
    expect(upgrades[0]["x-partykit-props"]).toBe(JSON.stringify({ userId: "intruder" }));
  });
});

describe("RobynnMCP.onStart in front of the real McpAgent.onStart", () => {
  function fakeSelf(storage: Map<string, unknown>) {
    return {
      ctx: {
        storage: {
          get: async (k: string) => storage.get(k),
          put: async (k: string, v: unknown) => void storage.set(k, v),
        },
      },
      props: undefined as unknown,
      sessionStarted: false,
      updateProps: McpAgent.prototype.updateProps,
      init: vi.fn(),
      server: { connect: vi.fn() },
      initTransport: () => ({}),
      reinitializeServer: vi.fn(),
    };
  }
  const onStart = RobynnMCP.prototype.onStart as (this: unknown, props?: unknown) => Promise<void>;

  it("binds and persists the first caller's props", async () => {
    const storage = new Map<string, unknown>();
    const self = fakeSelf(storage);
    await onStart.call(self, { ...A, accessToken: "a" });
    expect(storage.get(SESSION_BINDING_STORAGE_KEY)).toEqual(A);
    expect(storage.get("props")).toMatchObject({ userId: "user-a", accessToken: "a" });
    expect(self.sessionStarted).toBe(true);
  });

  it("after eviction, a different caller's props are neither persisted nor used", async () => {
    const storage = new Map<string, unknown>([
      [SESSION_BINDING_STORAGE_KEY, A],
      ["props", { ...A, accessToken: "a" }],
    ]);
    const self = fakeSelf(storage);
    await onStart.call(self, { hostGrantId: "hostB", userId: "user-b", organizationId: "org-b", appGrantId: "grant-b", accessToken: "b" });
    expect(storage.get("props")).toMatchObject({ userId: "user-a", accessToken: "a" });
    expect(self.props).toMatchObject({ userId: "user-a" });
    expect(storage.get(SESSION_BINDING_STORAGE_KEY)).toEqual(A);
  });

  it("the same identity's newer props are adopted", async () => {
    const storage = new Map<string, unknown>([
      [SESSION_BINDING_STORAGE_KEY, A],
      ["props", { ...A, accessToken: "a" }],
    ]);
    const self = fakeSelf(storage);
    await onStart.call(self, { ...A, accessToken: "a2" });
    expect(storage.get("props")).toMatchObject({ accessToken: "a2" });
  });
});
