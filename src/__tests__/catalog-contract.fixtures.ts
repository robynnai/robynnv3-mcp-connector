/**
 * COS-PLUGIN-001 P13 — per-tool contract fixtures (plan §8 "Every-tool contract coverage").
 *
 * One entry per Worker tool. Every entry must give:
 *  - `args`: a valid call that reaches the app (or R2 for Vault);
 *  - optional `variants`: further valid calls, so that the union of app routes
 *    the tool reaches equals its `appRoutes` in contracts/tool-route-map.json;
 *  - optional `rejected`: calls the Worker must refuse before any app/R2 request;
 *  - optional `reply`: a success body for routes whose handler needs a specific shape.
 *
 * Values are synthetic. `P13_MARKER` must come back to the caller on success,
 * which proves the app response reaches the MCP result.
 */
import type { AppRequest } from "./catalog-harness";

export const P13_MARKER = "p13-marker-7d1c";
export const P13_ARG = "p13-arg";
export const WEBSITE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export interface ToolCall {
  label: string;
  args: Record<string, unknown>;
  /** Argument values that must appear in the outgoing request(s). Default: every string arg. */
  forwards?: string[];
}

export interface ToolFixture extends Omit<ToolCall, "label"> {
  variants?: ToolCall[];
  rejected?: Array<ToolCall & { reason: RegExp }>;
  /** Success body for a request; default `genericSuccess`. */
  reply?: (request: AppRequest) => unknown;
}

const PANEL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FRESH = {
  generated_at: "2026-10-09T00:00:00.000Z",
  as_of: "2026-10-08T22:01:00.000Z",
  status: "available",
  reason: null,
};
const interval = (estimate: number | null, unit = "fraction") => ({
  estimate,
  lower90: estimate,
  upper90: estimate,
  unit,
  method: "prompt-clustered-ratio-t90-v1",
  evidence_label: "descriptive",
  expected_n: 12,
  observed_n: 12,
  clusters: 4,
});

/**
 * COS-PLUGIN-002 WP2-06: bare success objects of the discoverability read
 * routes (no `{ success, data }` envelope); they must satisfy the tools'
 * output schemas, which the SDK validates server-side.
 */
export const discoverabilityReplies = {
  siteHealth: () => ({
    website_id: WEBSITE_ID,
    issues: [{ code: "seo_history_unavailable", severity: "info", page_path: null, message: P13_MARKER, evidence: [] }],
    seo: interval(4.2, "percent"),
    geo: interval(-1.5, "percentage_points"),
    crawl: {
      treated_pages: 0,
      delivered_pages: 0,
      parity_pass_pages: 0,
      recrawled_pages: 0,
      exposure_eligible_pages: 0,
      status: "unknown",
      last_checked_at: null,
    },
    freshness: FRESH,
  }),
  aiVisibilityTrend: () => ({
    website_id: WEBSITE_ID,
    panel_id: PANEL_ID,
    series: [
      {
        engine: "perplexity",
        topic: P13_MARKER,
        observation_kind: "fresh_answer_run",
        mention: interval(0.4),
        citation: interval(0.2),
        share_of_voice: interval(0.5),
        fact_errors: 0,
        freshness: FRESH,
        entity_domain: "acme.example",
        metric_coverage: { expected: 12, mention_observed: 12, citation_observed: 10 },
      },
    ],
    provider_snapshots: [
      { platform: "google", observation_kind: "provider_snapshot", distinct_records: 2, provider_observed_at: null, freshness: FRESH },
    ],
    freshness: FRESH,
  }),
  siteLearnings: () => ({
    website_id: WEBSITE_ID,
    items: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        experiment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        type: "faq",
        page_types: ["blog"],
        summary: P13_MARKER,
        effect: interval(6, "percentage_points"),
        evidence: [],
        memory_status: "written",
        created_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    next_cursor: null,
    freshness: FRESH,
  }),
};

/** The `{ success, data }` envelope most `/api/cli/*` and CMO routes return. */
export const genericSuccess = () => ({
  success: true,
  data: {
    marker: P13_MARKER,
    status: "completed",
    id: "thr_p13",
    thread_id: "thr_p13",
    run_id: "run_p13",
    output: P13_MARKER,
  },
});

const PATH_GUARD = /Invalid (thread_id|run_id)/i;
/** SDK zod validation (MCP -32602) rejects the call before the handler runs. */
const schemaRejects = (field: string) => new RegExp(`Input validation error[\\s\\S]*${field}`);

export const TOOL_FIXTURES: Record<string, ToolFixture> = {
  robynn_brand_context: { args: { scope: "voice" }, forwards: ["voice"] },
  robynn_brand_context_search: { args: { query: `${P13_ARG}-query` } },
  robynn_status: { args: {}, forwards: [] },
  robynn_usage: { args: {}, forwards: [] },
  robynn_create_content: {
    args: { type: "blog_post", topic: `${P13_ARG}-topic` },
    variants: [{ label: "existing thread", args: { type: "email", topic: `${P13_ARG}-topic`, thread_id: "thr_existing" } }],
    rejected: [{ label: "unsafe thread_id", args: { type: "email", topic: "t", thread_id: "../runs/x" }, reason: PATH_GUARD }],
  },
  robynn_research: {
    args: { query: `${P13_ARG}-query` },
    // P13 review note 1: with a thread_id there is no createThread title, so only the run request can carry the query.
    variants: [{ label: "existing thread", args: { query: `${P13_ARG}-query-run`, thread_id: "thr_existing" } }],
    rejected: [{ label: "unsafe thread_id", args: { query: "q", thread_id: "a/b" }, reason: PATH_GUARD }],
  },
  robynn_assist: {
    args: { message: `${P13_ARG}-message` },
    variants: [{ label: "existing thread", args: { message: `${P13_ARG}-message-run`, thread_id: "thr_existing" } }],
    rejected: [{ label: "unsafe thread_id", args: { message: "m", thread_id: "a?b" }, reason: PATH_GUARD }],
  },
  robynn_conversations: {
    args: { action: "list" },
    forwards: [],
    variants: [{ label: "create", args: { action: "create", title: `${P13_ARG}-title` }, forwards: [`${P13_ARG}-title`] }],
    reply: (request) =>
      request.method === "GET"
        ? { success: true, data: { threads: [{ id: "thr_p13", title: P13_MARKER }] } }
        : genericSuccess(),
  },
  robynn_run_status: {
    args: { run_id: "run_p13" },
    rejected: [{ label: "unsafe run_id", args: { run_id: "../threads" }, reason: PATH_GUARD }],
  },
  robynn_cmo_agent: { args: { message: `${P13_ARG}-message` } },
  robynn_cmo_decide: {
    args: { thread_id: "thr_p13", run_id: "run_p13", decision_id: `${P13_ARG}-decision`, option_id: `${P13_ARG}-option` },
  },
  robynn_geo_analysis: { args: { company_name: `${P13_ARG}-company` } },
  robynn_competitive_battlecard: { args: { competitor_name: `${P13_ARG}-rival` } },
  robynn_seo_opportunities: { args: { company_name: `${P13_ARG}-company` } },
  robynn_brand_book_status: { args: {} },
  robynn_brand_book_gap_analysis: { args: { focus_areas: [`${P13_ARG}-focus`] }, forwards: [`${P13_ARG}-focus`] },
  robynn_brand_book_strategy: { args: { goals: [`${P13_ARG}-goal`] }, forwards: [`${P13_ARG}-goal`] },
  robynn_brand_reflections: { args: { status_filter: "pending" }, forwards: ["pending"] },
  robynn_trigger_brand_reflections: { args: { dry_run: true }, forwards: [] },
  robynn_publish_brand_book_html: { args: {} },
  robynn_campaign_creator: { args: { company_name: `${P13_ARG}-company` } },
  robynn_campaign_status: { args: { langgraph_thread_id: `${P13_ARG}-lt`, langgraph_run_id: `${P13_ARG}-lr` } },
  robynn_website_audit: { args: { website_url: "https://acme.example" } },
  robynn_website_audit_status: { args: { prospect_audit_id: `${P13_ARG}-audit` } },
  robynn_website_audit_v2: { args: { website_url: "https://acme.example" } },
  robynn_website_audit_v2_status: { args: { scan_id: `${P13_ARG}-scan` } },
  robynn_website_optimization_audit: { args: { website_url: "https://acme.example" } },
  robynn_website_optimization_audit_status: { args: { run_id: `${P13_ARG}-run` } },
  robynn_website_audit_orchestrator: { args: { audit_depth: "top_level", website_url: "https://acme.example" } },
  robynn_website_audit_orchestrator_status: { args: { run_id: `${P13_ARG}-run` } },
  robynn_website_strategy: { args: { primary_goal: `${P13_ARG}-goal` } },
  robynn_content_plan: { args: { brand_or_topic: `${P13_ARG}-topic` } },
  robynn_weekly_visibility_report: {
    args: { website_id: WEBSITE_ID },
    reply: () => ({
      success: true,
      data: {
        summary: P13_MARKER,
        status: "ok",
        generated_at: "2026-10-09T00:00:00.000Z",
        website: { id: WEBSITE_ID, label: "acme.example" },
        range: { current_start: "2026-10-01", current_end: "2026-10-07" },
        source_freshness: {},
        missing_sources: [],
        seo_kpis: { organic_clicks: 1, organic_impressions: 10, ctr: 0.1, average_position: 4 },
        keyword_table: [],
        page_table: [],
        non_ranking_pages: [],
        striking_distance_keywords: [],
        geo_kpis: { prompts_checked: 0, brand_mentions: 0, competitor_mentions: 0, model_scores: [] },
        geo_prompt_table: [],
        recommendations: [],
        next_steps: [],
      },
    }),
  },
  robynn_site_health: {
    args: { website_id: WEBSITE_ID },
    variants: [{ label: "focus and window", args: { website_id: WEBSITE_ID, focus: "geo", window_days: 7 }, forwards: [WEBSITE_ID, "geo"] }],
    reply: discoverabilityReplies.siteHealth,
    rejected: [
      { label: "unknown argument", args: { website_id: WEBSITE_ID, organization_id: WEBSITE_ID }, reason: schemaRejects("organization_id") },
      { label: "window below 7 days", args: { website_id: WEBSITE_ID, window_days: 6 }, reason: schemaRejects("window_days") },
      { label: "non-uuid website", args: { website_id: "not-a-uuid" }, reason: schemaRejects("website_id") },
    ],
  },
  robynn_ai_visibility_trend: {
    args: { website_id: WEBSITE_ID },
    variants: [
      {
        label: "filters",
        args: { website_id: WEBSITE_ID, panel_id: PANEL_ID, engines: ["perplexity"], competitors: ["rival.example"] },
        forwards: [WEBSITE_ID, PANEL_ID, "perplexity", "rival.example"],
      },
    ],
    reply: discoverabilityReplies.aiVisibilityTrend,
    rejected: [
      { label: "unknown engine", args: { website_id: WEBSITE_ID, engines: ["bing"] }, reason: schemaRejects("engines") },
      { label: "empty competitor list", args: { website_id: WEBSITE_ID, competitors: [] }, reason: schemaRejects("competitors") },
      { label: "duplicate competitors", args: { website_id: WEBSITE_ID, competitors: ["a.example", "a.example"] }, reason: schemaRejects("competitors") },
    ],
  },
  robynn_site_learnings: {
    args: { website_id: WEBSITE_ID },
    variants: [{ label: "filters and page", args: { website_id: WEBSITE_ID, type: "faq", page_type: "blog", limit: 5, cursor: "opaque-cursor" } }],
    reply: discoverabilityReplies.siteLearnings,
    rejected: [
      { label: "limit above 50", args: { website_id: WEBSITE_ID, limit: 51 }, reason: schemaRejects("limit") },
      { label: "unknown type", args: { website_id: WEBSITE_ID, type: "popup" }, reason: schemaRejects("type") },
    ],
  },
  robynn_capabilities: { args: {} },
  robynn_brand_source_add: {
    args: { source_type: "text", idempotency_key: `${P13_ARG}-idem`, title: `${P13_ARG}-title`, content: `${P13_ARG}-content` },
  },
  robynn_brand_rebuild: {
    args: { write_confirmed: true },
    forwards: [],
    rejected: [{ label: "write not confirmed", args: { write_confirmed: false }, reason: schemaRejects("write_confirmed") }],
  },
  robynn_connected_apps: {
    args: {},
    reply: () => ({
      success: true,
      data: { providers: [{ provider_key: "hubspot", display_name: P13_MARKER, read_actions: [] }] },
    }),
  },
  robynn_connected_app_capabilities: {
    args: { provider_key: "hubspot" },
    reply: () => ({
      success: true,
      data: { providers: [{ provider_key: "hubspot", display_name: P13_MARKER, read_actions: [] }] },
    }),
  },
  robynn_query_connected_app: { args: { provider_key: "hubspot", action_key: `${P13_ARG}-action` } },
  robynn_connected_app_action: {
    args: {
      service: "hubspot",
      action: `${P13_ARG}-action`,
      parameters: {},
      idempotency_key: `${P13_ARG}-idem`,
      dry_run: true,
    },
    reply: () => ({ ok: true, replayed: false, audit_id: P13_MARKER, dry_run: true }),
  },
  robynn_publish_strapi_draft: {
    args: { write_confirmed: true, title: `${P13_ARG}-title`, content: `${P13_ARG}-content` },
    rejected: [
      { label: "write not confirmed", args: { write_confirmed: false, title: "t", content: "c" }, reason: schemaRejects("write_confirmed") },
      { label: "no artifact_id or content", args: { write_confirmed: true, title: "t" }, reason: /Provide either artifact_id or content/ },
    ],
  },
  robynn_thread_upsert: {
    args: { hermes_host_id: `${P13_ARG}-host`, hermes_session_id: `${P13_ARG}-session`, platform: "cli" },
    reply: () => ({ id: P13_MARKER }),
  },
  robynn_thread_append: {
    args: { thread_id: "thr_p13", role: "user", content: `${P13_ARG}-content` },
    reply: () => ({ id: P13_MARKER }),
    rejected: [{ label: "unsafe thread_id", args: { thread_id: "../memory", role: "user", content: "c" }, reason: PATH_GUARD }],
  },
  robynn_memory_write: {
    args: { scope: "org", key: `${P13_ARG}-key`, value: `${P13_ARG}-value` },
    reply: () => ({ ok: true, marker: P13_MARKER }),
  },
  robynn_memory_get: {
    args: { scope: "org", key: `${P13_ARG}-key` },
    reply: () => ({ key: `${P13_ARG}-key`, value: P13_MARKER }),
  },
  robynn_memory_search: {
    args: { query: `${P13_ARG}-query` },
    reply: () => ({ rows: [{ id: "m1", scope: "org", key: "k", value: P13_MARKER, updated_at: "2026-10-09", score: 1 }] }),
  },
  robynn_vault_list: {
    args: { prefix: "brand/" },
    forwards: [],
    rejected: [{ label: "parent-directory prefix", args: { prefix: "../bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/" }, reason: /parent-directory/ }],
  },
  robynn_vault_read: {
    args: { path: "brand/voice.md" },
    forwards: [],
    rejected: [
      { label: "parent-directory path", args: { path: "../bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/brand/voice.md" }, reason: /parent-directory/ },
      { label: "absolute path", args: { path: "/orgs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/brand/voice.md" }, reason: /absolute/ },
    ],
  },
};
