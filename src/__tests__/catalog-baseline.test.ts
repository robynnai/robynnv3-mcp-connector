/**
 * COS-PLUGIN-001 P01 — catalog baseline (P13: on the real registration harness).
 *
 * Recounts the tool catalog through a real MCP `tools/list` round-trip and
 * checks that contracts/tool-route-map.json covers exactly the registered tools
 * with the annotations the code declares. Since P13 the tools come from the
 * real `RobynnMCP` Durable Object (`onStart` → `init()`) and the real
 * `robynn mcp` CLI action (see catalog-harness.ts), not from parsing the
 * registrar calls. P12 applied the titles, hints and descriptions; annotation
 * expectations here change together with the map. The full per-tool contract
 * and the committed snapshot live in catalog-contract.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("../cli/config", () => ({ readConfig: () => ({ apiKey: "p13-synthetic-cli-key" }), writeConfig: () => {} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", async () =>
  (await import("./catalog-harness")).cliStdioTransportMock(),
);

import { BRAND_BOOK_READS_PERSIST_COMPLETENESS } from "../tools/brand-book";
import { CONNECTED_APP_READS_PERSIST_POLICY } from "../tools/connectors";
import { APP_BASE_URL, schemaDigest, startCliSession, startWorkerSession } from "./catalog-harness";

const readSource = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

type ListedTool = Awaited<ReturnType<Awaited<ReturnType<typeof startWorkerSession>>["client"]["listTools"]>>["tools"][number];
const catalog = {} as { worker: ListedTool[]; noVault: ListedTool[]; cli: ListedTool[] };

beforeAll(async () => {
  // P13 review note 5: this suite never calls a tool; any outbound request is a bug (no network in unit tests).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`catalog-baseline makes no network requests (attempted ${String(input)})`);
    }),
  );
  process.env.ROBYNN_API_BASE_URL = APP_BASE_URL;
  const worker = await startWorkerSession();
  const noVault = await startWorkerSession({ vault: false });
  const cli = await startCliSession();
  catalog.worker = (await worker.client.listTools()).tools;
  catalog.noVault = (await noVault.client.listTools()).tools;
  catalog.cli = (await cli.client.listTools()).tools;
  await Promise.all([worker.close(), noVault.close(), cli.close()]);
}, 30_000);
afterAll(() => {
  delete process.env.ROBYNN_API_BASE_URL;
  vi.unstubAllGlobals();
});

interface Hints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

interface RouteMapTool {
  name: string;
  surfaces: { worker: boolean; workerWithoutVault: boolean; cli: boolean };
  currentHints: Hints;
  proposedHints: Hints;
  hintsAfterP07?: Hints;
  requiredScope: "brand:read" | "tools:execute";
  requiredScopeAfterP07?: "brand:read" | "tools:execute";
  conditional?: string;
  scopeByArgument?: Record<string, Record<string, string>>;
  appRoutes: Array<{ method: string; path: string; file: string | null; hop?: "internal" }>;
  titleProposal: string;
  pairedWith: string[];
  inputSchemaDigest: string;
  charges: string;
  environmentGate: string | null;
}

const declaredHints = (annotations: Record<string, unknown> | undefined): Hints => {
  const hints: Hints = {
    readOnlyHint: annotations?.readOnlyHint as boolean,
    destructiveHint: annotations?.destructiveHint as boolean,
    openWorldHint: annotations?.openWorldHint as boolean,
  };
  if (annotations?.idempotentHint !== undefined) hints.idempotentHint = annotations.idempotentHint as boolean;
  return hints;
};

const routeMap = JSON.parse(readSource("contracts/tool-route-map.json")) as {
  counts: { worker: number; workerWithoutVault: number; cli: number };
  tools: RouteMapTool[];
};

/**
 * † tools: read-only only once P07 removes a hidden write from their read path.
 * `pending` is the code flag that keeps each one conservative; when P07 lands,
 * flip the flag and the tool's map entry (currentHints/proposedHints →
 * hintsAfterP07, requiredScope → requiredScopeAfterP07) and these tests follow.
 */
const brandBookConditional = {
  pending: BRAND_BOOK_READS_PERSIST_COMPLETENESS,
  scopeAfterP07: "brand:read",
  marker: "brand-completeness summary",
} as const;
const P07_CONDITIONAL_TOOLS: Record<
  string,
  { pending: boolean; scopeAfterP07: "brand:read" | "tools:execute"; marker: string }
> = {
  robynn_brand_book_gap_analysis: brandBookConditional,
  robynn_brand_book_status: brandBookConditional,
  robynn_brand_book_strategy: brandBookConditional,
  robynn_publish_brand_book_html: brandBookConditional,
  // D-A (open decision, default tools:execute): the post-P07 scope is read from the map's
  // requiredScopeAfterP07, the single D-A flip point. A downgrade to brand:read needs P07 first:
  // while the flag is pending the tool is not read-only, so rule 1 keeps requiredScope at tools:execute.
  robynn_query_connected_app: {
    pending: CONNECTED_APP_READS_PERSIST_POLICY,
    scopeAfterP07: routeMap.tools.find((t) => t.name === "robynn_query_connected_app")!.requiredScopeAfterP07!,
    marker: "connector policy",
  },
};
const PENDING_P07_COUNT = Object.values(P07_CONDITIONAL_TOOLS).filter((t) => t.pending).length;

/** TOOL_CONTRACT.md §4 starter → poller pairs. */
const STARTER_POLLERS: Array<[starter: string, poller: string]> = [
  ["robynn_create_content", "robynn_run_status"],
  ["robynn_research", "robynn_run_status"],
  ["robynn_assist", "robynn_run_status"],
  ["robynn_cmo_agent", "robynn_run_status"],
  ["robynn_cmo_agent", "robynn_cmo_decide"],
  ["robynn_campaign_creator", "robynn_campaign_status"],
  ["robynn_website_audit", "robynn_website_audit_status"],
  ["robynn_website_audit_v2", "robynn_website_audit_v2_status"],
  ["robynn_website_optimization_audit", "robynn_website_optimization_audit_status"],
  ["robynn_website_audit_orchestrator", "robynn_website_audit_orchestrator_status"],
];


describe("P01 catalog baseline (real tools/list)", () => {
  it("counts 48 Worker tools with Vault, 46 without, 40 in the local CLI", async () => {
    const { worker, noVault, cli } = catalog;

    expect(worker).toHaveLength(48);
    expect(noVault).toHaveLength(46);
    expect(cli).toHaveLength(40);
    expect(new Set(worker.map((t) => t.name)).size).toBe(48);

    const cliNames = new Set(cli.map((t) => t.name));
    const workerOnly = worker.map((t) => t.name).filter((n) => !cliNames.has(n)).sort();
    expect(workerOnly).toEqual([
      "robynn_vault_list",
      "robynn_vault_read",
      "robynn_website_audit_orchestrator",
      "robynn_website_audit_orchestrator_status",
      "robynn_website_audit_v2",
      "robynn_website_audit_v2_status",
      "robynn_website_optimization_audit",
      "robynn_website_optimization_audit_status",
    ]);
  });

  it("records the P12 annotation catalog: 20/28 readOnly (25/23 after P07), 7 destructive, 19 openWorld, 26/16 idempotent, 48 titles", async () => {
    const { worker } = catalog;
    const count = (pred: (t: (typeof worker)[number]) => boolean) => worker.filter(pred).length;

    // 25/23 once P07 removes both hidden writes; as shipped all five † tools are pending (20/28).
    expect(count((t) => t.annotations?.readOnlyHint === true)).toBe(25 - PENDING_P07_COUNT);
    expect(count((t) => t.annotations?.readOnlyHint === false)).toBe(23 + PENDING_P07_COUNT);
    expect(count((t) => t.annotations?.destructiveHint === true)).toBe(7);
    expect(count((t) => t.annotations?.openWorldHint === true)).toBe(19);
    expect(count((t) => t.annotations?.idempotentHint === true)).toBe(26);
    expect(count((t) => t.annotations?.idempotentHint === false)).toBe(16);
    expect(count((t) => t.annotations?.idempotentHint === undefined)).toBe(6);
    expect(
      count(
        (t) =>
          typeof t.annotations?.readOnlyHint === "boolean" &&
          typeof t.annotations?.destructiveHint === "boolean" &&
          typeof t.annotations?.openWorldHint === "boolean",
      ),
    ).toBe(48);
    expect(count((t) => Boolean(t.title) && t.annotations?.title === t.title)).toBe(48);
    expect(new Set(worker.map((t) => t.title)).size).toBe(48);
  });

  it("contracts/tool-route-map.json maps every registered tool exactly once with matching hints, title, input schema and surfaces", async () => {
    const { worker } = catalog;
    const noVault = new Set(catalog.noVault.map((t) => t.name));
    const cli = new Set(catalog.cli.map((t) => t.name));

    expect(routeMap.counts).toEqual({ worker: 48, workerWithoutVault: 46, cli: 40 });
    expect(routeMap.tools.map((t) => t.name).sort()).toEqual(worker.map((t) => t.name).sort());

    for (const tool of worker) {
      const mapped = routeMap.tools.find((t) => t.name === tool.name)!;
      expect(mapped.currentHints, tool.name).toEqual(declaredHints(tool.annotations));
      expect(mapped.proposedHints, tool.name).toEqual(mapped.currentHints);
      expect(tool.title, tool.name).toBe(mapped.titleProposal);
      expect(tool.annotations?.title, tool.name).toBe(mapped.titleProposal);
      expect(schemaDigest(tool.inputSchema), `${tool.name} input schema changed`).toBe(mapped.inputSchemaDigest);
      expect(mapped.surfaces, tool.name).toEqual({
        worker: true,
        workerWithoutVault: noVault.has(tool.name),
        cli: cli.has(tool.name),
      });
    }
  });

  it("every mapped tool has a scope, a title proposal, explicit proposed hints and an app route (or an explicit null for Vault)", () => {
    for (const tool of routeMap.tools) {
      expect(["brand:read", "tools:execute"], tool.name).toContain(tool.requiredScope);
      // P13 review note 2: a pending (pre-flip) scope must already be a real scope.
      if (tool.requiredScopeAfterP07) expect(["brand:read", "tools:execute"], tool.name).toContain(tool.requiredScopeAfterP07);
      expect(tool.titleProposal.length, tool.name).toBeGreaterThan(3);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof tool.proposedHints[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
      // Anything that is not read-only needs tools:execute (read-only tools may still
      // need it when they charge, generate or reach third parties — see AUTHORIZATION_CONTRACT §7).
      if (!tool.proposedHints.readOnlyHint) expect(tool.requiredScope, tool.name).toBe("tools:execute");
      if (!tool.currentHints.readOnlyHint) expect(tool.requiredScope, tool.name).toBe("tools:execute");
      if (tool.hintsAfterP07) {
        expect(tool.conditional, `${tool.name} hintsAfterP07 needs a conditional note`).toBeTruthy();
        if (!tool.hintsAfterP07.readOnlyHint) {
          expect(tool.requiredScopeAfterP07 ?? tool.requiredScope, tool.name).toBe("tools:execute");
        }
      }
      expect(Array.isArray(tool.pairedWith), tool.name).toBe(true);
      for (const peer of tool.pairedWith) {
        expect(routeMap.tools.map((t) => t.name), `${tool.name}.pairedWith`).toContain(peer);
      }
      expect(tool.appRoutes.length, tool.name).toBeGreaterThan(0);
      for (const route of tool.appRoutes) {
        if (tool.name.startsWith("robynn_vault_")) {
          expect(route.file, tool.name).toBeNull();
        } else {
          expect(route.path, tool.name).toMatch(/^\/api\//);
        }
      }
    }
  });

  it("every app route in the map is a route the Worker client actually calls", () => {
    const clientSource = readSource("src/robynn-client.ts");
    const routes = new Set(
      routeMap.tools.flatMap((t) =>
        t.appRoutes.filter((r) => r.file !== null && r.hop !== "internal").map((r) => r.path),
      ),
    );
    for (const path of routes) {
      const literal = path.replace(/\{[^}]+\}/g, "${");
      const prefix = literal.split("${")[0];
      expect(clientSource, path).toContain(prefix);
    }
  });

  it("every app route the Worker client calls is mapped to at least one tool (reverse direction)", () => {
    const clientSource = readSource("src/robynn-client.ts");
    const normalize = (p: string) => p.replace(/\$\{[^}]+\}|\{[^}]+\}/g, "{}");
    const clientPaths = new Set(
      [...clientSource.matchAll(/["'`](\/api\/[^"'`?]+)["'`]/g)].map((m) => normalize(m[1])),
    );
    const mapped = new Set(
      routeMap.tools.flatMap((t) => t.appRoutes.filter((r) => r.file !== null).map((r) => normalize(r.path))),
    );
    expect(clientPaths.size).toBeGreaterThan(35);
    for (const path of clientPaths) expect(mapped, path).toContain(path);
  });
});

describe("P12 tool metadata (real tools/list)", () => {
  it("keeps the † tools conservative until P07 and records the post-P07 flip in the map", async () => {
    const { worker } = catalog;
    const conditional = routeMap.tools.filter((t) => t.hintsAfterP07).map((t) => t.name).sort();
    expect(conditional).toEqual(Object.keys(P07_CONDITIONAL_TOOLS).sort());

    for (const [name, expected] of Object.entries(P07_CONDITIONAL_TOOLS)) {
      const tool = worker.find((t) => t.name === name)!;
      const mapped = routeMap.tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint, name).toBe(!expected.pending);
      expect(mapped.hintsAfterP07?.readOnlyHint, name).toBe(true);
      expect(mapped.requiredScopeAfterP07, name).toBe(expected.scopeAfterP07);
      if (expected.pending) {
        expect(mapped.requiredScope, name).toBe("tools:execute");
        expect(mapped.currentHints, name).not.toEqual(mapped.hintsAfterP07);
        expect(tool.description, name).toContain(expected.marker);
      } else {
        expect(mapped.currentHints, name).toEqual(mapped.hintsAfterP07);
        expect(mapped.requiredScope, name).toBe(expected.scopeAfterP07);
        expect(tool.description, name).not.toContain(expected.marker);
      }
    }
  });

  it("names the exact poller in every starter description and the starter in every poller description", async () => {
    const { worker } = catalog;
    const description = (name: string) => worker.find((t) => t.name === name)?.description ?? "";

    for (const [starter, poller] of STARTER_POLLERS) {
      expect(description(starter), `${starter} → ${poller}`).toContain(poller);
      expect(description(poller), `${poller} ← ${starter}`).toContain(starter);
    }
  });

  it("discloses credit use, environment gates and the brand-book export semantics", async () => {
    const { worker } = catalog;

    for (const tool of worker) {
      const mapped = routeMap.tools.find((t) => t.name === tool.name)!;
      const description = tool.description ?? "";
      if (!mapped.charges.startsWith("none") && /reserv|charge/i.test(mapped.charges)) {
        expect(description, `${tool.name} must disclose credit use`).toMatch(/credit/i);
      }
      if (mapped.environmentGate?.includes("robynn-ai")) {
        expect(description, `${tool.name} must disclose the robynn-ai gate`).toContain("robynn-ai");
      }
      // Argument-dependent tools (robynn_conversations) may describe their read-only action.
      if (!tool.annotations?.readOnlyHint && !mapped.scopeByArgument) {
        expect(description, `${tool.name} is not read-only`).not.toMatch(/read-only/i);
      }
      expect(description, tool.name).not.toMatch(/Claude settings/);
    }

    const exportTool = worker.find((t) => t.name === "robynn_publish_brand_book_html")!;
    expect(exportTool.title).toBe("Export Brand Book as HTML");
    expect(exportTool.description).toMatch(/^Export /);
    expect(exportTool.description).toContain("not a publication");
  });

  // P19: the app makes a thread started over a plugin (OAuth) connection
  // private to the user (P09 PLUGIN_OAUTH_CMO_THREAD_VISIBILITY, on both the
  // threads route and cmo/run). The tools must not promise organization-wide
  // sharing to plugin users.
  it("describes new CMO threads as private on plugin connections", async () => {
    const { worker } = catalog;
    for (const name of [
      "robynn_create_content",
      "robynn_research",
      "robynn_assist",
      "robynn_cmo_agent",
      "robynn_conversations",
    ]) {
      const description = worker.find((t) => t.name === name)?.description ?? "";
      expect(description, name).toContain("private to you on plugin connections");
      expect(description, name).not.toMatch(/thread visible to your organization/);
    }
  });
});
