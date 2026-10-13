/**
 * COS-PLUGIN-002 WP2-11 — the remaining seven named discoverability tools
 * (propose, check, create, status, results, promote, rollback).
 *
 * 1. Schema equivalence: one positive/negative corpus checked against (a) the
 *    registered Zod schemas, (b) the draft-07 JSON Schemas the real
 *    `tools/list` publishes and (c) the WP2-01 semantic bundle
 *    contracts/discoverability-tools.v1.json. All three agree; the one
 *    documented exception is robynn_experiment_status's oneOf (exactly one of
 *    experiment_id / website_id; limit/cursor only with website_id), which the
 *    SDK's object-only input conversion cannot publish: the Worker handler
 *    refuses those calls before any request, and the app refuses them again.
 * 2. tools/list shape: titles, T/F/F/T reads and F/F/F/T request writes
 *    (rollback is a request only: tool-contracts.md supersedes the plan's
 *    F/T/T), closed inputs, required idempotency keys, disclosure wording.
 * 3. Real tools/call: bare success objects pass unchanged; the app's
 *    write-path codes (validation_failed, design_ineligible, proposal_stale,
 *    conflict, idempotency_*, environment_not_eligible) stay structured with
 *    their bounded detail; nothing else is forwarded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { ZodTypeAny } from "zod";
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

import { APP_BASE_URL, FakeApp, startWorkerSession, type AppReply, type AppRequest } from "../__tests__/catalog-harness";
import { discoverabilityWriteReplies, WP2_11_IDS } from "../__tests__/catalog-contract.fixtures";
import { WRITE_DISCLOSURE } from "./discoverability";
import {
  checkPageContentInputSchema,
  checkPageContentOutputSchema,
  createExperimentInputSchema,
  createExperimentOutputSchema,
  experimentResultsInputSchema,
  experimentResultsOutputSchema,
  experimentStatusInputSchema,
  experimentStatusOutputSchema,
  experimentStatusSelection,
  promoteExperimentInputSchema,
  promoteExperimentOutputSchema,
  proposeExperimentsInputSchema,
  proposeExperimentsOutputSchema,
  rollbackExperimentInputSchema,
  rollbackExperimentOutputSchema,
} from "./discoverability-schemas";

const TOOLS = [
  "robynn_propose_experiments",
  "robynn_check_page_content",
  "robynn_create_experiment",
  "robynn_experiment_status",
  "robynn_experiment_results",
  "robynn_promote_experiment",
  "robynn_rollback_experiment",
] as const;
type ToolName = (typeof TOOLS)[number];
const READS: ToolName[] = [
  "robynn_propose_experiments",
  "robynn_check_page_content",
  "robynn_experiment_status",
  "robynn_experiment_results",
];
const WRITES: ToolName[] = ["robynn_create_experiment", "robynn_promote_experiment", "robynn_rollback_experiment"];

const ZOD: Record<ToolName, { input: ZodTypeAny; output: ZodTypeAny }> = {
  robynn_propose_experiments: { input: proposeExperimentsInputSchema, output: proposeExperimentsOutputSchema },
  robynn_check_page_content: { input: checkPageContentInputSchema, output: checkPageContentOutputSchema },
  robynn_create_experiment: { input: createExperimentInputSchema, output: createExperimentOutputSchema },
  robynn_experiment_status: { input: experimentStatusInputSchema, output: experimentStatusOutputSchema },
  robynn_experiment_results: { input: experimentResultsInputSchema, output: experimentResultsOutputSchema },
  robynn_promote_experiment: { input: promoteExperimentInputSchema, output: promoteExperimentOutputSchema },
  robynn_rollback_experiment: { input: rollbackExperimentInputSchema, output: rollbackExperimentOutputSchema },
};

const W = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const E = WP2_11_IDS.EXPERIMENT_ID;
const B = WP2_11_IDS.BINDING_ID;
const H = WP2_11_IDS.HASH_A;
const KEY = "wp211_idempotency_01";
const change = (over: Record<string, unknown> = {}) => ({
  page_path: "/blog/a",
  field: "faq",
  content: "<section id=\"faq\"><h2>FAQ</h2></section>",
  before_hash: H,
  delivery_binding_id: B,
  ...over,
});
const create = (over: Record<string, unknown> = {}) => ({
  website_id: W,
  type: "faq",
  hypothesis: "An FAQ raises citations.",
  changes: [change()],
  idempotency_key: KEY,
  ...over,
});

/** [label, value, accepted?] */
type Case = [string, unknown, boolean];

const INPUT_CORPUS: Record<ToolName, Case[]> = {
  robynn_propose_experiments: [
    ["minimal", { website_id: W, goal: "geo_citation_rate" }, true],
    ["all fields", { website_id: W, goal: "seo_ctr", types: ["title_meta", "faq"], max: 10 }, true],
    ["eight types", { website_id: W, goal: "seo_clicks", types: ["title_meta", "answer_first", "evidence_block", "faq", "brand_fact", "structured_data", "internal_links", "comparison_page"] }, true],
    ["missing goal", { website_id: W }, false],
    ["unknown goal", { website_id: W, goal: "conversions" }, false],
    ["empty types", { website_id: W, goal: "seo_ctr", types: [] }, false],
    ["unknown type", { website_id: W, goal: "seo_ctr", types: ["popup"] }, false],
    ["max zero", { website_id: W, goal: "seo_ctr", max: 0 }, false],
    ["max eleven", { website_id: W, goal: "seo_ctr", max: 11 }, false],
    ["identity argument", { website_id: W, goal: "seo_ctr", organization_id: W }, false],
  ],
  robynn_check_page_content: [
    ["minimal", { website_id: W, page_path: "/pricing", draft: "Draft" }, true],
    ["root path", { website_id: W, page_path: "/", draft: "x" }, true],
    ["missing draft", { website_id: W, page_path: "/a" }, false],
    ["empty draft", { website_id: W, page_path: "/a", draft: "" }, false],
    ["draft over 100000", { website_id: W, page_path: "/a", draft: "x".repeat(100_001) }, false],
    ["relative path", { website_id: W, page_path: "pricing", draft: "x" }, false],
    ["protocol-relative path", { website_id: W, page_path: "//evil.example/x", draft: "x" }, false],
    ["path with query", { website_id: W, page_path: "/a?b=1", draft: "x" }, false],
    ["path with fragment", { website_id: W, page_path: "/a#b", draft: "x" }, false],
    ["path with backslash", { website_id: W, page_path: "/a\\b", draft: "x" }, false],
    ["url argument", { website_id: W, page_path: "/a", draft: "x", url: "https://evil.example" }, false],
  ],
  robynn_create_experiment: [
    ["minimal", create(), true],
    ["all fields", create({ proposal_id: H, primary_metric: "geo_mention_rate", changes: [change({ selector: "#faq", claim_version_ids: [B] })] }), true],
    ["100 changes", create({ changes: Array.from({ length: 100 }, (_, i) => change({ page_path: `/p${i}` })) }), true],
    ["missing idempotency key", (() => { const v = create(); delete (v as Record<string, unknown>).idempotency_key; return v; })(), false],
    ["short idempotency key", create({ idempotency_key: "short" }), false],
    ["idempotency key with space", create({ idempotency_key: "has space in it 123" }), false],
    ["no changes", create({ changes: [] }), false],
    ["101 changes", create({ changes: Array.from({ length: 101 }, (_, i) => change({ page_path: `/p${i}` })) }), false],
    ["unknown field", create({ changes: [change({ field: "footer" })] }), false],
    ["change without before_hash", create({ changes: [(() => { const c = change(); delete (c as Record<string, unknown>).before_hash; return c; })()] }), false],
    ["uppercase before_hash", create({ changes: [change({ before_hash: "A".repeat(64) })] }), false],
    ["non-uuid binding", create({ changes: [change({ delivery_binding_id: "wp-1" })] }), false],
    ["51 claim versions", create({ changes: [change({ claim_version_ids: Array.from({ length: 51 }, () => B) })] }), false],
    ["extra change key", create({ changes: [change({ publish: true })] }), false],
    ["bad proposal id", create({ proposal_id: "p-1" }), false],
    ["unknown type", create({ type: "popup" }), false],
    ["hypothesis over 2000", create({ hypothesis: "h".repeat(2001) }), false],
    ["identity argument", create({ user_id: W }), false],
  ],
  robynn_experiment_status: [
    ["by experiment", { experiment_id: E }, true],
    ["by website", { website_id: W }, true],
    ["by website with page", { website_id: W, limit: 50, cursor: "c" }, true],
    ["non-uuid experiment", { experiment_id: "exp-1" }, false],
    ["limit zero", { website_id: W, limit: 0 }, false],
    ["limit 51", { website_id: W, limit: 51 }, false],
    ["overlong cursor", { website_id: W, cursor: "c".repeat(513) }, false],
    ["unknown argument", { website_id: W, run_id: E }, false],
  ],
  robynn_experiment_results: [
    ["minimal", { experiment_id: E }, true],
    ["missing id", {}, false],
    ["non-uuid", { experiment_id: "x" }, false],
    ["unknown argument", { experiment_id: E, finalize: true }, false],
  ],
  robynn_promote_experiment: [
    ["similar pages", { experiment_id: E, scope: "all_similar_pages", idempotency_key: KEY }, true],
    ["treated pages", { experiment_id: E, scope: "treated_pages", idempotency_key: KEY }, true],
    ["missing scope", { experiment_id: E, idempotency_key: KEY }, false],
    ["unknown scope", { experiment_id: E, scope: "future_pages", idempotency_key: KEY }, false],
    ["missing key", { experiment_id: E, scope: "treated_pages" }, false],
    ["target list argument", { experiment_id: E, scope: "treated_pages", idempotency_key: KEY, pages: ["/a"] }, false],
  ],
  robynn_rollback_experiment: [
    ["minimal", { experiment_id: E, reason: "Harm alert", confirm: true, idempotency_key: KEY }, true],
    ["confirm false", { experiment_id: E, reason: "r", confirm: false, idempotency_key: KEY }, false],
    ["confirm string", { experiment_id: E, reason: "r", confirm: "true", idempotency_key: KEY }, false],
    ["missing confirm", { experiment_id: E, reason: "r", idempotency_key: KEY }, false],
    ["empty reason", { experiment_id: E, reason: "", confirm: true, idempotency_key: KEY }, false],
    ["reason over 2000", { experiment_id: E, reason: "r".repeat(2001), confirm: true, idempotency_key: KEY }, false],
    ["execute argument", { experiment_id: E, reason: "r", confirm: true, idempotency_key: KEY, execute: true }, false],
  ],
};

/** Status inputs the published draft-07 schema accepts but the spec's oneOf refuses. */
const ONE_OF_CASES: Array<[string, Record<string, unknown>]> = [
  ["both ids", { experiment_id: E, website_id: W }],
  ["neither id", {}],
];

const R = discoverabilityWriteReplies;
function mutate<T>(value: T, change: (copy: any) => void): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

const OUTPUT_CORPUS: Record<ToolName, Case[]> = {
  robynn_propose_experiments: [
    ["bare success", R.proposeExperiments(), true],
    ["no proposals", { ...R.proposeExperiments(), proposals: [] }, true],
    ["ok/data wrapper", { ok: true, data: R.proposeExperiments() }, false],
    ["minimum days below 21", mutate(R.proposeExperiments(), (o) => (o.proposals[0].minimum_days = 20)), false],
    ["minimum days above 84", mutate(R.proposeExperiments(), (o) => (o.proposals[0].minimum_days = 85)), false],
    ["credits charged", mutate(R.proposeExperiments(), (o) => (o.proposals[0].cost.credits_charged = true)), false],
    ["non-USD", mutate(R.proposeExperiments(), (o) => (o.proposals[0].cost.currency = "EUR")), false],
    ["26 pages", mutate(R.proposeExperiments(), (o) => (o.proposals[0].pages = Array.from({ length: 26 }, (_, i) => `/p${i}`))), false],
    ["unknown design", mutate(R.proposeExperiments(), (o) => (o.proposals[0].design = "D")), false],
    ["11 proposals", mutate(R.proposeExperiments(), (o) => (o.proposals = Array.from({ length: 11 }, () => o.proposals[0]))), false],
  ],
  robynn_check_page_content: [
    ["bare success", R.checkPageContent(), true],
    ["invalid report", { ...R.checkPageContent(), valid: false }, true],
    ["bad report hash", mutate(R.checkPageContent(), (o) => (o.report_hash = "x")), false],
    ["extra key", { ...R.checkPageContent(), actions: [] }, false],
    ["missing evidence freshness", mutate(R.checkPageContent(), (o) => delete o.evidence_freshness), false],
  ],
  robynn_create_experiment: [
    ["bare success", R.createExperiment(), true],
    ["approved state", mutate(R.createExperiment(), (o) => (o.state = "approved")), false],
    ["duration 20", mutate(R.createExperiment(), (o) => (o.duration_days = 20)), false],
    ["relative approval link", mutate(R.createExperiment(), (o) => (o.approval_link = "/discoverability/approvals/x")), false],
    ["missing approval link", mutate(R.createExperiment(), (o) => delete o.approval_link), false],
    ["credits charged", mutate(R.createExperiment(), (o) => (o.cost.credits_charged = true)), false],
    ["bad expiry", mutate(R.createExperiment(), (o) => (o.approval_expires_at = "tomorrow")), false],
  ],
  robynn_experiment_status: [
    ["bare success", R.experimentStatus(), true],
    ["empty page", { items: [], next_cursor: null }, true],
    ["conclusive", mutate(R.experimentStatus(), (o) => (o.items[0].conclusive = true)), false],
    ["unknown state", mutate(R.experimentStatus(), (o) => (o.items[0].state = "live")), false],
    ["bad post_start", mutate(R.experimentStatus(), (o) => (o.items[0].post_start = "2026-13-01")), false],
    ["date-time post_end", mutate(R.experimentStatus(), (o) => (o.items[0].post_end = "2026-10-30T00:00:00Z")), false],
    ["negative days", mutate(R.experimentStatus(), (o) => (o.items[0].days_elapsed = -1)), false],
    ["51 items", mutate(R.experimentStatus(), (o) => (o.items = Array.from({ length: 51 }, () => o.items[0]))), false],
  ],
  robynn_experiment_results: [
    ["bare success", R.experimentResults(), true],
    ["measuring", mutate(R.experimentResults(), (o) => { o.verdict = "measuring"; o.is_final = false; }), true],
    ["unknown verdict", mutate(R.experimentResults(), (o) => (o.verdict = "promising")), false],
    ["four guardrails", mutate(R.experimentResults(), (o) => (o.guardrails = Array.from({ length: 4 }, () => o.guardrails[0]))), false],
    ["unknown guardrail", mutate(R.experimentResults(), (o) => (o.guardrails[0].metric = "revenue")), false],
    ["guardrail not_noninferior", mutate(R.experimentResults(), (o) => (o.guardrails[0].status = "not_noninferior")), false],
    ["unit win badge", mutate(R.experimentResults(), (o) => (o.units[0].verdict = "win")), false],
    ["11 learnings", mutate(R.experimentResults(), (o) => (o.learnings = Array.from({ length: 11 }, () => o.learnings[0]))), false],
  ],
  robynn_promote_experiment: [
    ["bare success", R.promoteExperiment(), true],
    ["no targets", mutate(R.promoteExperiment(), (o) => (o.target_pages = [])), false],
    ["26 targets", mutate(R.promoteExperiment(), (o) => (o.target_pages = Array.from({ length: 26 }, (_, i) => `/p${i}`))), false],
    ["delivered state", mutate(R.promoteExperiment(), (o) => (o.state = "delivering")), false],
  ],
  robynn_rollback_experiment: [
    ["bare success", R.rollbackExperiment(), true],
    ["executed", mutate(R.rollbackExperiment(), (o) => (o.executed = true)), false],
    ["rolled back", mutate(R.rollbackExperiment(), (o) => (o.state = "rolled_back")), false],
    ["missing link", mutate(R.rollbackExperiment(), (o) => delete o.approval_link), false],
  ],
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const ajv = new AjvJsonSchemaValidator();
const bundle = JSON.parse(readFileSync(join(process.cwd(), "contracts/discoverability-tools.v1.json"), "utf8")) as {
  $defs: Record<string, unknown>;
  tools: Array<{ name: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>;
};
function specSchema(name: ToolName, which: "inputSchema" | "outputSchema"): JsonSchemaType {
  const tool = bundle.tools.find((t) => t.name === name)!;
  return { ...tool[which], $defs: bundle.$defs } as JsonSchemaType;
}
const specError = { ...(bundle.$defs.error as Record<string, unknown>), $defs: bundle.$defs } as JsonSchemaType;

const app = new FakeApp();
type Listed = { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; annotations: unknown; title?: string; description?: string };
let published: Record<ToolName, Listed>;
let allTools: Array<{ name: string; description?: string }>;
let tokenCounter = 0;

beforeAll(async () => {
  app.install();
  process.env.ROBYNN_API_BASE_URL = APP_BASE_URL;
  const session = await startWorkerSession({ accessToken: "wp211-synthetic-token-list" });
  const { tools } = await session.client.listTools();
  allTools = tools;
  published = Object.fromEntries(tools.filter((t) => (TOOLS as readonly string[]).includes(t.name)).map((t) => [t.name, t])) as never;
  await session.close();
}, 30_000);
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.ROBYNN_API_BASE_URL;
});

describe.each(TOOLS)("%s schemas: Zod, published draft-07 and the WP2-01 semantic bundle agree", (name) => {
  it.each(INPUT_CORPUS[name])("input %s", (_label, value, accepted) => {
    expect(ZOD[name].input.safeParse(value).success, "zod").toBe(accepted);
    expect(ajv.getValidator(published[name].inputSchema)(value).valid, "tools/list draft-07").toBe(accepted);
    expect(ajv.getValidator(specSchema(name, "inputSchema"))(value).valid, "spec 2020-12 bundle").toBe(accepted);
  });

  it.each(OUTPUT_CORPUS[name])("output %s", (_label, value, accepted) => {
    expect(ZOD[name].output.safeParse(value).success, "zod").toBe(accepted);
    expect(ajv.getValidator(published[name].outputSchema)(value).valid, "tools/list draft-07").toBe(accepted);
    expect(ajv.getValidator(specSchema(name, "outputSchema"))(value).valid, "spec 2020-12 bundle").toBe(accepted);
  });
});

describe("documented gap: robynn_experiment_status oneOf", () => {
  it.each(ONE_OF_CASES)("%s: the spec refuses; the published object schema cannot say so; the handler refuses", (_label, value) => {
    expect(ajv.getValidator(specSchema("robynn_experiment_status", "inputSchema"))(value).valid).toBe(false);
    expect(ajv.getValidator(published.robynn_experiment_status.inputSchema)(value).valid).toBe(true);
    expect(experimentStatusSelection(value)).not.toBeNull();
  });

  it("limit or cursor with experiment_id is refused by the handler (tool-contracts.md Defaults)", () => {
    expect(experimentStatusSelection({ experiment_id: E, limit: 5 })).toMatch(/only valid with website_id/);
    expect(experimentStatusSelection({ experiment_id: E, cursor: "c" })).toMatch(/only valid with website_id/);
    expect(experimentStatusSelection({ website_id: W, limit: 5, cursor: "c" })).toBeNull();
  });
});

describe("tools/list shape", () => {
  it.each([
    ["robynn_propose_experiments", "Propose Discoverability Experiments", true],
    ["robynn_check_page_content", "Check Page Content", true],
    ["robynn_create_experiment", "Create Discoverability Experiment", false],
    ["robynn_experiment_status", "Get Experiment Status", true],
    ["robynn_experiment_results", "Get Experiment Results", true],
    ["robynn_promote_experiment", "Request Experiment Promotion", false],
    ["robynn_rollback_experiment", "Request Experiment Rollback", false],
  ] as const)("%s: title %s, annotations, closed input, output schema, no $ref", (name, title, readOnly) => {
    const tool = published[name];
    expect(tool.title).toBe(title);
    expect(tool.annotations).toEqual({
      title,
      readOnlyHint: readOnly,
      // tool-contracts.md: every addition is closed-world with no external
      // effect; rollback only records a request (F/F/F/T supersedes F/T/T).
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(tool)).not.toContain("$ref");
  });

  it("request writes require an idempotency key; rollback requires confirm: true and returns executed: false", () => {
    for (const name of WRITES) {
      expect(published[name].inputSchema.required, name).toContain("idempotency_key");
    }
    const rollback = published.robynn_rollback_experiment;
    expect((rollback.inputSchema.properties as Record<string, unknown>).confirm).toEqual({ type: "boolean", const: true });
    expect(rollback.inputSchema.required).toEqual(["experiment_id", "reason", "confirm", "idempotency_key"]);
    expect((rollback.outputSchema.properties as Record<string, unknown>).executed).toEqual({ type: "boolean", const: false });
  });

  it("every write tool discloses: a saved request, no credits, human approval, no publication, and names robynn_experiment_status", () => {
    for (const name of WRITES) {
      const description = published[name].description ?? "";
      expect(description, name).toContain(WRITE_DISCLOSURE);
    }
    expect(WRITE_DISCLOSURE).toMatch(/saves a request in Robynn/);
    expect(WRITE_DISCLOSURE).toMatch(/no credits are charged/);
    expect(WRITE_DISCLOSURE).toMatch(/nothing is published/);
    expect(WRITE_DISCLOSURE).toMatch(/must approve it in Robynn \(the agent cannot approve\)/);
    expect(WRITE_DISCLOSURE).toMatch(/robynn_experiment_status/);
  });

  it("no approve, execute or generic discoverability dispatcher is registered", () => {
    const names = allTools.map((t) => t.name);
    expect(names.filter((n) => /approve|execute_rollback|discoverability_(action|dispatch)/.test(n))).toEqual([]);
    expect(names.filter((n) => /experiment|discoverab|propose|page_content|site_(health|learnings)|visibility_trend/.test(n)).sort()).toEqual(
      [...TOOLS, "robynn_site_health", "robynn_ai_visibility_trend", "robynn_site_learnings"].sort(),
    );
  });

  it("defaults match the spec (max 5); status has no default limit outside website listings", () => {
    const props = (n: ToolName) => published[n].inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props("robynn_propose_experiments").max.default).toBe(5);
    expect(props("robynn_experiment_status").limit.default).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real tools/call through the Worker
// ---------------------------------------------------------------------------

async function session(responder: (request: AppRequest) => AppReply | undefined) {
  const token = `wp211-synthetic-token-${++tokenCounter}`;
  app.respond(token, responder);
  const s = await startWorkerSession({ accessToken: token });
  return { ...s, token, requests: () => app.requestsFor(token) };
}

const ARGS: Record<ToolName, Record<string, unknown>> = {
  robynn_propose_experiments: { website_id: W, goal: "geo_citation_rate" },
  robynn_check_page_content: { website_id: W, page_path: "/blog/a", draft: "<p>Draft</p>" },
  robynn_create_experiment: create(),
  robynn_experiment_status: { experiment_id: E },
  robynn_experiment_results: { experiment_id: E },
  robynn_promote_experiment: { experiment_id: E, scope: "all_similar_pages", idempotency_key: KEY },
  robynn_rollback_experiment: { experiment_id: E, reason: "Traffic dropped", confirm: true, idempotency_key: KEY },
};
const REPLIES: Record<ToolName, () => unknown> = {
  robynn_propose_experiments: R.proposeExperiments,
  robynn_check_page_content: R.checkPageContent,
  robynn_create_experiment: R.createExperiment,
  robynn_experiment_status: R.experimentStatus,
  robynn_experiment_results: R.experimentResults,
  robynn_promote_experiment: R.promoteExperiment,
  robynn_rollback_experiment: R.rollbackExperiment,
};
const PATHS: Record<ToolName, string> = {
  robynn_propose_experiments: "/api/cli/mcp/discoverability/propose-experiments",
  robynn_check_page_content: "/api/cli/mcp/discoverability/check-page-content",
  robynn_create_experiment: "/api/cli/mcp/discoverability/create-experiment",
  robynn_experiment_status: "/api/cli/mcp/discoverability/experiment-status",
  robynn_experiment_results: "/api/cli/mcp/discoverability/experiment-results",
  robynn_promote_experiment: "/api/cli/mcp/discoverability/promote-experiment",
  robynn_rollback_experiment: "/api/cli/mcp/discoverability/rollback-experiment",
};

describe.each(TOOLS)("%s tools/call", (name) => {
  it("passes the app's bare success object through unchanged and sends only the arguments", async () => {
    const s = await session(() => ({ body: REPLIES[name]() }));
    const result = await s.client.callTool({ name, arguments: ARGS[name] });
    await s.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(REPLIES[name]());
    expect(s.requests()).toHaveLength(1);
    expect(s.requests()[0]).toMatchObject({ method: "POST", path: PATHS[name] });
    const body = s.requests()[0].body as Record<string, unknown>;
    for (const identity of ["organization_id", "user_id", "client_id", "grant_id"]) {
      expect(Object.keys(body)).not.toContain(identity);
    }
    if (WRITES.includes(name)) {
      expect(body.idempotency_key).toBe(KEY);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain(WRITE_DISCLOSURE);
    }
  });

  it.each([
    { status: 422, body: { code: "validation_failed", message: "The proposed change failed validation. (unsupported_claim /blog/a)", retryable: false }, code: "validation_failed", retryable: false, text: "unsupported_claim /blog/a" },
    { status: 422, body: { code: "design_ineligible", message: "No eligible experiment design for these pages yet. (descriptive_only)", retryable: false }, code: "design_ineligible", retryable: false, text: "descriptive_only" },
    { status: 409, body: { code: "proposal_stale", message: "The proposal changed since it was read. (diagnostics_changed)", retryable: false }, code: "proposal_stale", retryable: false, text: "diagnostics_changed" },
    { status: 409, body: { code: "conflict", message: "The pages conflict with other work on this site. (growth_conflict_unknown)", retryable: true }, code: "conflict", retryable: true, text: "growth_conflict_unknown" },
    { status: 409, body: { code: "idempotency_key_reused", message: "This idempotency_key was already used for a different request. Use a new key.", retryable: false }, code: "idempotency_key_reused", retryable: false },
    { status: 409, body: { code: "idempotency_in_progress", message: "This request is already being processed.", retryable: true }, code: "idempotency_in_progress", retryable: true },
    { status: 403, body: { code: "environment_not_eligible", message: "Comparison-page experiments are only available on the robynn.ai dogfood site in v2.0.", retryable: false }, code: "environment_not_eligible", retryable: false, text: "dogfood" },
    { status: 403, body: { code: "tool_not_permitted", message: "Organization API keys cannot use this tool.", retryable: false }, code: "tool_not_permitted", retryable: false },
    { status: 403, body: { code: "insufficient_scope", message: "x", retryable: false, required_scope: "tools:execute" }, code: "insufficient_scope", retryable: false, requiredScope: "tools:execute", text: "tools:execute permission" },
    { status: 401, body: { code: "grant_revoked", message: "This Robynn connection is no longer active." }, code: "grant_revoked", retryable: false },
    { status: 404, body: { code: "not_found", message: "Experiment not found.", retryable: false }, code: "not_found", retryable: false },
    // A missing stored precondition is a 422 so its reason reaches the agent
    // (5xx bodies are never forwarded); retryable comes from the body.
    { status: 422, body: { code: "data_unavailable", message: "Stored data this experiment needs is not available. (page_snapshot_missing)", retryable: true }, code: "data_unavailable", retryable: true, text: "page_snapshot_missing" },
    { status: 503, body: { code: "data_unavailable", message: "p17-5xx-message-canary", retryable: true }, code: "data_unavailable", retryable: true },
    { status: 503, body: { code: "internal_error", message: "db exploded at host:5432", retryable: true }, code: "internal_error", retryable: true },
  ])("app $status $code → structured $code (spec $defs/error), bounded detail only", async (row) => {
    const s = await session(() => ({ status: row.status, body: row.body }));
    const result = await s.client.callTool({ name, arguments: ARGS[name] });
    await s.close();
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(row.code);
    expect(error.retryable).toBe(row.retryable);
    if (row.requiredScope) expect(error.required_scope).toBe(row.requiredScope);
    else expect(error).not.toHaveProperty("required_scope");
    expect(error).not.toHaveProperty("request_id");
    expect(ajv.getValidator(specError)(result.structuredContent).valid).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text.startsWith(`${row.code}: `)).toBe(true);
    if (row.text) expect(text).toContain(row.text);
    expect(JSON.stringify(result)).not.toContain(s.token);
    expect(JSON.stringify(result)).not.toContain("db exploded");
    expect(JSON.stringify(result)).not.toContain("p17-5xx-message-canary");
    // 503 is retried once (retrySafe: reads, or writes replayed by their key).
    expect(s.requests().length).toBe(row.status === 503 ? 2 : 1);
    if (row.status === 503 && WRITES.includes(name)) {
      expect(s.requests()[0].body).toEqual(s.requests()[1].body);
    }
  }, 15_000);
});

describe("robynn_experiment_status selection is refused before any request", () => {
  it.each([
    ["both ids", { experiment_id: E, website_id: W }],
    ["neither id", {}],
    ["limit with experiment_id", { experiment_id: E, limit: 3 }],
  ])("%s → invalid_request, zero requests", async (_label, args) => {
    const s = await session(() => ({ body: R.experimentStatus() }));
    const result = await s.client.callTool({ name: "robynn_experiment_status", arguments: args });
    await s.close();
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(ajv.getValidator(specError)(result.structuredContent).valid).toBe(true);
    expect(s.requests()).toHaveLength(0);
  });
});
