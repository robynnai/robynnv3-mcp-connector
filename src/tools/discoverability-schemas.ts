// COS-PLUGIN-002 WP2-06/WP2-11: Zod wire schemas of the ten named
// discoverability tools (WP2-01 tool-contracts.md "Wire schemas"). Mirrors the
// app's src/lib/server/discoverability/read/contracts.ts (reads) and
// .../tools/contracts.ts, .../experiments/service.ts and
// .../guardrails/contract.ts (WP2-11 tools); all are checked against the spec
// bundle contracts/discoverability-tools.v1.json with the same
// positive/negative corpus (src/tools/discoverability*.test.ts).
//
// Inputs are CLOSED objects (`.strict()` → additionalProperties:false), so the
// SDK rejects unknown arguments before the handler runs. Outputs describe the
// BARE success object passed to toSuccessResult as structuredContent; the SDK
// validates it server-side. Errors use the separate DISCOVERABILITY_ERROR shape.

import { z } from "zod";

export const DISCOVERABILITY_ENGINES = [
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
] as const;
export type DiscoverabilityEngine = (typeof DISCOVERABILITY_ENGINES)[number];

export const EXPERIMENT_TYPES = [
  "title_meta",
  "answer_first",
  "evidence_block",
  "faq",
  "brand_fact",
  "structured_data",
  "internal_links",
  "comparison_page",
] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

/** tool-contracts.md $defs/error code enum. */
export const DISCOVERABILITY_ERROR_CODES = [
  "invalid_token",
  "insufficient_scope",
  "membership_inactive",
  "role_forbidden",
  "grant_revoked",
  "authorization_expired",
  "authorization_unavailable",
  "tool_not_permitted",
  "not_found",
  "idempotency_key_reused",
  "idempotency_in_progress",
  "idempotency_outcome_unknown",
  "environment_not_eligible",
  "invalid_request",
  "validation_failed",
  "data_unavailable",
  "design_ineligible",
  "proposal_stale",
  "conflict",
  "internal_error",
] as const;
export type DiscoverabilityErrorCode =
  (typeof DISCOVERABILITY_ERROR_CODES)[number];

const uuid = () => z.string().uuid();
const dateTime = () => z.string().datetime({ offset: true });
const nullableDateTime = () => dateTime().nullable();

/** $defs/path: `^/(?!/)[^?#\\]*$`, 1..2048 characters. */
const pagePathSchemaDef = () =>
  z
    .string()
    .min(1)
    .max(2048)
    .regex(/^\/(?!\/)[^?#\\]*$/);
export const pagePathSchema = pagePathSchemaDef();

const evidenceSchemaDef = () =>
  z
    .object({
      kind: z.enum(["scan", "gsc", "panel", "crawl", "claim", "experiment"]),
      id: z.string().min(1).max(512),
      summary: z.string().min(1).max(2000),
      observed_at: nullableDateTime(),
    })
    .strict();
export const evidenceSchema = evidenceSchemaDef();
export type Evidence = z.infer<typeof evidenceSchema>;

export const FRESHNESS_STATUSES = [
  "available",
  "stale",
  "partial",
  "unavailable",
] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

const freshnessSchemaDef = () =>
  z
    .object({
      generated_at: nullableDateTime(),
      as_of: nullableDateTime(),
      status: z.enum(FRESHNESS_STATUSES),
      reason: z.string().min(1).max(100).nullable(),
    })
    .strict();
export const freshnessSchema = freshnessSchemaDef();
export type Freshness = z.infer<typeof freshnessSchema>;

const intervalSchemaDef = () =>
  z
    .object({
      estimate: z.number().nullable(),
      lower90: z.number().nullable(),
      upper90: z.number().nullable(),
      unit: z.enum(["percent", "percentage_points", "fraction", "count"]),
      method: z.string().min(1).max(100),
      evidence_label: z.enum(["randomized", "observational", "descriptive"]),
      expected_n: z.number().int().min(0),
      observed_n: z.number().int().min(0),
      clusters: z.number().int().min(0),
    })
    .strict();
export const intervalSchema = intervalSchemaDef();
export type Interval = z.infer<typeof intervalSchema>;

const issueSchemaDef = () =>
  z
    .object({
      code: z.string().min(1).max(100),
      severity: z.enum(["info", "warning", "blocker"]),
      page_path: pagePathSchemaDef().nullable(),
      message: z.string().min(1).max(2000),
      evidence: z.array(evidenceSchemaDef()).min(0).max(20),
    })
    .strict();
export const issueSchema = issueSchemaDef();
export type Issue = z.infer<typeof issueSchema>;

const deliverySchemaDef = () =>
  z
    .object({
      treated_pages: z.number().int().min(0),
      delivered_pages: z.number().int().min(0),
      parity_pass_pages: z.number().int().min(0),
      recrawled_pages: z.number().int().min(0),
      exposure_eligible_pages: z.number().int().min(0),
      status: z.enum(["pending", "verified", "failed", "unknown"]),
      last_checked_at: nullableDateTime(),
    })
    .strict();
export const deliverySchema = deliverySchemaDef();
export type Delivery = z.infer<typeof deliverySchema>;

const learningSchemaDef = () =>
  z
    .object({
      id: uuid(),
      experiment_id: uuid(),
      type: z.enum(EXPERIMENT_TYPES),
      page_types: z.array(z.string().min(1).max(100)).min(0).max(30),
      summary: z.string().min(1).max(2000),
      effect: intervalSchemaDef(),
      evidence: z.array(evidenceSchemaDef()).min(0).max(20),
      memory_status: z.enum(["pending", "written", "failed"]),
      created_at: dateTime(),
    })
    .strict();
export const learningSchema = learningSchemaDef();
export type Learning = z.infer<typeof learningSchema>;

// ---------------------------------------------------------------------------
// Inputs (closed objects; unknown arguments fail before any I/O)
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_DAYS = 28;
export const DEFAULT_LEARNINGS_LIMIT = 20;

const windowDays = () => z.number().int().min(7).max(180);

export const siteHealthInputSchema = z
  .object({
    website_id: uuid(),
    focus: z.enum(["seo", "geo", "both"]).optional(),
    window_days: windowDays().default(DEFAULT_WINDOW_DAYS),
  })
  .strict();
export type SiteHealthInput = z.infer<typeof siteHealthInputSchema>;

export const aiVisibilityTrendInputSchema = z
  .object({
    website_id: uuid(),
    panel_id: uuid().optional(),
    engines: z.array(z.enum(DISCOVERABILITY_ENGINES)).min(1).max(4).optional(),
    window_days: windowDays().default(DEFAULT_WINDOW_DAYS),
    competitors: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(10)
      .refine((items) => new Set(items).size === items.length, {
        message: "competitors must be unique",
      })
      .optional(),
  })
  .strict();
export type AiVisibilityTrendInput = z.infer<
  typeof aiVisibilityTrendInputSchema
>;

export const siteLearningsInputSchema = z
  .object({
    website_id: uuid(),
    type: z.enum(EXPERIMENT_TYPES).optional(),
    page_type: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(50).default(DEFAULT_LEARNINGS_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type SiteLearningsInput = z.infer<typeof siteLearningsInputSchema>;

// ---------------------------------------------------------------------------
// Outputs (bare success objects)
// ---------------------------------------------------------------------------

export const siteHealthOutputSchema = z
  .object({
    website_id: uuid(),
    issues: z.array(issueSchemaDef()).min(0).max(100),
    seo: intervalSchemaDef(),
    geo: intervalSchemaDef(),
    crawl: deliverySchemaDef(),
    freshness: freshnessSchemaDef(),
  })
  .strict();
export type SiteHealthOutput = z.infer<typeof siteHealthOutputSchema>;

const trendSeriesSchemaDef = () =>
  z
    .object({
      engine: z.enum(DISCOVERABILITY_ENGINES),
      topic: z.string().min(1).max(200),
      observation_kind: z.literal("fresh_answer_run"),
      mention: intervalSchemaDef(),
      citation: intervalSchemaDef(),
      share_of_voice: intervalSchemaDef(),
      fact_errors: z.number().int().min(0),
      freshness: freshnessSchemaDef(),
      entity_domain: z.string().min(1).max(253),
      metric_coverage: z
        .object({
          expected: z.number().int().min(0),
          mention_observed: z.number().int().min(0),
          citation_observed: z.number().int().min(0),
        })
        .strict(),
    })
    .strict();
export const trendSeriesSchema = trendSeriesSchemaDef();
export type TrendSeries = z.infer<typeof trendSeriesSchema>;

const providerSnapshotSeriesSchemaDef = () =>
  z
    .object({
      platform: z.enum(["google", "chat_gpt"]),
      observation_kind: z.literal("provider_snapshot"),
      distinct_records: z.number().int().min(0),
      provider_observed_at: nullableDateTime(),
      freshness: freshnessSchemaDef(),
    })
    .strict();
export const providerSnapshotSeriesSchema = providerSnapshotSeriesSchemaDef();
export type ProviderSnapshotSeries = z.infer<
  typeof providerSnapshotSeriesSchema
>;

export const MAX_TREND_SERIES = 500;

export const aiVisibilityTrendOutputSchema = z
  .object({
    website_id: uuid(),
    panel_id: uuid().nullable(),
    series: z.array(trendSeriesSchemaDef()).min(0).max(MAX_TREND_SERIES),
    provider_snapshots: z
      .array(providerSnapshotSeriesSchemaDef())
      .min(0)
      .max(20),
    freshness: freshnessSchemaDef(),
  })
  .strict();
export type AiVisibilityTrendOutput = z.infer<
  typeof aiVisibilityTrendOutputSchema
>;

export const siteLearningsOutputSchema = z
  .object({
    website_id: uuid(),
    items: z.array(learningSchemaDef()).min(0).max(50),
    next_cursor: z.string().min(1).max(512).nullable(),
    freshness: freshnessSchemaDef(),
  })
  .strict();
export type SiteLearningsOutput = z.infer<typeof siteLearningsOutputSchema>;

/** $defs/error: the structured denial / failure body of these routes. */
export const discoverabilityErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum(DISCOVERABILITY_ERROR_CODES),
        message: z.string(),
        retryable: z.boolean(),
        required_scope: z.enum(["brand:read", "tools:execute"]).optional(),
        request_id: z.string().optional(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// COS-PLUGIN-002 WP2-11: the remaining seven tools
// ---------------------------------------------------------------------------

export const PRIMARY_METRICS = [
  "seo_clicks",
  "seo_ctr",
  "geo_citation_rate",
  "geo_mention_rate",
] as const;

export const EXPERIMENT_STATES = [
  "pending_approval",
  "approved",
  "queued",
  "delivering",
  "measuring",
  "paused",
  "completed",
  "cancelled",
  "rollback_requested",
  "rolling_back",
  "rolled_back",
  "failed",
] as const;

export const CHANGE_FIELDS = [
  "title",
  "meta_description",
  "h1",
  "intro",
  "body_block",
  "faq",
  "schema_jsonld",
  "internal_link",
  "new_page",
] as const;

const hash = () => z.string().regex(/^[0-9a-f]{64}$/);
/** JSON Schema `format: date`. */
const fullDate = () => z.string().date();
const idempotencyKey = () =>
  z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);

const costSchemaDef = () =>
  z
    .object({
      currency: z.literal("USD"),
      estimated_microusd: z.number().int().min(0),
      maximum_microusd: z.number().int().min(0),
      budget_remaining_microusd: z.number().int().min(0),
      rate_card_version: z.string().min(1).max(100),
      credits_charged: z.literal(false),
    })
    .strict();
export const costSchema = costSchemaDef();
export type Cost = z.infer<typeof costSchema>;

/** $defs/approval_link: absolute same-origin navigation URL (format uri). */
const approvalLinkDef = () => z.string().url().max(2048);

const validationSchemaDef = () =>
  z
    .object({
      valid: z.boolean(),
      report_hash: hash(),
      validator_version: z.string().min(1).max(100),
      issues: z.array(issueSchemaDef()).min(0).max(100),
      claim_version_ids: z.array(uuid()).min(0).max(100),
      content_hash: hash(),
      evidence_freshness: freshnessSchemaDef(),
    })
    .strict();
export const validationSchema = validationSchemaDef();
export type Validation = z.infer<typeof validationSchema>;

const changeSchemaDef = () =>
  z
    .object({
      page_path: pagePathSchemaDef(),
      field: z.enum(CHANGE_FIELDS),
      content: z.string().min(1).max(100_000),
      selector: z.string().min(1).max(512).optional(),
      before_hash: hash(),
      delivery_binding_id: uuid(),
      claim_version_ids: z.array(uuid()).min(0).max(50).optional(),
    })
    .strict();

const proposalSchemaDef = () =>
  z
    .object({
      proposal_id: hash(),
      diagnostic_hash: hash(),
      type: z.enum(EXPERIMENT_TYPES),
      hypothesis: z.string().min(1).max(2000),
      pages: z.array(pagePathSchemaDef()).min(1).max(25),
      design: z.enum(["A", "B", "C"]),
      evidence_label: z.enum(["randomized", "observational", "descriptive"]),
      expected_impact: z.string().min(1).max(2000),
      minimum_days: z.number().int().min(21).max(84),
      cost: costSchemaDef(),
      eligibility_reasons: z.array(z.string().min(1).max(200)).min(0).max(30),
      evidence: z.array(evidenceSchemaDef()).min(0).max(20),
    })
    .strict();
export type Proposal = z.infer<ReturnType<typeof proposalSchemaDef>>;

const guardrailSchemaDef = () =>
  z
    .object({
      metric: z.enum(["conversion_rate", "untreated_clicks", "fact_accuracy"]),
      status: z.enum(["pass", "regressed", "unknown"]),
      margin: z.number(),
      interval: intervalSchemaDef(),
      reason: z.string().min(1).max(2000).nullable(),
    })
    .strict();

const statusItemSchemaDef = () =>
  z
    .object({
      experiment_id: uuid(),
      website_id: uuid(),
      state: z.enum(EXPERIMENT_STATES),
      days_elapsed: z.number().int().min(0),
      post_start: fullDate(),
      post_end: fullDate(),
      delivery: deliverySchemaDef(),
      interim: intervalSchemaDef(),
      conclusive: z.literal(false),
      warnings: z.array(z.string().min(1).max(2000)).min(0).max(100),
      freshness: freshnessSchemaDef(),
    })
    .strict();
export type StatusItem = z.infer<ReturnType<typeof statusItemSchemaDef>>;

export const DEFAULT_PROPOSALS_MAX = 5;
export const DEFAULT_STATUS_LIMIT = 20;

export const proposeExperimentsInputSchema = z
  .object({
    website_id: uuid(),
    goal: z.enum(PRIMARY_METRICS),
    types: z.array(z.enum(EXPERIMENT_TYPES)).min(1).max(8).optional(),
    max: z.number().int().min(1).max(10).default(DEFAULT_PROPOSALS_MAX),
  })
  .strict();
export type ProposeExperimentsInput = z.infer<typeof proposeExperimentsInputSchema>;

export const checkPageContentInputSchema = z
  .object({
    website_id: uuid(),
    page_path: pagePathSchemaDef(),
    draft: z.string().min(1).max(100_000),
  })
  .strict();
export type CheckPageContentInput = z.infer<typeof checkPageContentInputSchema>;

export const createExperimentInputSchema = z
  .object({
    website_id: uuid(),
    proposal_id: hash().optional(),
    type: z.enum(EXPERIMENT_TYPES),
    hypothesis: z.string().min(1).max(2000),
    changes: z.array(changeSchemaDef()).min(1).max(100),
    primary_metric: z.enum(PRIMARY_METRICS).optional(),
    idempotency_key: idempotencyKey(),
  })
  .strict();
export type CreateExperimentInput = z.infer<typeof createExperimentInputSchema>;

/**
 * Published shape of robynn_experiment_status. The spec's oneOf (exactly one
 * of experiment_id / website_id; limit and cursor only with website_id) is
 * not expressible through the SDK's object-only input conversion, so it is
 * enforced by `experimentStatusSelection` in the handler (and again by the
 * app) before any request; the documented equivalence gap is pinned in
 * discoverability-write.test.ts.
 */
export const experimentStatusInputSchema = z
  .object({
    experiment_id: uuid().optional(),
    website_id: uuid().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ExperimentStatusInput = z.infer<typeof experimentStatusInputSchema>;

/** The spec's oneOf as a refinement: null when valid, else the reason. */
export function experimentStatusSelection(input: ExperimentStatusInput): string | null {
  const byExperiment = input.experiment_id !== undefined;
  const byWebsite = input.website_id !== undefined;
  if (byExperiment === byWebsite) return "Pass exactly one of experiment_id or website_id.";
  if (byExperiment && (input.limit !== undefined || input.cursor !== undefined)) {
    return "limit and cursor are only valid with website_id.";
  }
  return null;
}

export const experimentResultsInputSchema = z.object({ experiment_id: uuid() }).strict();
export type ExperimentResultsInput = z.infer<typeof experimentResultsInputSchema>;

export const promoteExperimentInputSchema = z
  .object({
    experiment_id: uuid(),
    scope: z.enum(["treated_pages", "all_similar_pages"]),
    idempotency_key: idempotencyKey(),
  })
  .strict();
export type PromoteExperimentInput = z.infer<typeof promoteExperimentInputSchema>;

export const rollbackExperimentInputSchema = z
  .object({
    experiment_id: uuid(),
    reason: z.string().min(1).max(2000),
    confirm: z.literal(true),
    idempotency_key: idempotencyKey(),
  })
  .strict();
export type RollbackExperimentInput = z.infer<typeof rollbackExperimentInputSchema>;

export const proposeExperimentsOutputSchema = z
  .object({
    website_id: uuid(),
    proposals: z.array(proposalSchemaDef()).min(0).max(10),
    freshness: freshnessSchemaDef(),
  })
  .strict();
export type ProposeExperimentsOutput = z.infer<typeof proposeExperimentsOutputSchema>;

export const checkPageContentOutputSchema = validationSchemaDef();
export type CheckPageContentOutput = z.infer<typeof checkPageContentOutputSchema>;

export const createExperimentOutputSchema = z
  .object({
    experiment_id: uuid(),
    state: z.literal("pending_approval"),
    validation: validationSchemaDef(),
    design: z.enum(["A", "B", "C"]),
    analysis_plan_hash: hash(),
    change_set_hash: hash(),
    duration_days: z.number().int().min(21).max(84),
    cost: costSchemaDef(),
    approval_link: approvalLinkDef(),
    approval_expires_at: dateTime(),
  })
  .strict();
export type CreateExperimentOutput = z.infer<typeof createExperimentOutputSchema>;

export const experimentStatusOutputSchema = z
  .object({
    items: z.array(statusItemSchemaDef()).min(0).max(50),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ExperimentStatusOutput = z.infer<typeof experimentStatusOutputSchema>;

export const experimentResultsOutputSchema = z
  .object({
    experiment_id: uuid(),
    verdict: z.enum(["measuring", "win", "loss", "neutral", "inconclusive", "invalid"]),
    is_final: z.boolean(),
    primary: intervalSchemaDef(),
    guardrails: z.array(guardrailSchemaDef()).min(0).max(3),
    delivery: deliverySchemaDef(),
    units: z
      .array(
        z
          .object({
            unit_id: uuid(),
            arm: z.enum(["treatment", "control"]),
            effect: intervalSchemaDef(),
            warnings: z.array(z.string().min(1).max(2000)).min(0).max(20),
          })
          .strict(),
      )
      .min(0)
      .max(100),
    learnings: z.array(learningSchemaDef()).min(0).max(10),
    warnings: z.array(z.string().min(1).max(2000)).min(0).max(100),
    freshness: freshnessSchemaDef(),
  })
  .strict();
export type ExperimentResultsOutput = z.infer<typeof experimentResultsOutputSchema>;

export const promoteExperimentOutputSchema = z
  .object({
    request_id: uuid(),
    source_experiment_id: uuid(),
    new_experiment_id: uuid(),
    state: z.literal("pending_approval"),
    target_pages: z.array(pagePathSchemaDef()).min(1).max(25),
    change_set_hash: hash(),
    approval_link: approvalLinkDef(),
    cost: costSchemaDef(),
  })
  .strict();
export type PromoteExperimentOutput = z.infer<typeof promoteExperimentOutputSchema>;

export const rollbackExperimentOutputSchema = z
  .object({
    request_id: uuid(),
    experiment_id: uuid(),
    state: z.literal("rollback_requested"),
    executed: z.literal(false),
    approval_link: approvalLinkDef(),
  })
  .strict();
export type RollbackExperimentOutput = z.infer<typeof rollbackExperimentOutputSchema>;
