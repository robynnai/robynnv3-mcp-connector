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
 * from the shipped wiring. P12 is expected to change the annotation
 * expectations here together with the map.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAssistTools } from "../tools/assist";
import { registerBattlecardTools } from "../tools/battlecard";
import { registerBrandBookTools } from "../tools/brand-book";
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

interface RouteMapTool {
  name: string;
  surfaces: { worker: boolean; workerWithoutVault: boolean; cli: boolean };
  currentHints: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  proposedHints: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  };
  requiredScope: "brand:read" | "tools:execute";
  hintsAfterP07?: RouteMapTool["proposedHints"];
  conditional?: string;
  appRoutes: Array<{ method: string; path: string; file: string | null; hop?: "internal" }>;
  titleProposal: string;
  pairedWith: string[];
}

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

  it("records the current (pre-P12) annotation baseline: 31/17 readOnly, 1 destructive, 14 openWorld, 0 titles", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const count = (pred: (t: (typeof worker)[number]) => boolean) => worker.filter(pred).length;

    expect(count((t) => t.annotations?.readOnlyHint === true)).toBe(31);
    expect(count((t) => t.annotations?.readOnlyHint === false)).toBe(17);
    expect(count((t) => t.annotations?.destructiveHint === true)).toBe(1);
    expect(count((t) => t.annotations?.openWorldHint === true)).toBe(14);
    expect(count((t) => t.annotations?.idempotentHint !== undefined)).toBe(0);
    expect(
      count(
        (t) =>
          typeof t.annotations?.readOnlyHint === "boolean" &&
          typeof t.annotations?.destructiveHint === "boolean" &&
          typeof t.annotations?.openWorldHint === "boolean",
      ),
    ).toBe(48);
    expect(count((t) => Boolean(t.title) || Boolean(t.annotations?.title))).toBe(0);
  });

  it("contracts/tool-route-map.json maps every registered tool exactly once with matching current hints and surfaces", async () => {
    const worker = await listTools(workerCalls, { vault: true });
    const noVault = new Set((await listTools(workerCalls, { vault: false })).map((t) => t.name));
    const cli = new Set((await listTools(cliCalls, { vault: false })).map((t) => t.name));

    expect(routeMap.counts).toEqual({ worker: 48, workerWithoutVault: 46, cli: 40 });
    expect(routeMap.tools.map((t) => t.name).sort()).toEqual(worker.map((t) => t.name).sort());

    for (const tool of worker) {
      const mapped = routeMap.tools.find((t) => t.name === tool.name)!;
      expect(mapped.currentHints, tool.name).toEqual({
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
        openWorldHint: tool.annotations?.openWorldHint,
      });
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
      if (tool.hintsAfterP07) {
        expect(tool.conditional, `${tool.name} hintsAfterP07 needs a conditional note`).toBeTruthy();
        if (!tool.hintsAfterP07.readOnlyHint) expect(tool.requiredScope, tool.name).toBe("tools:execute");
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
