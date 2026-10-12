/**
 * COS-PLUGIN-002 WP2-06 — MILESTONE 1 read path on the plugin-local stack.
 *
 * A real MCP host connection (P16 OAuth chain: /authorize → sign-in →
 * consent → /callback → PKCE /token) to the real Worker (`wrangler dev
 * --local`), which calls the real app routes, which read the stored
 * projections that the app's M1 run produced from robynn.ai-shaped daily
 * Search Console and AI-visibility history (app repo
 * src/lib/server/discoverability/read/m1-watch.local.test.ts, run first).
 *
 * Proves: the three tools are listed with their annotations; a read-only
 * (brand:read) connection reads the daily GSC and panel history; filters
 * and windows work; unknown competitors are refused; another organization
 * cannot see the website; and reading changes nothing in the database.
 *
 * Skipped unless PLUGIN_LOCAL_LIVE=1 (`pnpm test:plugin-local`).
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ALPHA,
  BETA,
  LIVE,
  ORG_A,
  ORG_B,
  callTool,
  connectHost,
  explicitlySkipped,
  lit,
  listTools,
  logsContainingSensitiveValues,
  openSession,
  registerHost,
  sql,
  toolErrorCode,
  toolOk,
  type HostConnection,
  type McpReply,
} from "./live-stack";

const WEBSITE = process.env.PLUGIN_LOCAL_M1_WEBSITE_ID ?? "0c05a001-0000-4000-8000-0000000206a1";
const EVIDENCE_OUT = process.env.PLUGIN_LOCAL_M1_EVIDENCE_OUT ?? "";
const TOOLS = ["robynn_site_health", "robynn_ai_visibility_trend", "robynn_site_learnings"];

interface Conn extends HostConnection {
  session: string;
}

async function connect(user: { id: string; email: string }, organizationId: string): Promise<Conn> {
  const clientId = await registerHost(`WP2-06 M1 Host ${organizationId.slice(-2)}`);
  const conn = await connectHost({ clientId, user, organizationId, scope: "brand:read" });
  expect(conn.scope).toBe("brand:read");
  return { ...conn, session: await openSession(conn.access) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: McpReply): any => r.json?.result?.structuredContent ?? {};
const text = (r: McpReply) => (r.json?.result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "";

/** Row counts and fingerprints a read must never change. */
function dbFingerprint() {
  const site = lit(WEBSITE);
  return {
    projections: sql(
      `select count(*) || ':' || coalesce(max(generated_at)::text, '-') || ':' || coalesce(string_agg(inputs_hash, ',' order by kind, projection_key), '-') from public.discoverability_projections where website_id = ${site}`,
    ),
    job_runs: sql(`select count(*) from public.discoverability_job_runs where website_id = ${site}`),
    slots: sql(`select count(*) from public.geo_run_slots where website_id = ${site}`),
    spend: sql(`select coalesce(sum(spent_microusd + reserved_microusd), 0) from public.discoverability_spend_months where organization_id = ${lit(ORG_A)}`),
    outbox: sql(`select count(*) from public.discoverability_outbox where website_id = ${site}`),
    audit: sql(`select count(*) from public.discoverability_audit_events where website_id = ${site}`),
    gsc_extractions: sql(`select count(*) from public.gsc_extractions where website_id = ${site}`),
  };
}

describe.skipIf(!LIVE || explicitlySkipped("discoverability-m1"))("M1: discoverability history through a real MCP client (plugin-local)", () => {
  let alpha: Conn;
  const evidence: Record<string, unknown> = {};
  let before: ReturnType<typeof dbFingerprint>;

  beforeAll(async () => {
    // The app-side M1 run must have produced this website's projections.
    expect(sql(`select count(*) from public.discoverability_projections where website_id = ${lit(WEBSITE)}`)).toBe("4");
    before = dbFingerprint();
    alpha = await connect(ALPHA, ORG_A);
  }, 120_000);

  afterAll(() => {
    if (EVIDENCE_OUT) writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  });

  it("tools/list: the three named read tools with T/F/F/T annotations on a brand:read connection", async () => {
    const list = await listTools(alpha.access, alpha.session);
    const tools = list.json?.result?.tools as Array<{ name: string; title: string; annotations: Record<string, unknown>; outputSchema?: unknown }>;
    expect(tools).toHaveLength(51);
    for (const name of TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });
      expect(tool.outputSchema, name).toBeDefined();
    }
    evidence.tools_list = TOOLS.map((name) => {
      const t = tools.find((x) => x.name === name)!;
      return { name, title: t.title, annotations: t.annotations };
    });
  });

  it("robynn_site_health: the daily Search Console trend and the AI mention-rate trend from stored history", async () => {
    const reply = await callTool(alpha.access, alpha.session, "robynn_site_health", { website_id: WEBSITE });
    expect(toolOk(reply), JSON.stringify(reply.json).slice(0, 500)).toBe(true);
    const out = data(reply);
    expect(out.website_id).toBe(WEBSITE);
    expect(out.seo).toMatchObject({ unit: "percent", observed_n: 56, expected_n: 56, evidence_label: "descriptive" });
    expect(out.seo.estimate).not.toBeNull();
    expect(out.geo.unit).toBe("percentage_points");
    expect(out.geo.estimate).not.toBeNull();
    expect(out.geo.clusters).toBe(35);
    expect(out.crawl.status).toBe("unknown");
    expect(out.freshness).toMatchObject({ status: "partial", reason: "unavailable_sections:crawl" });
    expect(out.issues.map((i: { code: string }) => i.code)).toContain("crawl_history_unavailable");
    expect(text(reply)).toMatch(/SEO \(Search Console clicks/);
    evidence.site_health = { structured: out, text: text(reply) };
  });

  it("robynn_ai_visibility_trend: per-engine mention/citation/share-of-voice with coverage, competitors and provider snapshots apart", async () => {
    const reply = await callTool(alpha.access, alpha.session, "robynn_ai_visibility_trend", { website_id: WEBSITE });
    expect(toolOk(reply), JSON.stringify(reply.json).slice(0, 500)).toBe(true);
    const out = data(reply);
    const target = out.series.filter((s: { topic: string; entity_domain: string }) => s.topic === "all" && s.entity_domain === "robynn.ai");
    expect(target.map((s: { engine: string }) => s.engine).sort()).toEqual(["chatgpt", "claude", "gemini", "perplexity"]);
    for (const s of target) {
      expect(s.observation_kind).toBe("fresh_answer_run");
      expect(s.metric_coverage.mention_observed).toBeGreaterThan(0);
      expect(s.metric_coverage.mention_observed).toBeLessThanOrEqual(s.metric_coverage.expected);
      expect(s.mention.evidence_label).toBe("descriptive");
    }
    expect(out.series.some((s: { entity_domain: string }) => s.entity_domain === "competitor.example.test")).toBe(true);
    expect(out.provider_snapshots.map((p: { platform: string; observation_kind: string }) => [p.platform, p.observation_kind])).toEqual([
      ["google", "provider_snapshot"],
      ["chat_gpt", "provider_snapshot"],
    ]);
    evidence.ai_visibility_trend = {
      panel_id: out.panel_id,
      freshness: out.freshness,
      series: out.series.length,
      all_topics_target: target,
      provider_snapshots: out.provider_snapshots,
      text: text(reply),
    };

    const week = await callTool(alpha.access, alpha.session, "robynn_ai_visibility_trend", {
      website_id: WEBSITE,
      window_days: 7,
      engines: ["perplexity"],
      competitors: ["Competitor.Example.Test"],
    });
    expect(toolOk(week)).toBe(true);
    const weekOut = data(week);
    expect(new Set(weekOut.series.map((s: { engine: string }) => s.engine))).toEqual(new Set(["perplexity"]));
    expect(new Set(weekOut.series.map((s: { entity_domain: string }) => s.entity_domain))).toEqual(new Set(["robynn.ai", "competitor.example.test"]));
    const weekAll = weekOut.series.find((s: { topic: string; entity_domain: string }) => s.topic === "all" && s.entity_domain === "robynn.ai");
    const monthAll = target.find((s: { engine: string }) => s.engine === "perplexity");
    expect(weekAll.metric_coverage.expected).toBeLessThan(monthAll.metric_coverage.expected);
    evidence.ai_visibility_trend_week_perplexity = weekAll;

    const unknown = await callTool(alpha.access, alpha.session, "robynn_ai_visibility_trend", { website_id: WEBSITE, competitors: ["unknown.example.test"] });
    expect(toolErrorCode(unknown)).toBe("invalid_request");
    evidence.unknown_competitor = data(unknown);
  });

  it("robynn_site_learnings: no finalized experiments yet, reported as available and empty", async () => {
    const reply = await callTool(alpha.access, alpha.session, "robynn_site_learnings", { website_id: WEBSITE });
    expect(toolOk(reply)).toBe(true);
    expect(data(reply)).toMatchObject({ website_id: WEBSITE, items: [], next_cursor: null });
    expect(data(reply).freshness).toMatchObject({ status: "available", reason: "no_learnings_recorded" });
    evidence.site_learnings = data(reply);
  });

  it("another organization cannot see the website (not_found, no ownership oracle)", async () => {
    const betaB = await connect(BETA, ORG_B);
    const alphaB = await connect(ALPHA, ORG_B);
    const codes: Record<string, string | null> = {};
    for (const [label, conn] of [
      ["beta@orgB", betaB],
      ["alpha@orgB", alphaB],
    ] as const) {
      for (const name of TOOLS) {
        const reply = await callTool(conn.access, conn.session, name, { website_id: WEBSITE });
        codes[`${label} ${name}`] = toolErrorCode(reply);
        expect(toolErrorCode(reply), `${label} ${name}`).toBe("not_found");
      }
    }
    evidence.cross_org = codes;
  }, 180_000);

  it("reading changed nothing: projections, jobs, slots, spend, outbox, audit and GSC extractions are identical; no secret reached the logs", () => {
    const after = dbFingerprint();
    expect(after).toEqual(before);
    evidence.db_fingerprint = { before, after };
    expect(logsContainingSensitiveValues()).toEqual([]);
  });
});
