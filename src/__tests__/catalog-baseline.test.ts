/**
 * COS-PLUGIN-001 P01 — catalog baseline.
 *
 * Recounts the tool catalog from the real registration code paths through a
 * real MCP `tools/list` round-trip (SDK Client ↔ McpServer over an in-memory
 * transport), and checks that contracts/tool-route-map.json covers exactly the
 * registered tools with the annotations the code currently declares.
 *
 * The registrar call order is parsed from `RobynnMCP.init()` (src/index.ts)
 * and the CLI `mcp` command (src/cli/index.ts) so the counts cannot drift
 * from the shipped wiring. P12 applied the titles, hints and descriptions;
 * annotation expectations here change together with the map.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAssistTools } from "../tools/assist";
import { registerBattlecardTools } from "../tools/battlecard";
import { BRAND_BOOK_READS_PERSIST_COMPLETENESS, registerBrandBookTools } from "../tools/brand-book";
import { registerBrandOperationTools } from "../tools/brand-operations";
import { registerCampaignTools } from "../tools/campaign";
import { registerCapabilityTools } from "../tools/capabilities";
import { registerCmoAgentTools } from "../tools/cmo-agent";
import { registerCmoDecideTools } from "../tools/cmo-decide";
import { registerConnectorActionTools } from "../tools/connector-act";
import { registerConnectorTools } from "../tools/connectors";
import { registerContentPlanTools } from "../tools/content-plan";
import { registerContentTools } from "../tools/content";
import { registerContextTools } from "../tools/context";
import { registerConversationTools } from "../tools/conversations";
import { registerGeoTools } from "../tools/geo";
import { registerHermesBridgeTools } from "../tools/hermes-bridge";
import { registerResearchTools } from "../tools/research";
import { registerRunTools } from "../tools/runs";
import { registerSeoTools } from "../tools/seo";
import { registerStatusTools } from "../tools/status";
import { registerStrapiTools } from "../tools/strapi";
import { registerVaultTools } from "../tools/vault";
import { registerWebsiteTools } from "../tools/website";
import { registerWeeklyVisibilityTools } from "../tools/weekly-visibility";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Registrar = (server: McpServer, dep: never, options?: any) => void;

const REGISTRARS: Record<string, Registrar> = {
  registerAssistTools,
  registerBattlecardTools,
  registerBrandBookTools,
  registerBrandOperationTools,
  registerCampaignTools,
  registerCapabilityTools,
  registerCmoAgentTools,
  registerCmoDecideTools,
  registerConnectorActionTools,
  registerConnectorTools,
  registerContentPlanTools,
  registerContentTools,
  registerContextTools,
  registerConversationTools,
  registerGeoTools,
  registerHermesBridgeTools,
  registerResearchTools,
  registerRunTools,
  registerSeoTools,
  registerStatusTools,
  registerStrapiTools,
  registerVaultTools,
  registerWebsiteTools,
  registerWeeklyVisibilityTools,
};

interface RegistrarCall {
  name: string;
  coreWebsiteFamily: boolean;
}

const readSource = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Registrar calls in source order, e.g. `registerWebsiteTools(server, client, { family: "core" })`. */
function parseRegistrarCalls(source: string, serverExpr: string): RegistrarCall[] {
  const escaped = serverExpr.replace(/\./g, "\\.");
  const pattern = new RegExp(`(register\\w+Tools)\\(\\s*${escaped}\\s*,([^;]*)\\);`, "g");
  return [...source.matchAll(pattern)].map((m) => ({
    name: m[1],
    coreWebsiteFamily: /family:\s*"core"/.test(m[2]),
  }));
}

async function listTools(calls: RegistrarCall[], opts: { vault: boolean }) {
  const server = new McpServer({ name: "catalog-baseline", version: "0.0.0" });
  for (const call of calls) {
    if (call.name === "registerVaultTools" && !opts.vault) continue;
    const register = REGISTRARS[call.name];
    expect(register, `unknown registrar ${call.name}`).toBeTypeOf("function");
    register(server, {} as never, call.coreWebsiteFamily ? { family: "core" } : undefined);
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "catalog-baseline-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const workerCalls = parseRegistrarCalls(readSource("src/index.ts"), "this.server");
const cliCalls = parseRegistrarCalls(readSource("src/cli/index.ts"), "server");

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
  scopeByArgument?: Record<string, Record<string, string>>;
  appRoutes: Array<{ method: string; path: string; file: string | null; hop?: "internal" }>;
  titleProposal: string;
  inputSchemaDigest: string;
  charges: string;
  environmentGate: string | null;
}

/** Sorted-key compact JSON without string-valued `description` keys (see the map's $comment). */
function canonicalSchemaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSchemaJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => !(key === "description" && typeof record[key] === "string"))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSchemaJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const schemaDigest = (schema: unknown) =>
  `sha256:${createHash("sha256").update(canonicalSchemaJson(schema)).digest("hex")}`;

const declaredHints = (annotations: Record<string, unknown> | undefined): Hints => {
  const hints: Hints = {
    readOnlyHint: annotations?.readOnlyHint as boolean,
    destructiveHint: annotations?.destructiveHint as boolean,
    openWorldHint: annotations?.openWorldHint as boolean,
  };
  if (annotations?.idempotentHint !== undefined) hints.idempotentHint = annotations.idempotentHint as boolean;
  return hints;
};

/** † tools: read-only only once P07 removes the hidden brand-book completeness write. */
const BRAND_BOOK_CONDITIONAL_TOOLS = [
  "robynn_brand_book_gap_analysis",
  "robynn_brand_book_status",
  "robynn_brand_book_strategy",
  "robynn_publish_brand_book_html",
];

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

const routeMap = JSON.parse(readSource("contracts/tool-route-map.json")) as {
  counts: { worker: number; workerWithoutVault: number; cli: number };
  tools: RouteMapTool[];
};

describe("P01 catalog baseline (real tools/list)", () => {
  it("parses the registrar wiring from RobynnMCP.init() and the CLI mcp command", () => {
    expect(workerCalls).toHaveLength(24);
    expect(workerCalls.at(-1)?.name).toBe("registerVaultTools");
    expect(cliCalls).toHaveLength(23);
    expect(cliCalls.filter((c) => c.coreWebsiteFamily).map((c) => c.name)).toEqual(["registerWebsiteTools"]);
    expect(cliCalls.map((c) => c.name)).not.toContain("registerVaultTools");
  });

  it("counts 48 Worker tools with Vault, 46 without, 40 in the local CLI", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const noVault = await listTools(workerCalls, { vault: false });
    const cli = await listTools(cliCalls, { vault: false });

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

  it("records the P12 annotation catalog: 21/27 readOnly, 7 destructive, 19 openWorld, 26/16 idempotent, 48 titles", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const count = (pred: (t: (typeof worker)[number]) => boolean) => worker.filter(pred).length;

    // P01 proposed 25/23; the four † brand-book tools stay non-read-only until P07 lands.
    expect(BRAND_BOOK_READS_PERSIST_COMPLETENESS).toBe(true);
    expect(count((t) => t.annotations?.readOnlyHint === true)).toBe(21);
    expect(count((t) => t.annotations?.readOnlyHint === false)).toBe(27);
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
    const worker = await listTools(workerCalls, { vault: true });
    const noVault = new Set((await listTools(workerCalls, { vault: false })).map((t) => t.name));
    const cli = new Set((await listTools(cliCalls, { vault: false })).map((t) => t.name));

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
      expect(tool.titleProposal.length, tool.name).toBeGreaterThan(3);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof tool.proposedHints[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
      // Anything that is not read-only needs tools:execute (read-only tools may still
      // need it when they charge, generate or reach third parties — see AUTHORIZATION_CONTRACT §7).
      if (!tool.proposedHints.readOnlyHint) expect(tool.requiredScope, tool.name).toBe("tools:execute");
      if (!tool.currentHints.readOnlyHint) expect(tool.requiredScope, tool.name).toBe("tools:execute");
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
});

describe("P12 tool metadata (real tools/list)", () => {
  it("keeps the † brand-book tools conservative until P07 and records the post-P07 flip in the map", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const conditional = routeMap.tools.filter((t) => t.hintsAfterP07).map((t) => t.name).sort();
    expect(conditional).toEqual(BRAND_BOOK_CONDITIONAL_TOOLS);

    for (const name of BRAND_BOOK_CONDITIONAL_TOOLS) {
      const tool = worker.find((t) => t.name === name)!;
      const mapped = routeMap.tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint, name).toBe(!BRAND_BOOK_READS_PERSIST_COMPLETENESS);
      expect(mapped.requiredScope, name).toBe("tools:execute");
      expect(mapped.hintsAfterP07?.readOnlyHint, name).toBe(true);
      expect(mapped.requiredScopeAfterP07, name).toBe("brand:read");
      expect(tool.description, name).toContain("brand-completeness summary");
    }
  });

  it("names the exact poller in every starter description and the starter in every poller description", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const description = (name: string) => worker.find((t) => t.name === name)?.description ?? "";

    for (const [starter, poller] of STARTER_POLLERS) {
      expect(description(starter), `${starter} → ${poller}`).toContain(poller);
      expect(description(poller), `${poller} ← ${starter}`).toContain(starter);
    }
  });

  it("discloses credit use, environment gates and the brand-book export semantics", async () => {
    const worker = await listTools(workerCalls, { vault: true });

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
});
