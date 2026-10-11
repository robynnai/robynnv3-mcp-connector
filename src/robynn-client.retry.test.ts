/**
 * COS-PLUGIN-001 P11: automatic retries only for operations proven safe.
 *
 * Every public RobynnClient method is called against an app that always
 * fails. The number of requests it sends must match `retrySafe` in
 * contracts/tool-route-map.json for the route it hit: 2 (one retry) for
 * retry-safe operations, exactly 1 for everything else.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RobynnApiError, RobynnClient } from "./robynn-client";

type MapTool = {
  name: string;
  retrySafe: boolean;
  appRoutes: Array<{ method: string; path: string }>;
};

const MAP = JSON.parse(
  readFileSync(resolve(__dirname, "../contracts/tool-route-map.json"), "utf8"),
) as { tools: MapTool[] };

// Routes the map lists that the Worker never calls directly: R2 bindings and
// app-internal hops made by another app route.
const NOT_CALLED_BY_CLIENT = new Set([
  "R2 VAULT binding: list orgs/{organizationId}/…",
  "R2 VAULT binding: get orgs/{organizationId}/{path}",
  "POST /api/agents/geo/execute",
  "POST /api/agents/seo/execute",
  "POST /api/publish",
]);

function routeKey(route: { method: string; path: string }) {
  return route.path.startsWith("R2 ") ? route.path : `${route.method} ${route.path}`;
}

function templateMatches(template: string, pathname: string) {
  const pattern = template
    .split("/")
    .map((part) => (/^\{[A-Za-z]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}$`).test(pathname);
}

/** Map routes (and the tools behind them) that a request hit. */
function routesFor(method: string, pathname: string) {
  const hits: Array<{ key: string; tool: MapTool }> = [];
  for (const tool of MAP.tools) {
    for (const route of tool.appRoutes) {
      if (route.method === method && templateMatches(route.path, pathname)) {
        hits.push({ key: routeKey(route), tool });
      }
    }
  }
  return hits;
}

/**
 * A route is retry-safe when a retrySafe tool uses it and no single-route
 * tool that is not retry-safe uses it. (Multi-route tools such as
 * robynn_create_content are not retry-safe because of their POSTs; their
 * GET run poll is shared with robynn_run_status, which is.)
 */
function expectedRetrySafe(method: string, pathname: string) {
  const hits = routesFor(method, pathname);
  const exactHits = hits.filter((hit) => !hit.key.includes("{"));
  const relevant = exactHits.length > 0 ? exactHits : hits;
  const anySafe = relevant.some((hit) => hit.tool.retrySafe);
  const vetoed = relevant.some(
    (hit) => !hit.tool.retrySafe && hit.tool.appRoutes.length === 1,
  );
  return anySafe && !vetoed;
}

type Call = (client: RobynnClient) => Promise<unknown>;

const CALLS: Record<string, Call> = {
  getBrandContext: (c) => c.getBrandContext("voice"),
  getUsage: (c) => c.getUsage(),
  getStatus: (c) => c.getStatus(),
  getConnectedAppCapabilities: (c) => c.getConnectedAppCapabilities("hubspot"),
  readConnectedApp: (c) => c.readConnectedApp({ provider_key: "hubspot", action_key: "list_contacts" }),
  getBridgeCapabilities: (c) => c.getBridgeCapabilities(),
  addBrandSource: (c) => c.addBrandSource({ source_type: "text", text: "x" } as never),
  rebuildBrandContext: (c) => c.rebuildBrandContext({} as never),
  listThreads: (c) => c.listThreads(),
  geoAnalysis: (c) => c.geoAnalysis({ company_name: "Acme" } as never),
  competitiveBattlecard: (c) => c.competitiveBattlecard({ competitor_name: "X" } as never),
  seoOpportunities: (c) => c.seoOpportunities({} as never),
  brandContextSearch: (c) => c.brandContextSearch({ query: "q" } as never),
  brandBookStatus: (c) => c.brandBookStatus({ include_recent_reflections: true }),
  brandBookGapAnalysis: (c) => c.brandBookGapAnalysis({} as never),
  brandBookStrategy: (c) => c.brandBookStrategy({} as never),
  brandReflections: (c) => c.brandReflections({ limit: 5 }),
  triggerBrandReflections: (c) => c.triggerBrandReflections({}),
  publishBrandBookHtml: (c) => c.publishBrandBookHtml({}),
  publishStrapiDraft: (c) => c.publishStrapiDraft({} as never),
  websiteAudit: (c) => c.websiteAudit({ website_url: "https://example.com" } as never),
  websiteAuditStatus: (c) => c.websiteAuditStatus({ prospect_audit_id: "pa-1" }),
  websiteAuditV2: (c) => c.websiteAuditV2({} as never),
  websiteAuditV2Status: (c) => c.websiteAuditV2Status({ scan_id: "scan-1" }),
  websiteOptimizationAudit: (c) => c.websiteOptimizationAudit({} as never),
  websiteOptimizationAuditStatus: (c) => c.websiteOptimizationAuditStatus({ run_id: "run-1" }),
  websiteAuditOrchestrator: (c) => c.websiteAuditOrchestrator({} as never),
  websiteAuditOrchestratorStatus: (c) => c.websiteAuditOrchestratorStatus({ run_id: "run-1" } as never),
  websiteStrategy: (c) => c.websiteStrategy({} as never),
  contentPlan: (c) => c.contentPlan({} as never),
  weeklyVisibilityReport: (c) => c.weeklyVisibilityReport({} as never),
  createThread: (c) => c.createThread("t"),
  startRun: (c) => c.startRun("thread-1", { message: "hi" } as never),
  getRun: (c) => c.getRun("run-1"),
  cmoAgent: (c) => c.cmoAgent({ message: "hi" } as never),
  cmoDecide: (c) => c.cmoDecide({} as never),
  campaignCreator: (c) => c.campaignCreator({} as never),
  campaignStatus: (c) =>
    c.campaignStatus({ langgraph_thread_id: "t-1", langgraph_run_id: "r-1" } as never),
  upsertHermesThread: (c) =>
    c.upsertHermesThread({ hermes_host_id: "h", hermes_session_id: "s", platform: "cli" }),
  appendHermesMessage: (c) => c.appendHermesMessage("thread-1", { role: "user", content: "x" }),
  writeHermesMemory: (c) => c.writeHermesMemory({ scope: "org", key: "k", value: "v" }),
  getHermesMemory: (c) => c.getHermesMemory("org", "k"),
  searchHermesMemory: (c) => c.searchHermesMemory({ query: "q" }),
  actOnConnectedApp: (c) =>
    c.actOnConnectedApp({
      service: "hubspot",
      action: "create_task",
      parameters: {},
      idempotency_key: "idem-1",
    } as never),
};

// Not single operations: pollRun loops over getRun (covered above).
const NOT_SINGLE_OPERATIONS = new Set(["pollRun"]);
const PRIVATE_METHODS = new Set([
  "constructor",
  // P10 adds setAccessToken (sends no request).
  "setAccessToken",
  "withQuery",
  "fetch",
  "fetchWithRetry",
  "logContext",
  "retryAfterDelay",
]);

type Recorded = { method: string; pathname: string; search: string };

function stubFetch(respond: (count: number) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      method: (init?.method ?? "GET").toUpperCase(),
      pathname: url.pathname,
      search: url.search,
    });
    return respond(requests.length);
  });
  return requests;
}

function newClient(options: ConstructorParameters<typeof RobynnClient>[2] = {}) {
  return new RobynnClient("https://robynn.test", "token-123", {
    retryDelayMs: 0,
    ...options,
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RobynnClient retry policy matches tool-route-map retrySafe", () => {
  it("covers every public client method", () => {
    const methods = Object.getOwnPropertyNames(RobynnClient.prototype).filter(
      (name) => !PRIVATE_METHODS.has(name) && !NOT_SINGLE_OPERATIONS.has(name),
    );
    expect(methods.sort()).toEqual(Object.keys(CALLS).sort());
  });

  const observedRoutes = new Set<string>();

  for (const [name, call] of Object.entries(CALLS)) {
    it(`${name}: 503 is retried only when the map marks the route retry-safe`, async () => {
      const requests = stubFetch(() => new Response("upstream down", { status: 503 }));

      await expect(call(newClient())).rejects.toBeInstanceOf(RobynnApiError);

      const first = requests[0];
      const hits = routesFor(first.method, first.pathname);
      expect(hits.length, `${first.method} ${first.pathname} is not in the map`).toBeGreaterThan(0);
      hits.forEach((hit) => observedRoutes.add(hit.key));

      const safe = expectedRetrySafe(first.method, first.pathname);
      expect(requests.length).toBe(safe ? 2 : 1);
      for (const request of requests) {
        expect(request).toEqual(first);
      }
    });

    it(`${name}: a network failure is retried only when retry-safe`, async () => {
      const requests = stubFetch(() => {
        throw new TypeError("fetch failed: connect ECONNRESET https://robynn.test/x?key=canary");
      });

      const error = await call(newClient()).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RobynnApiError);
      expect((error as Error).message).not.toContain("canary");

      const first = requests[0];
      const safe = expectedRetrySafe(first.method, first.pathname);
      expect(requests.length).toBe(safe ? 2 : 1);
    });
  }

  it("exercises every app route in the map", () => {
    const mapRoutes = new Set(
      MAP.tools.flatMap((tool) => tool.appRoutes.map((route) => routeKey(route))),
    );
    const missing = [...mapRoutes].filter(
      (key) => !observedRoutes.has(key) && !NOT_CALLED_BY_CLIENT.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("never retries the charged, run-starting and connector-write operations", async () => {
    // Pinned explicitly so a map edit cannot silently re-enable them.
    const pinned = [
      "websiteAudit",
      "websiteAuditV2",
      "websiteOptimizationAudit",
      "websiteAuditOrchestrator",
      "cmoAgent",
      "startRun",
      "createThread",
      "campaignCreator",
      "campaignStatus",
      "triggerBrandReflections",
      "publishStrapiDraft",
      "actOnConnectedApp",
      "appendHermesMessage",
      "writeHermesMemory",
      "addBrandSource",
    ];
    for (const name of pinned) {
      vi.restoreAllMocks();
      const requests = stubFetch(() => new Response("", { status: 500 }));
      await expect(CALLS[name](newClient())).rejects.toThrow("API error 500");
      expect(requests.length, name).toBe(1);
    }
  });
});

describe("RobynnClient retry edge cases", () => {
  it("does not retry a retry-safe operation after a timeout", async () => {
    const requests = stubFetch(() => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });

    await expect(newClient().getStatus()).rejects.toMatchObject({ code: "timeout" });
    expect(requests.length).toBe(1);
  });

  it("does not retry a retry-safe operation on 4xx", async () => {
    const requests = stubFetch(() => new Response("{}", { status: 422 }));
    await expect(newClient().getStatus()).rejects.toThrow("API error 422");
    expect(requests.length).toBe(1);
  });

  it("retries a retry-safe operation at most once", async () => {
    const requests = stubFetch(() => new Response("", { status: 502 }));
    await expect(newClient().getUsage()).rejects.toThrow("API error 502");
    expect(requests.length).toBe(2);
  });

  it("succeeds when the single retry of a retry-safe operation succeeds", async () => {
    const requests = stubFetch((count) =>
      count === 1
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ success: true, data: { ok: true } })),
    );
    await expect(newClient().getStatus()).resolves.toMatchObject({ success: true });
    expect(requests.length).toBe(2);
  });

  it("replays a non-retry-safe operation after a 401 refresh, then never on 5xx", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh-token");
    const requests = stubFetch((count) =>
      count === 1 ? new Response("", { status: 401 }) : new Response("", { status: 503 }),
    );

    await expect(newClient({ refreshAccessToken }).websiteAudit({} as never)).rejects.toThrow(
      "API error 503",
    );
    // 401 means the app refused before any business work; the replay is safe.
    // The 503 that follows may have charged credits, so it is not retried.
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(requests.length).toBe(2);
  });

  it("waits before the retry by default", async () => {
    vi.useFakeTimers();
    try {
      const requests = stubFetch((count) =>
        count === 1
          ? new Response("", { status: 503 })
          : new Response(JSON.stringify({ success: true })),
      );
      const pending = new RobynnClient("https://robynn.test", "t").getStatus();
      await vi.advanceTimersByTimeAsync(999);
      expect(requests.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ success: true });
      expect(requests.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RobynnClient path ids", () => {
  it("encodes thread and run ids as a single path segment", async () => {
    const requests = stubFetch(() => new Response(JSON.stringify({ success: true, data: {} })));
    const client = newClient();

    await client.startRun("../../oauth/token?x=1#frag", { message: "hi" } as never);
    await client.getRun("a/b?c");
    await client.appendHermesMessage("../memory", { role: "user", content: "x" });

    expect(requests.map((r) => `${r.method} ${r.pathname}${r.search}`)).toEqual([
      "POST /api/agents/cmo/threads/..%2F..%2Foauth%2Ftoken%3Fx%3D1%23frag/runs",
      "GET /api/agents/cmo/runs/a%2Fb%3Fc",
      "POST /api/cli/threads/..%2Fmemory/messages",
    ]);
  });

  it("refuses dot-segment and empty ids without sending a request", async () => {
    const requests = stubFetch(() => new Response(JSON.stringify({ success: true })));
    const client = newClient();

    for (const id of [".", "..", ""]) {
      await expect(client.getRun(id)).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(client.startRun(id, {} as never)).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(
        client.appendHermesMessage(id, { role: "user", content: "x" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(client.getBrandContext(".." as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(requests).toEqual([]);
  });
});
