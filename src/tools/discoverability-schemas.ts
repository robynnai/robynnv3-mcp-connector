// COS-PLUGIN-002 WP2-06: Zod wire schemas of the three named discoverability
// read tools (WP2-01 tool-contracts.md "Wire schemas"). Mirrors the app's
// src/lib/server/discoverability/read/contracts.ts; both are checked against
// the spec bundle contracts/discoverability-tools.v1.json with the same
// positive/negative corpus (src/tools/discoverability.test.ts).
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
