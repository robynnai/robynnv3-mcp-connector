/**
 * COS-PLUGIN-002 WP2-14 — the LIVE surfaces of the full local loop.
 *
 * The app repo's orchestrator (src/lib/server/discoverability/integration/
 * __tests__/full-loop.local.test.ts, WP214_LOOP_MCP_DIR set) runs this file
 * once per stage with WP214_LOOP_STAGE and a state file (WP214_LOOP_STATE,
 * mode 600, outside git). Agent steps are real MCP host calls through the
 * real Worker (`wrangler dev --local`) and app routes over the P16 OAuth
 * chain; human steps are a real signed-in browser session (form sign-in,
 * same origin, CSRF, fresh re-authentication) against the app's human-only
 * routes. Synthetic data only; loopback only.
 *
 * Roles (plugin-local seed): alpha is an active collaborator of Org B and
 * proposes as the agent (tools:execute); beta is Org B's admin and approves
 * or rolls back as a person. alpha in Org A is the other tenant. The
 * connections are made once (stage "reads") and reused, so the grant that
 * created the experiment stays the same grant all the way through.
 *
 * Skipped unless PLUGIN_LOCAL_LIVE=1 and WP214_LOOP_STAGE are set.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALPHA,
  APP,
  BETA,
  LIVE,
  ORG_A,
  ORG_B,
  browserFor,
  callTool,
  connectHost,
  hostRefresh,
  listTools,
  logsContainingSensitiveValues,
  openSession,
  registerHost,
  remember,
  toolErrorCode,
  toolOk,
  type HostConnection,
  type McpReply,
} from "./live-stack";

const STAGE = process.env.WP214_LOOP_STAGE ?? "";
const STATE_FILE = process.env.WP214_LOOP_STATE ?? "";

const DISCOVERABILITY_TOOLS = [
  "robynn_site_health",
  "robynn_ai_visibility_trend",
  "robynn_site_learnings",
  "robynn_propose_experiments",
  "robynn_check_page_content",
  "robynn_create_experiment",
  "robynn_experiment_status",
  "robynn_experiment_results",
  "robynn_promote_experiment",
  "robynn_rollback_experiment",
];

interface LoopState {
  ids: { orgA: string; orgB: string; siteA: string; siteB: string; alpha: string; beta: string };
  loop: { proposalId: string; experimentId: string; approvalId: string; executionId: string; rollbackExecutionId: string };
  stage: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  conns?: Record<string, HostConnection>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: McpReply): any => r.json?.result?.structuredContent ?? {};
/** Assertion message: the status and the tool's error object (no secrets). */
const detail = (r: McpReply) => JSON.stringify({ status: r.status, error: data(r).error ?? r.json?.error ?? null }).slice(0, 600);

function readState(): LoopState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as LoopState;
}

function writeState(state: LoopState) {
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

async function connection(state: LoopState, name: string, make: () => Promise<HostConnection>) {
  state.conns ??= {};
  let conn = state.conns[name];
  if (!conn) {
    conn = await make();
    state.conns[name] = conn;
  } else {
    remember(conn.access);
    remember(conn.refresh);
  }
  let session: string;
  try {
    session = await openSession(conn.access);
  } catch {
    // The access token expired between stages: refresh on the same grant.
    const refreshed = await hostRefresh(conn.clientId, conn.refresh);
    expect(refreshed.status).toBe(200);
    conn = { ...conn, access: refreshed.body.access_token, refresh: refreshed.body.refresh_token ?? conn.refresh };
    state.conns[name] = conn;
    session = await openSession(conn.access);
  }
  return { ...conn, session };
}

async function agent(state: LoopState) {
  return connection(state, "alphaB", async () => {
    const clientId = await registerHost("WP2-14 loop agent");
    const conn = await connectHost({ clientId, user: ALPHA, organizationId: ORG_B, scope: "brand:read tools:execute", allowExecute: true });
    expect(conn.scope).toContain("tools:execute");
    return conn;
  });
}

/** A signed-in browser session (fresh re-authentication) for a person. */
async function person(user: { email: string }) {
  return browserFor(user);
}

async function stageReads(state: LoopState) {
  const a = await agent(state);
  const site = state.ids.siteB;
  const tools = await listTools(a.access, a.session);
  const names = ((tools.json?.result?.tools ?? []) as Array<{ name: string; annotations?: Record<string, boolean> }>).map((t) => t.name);
  for (const t of DISCOVERABILITY_TOOLS) expect(names).toContain(t);
  expect(names.some((n) => /approve|execute_experiment|deliver/.test(n))).toBe(false);
  const health = await callTool(a.access, a.session, "robynn_site_health", { website_id: site });
  expect(toolOk(health), detail(health)).toBe(true);
  const trend = await callTool(a.access, a.session, "robynn_ai_visibility_trend", { website_id: site });
  expect(toolOk(trend), detail(trend)).toBe(true);
  const learnings = await callTool(a.access, a.session, "robynn_site_learnings", { website_id: site });
  expect(toolOk(learnings), detail(learnings)).toBe(true);
  const proposals = await callTool(a.access, a.session, "robynn_propose_experiments", { website_id: site, goal: "seo_clicks", max: 5 });
  expect(toolOk(proposals), detail(proposals)).toBe(true);
  const proposal = (data(proposals).proposals as Array<{ proposal_id: string; type: string; pages: string[] }>).find((p) => p.type === "title_meta");
  expect(proposal).toBeDefined();
  // A read-only connection of the same person cannot write (Phase 1 shape).
  const readonly = await connection(state, "alphaBRead", async () => {
    const clientId = await registerHost("WP2-14 loop read-only");
    return connectHost({ clientId, user: ALPHA, organizationId: ORG_B, scope: "brand:read" });
  });
  const refused = await callTool(readonly.access, readonly.session, "robynn_create_experiment", {
    website_id: site,
    type: "title_meta",
    hypothesis: "read-only connection",
    idempotency_key: "wp214_live_readonly",
    changes: [],
  });
  expect(toolErrorCode(refused)).toBe("insufficient_scope");
  expect(data(refused).error?.required_scope).toBe("tools:execute");
  // The other tenant: alpha connected to Org A cannot see Org B's website.
  const other = await connection(state, "alphaA", async () => {
    const clientId = await registerHost("WP2-14 loop other tenant");
    return connectHost({ clientId, user: ALPHA, organizationId: ORG_A, scope: "brand:read" });
  });
  for (const tool of ["robynn_site_health", "robynn_ai_visibility_trend", "robynn_site_learnings"]) {
    const cross = await callTool(other.access, other.session, tool, { website_id: site });
    expect(toolErrorCode(cross)).toBe("not_found");
  }
  return {
    tools_listed: names.filter((n) => DISCOVERABILITY_TOOLS.includes(n)).length,
    health_freshness: data(health).freshness?.status,
    trend_series: (data(trend).series ?? []).length,
    learnings: (data(learnings).items ?? []).length,
    proposal_id: proposal!.proposal_id,
    proposal_pages: proposal!.pages.length,
    readonly_create: toolErrorCode(refused),
    other_tenant_reads: "not_found",
  };
}

async function stageCheckAndCreate(state: LoopState) {
  const a = await agent(state);
  const site = state.ids.siteB;
  const pages = state.input.pages as Array<{ page: string; title: string }>;
  const changes: Array<Record<string, string>> = [];
  for (const { page, title } of pages) {
    const check = await callTool(a.access, a.session, "robynn_check_page_content", { website_id: site, page_path: page, draft: title });
    expect(toolOk(check), detail(check)).toBe(true);
    expect(data(check).valid).toBe(true);
    const handle = (data(check).issues as Array<{ code: string; message: string }>).find((i) => i.code === "stored_page_snapshot");
    const m = /delivery_binding_id ([0-9a-f-]{36}), before_hash ([0-9a-f]{64})/.exec(handle?.message ?? "");
    expect(m).not.toBeNull();
    changes.push({ page_path: page, field: "title", content: title, before_hash: m![2], delivery_binding_id: m![1] });
  }
  const create = await callTool(a.access, a.session, "robynn_create_experiment", {
    website_id: site,
    proposal_id: state.input.proposal_id,
    type: "title_meta",
    hypothesis: "Query-intent titles lift Search Console clicks (synthetic WP2-14 loop, live)",
    primary_metric: "seo_clicks",
    idempotency_key: `wp214_live_create_${state.ids.siteB.slice(0, 8)}`,
    changes,
  });
  expect(toolOk(create), detail(create)).toBe(true);
  const out = data(create);
  expect(out.state).toBe("pending_approval");
  const approvalId = String(out.approval_link).split("/").pop()!;
  expect(out.approval_link).toBe(`${APP}/discoverability/approvals/${approvalId}`);
  const status = await callTool(a.access, a.session, "robynn_experiment_status", { experiment_id: out.experiment_id });
  expect(data(status).items?.[0]?.state).toBe("pending_approval");
  return { experiment_id: out.experiment_id, approval_id: approvalId, design: out.design, checked_pages: changes.length };
}

async function stageApprovalBypass(state: LoopState) {
  const a = await agent(state);
  const { approvalId } = state.loop;
  // The agent's bearer never reaches a decision (machine credential refused).
  const bearer = await fetch(`${APP}/api/discoverability/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${a.access}`, "content-type": "application/json", origin: APP },
    body: JSON.stringify({ decision: "approved" }),
    redirect: "manual",
  });
  await bearer.body?.cancel();
  expect(bearer.status).toBe(403);
  // No approve tool exists; an invented one is not permitted.
  const invented = await callTool(a.access, a.session, "robynn_approve_experiment", { experiment_id: state.loop.experimentId });
  expect(toolOk(invented)).toBe(false);
  // alpha signed in as a person is a collaborator: may view, cannot decide.
  const alpha = await person(ALPHA);
  const view = await alpha.fetch(`${APP}/api/discoverability/approvals/${approvalId}`);
  const review = (await view.json()) as Record<string, unknown>;
  expect(view.status).toBe(200);
  expect(review.can_decide).toBe(false);
  const forged = await alpha.fetch(`${APP}/api/discoverability/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, "x-robynn-csrf": "forged.token" },
    body: JSON.stringify({ decision: "approved" }),
  });
  await forged.body?.cancel();
  expect(forged.status).toBe(403);
  return { agent_bearer: bearer.status, invented_tool_ok: toolOk(invented), collaborator_decision: forged.status };
}

async function stageApprove(state: LoopState) {
  const { approvalId } = state.loop;
  const beta = await person(BETA);
  const view = await beta.fetch(`${APP}/api/discoverability/approvals/${approvalId}`);
  const review = (await view.json()) as { can_decide: boolean; review_complete: boolean; csrf_token: string | null; reauth: { fresh: boolean } };
  expect(view.status).toBe(200);
  expect(review).toMatchObject({ can_decide: true, review_complete: true, reauth: { fresh: true } });
  remember(review.csrf_token);
  // Cross-origin with a valid token is still refused.
  const crossOrigin = await beta.fetch(`${APP}/api/discoverability/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.test", "x-robynn-csrf": review.csrf_token! },
    body: JSON.stringify({ decision: "approved" }),
  });
  await crossOrigin.body?.cancel();
  expect(crossOrigin.status).toBe(403);
  const decided = await beta.fetch(`${APP}/api/discoverability/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, "x-robynn-csrf": review.csrf_token! },
    body: JSON.stringify({ decision: "approved", surface: "slack_reauth" }),
  });
  const body = (await decided.json()) as Record<string, unknown>;
  expect(decided.status).toBe(200);
  expect(body).toMatchObject({ status: "approved", experiment_moved: true });
  return { status: body.status, experiment_moved: body.experiment_moved, cross_origin: crossOrigin.status };
}

async function stageStatus(state: LoopState) {
  const a = await agent(state);
  const status = await callTool(a.access, a.session, "robynn_experiment_status", { experiment_id: state.loop.experimentId });
  expect(toolOk(status), detail(status)).toBe(true);
  const item = data(status).items?.[0] ?? {};
  return { state: item.state, conclusive: item.conclusive, delivery: item.delivery?.status ?? null };
}

async function stageResults(state: LoopState) {
  const a = await agent(state);
  const results = await callTool(a.access, a.session, "robynn_experiment_results", { experiment_id: state.loop.experimentId });
  expect(toolOk(results), detail(results)).toBe(true);
  const r = data(results);
  expect(r.is_final).toBe(true);
  expect(r.verdict).not.toBe("win");
  expect((r.learnings ?? []).length).toBe(1);
  const learnings = await callTool(a.access, a.session, "robynn_site_learnings", { website_id: state.ids.siteB });
  expect((data(learnings).items ?? []).length).toBe(1);
  const promote = await callTool(a.access, a.session, "robynn_promote_experiment", {
    experiment_id: state.loop.experimentId,
    scope: "all_similar_pages",
    idempotency_key: `wp214_live_promote_${state.ids.siteB.slice(0, 8)}`,
  });
  expect(toolErrorCode(promote)).toBe("conflict");
  return {
    verdict: r.verdict,
    is_final: r.is_final,
    guardrails: (r.guardrails ?? []).map((g: { metric: string; status: string }) => [g.metric, g.status]),
    learnings: (data(learnings).items ?? []).length,
    promotion: toolErrorCode(promote),
  };
}

async function stageRollbackRequest(state: LoopState) {
  const a = await agent(state);
  const reply = await callTool(a.access, a.session, "robynn_rollback_experiment", {
    experiment_id: state.loop.experimentId,
    reason: "Synthetic: revert the titles after the readout",
    confirm: true,
    idempotency_key: `wp214_live_rollback_${state.ids.siteB.slice(0, 8)}`,
  });
  expect(toolOk(reply), detail(reply)).toBe(true);
  const out = data(reply);
  expect(out).toMatchObject({ executed: false, state: "rollback_requested" });
  expect(out.approval_link).toBe(`${APP}/discoverability/experiments/${state.loop.experimentId}/rollback`);
  return { executed: out.executed, state: out.state, request_id: out.request_id };
}

async function stageHumanRollback(state: LoopState) {
  const beta = await person(BETA);
  const id = state.loop.experimentId;
  const view = await beta.fetch(`${APP}/api/discoverability/experiments/${id}/rollback`);
  const page = (await view.json()) as { can_roll_back: boolean; csrf_token: string | null };
  expect(view.status).toBe(200);
  expect(page.can_roll_back).toBe(true);
  remember(page.csrf_token);
  const res = await beta.fetch(`${APP}/api/discoverability/experiments/${id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, "x-robynn-csrf": page.csrf_token! },
    body: JSON.stringify({ reason: "Synthetic rollback after the readout", execution_id: state.input.execution_id }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status).toBe(200);
  expect(body.state).toBe("rolling_back");
  return { state: body.state, restoration: body.restoration, replayed: body.replayed };
}

const STAGES: Record<string, (state: LoopState) => Promise<Record<string, unknown>>> = {
  reads: stageReads,
  check_and_create: stageCheckAndCreate,
  approval_bypass: stageApprovalBypass,
  approve: stageApprove,
  status: stageStatus,
  results: stageResults,
  rollback_request: stageRollbackRequest,
  human_rollback: stageHumanRollback,
};

describe.skipIf(!LIVE || !STAGE)("WP2-14 loop stage (plugin-local, live)", () => {
  it(`stage ${STAGE}`, async () => {
    expect(STATE_FILE).not.toBe("");
    const run = STAGES[STAGE];
    expect(run, `unknown stage ${STAGE}`).toBeDefined();
    const state = readState();
    expect(state.stage).toBe(STAGE);
    expect(state.ids.orgB).toBe(ORG_B);
    const output = await run(state);
    // No credential, CSRF token or code this stage saw reached a log.
    expect(logsContainingSensitiveValues()).toEqual([]);
    writeState({ ...state, output });
  }, 300_000);
});
