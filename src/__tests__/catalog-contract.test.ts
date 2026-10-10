/**
 * COS-PLUGIN-001 P13 — full catalog contract suite.
 *
 * Everything here goes through a real MCP round-trip (SDK `Client` ↔ the real
 * `RobynnMCP` Durable Object or the real `robynn mcp` CLI action; see
 * catalog-harness.ts) with the app behind a stubbed `fetch`:
 *
 *  1. Catalog: 48 tools with Vault, 46 without (unbound VAULT or no
 *     organizationId), the unauthenticated fallback, and the CLI's intentional
 *     40-tool subset with byte-identical definitions.
 *  2. Snapshot: the sanitized `tools/list` + `resources/list` is committed as
 *     contracts/mcp-tools.json; any drift fails. Regenerate deliberately with
 *     `UPDATE_MCP_TOOLS_SNAPSHOT=1 pnpm exec vitest run src/__tests__/catalog-contract.test.ts`
 *     and review the diff together with contracts/tool-route-map.json.
 *  3. Every tool: success (+ variants), upstream failure (422 and 503),
 *     permission denied (403), revoked credential (401) and inputs the Worker
 *     must refuse before any request. Vault's equivalents run against R2.
 *  4. Route attribution in both directions: per tool, the app routes it really
 *     calls equal its map `appRoutes`; globally, RobynnClient paths ↔ map ↔
 *     observed requests.
 *
 * What a "permission denied" case proves today: when the app denies (P07), the
 * tool surfaces an MCP error and starts no follow-on work. Worker-side denial
 * before any request (TOOL_POLICY from the map) is P10's and adds a case here.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

import {
  APP_BASE_URL,
  FakeApp,
  MCP_PUBLIC_BASE_URL,
  MemoryR2Bucket,
  TEST_ORG_ID,
  startCliSession,
  startWorkerSession,
  schemaDigest,
  type AppReply,
  type AppRequest,
} from "./catalog-harness";
import { P13_MARKER, TOOL_FIXTURES, genericSuccess, type ToolCall } from "./catalog-contract.fixtures";

const readSource = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

interface MappedRoute {
  method: string;
  path: string;
  file: string | null;
  hop?: "internal";
}
const routeMap = JSON.parse(readSource("contracts/tool-route-map.json")) as {
  counts: { worker: number; workerWithoutVault: number; cli: number };
  tools: Array<{
    name: string;
    registrar: string;
    appRoutes: MappedRoute[];
    requiredScope: string;
    titleProposal: string;
    currentHints: Record<string, boolean>;
    inputSchemaDigest: string;
  }>;
};
const MAPPED_TOOLS = routeMap.tools.map((t) => t.name);
const VAULT_TOOLS = ["robynn_vault_list", "robynn_vault_read"];

/**
 * The CLI's 40 tools are intentional (TOOL_CONTRACT §1): the local bridge has no
 * R2 binding, and `registerWebsiteTools(server, client, { family: "core" })`
 * keeps only the marketer website path (audit + status + strategy).
 */
const CLI_OMITTED = {
  vault: VAULT_TOOLS,
  websiteFamilyCore: [
    "robynn_website_audit_v2",
    "robynn_website_audit_v2_status",
    "robynn_website_optimization_audit",
    "robynn_website_optimization_audit_status",
    "robynn_website_audit_orchestrator",
    "robynn_website_audit_orchestrator_status",
  ],
};

const SNAPSHOT_FILE = "contracts/mcp-tools.json";
const UPDATE_SNAPSHOT = process.env.UPDATE_MCP_TOOLS_SNAPSHOT === "1";

const app = new FakeApp();
let tokenCounter = 0;

beforeAll(async () => {
  app.install();
  process.env.ROBYNN_API_BASE_URL = APP_BASE_URL;
  // Cold-import the Worker module graph (agents, OAuth provider, all tools) here, not inside
  // the first test, so its default 5 s timeout does not absorb a slow import under load.
  await import("../index");
}, 30_000);
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.ROBYNN_API_BASE_URL;
});

/** A Worker session with its own synthetic token, so its app requests are attributable. */
async function workerSession(
  responder: (request: AppRequest) => AppReply | undefined = () => undefined,
  options: Parameters<typeof startWorkerSession>[0] = {},
) {
  const token = `p13-synthetic-token-${++tokenCounter}`;
  app.respond(token, responder);
  const session = await startWorkerSession({ ...options, accessToken: token });
  return { ...session, token, requests: () => app.requestsFor(token) };
}

type CallResult = Awaited<ReturnType<Awaited<ReturnType<typeof workerSession>>["client"]["callTool"]>>;
const resultText = (result: CallResult) =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys (array order is meaningful and kept). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Environment-specific origins become placeholders; nothing else is rewritten. */
const sanitize = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(MCP_PUBLIC_BASE_URL, "{MCP_PUBLIC_BASE_URL}")
      .replaceAll(APP_BASE_URL, "{ROBYNN_API_BASE_URL}"),
  );

// ---------------------------------------------------------------------------
// 1–2. Catalog and snapshot
// ---------------------------------------------------------------------------

describe("P13 catalog through the real RobynnMCP and CLI registration paths", () => {
  it("Worker with Vault (VAULT binding + organizationId): exactly the 48 mapped tools", async () => {
    const session = await workerSession();
    const { tools } = await session.client.listTools();
    expect(session.serverInfo?.name).toBe("Robynn");
    expect(tools).toHaveLength(48);
    expect(routeMap.counts.worker).toBe(48);
    expect(tools.map((t) => t.name).sort()).toEqual([...MAPPED_TOOLS].sort());
    await session.close();
  });

  it("Worker without Vault: 46 tools when VAULT is unbound", async () => {
    const expected = MAPPED_TOOLS.filter((name) => !VAULT_TOOLS.includes(name));
    const session = await workerSession(undefined, { vault: false });
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(expected.sort());
    await session.close();
    expect(routeMap.counts.workerWithoutVault).toBe(46);
  });

  it("props without organizationId are refused by the P10 session binding: only the fallback robynn_status", async () => {
    // P10: a session binds {hostGrantId, userId, organizationId, appGrantId};
    // incomplete props are never adopted, so no app-backed or Vault tool registers.
    const session = await workerSession(undefined, { organizationId: null });
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["robynn_status"]);
    await session.close();
  });

  it("unauthenticated session (no access token): only the fallback robynn_status, which fails without calling the app", async () => {
    const session = await startWorkerSession({ accessToken: null });
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["robynn_status"]);
    const before = app.requests.length;
    const result = await session.client.callTool({ name: "robynn_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(app.requests.length).toBe(before);
    await session.close();
  });

  it("CLI (`robynn mcp`): the intentional 40-tool subset, with definitions identical to the Worker's", async () => {
    const worker = await workerSession();
    const workerTools = (await worker.client.listTools()).tools;
    const cli = await startCliSession();
    const cliTools = (await cli.client.listTools()).tools;

    expect(cli.client.getServerVersion()?.name).toBe("Robynn (Local CLI)");
    expect(cliTools).toHaveLength(40);
    expect(routeMap.counts.cli).toBe(40);
    const omitted = [...CLI_OMITTED.vault, ...CLI_OMITTED.websiteFamilyCore];
    expect(cliTools.map((t) => t.name)).toEqual(workerTools.map((t) => t.name).filter((n) => !omitted.includes(n)));
    for (const tool of cliTools) {
      expect(tool, tool.name).toEqual(workerTools.find((t) => t.name === tool.name));
    }
    // Known gap, recorded for follow-up (TOOL_CONTRACT §7): the CLI registers no report resources,
    // so its app tools reference ui://reports/* URIs it cannot serve; hosts fall back to the text result.
    expect(cli.client.getServerCapabilities()?.resources).toBeUndefined();
    expect(cliTools.filter((t) => (t._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri)).toHaveLength(14);

    // The CLI reaches the app with its configured key through the same RobynnClient.
    app.respond("p13-synthetic-cli-key", () => ({ body: genericSuccess() }));
    const status = await cli.client.callTool({ name: "robynn_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(app.requestsFor("p13-synthetic-cli-key").map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/cli/context/summary",
    ]);
    await Promise.all([worker.close(), cli.close()]);
  });

  it("every report resource a tool references is served by the Worker's resources/list", async () => {
    const session = await workerSession();
    const { tools } = await session.client.listTools();
    const { resources } = await session.client.listResources();
    const served = new Set(resources.map((r) => r.uri));
    const referenced = tools
      .map((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)
      .filter((uri): uri is string => Boolean(uri));
    expect(referenced.length).toBeGreaterThan(0);
    for (const uri of referenced) expect(served, uri).toContain(uri);
    await session.close();
  });

  it(`matches the committed sanitized snapshot ${SNAPSHOT_FILE}`, async () => {
    const worker = await workerSession();
    const fallback = await startWorkerSession({ accessToken: null });
    const snapshot = sortKeys(
      sanitize({
        $comment:
          "COS-PLUGIN-001 P13: sanitized real tools/list + resources/list of the RobynnMCP Worker (VAULT bound, organizationId present). Generated by src/__tests__/catalog-contract.test.ts; do not edit by hand. Regenerate with UPDATE_MCP_TOOLS_SNAPSHOT=1 and review together with contracts/tool-route-map.json. Origins are placeholders; the server version is omitted.",
        server: { name: worker.serverInfo?.name, instructions: worker.client.getInstructions() ?? null },
        counts: { worker: 48, workerWithoutVault: 46, cli: 40, unauthenticatedFallback: 1 },
        surfaces: { workerOnlyWithVault: VAULT_TOOLS, cliOmitted: CLI_OMITTED },
        tools: (await worker.client.listTools()).tools,
        resources: (await worker.client.listResources()).resources,
        unauthenticatedFallback: { tools: (await fallback.client.listTools()).tools },
      }),
    );
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    await Promise.all([worker.close(), fallback.close()]);

    // Sanitization guard: no synthetic credential, bearer or test origin may reach the file.
    expect(serialized).not.toMatch(/p13-synthetic|Bearer |robynn\.test|eyJ[A-Za-z0-9_-]{10,}/);

    if (UPDATE_SNAPSHOT) writeFileSync(join(process.cwd(), SNAPSHOT_FILE), serialized);
    const committed = readSource(SNAPSHOT_FILE);
    expect(
      serialized === committed,
      `${SNAPSHOT_FILE} drifted from the real tools/list; regenerate with UPDATE_MCP_TOOLS_SNAPSHOT=1 and review the diff`,
    ).toBe(true);
  });

  it(`${SNAPSHOT_FILE} and contracts/tool-route-map.json agree on names, titles, hints and input schemas`, () => {
    const snapshot = JSON.parse(readSource(SNAPSHOT_FILE)) as {
      counts: Record<string, number>;
      tools: Array<{ name: string; title: string; annotations: Record<string, unknown>; inputSchema: unknown }>;
    };
    expect(snapshot.counts).toMatchObject(routeMap.counts);
    expect(snapshot.tools.map((t) => t.name).sort()).toEqual([...MAPPED_TOOLS].sort());
    for (const tool of snapshot.tools) {
      const mapped = routeMap.tools.find((t) => t.name === tool.name)!;
      const { title, ...hints } = tool.annotations;
      expect(tool.title, tool.name).toBe(mapped.titleProposal);
      expect(title, tool.name).toBe(mapped.titleProposal);
      expect(hints, tool.name).toEqual(mapped.currentHints);
      expect(schemaDigest(tool.inputSchema), tool.name).toBe(mapped.inputSchemaDigest);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Every tool: success, upstream failure, permission denied, revoked, refused input
// ---------------------------------------------------------------------------

const routeKey = (method: string, path: string) => `${method} ${path}`;
const templateRegex = (path: string) => new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
const mappedRoutes = (name: string) =>
  routeMap.tools.find((t) => t.name === name)!.appRoutes.filter((r) => r.file !== null && r.hop !== "internal");
const matchRoute = (name: string, request: AppRequest) =>
  mappedRoutes(name).find((r) => r.method === request.method && templateRegex(r.path).test(request.path));

const stringArgs = (args: Record<string, unknown>) =>
  Object.values(args).filter((v): v is string => typeof v === "string");

/** Runs a tool's default call and success variants, each in its own session against a succeeding app. */
async function runSuccessCalls(name: string) {
  const fixture = TOOL_FIXTURES[name];
  const reply = (request: AppRequest): AppReply => ({ body: (fixture.reply ?? genericSuccess)(request) });
  const calls: ToolCall[] = [{ label: "default", args: fixture.args, forwards: fixture.forwards }, ...(fixture.variants ?? [])];
  const outcomes = [];
  for (const call of calls) {
    const session = await workerSession(reply);
    const result = await session.client.callTool({ name, arguments: call.args });
    outcomes.push({ call, result, requests: session.requests() });
    await session.close();
  }
  return outcomes;
}

const appTools = MAPPED_TOOLS.filter((name) => !VAULT_TOOLS.includes(name));

describe("P13 per-tool contract (app-backed tools)", () => {
  it("has a fixture for every mapped tool and no stale fixtures", () => {
    expect(Object.keys(TOOL_FIXTURES).sort()).toEqual([...MAPPED_TOOLS].sort());
  });

  describe.each(appTools)("%s", (name) => {
    const fixture = TOOL_FIXTURES[name];
    const reply = (request: AppRequest): AppReply => ({ body: (fixture.reply ?? genericSuccess)(request) });

    it("success: returns the app's data, sends the bearer, forwards its arguments and calls only mapped routes", async () => {
      const reached = new Set<string>();
      for (const { call, result, requests } of await runSuccessCalls(name)) {
        const label = `${name} (${call.label})`;

        expect(result.isError, `${label}: ${resultText(result)}`).toBeFalsy();
        expect(JSON.stringify([result.content, result.structuredContent]), label).toContain(P13_MARKER);
        expect(requests.length, label).toBeGreaterThan(0);
        for (const request of requests) {
          const route = matchRoute(name, request);
          expect(route, `${label}: unmapped ${routeKey(request.method, request.path)}`).toBeDefined();
          reached.add(routeKey(route!.method, route!.path));
        }
        const sent = JSON.stringify(requests.map((r) => [r.path, r.query, r.body]));
        for (const value of call.forwards ?? stringArgs(call.args)) {
          expect(sent, `${label} must forward ${value}`).toContain(value);
        }
      }
      // Per-tool attribution, both directions: what it calls == what the map says.
      expect([...reached].sort()).toEqual(mappedRoutes(name).map((r) => routeKey(r.method, r.path)).sort());
    });

    it.each([
      { label: "upstream failure (422)", status: 422, body: { error: "p13_upstream_failure" } },
      { label: "permission denied (403 insufficient_scope)", status: 403, body: { error: "insufficient_scope" } },
      { label: "revoked credential (401)", status: 401, body: { error: "invalid_token" } },
    ])("$label: MCP error after exactly one request, no follow-on work", async ({ status, body }) => {
      const session = await workerSession(() => ({ status, body }));
      const result = await session.client.callTool({ name, arguments: fixture.args });
      expect(result.isError, resultText(result)).toBe(true);
      expect(resultText(result).length).toBeGreaterThan(0);
      expect(session.requests()).toHaveLength(1);
      expect(matchRoute(name, session.requests()[0])).toBeDefined();
      await session.close();
    });

    if (fixture.rejected?.length) {
      it.each(fixture.rejected)("refuses $label before any request", async ({ args, reason }) => {
        const session = await workerSession(reply);
        const result = await session.client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toMatch(reason);
        expect(session.requests()).toEqual([]);
        await session.close();
      });
    }
  });

  it("upstream failure (503, after the client's current single retry): every app-backed tool returns an MCP error", async () => {
    // Concurrent: RobynnClient waits 1 s before its one 5xx retry (P11 changes retry policy per tool).
    const outcomes = await Promise.all(
      appTools.map(async (name) => {
        const session = await workerSession(() => ({ status: 503, body: { error: "p13_unavailable" } }));
        const result = await session.client.callTool({ name, arguments: TOOL_FIXTURES[name].args });
        await session.close();
        return { name, isError: result.isError === true, requests: session.requests().length };
      }),
    );
    for (const outcome of outcomes) {
      expect(outcome.isError, outcome.name).toBe(true);
      expect(outcome.requests, outcome.name).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe("P13 per-tool contract (Vault tools against R2)", () => {
  const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const seededBucket = () => {
    const bucket = new MemoryR2Bucket();
    bucket.objects.set(`orgs/${TEST_ORG_ID}/brand/voice.md`, `# Voice ${P13_MARKER}`);
    bucket.objects.set(`orgs/${OTHER_ORG}/brand/voice.md`, "# Other org voice p13-foreign");
    return bucket;
  };

  describe.each(VAULT_TOOLS)("%s", (name) => {
    const fixture = TOOL_FIXTURES[name];

    it("success: reads only under orgs/<bound org>/ and never returns another org's object", async () => {
      const bucket = seededBucket();
      const session = await workerSession(undefined, { bucket });
      const result = await session.client.callTool({ name, arguments: fixture.args });
      expect(result.isError, resultText(result)).toBeFalsy();
      expect(JSON.stringify([result.content, result.structuredContent])).toContain(
        name === "robynn_vault_list" ? "brand/voice.md" : P13_MARKER,
      );
      expect(JSON.stringify(result)).not.toMatch(/p13-foreign|bbbbbbbb-bbbb/);
      expect(bucket.calls.length).toBeGreaterThan(0);
      for (const call of bucket.calls) expect(call.key.startsWith(`orgs/${TEST_ORG_ID}/`), call.key).toBe(true);
      expect(session.requests()).toEqual([]);
      await session.close();
    });

    it("upstream failure: an R2 error becomes an MCP error", async () => {
      const bucket = seededBucket();
      bucket.failWith = new Error("p13 r2 unavailable");
      const session = await workerSession(undefined, { bucket });
      const result = await session.client.callTool({ name, arguments: fixture.args });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("p13 r2 unavailable");
      await session.close();
    });

    it.each(fixture.rejected ?? [])("permission denied: refuses $label before any R2 call", async ({ args, reason }) => {
      const bucket = seededBucket();
      const session = await workerSession(undefined, { bucket });
      const result = await session.client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(reason);
      expect(bucket.calls).toEqual([]);
      await session.close();
    });
  });

  it("robynn_vault_read reports a missing object as not_found rather than an error", async () => {
    const session = await workerSession(undefined, { bucket: new MemoryR2Bucket() });
    const result = await session.client.callTool({ name: "robynn_vault_read", arguments: { path: "brand/none.md" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ not_found: true, path: "brand/none.md" });
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Route coverage in both directions: RobynnClient paths ↔ map ↔ observed calls
// ---------------------------------------------------------------------------

describe("P13 route attribution (RobynnClient ↔ map ↔ observed tool calls)", () => {
  const normalize = (path: string) => path.replace(/\$\{[^}]+\}|\{[^}]+\}/g, "{}");
  const clientPaths = () =>
    new Set(
      [...readSource("src/robynn-client.ts").matchAll(/["'`](\/api\/[^"'`?]+)["'`]/g)].map((m) => normalize(m[1])),
    );
  const mapPaths = () =>
    new Set(routeMap.tools.flatMap((t) => mappedRoutes(t.name).map((r) => normalize(r.path))));

  it("every path RobynnClient can call is mapped, and every mapped path is in RobynnClient", () => {
    const client = clientPaths();
    const mapped = mapPaths();
    expect(client.size).toBeGreaterThan(35);
    expect([...client].filter((p) => !mapped.has(p)), "client paths missing from the map").toEqual([]);
    expect([...mapped].filter((p) => !client.has(p)), "mapped paths RobynnClient never calls").toEqual([]);
  });

  it("every RobynnClient path is reached by at least one tool's success call, and nothing else is", async () => {
    // Self-contained (order-independent): re-runs every tool's success calls concurrently.
    const perTool = await Promise.all(appTools.map(async (name) => ({ name, outcomes: await runSuccessCalls(name) })));
    const observed = new Set(
      perTool.flatMap(({ name, outcomes }) =>
        outcomes.flatMap(({ requests }) => requests.map((r) => normalize(matchRoute(name, r)?.path ?? r.path))),
      ),
    );
    expect([...clientPaths()].sort()).toEqual([...observed].sort());
  });
});
