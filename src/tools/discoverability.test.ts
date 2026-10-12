/**
 * COS-PLUGIN-002 WP2-06 — the three named discoverability read tools.
 *
 * 1. Schema equivalence: one positive/negative corpus is checked against
 *    (a) the registered Zod schemas, (b) the draft-07 JSON Schemas the real
 *    `tools/list` publishes (catalog harness) and (c) the WP2-01 semantic
 *    bundle contracts/discoverability-tools.v1.json (verbatim from the spec).
 *    All three must accept/reject identically; the one documented exception
 *    is `uniqueItems` on competitors, which zod-to-json-schema cannot emit
 *    (Zod and the spec reject duplicates; the published schema omits it).
 * 2. tools/list shape: titles, T/F/F/T annotations, closed inputs, output schemas.
 * 3. Through a real tools/call: bare success objects pass unchanged; app
 *    denials keep their codes as structured errors (spec $defs/error); no
 *    upstream body, stack or credential reaches the result.
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
import { discoverabilityReplies } from "../__tests__/catalog-contract.fixtures";
import { RobynnApiError, UpstreamAuthorizationExpiredError } from "../robynn-client";
import { toDiscoverabilityErrorResult } from "./discoverability";
import {
  aiVisibilityTrendInputSchema,
  aiVisibilityTrendOutputSchema,
  siteHealthInputSchema,
  siteHealthOutputSchema,
  siteLearningsInputSchema,
  siteLearningsOutputSchema,
} from "./discoverability-schemas";

const TOOLS = ["robynn_site_health", "robynn_ai_visibility_trend", "robynn_site_learnings"] as const;
type ToolName = (typeof TOOLS)[number];

const ZOD: Record<ToolName, { input: ZodTypeAny; output: ZodTypeAny }> = {
  robynn_site_health: { input: siteHealthInputSchema, output: siteHealthOutputSchema },
  robynn_ai_visibility_trend: { input: aiVisibilityTrendInputSchema, output: aiVisibilityTrendOutputSchema },
  robynn_site_learnings: { input: siteLearningsInputSchema, output: siteLearningsOutputSchema },
};

const W = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** [label, value, accepted?] */
type Case = [string, unknown, boolean];

const INPUT_CORPUS: Record<ToolName, Case[]> = {
  robynn_site_health: [
    ["minimal", { website_id: W }, true],
    ["all fields", { website_id: W, focus: "geo", window_days: 180 }, true],
    ["window lower bound", { website_id: W, window_days: 7 }, true],
    ["missing website_id", {}, false],
    ["non-uuid website_id", { website_id: "site-1" }, false],
    ["unknown argument", { website_id: W, organization_id: W }, false],
    ["identity argument", { website_id: W, user_id: W }, false],
    ["window too small", { website_id: W, window_days: 6 }, false],
    ["window too large", { website_id: W, window_days: 181 }, false],
    ["fractional window", { website_id: W, window_days: 7.5 }, false],
    ["unknown focus", { website_id: W, focus: "ads" }, false],
    ["ok/data wrapper", { ok: true, data: { website_id: W } }, false],
  ],
  robynn_ai_visibility_trend: [
    ["minimal", { website_id: W }, true],
    ["all fields", { website_id: W, panel_id: P, engines: ["chatgpt", "perplexity"], window_days: 28, competitors: ["rival.example"] }, true],
    ["four engines", { website_id: W, engines: ["chatgpt", "claude", "gemini", "perplexity"] }, true],
    ["ten competitors", { website_id: W, competitors: Array.from({ length: 10 }, (_, i) => `r${i}.example`) }, true],
    ["non-uuid panel", { website_id: W, panel_id: "panel-1" }, false],
    ["empty engines", { website_id: W, engines: [] }, false],
    ["unknown engine", { website_id: W, engines: ["bing"] }, false],
    ["five engines", { website_id: W, engines: ["chatgpt", "claude", "gemini", "perplexity", "chatgpt"] }, false],
    ["empty competitors", { website_id: W, competitors: [] }, false],
    ["eleven competitors", { website_id: W, competitors: Array.from({ length: 11 }, (_, i) => `r${i}.example`) }, false],
    ["empty competitor string", { website_id: W, competitors: [""] }, false],
    ["overlong competitor", { website_id: W, competitors: ["a".repeat(254)] }, false],
    ["unknown argument", { website_id: W, refresh: true }, false],
  ],
  robynn_site_learnings: [
    ["minimal", { website_id: W }, true],
    ["all fields", { website_id: W, type: "faq", page_type: "blog", limit: 50, cursor: "opaque" }, true],
    ["limit lower bound", { website_id: W, limit: 1 }, true],
    ["limit zero", { website_id: W, limit: 0 }, false],
    ["limit too large", { website_id: W, limit: 51 }, false],
    ["unknown type", { website_id: W, type: "popup" }, false],
    ["empty page_type", { website_id: W, page_type: "" }, false],
    ["overlong cursor", { website_id: W, cursor: "c".repeat(513) }, false],
    ["unknown argument", { website_id: W, organization_id: W }, false],
  ],
};

/** Inputs where the published draft-07 schema is knowingly weaker (uniqueItems is not expressible from Zod). */
const UNIQUE_ITEMS_CASES: Array<[ToolName, unknown]> = [
  ["robynn_ai_visibility_trend", { website_id: W, competitors: ["a.example", "a.example"] }],
];

const health = discoverabilityReplies.siteHealth;
const trend = discoverabilityReplies.aiVisibilityTrend;
const learnings = discoverabilityReplies.siteLearnings;

function mutate<T>(value: T, change: (copy: any) => void): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

const OUTPUT_CORPUS: Record<ToolName, Case[]> = {
  robynn_site_health: [
    ["bare success", health(), true],
    ["unavailable sections", mutate(health(), (o) => {
      o.seo = { ...o.seo, estimate: null, lower90: null, upper90: null, observed_n: 0 };
      o.freshness = { generated_at: null, as_of: null, status: "unavailable", reason: "projection_missing" };
    }), true],
    ["ok/data wrapper", { ok: true, data: health() }, false],
    ["extra field", { ...health(), raw_answers: [] }, false],
    ["missing crawl", mutate(health(), (o) => delete o.crawl), false],
    ["bad freshness status", mutate(health(), (o) => (o.freshness.status = "fresh")), false],
    ["reason over 100", mutate(health(), (o) => (o.freshness.reason = "r".repeat(101))), false],
    ["bad date-time", mutate(health(), (o) => (o.freshness.generated_at = "yesterday")), false],
    ["negative count", mutate(health(), (o) => (o.crawl.treated_pages = -1)), false],
    ["bad page path", mutate(health(), (o) => (o.issues[0].page_path = "//evil.example/x")), false],
    ["page path with query", mutate(health(), (o) => (o.issues[0].page_path = "/a?b=1")), false],
    ["bad interval unit", mutate(health(), (o) => (o.seo.unit = "ratio")), false],
    ["101 issues", mutate(health(), (o) => (o.issues = Array.from({ length: 101 }, () => o.issues[0]))), false],
  ],
  robynn_ai_visibility_trend: [
    ["bare success", trend(), true],
    ["no panel", { website_id: W, panel_id: null, series: [], provider_snapshots: [], freshness: health().freshness }, true],
    ["provider snapshot as panel trial", mutate(trend(), (o) => (o.series[0].observation_kind = "provider_snapshot")), false],
    ["fresh run as provider snapshot", mutate(trend(), (o) => (o.provider_snapshots[0].observation_kind = "fresh_answer_run")), false],
    ["unknown platform", mutate(trend(), (o) => (o.provider_snapshots[0].platform = "bing")), false],
    ["missing entity_domain", mutate(trend(), (o) => delete o.series[0].entity_domain), false],
    ["missing citation coverage", mutate(trend(), (o) => delete o.series[0].metric_coverage.citation_observed), false],
    ["extra coverage field", mutate(trend(), (o) => (o.series[0].metric_coverage.extra = 1)), false],
    ["negative fact errors", mutate(trend(), (o) => (o.series[0].fact_errors = -1)), false],
    ["non-uuid panel", mutate(trend(), (o) => (o.panel_id = "panel")), false],
  ],
  robynn_site_learnings: [
    ["bare success", learnings(), true],
    ["empty page", { website_id: W, items: [], next_cursor: null, freshness: health().freshness }, true],
    ["unknown learning type", mutate(learnings(), (o) => (o.items[0].type = "popup")), false],
    ["bad memory status", mutate(learnings(), (o) => (o.items[0].memory_status = "done")), false],
    ["empty cursor", mutate(learnings(), (o) => (o.next_cursor = "")), false],
    ["51 items", mutate(learnings(), (o) => (o.items = Array.from({ length: 51 }, () => o.items[0]))), false],
    ["missing created_at", mutate(learnings(), (o) => delete o.items[0].created_at), false],
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

/** A spec tool schema with the bundle's $defs attached (draft-07-compatible subset). */
function specSchema(name: ToolName, which: "inputSchema" | "outputSchema"): JsonSchemaType {
  const tool = bundle.tools.find((t) => t.name === name)!;
  return { ...tool[which], $defs: bundle.$defs } as JsonSchemaType;
}
const specError = { ...(bundle.$defs.error as Record<string, unknown>), $defs: bundle.$defs } as JsonSchemaType;

const app = new FakeApp();
let published: Record<ToolName, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; annotations: unknown; title?: string }>;
let tokenCounter = 0;

beforeAll(async () => {
  app.install();
  process.env.ROBYNN_API_BASE_URL = APP_BASE_URL;
  const session = await startWorkerSession({ accessToken: "wp206-synthetic-token-list" });
  const { tools } = await session.client.listTools();
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

describe("documented gap: uniqueItems", () => {
  it.each(UNIQUE_ITEMS_CASES)("%s duplicate competitors: Zod and the spec reject; the published schema cannot say so", (name, value) => {
    expect(ZOD[name].input.safeParse(value).success).toBe(false);
    expect(ajv.getValidator(specSchema(name, "inputSchema"))(value).valid).toBe(false);
    expect(ajv.getValidator(published[name].inputSchema)(value).valid).toBe(true);
  });
});

describe("tools/list shape", () => {
  it.each([
    ["robynn_site_health", "Get Site Health"],
    ["robynn_ai_visibility_trend", "Get AI Visibility Trend"],
    ["robynn_site_learnings", "Get Site Learnings"],
  ] as const)("%s: title, T/F/F/T annotations, closed input, output schema, no $ref", (name, title) => {
    const tool = published[name];
    expect(tool.title).toBe(title);
    expect(tool.annotations).toEqual({
      title,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(["website_id"]);
    expect(tool.outputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(tool)).not.toContain("$ref");
    // uuid/date-time formats are asserted, not just annotated.
    expect((tool.inputSchema.properties as Record<string, { format?: string }>).website_id.format).toBe("uuid");
  });

  it("defaults match the spec (window_days 28, limit 20)", () => {
    const props = (n: ToolName) => published[n].inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props("robynn_site_health").window_days.default).toBe(28);
    expect(props("robynn_ai_visibility_trend").window_days.default).toBe(28);
    expect(props("robynn_site_learnings").limit.default).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Real tools/call through the Worker
// ---------------------------------------------------------------------------

async function session(responder: (request: AppRequest) => AppReply | undefined) {
  const token = `wp206-synthetic-token-${++tokenCounter}`;
  app.respond(token, responder);
  const s = await startWorkerSession({ accessToken: token });
  return { ...s, token, requests: () => app.requestsFor(token) };
}

const ARGS: Record<ToolName, Record<string, unknown>> = {
  robynn_site_health: { website_id: W },
  robynn_ai_visibility_trend: { website_id: W, competitors: ["Rival.Example"] },
  robynn_site_learnings: { website_id: W, limit: 5 },
};
const REPLIES: Record<ToolName, () => unknown> = {
  robynn_site_health: health,
  robynn_ai_visibility_trend: trend,
  robynn_site_learnings: learnings,
};
const PATHS: Record<ToolName, string> = {
  robynn_site_health: "/api/cli/mcp/discoverability/site-health",
  robynn_ai_visibility_trend: "/api/cli/mcp/discoverability/ai-visibility-trend",
  robynn_site_learnings: "/api/cli/mcp/discoverability/site-learnings",
};

describe.each(TOOLS)("%s tools/call", (name) => {
  it("passes the app's bare success object through unchanged, with a text summary carrying the numbers", async () => {
    const s = await session(() => ({ body: REPLIES[name]() }));
    const result = await s.client.callTool({ name, arguments: ARGS[name] });
    await s.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(REPLIES[name]());
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain(W);
    expect(text).toMatch(/Freshness: data available/);
    expect(s.requests()).toHaveLength(1);
    expect(s.requests()[0]).toMatchObject({ method: "POST", path: PATHS[name] });
    // Defaults applied by the schema; identity never sent as an argument.
    const body = s.requests()[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).not.toContain("organization_id");
    expect(body.website_id).toBe(W);
  });

  it("an app reply that violates the output schema is not returned as success", async () => {
    const s = await session(() => ({ body: { success: true, data: REPLIES[name]() } }));
    const result = await s.client.callTool({ name, arguments: ARGS[name] }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    await s.close();
    expect(result.isError).toBe(true);
  });

  it.each([
    { status: 403, body: { code: "membership_inactive", message: "You are no longer an active member of this organization.", retryable: false }, code: "membership_inactive", retryable: false },
    { status: 403, body: { code: "role_forbidden", message: "Your role in this organization cannot perform this operation.", retryable: false }, code: "role_forbidden", retryable: false },
    { status: 403, body: { code: "tool_not_permitted", message: "Organization API keys cannot use this operation.", retryable: false }, code: "tool_not_permitted", retryable: false },
    { status: 403, body: { code: "insufficient_scope", message: "x", retryable: false, required_scope: "brand:read" }, code: "insufficient_scope", retryable: false, requiredScope: "brand:read" },
    { status: 401, body: { code: "grant_revoked", message: "This Robynn connection is no longer active." }, code: "grant_revoked", retryable: false },
    { status: 401, body: { error: "invalid_token" }, code: "authorization_expired", retryable: true },
    { status: 404, body: { code: "not_found", message: "Website not found.", retryable: false }, code: "not_found", retryable: false },
    { status: 400, body: { code: "invalid_request", message: "A competitor is not in this panel's frozen competitor set.", retryable: false }, code: "invalid_request", retryable: false, text: "frozen competitor set" },
    { status: 413, body: { code: "invalid_request", message: "The request is too large.", retryable: false }, code: "invalid_request", retryable: false },
    { status: 422, body: { error: "p13_upstream_failure" }, code: "validation_failed", retryable: false },
    { status: 503, body: { code: "authorization_unavailable", message: "x", retryable: true }, code: "authorization_unavailable", retryable: true },
    { status: 503, body: { code: "internal_error", message: "store down", retryable: true }, code: "internal_error", retryable: true },
  ])("app $status $code → structured $code error (spec error shape), nothing else forwarded", async (row) => {
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
    expect(JSON.stringify(result)).not.toContain("store down");
    // 503 is retried once (retrySafe); everything else exactly once.
    expect(s.requests().length).toBe(row.status === 503 ? 2 : 1);
  }, 15_000);
});

describe("toDiscoverabilityErrorResult", () => {
  it("never echoes unknown errors and maps transport failures to retryable internal_error", () => {
    const unknown = toDiscoverabilityErrorResult(new Error("connect ECONNREFUSED secret-host:5432 Bearer abc"));
    expect(unknown.structuredContent.error).toEqual({
      code: "internal_error",
      message: "Robynn could not read the stored history right now. Nothing was changed.",
      retryable: false,
    });
    const timeout = toDiscoverabilityErrorResult(new RobynnApiError(0, "timeout", "The Robynn API request timed out.", false));
    expect(timeout.structuredContent.error).toMatchObject({ code: "internal_error", retryable: true });
    const expired = toDiscoverabilityErrorResult(new UpstreamAuthorizationExpiredError(null));
    expect(expired.structuredContent.error).toMatchObject({ code: "authorization_expired", retryable: true });
    const unknownCode = toDiscoverabilityErrorResult(new RobynnApiError(403, "made_up_code", "x"));
    expect(unknownCode.structuredContent.error.code).toBe("tool_not_permitted");
    for (const r of [unknown, timeout, expired, unknownCode]) {
      expect(ajv.getValidator(specError)(r.structuredContent).valid).toBe(true);
    }
  });
});
