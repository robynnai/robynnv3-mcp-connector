/**
 * COS-PLUGIN-001 P17 — synthetic outputs for every LangGraph graph the 48
 * MCP tools reach on the plugin-local stack. Shapes follow the app's parsers
 * (file references are robynnv3 paths), not any real agent: the point is to
 * prove the app → Worker → MCP plumbing, persistence and billing around a
 * graph, deterministically and offline.
 */
import { FIXTURE_MARKER, cmoOutput, type BackendFixture, type FixtureRun } from "./backend-fixture";

const MARKDOWN = `# ${FIXTURE_MARKER}\n\n` + "Synthetic fixture report paragraph for the plugin-local stack. ".repeat(8);

/** v3 / orchestrator result: one completed page report per seeded page (v3/agent-client.ts, audit-billing.ts). */
function websiteV3Values(version: string) {
  return (run: FixtureRun) => {
    const seeds = Array.isArray(run.input.seed_pages) ? (run.input.seed_pages as Array<Record<string, unknown>>) : [];
    return {
      version,
      summary: FIXTURE_MARKER,
      recommendations: [],
      website_report: { summary: FIXTURE_MARKER },
      page_reports: seeds.map((page) => ({ url: page.url, status: "completed", summary: FIXTURE_MARKER })),
      evidence_graph: {},
    };
  };
}

export interface GraphHooks {
  /** competitor_intelligence_v1 writes its battlecard row itself (competitive-battlecard/+server.ts reads it back). */
  writeBattlecard(competitorId: string): void;
}

export function registerFixtureGraphs(fixture: BackendFixture, hooks: GraphHooks) {
  // Instant Agent / CMO (runs.ts): thread state with text, decision card and artifact manifest.
  for (const id of ["cmo_v3", "cmo_v2", "auto", "*"]) fixture.graph(id, cmoOutput);

  // GEO (agents/geo/execute: threads → runs → poll → state values).
  fixture.graph("geo_researcher", () => ({
    markdown: `<div>${FIXTURE_MARKER}</div>`,
    summary: FIXTURE_MARKER,
    total_citations: 3,
    target_citations: 1,
    competitor_citations: 1,
    topic_gaps: [],
    strategic_recommendations: [`${FIXTURE_MARKER} recommendation`],
    run_valid: true,
    grounding_confidence: "medium",
  }));

  // SEO (seo-researcher-agent.ts: runs/wait needs html_report, no errors).
  fixture.graph("seo_researcher", () => ({
    html_report: `<div>${FIXTURE_MARKER}</div>`,
    content_gaps: [],
    competitors: [],
    keyword_data: [],
    serp_analysis: {},
    errors: [],
  }));

  // Content planner (content-planner-v2-agent.ts: json_report.content_plan_rows non-empty).
  fixture.graph("content_planner_v2", () => ({
    json_report: {
      status: "success",
      summary: FIXTURE_MARKER,
      content_plan_rows: [
        {
          title: `${FIXTURE_MARKER} article`,
          target_slug: "p17-fixture-article",
          premise: "Synthetic premise",
          source_references: ["synthetic-research"],
          existing_content_decision: "new",
        },
      ],
    },
  }));

  // Battlecard (competitive-battlecard/+server.ts: runs/wait, then reads competitor_battlecards).
  fixture.graph("competitor_intelligence_v1", {
    values: () => ({ status: "success" }),
    onRun: (run) => {
      const id = run.input.competitor_id;
      if (typeof id === "string") hooks.writeBattlecard(id);
    },
  });

  // Brand reflection (langgraph-client.ts: analysis_result).
  fixture.graph("brand_reflection", () => ({
    analysis_result: { is_significant: false, brand_impact_type: "none", confidence: 0.5, headline: FIXTURE_MARKER, summary: FIXTURE_MARKER },
  }));

  // Website strategy (website-adapters.ts: runs/wait output.result.report_markdown).
  fixture.graph("website_report_v1", () => ({
    output: {
      result: {
        status: "success",
        report_markdown: `## 1. Website First Impression + Positioning\n${FIXTURE_MARKER} clear promise.\n## 2. UX/Conversion Friction\nOne CTA.\n## 3. Keyword Opportunities + Gap\nSynthetic gap.`,
        confidence_summary: { overall: "medium" },
      },
    },
  }));

  // Website audit v2 (website-optimization/agent-client.ts: any 2xx JSON completes the scan).
  fixture.graph("website_optimization_v2", () => ({
    output: { change_packs: [], opportunity_briefs: [], summary: { text: FIXTURE_MARKER } },
  }));

  // v3 optimization audit and orchestrator (SSE `values`, then run status success).
  fixture.graph("website_optimization_v3", websiteV3Values("v3"));
  fixture.graph("website_audit_orchestrator_v1", websiteV3Values("orchestrator_v1"));

  // Campaign builder (marketing-campaign-runner.ts: values.output_data.result.markdown).
  fixture.graph("marketing_campaign_builder", () => ({ output_data: { result: { markdown: MARKDOWN } } }));

  // Prospect audit (prospect-audit-runner.ts: a nested `prospect_audit` object in the run or the state).
  const prospectAudit = { headline: FIXTURE_MARKER, score: 72, summary: "Synthetic prospect audit" };
  fixture.graph("cmo_audit_v1", {
    values: () => ({ prospect_audit: prospectAudit }),
    runFields: () => ({ output: { prospect_audit: prospectAudit } }),
  });
}
