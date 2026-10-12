import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  RobynnApiError,
  UpstreamAuthorizationExpiredError,
  type RobynnClient,
} from "../robynn-client";
import {
  DISCOVERABILITY_ERROR_CODES,
  aiVisibilityTrendInputSchema,
  aiVisibilityTrendOutputSchema,
  siteHealthInputSchema,
  siteHealthOutputSchema,
  siteLearningsInputSchema,
  siteLearningsOutputSchema,
  type AiVisibilityTrendOutput,
  type DiscoverabilityErrorCode,
  type Interval,
  type SiteHealthOutput,
  type SiteLearningsOutput,
} from "./discoverability-schemas";
import { toSuccessResult, toolMetadata } from "./util";

/**
 * COS-PLUGIN-002 WP2-06: the three named, read-only discoverability tools
 * (WP2-01 tool-contracts.md). Each reads STORED projections in Robynn only:
 * no refresh, no provider call, no charge, no write, no alert. Sections
 * with nothing stored come back "unavailable", never as zero visibility.
 * Registered on the Worker (with and without Vault) and the local CLI.
 */
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const KNOWN_CODES: ReadonlySet<string> = new Set(DISCOVERABILITY_ERROR_CODES);

const ERROR_MESSAGES: Partial<Record<DiscoverabilityErrorCode, string>> = {
  invalid_token: "Robynn did not accept this connection. Reconnect Robynn.",
  insufficient_scope:
    "This connection does not include the brand:read permission. Reconnect Robynn to use this tool.",
  membership_inactive: "You are no longer an active member of this organization.",
  role_forbidden: "Your role in this organization cannot use this tool.",
  grant_revoked: "This Robynn connection is no longer active. Reconnect Robynn.",
  authorization_expired:
    "Robynn did not accept this connection's current credentials. Retry the request; if it keeps failing, reconnect Robynn.",
  authorization_unavailable:
    "Robynn could not confirm this connection's permissions right now. Nothing was executed. Try again shortly.",
  tool_not_permitted: "This tool is not available on this Robynn connection.",
  not_found: "Not found in this organization.",
  data_unavailable: "The stored data for this request is not available.",
  validation_failed: "The request was rejected.",
  conflict: "The request conflicts with the current state.",
  internal_error: "Robynn could not read the stored history right now. Nothing was changed.",
};

function statusCode(status: number): DiscoverabilityErrorCode {
  if (status === 400 || status === 413) return "invalid_request";
  if (status === 401) return "authorization_expired";
  if (status === 403) return "tool_not_permitted";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_failed";
  return "internal_error";
}

/** `API error 400 (code): detail` → `detail` (already redacted and bounded by robynn-client). */
function apiDetail(error: RobynnApiError): string | null {
  const match = /^API error \d+(?: \([a-z0-9_]+\))?: (.+)$/s.exec(error.message);
  return match ? match[1].slice(0, 160) : null;
}

/**
 * Structured tool error for these tools (AUTHORIZATION_CONTRACT §8.3; the
 * spec's $defs/error): `structuredContent.error = {code, message, retryable,
 * required_scope?}`, with the code repeated in the text content (Claude Code
 * passes only text to the model). App HTTP status and denial codes are
 * preserved; upstream bodies, stacks and credentials never are.
 */
export function toDiscoverabilityErrorResult(err: unknown) {
  let code: DiscoverabilityErrorCode = "internal_error";
  let retryable = false;
  let requiredScope: "brand:read" | "tools:execute" | undefined;
  let message: string | undefined;

  if (err instanceof UpstreamAuthorizationExpiredError) {
    code =
      err.upstreamCode && KNOWN_CODES.has(err.upstreamCode) && err.upstreamCode !== "authorization_expired"
        ? (err.upstreamCode as DiscoverabilityErrorCode)
        : "authorization_expired";
    retryable = code === "authorization_expired";
  } else if (err instanceof RobynnApiError) {
    code =
      err.code && KNOWN_CODES.has(err.code)
        ? (err.code as DiscoverabilityErrorCode)
        : err.status > 0
          ? statusCode(err.status)
          : "internal_error";
    retryable =
      err.retryable ||
      code === "authorization_unavailable" ||
      err.status === 0 ||
      err.status === 429 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504;
    if (err.requiredScope === "brand:read" || err.requiredScope === "tools:execute") {
      requiredScope = err.requiredScope;
    }
    if (code === "invalid_request" && err.status > 0 && err.status < 500) {
      message = apiDetail(err) ?? undefined;
    }
  }
  message ??= ERROR_MESSAGES[code] ?? "The request was rejected.";
  const error = {
    code,
    message,
    retryable,
    ...(requiredScope ? { required_scope: requiredScope } : {}),
  };
  return {
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    structuredContent: { error },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Text summaries (hosts that pass only text content still get the numbers)
// ---------------------------------------------------------------------------

function pct(value: number | null, digits = 1) {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}

function fmtInterval(interval: Interval): string {
  if (interval.estimate === null) {
    return `unavailable (${interval.method})`;
  }
  const scale = interval.unit === "fraction" ? (v: number) => pct(v) : (v: number) => `${v.toFixed(1)}`;
  const suffix = interval.unit === "percent" ? "%" : interval.unit === "percentage_points" ? " pp" : "";
  const sign = interval.unit === "fraction" || interval.estimate < 0 ? "" : "+";
  const bounds =
    interval.lower90 === null || interval.upper90 === null
      ? "no interval"
      : `90% CI ${scale(interval.lower90)}${suffix} to ${scale(interval.upper90)}${suffix}`;
  return `${sign}${scale(interval.estimate)}${suffix} (${bounds}; ${interval.observed_n}/${interval.expected_n} observed; ${interval.evidence_label})`;
}

function freshnessLine(f: { status: string; reason: string | null; as_of: string | null; generated_at: string | null }) {
  return `data ${f.status}${f.reason ? ` (${f.reason})` : ""}; as of ${f.as_of ?? "n/a"}; projection generated ${f.generated_at ?? "never"}`;
}

export function siteHealthSummary(data: SiteHealthOutput, windowDays: number): string {
  const lines = [
    `Site health for website ${data.website_id}, last ${windowDays} days vs the previous ${windowDays} (stored data only; nothing was refreshed).`,
    `Freshness: ${freshnessLine(data.freshness)}.`,
    `SEO (Search Console clicks, change of daily mean): ${fmtInterval(data.seo)}.`,
    `GEO (AI answer mention rate, change; equal weights per engine and prompt): ${fmtInterval(data.geo)}.`,
    `Crawl/delivery: ${data.crawl.status}; treated ${data.crawl.treated_pages}, delivered ${data.crawl.delivered_pages}, parity pass ${data.crawl.parity_pass_pages}, recrawled ${data.crawl.recrawled_pages}; last checked ${data.crawl.last_checked_at ?? "n/a"}.`,
    `Issues (${data.issues.length}):`,
    ...data.issues
      .slice(0, 15)
      .map(
        (i) =>
          `- [${i.severity}] ${i.code}${i.page_path ? ` ${i.page_path}` : ""}: ${
            // Recommendation text is stored scan output (it can derive from
            // crawled pages): label it as data, not as an instruction.
            i.code.startsWith("scan_recommendation") ? `(stored scan text) ${i.message}` : i.message
          }`,
      ),
  ];
  if (data.issues.length > 15) lines.push(`- … ${data.issues.length - 15} more in structuredContent.`);
  return lines.join("\n");
}

export function trendSummary(data: AiVisibilityTrendOutput, windowDays: number): string {
  const lines = [
    `AI visibility for website ${data.website_id}, panel ${data.panel_id ?? "none"}, last ${windowDays} days (stored panel answers only; no engine was queried).`,
    `Freshness: ${freshnessLine(data.freshness)}.`,
  ];
  const targetDomain = data.series[0]?.entity_domain;
  const target = data.series.filter((s) => s.entity_domain === targetDomain);
  for (const s of target) {
    lines.push(
      `- ${s.engine} / ${s.topic}: mentioned ${fmtInterval(s.mention)}; cited ${fmtInterval(s.citation)}; share of voice ${fmtInterval(s.share_of_voice)}; fact errors ${s.fact_errors}; coverage ${s.metric_coverage.mention_observed} mention / ${s.metric_coverage.citation_observed} citation of ${s.metric_coverage.expected} expected; ${s.freshness.status}${s.freshness.reason ? ` (${s.freshness.reason})` : ""}.`,
    );
  }
  const competitors = data.series.filter((s) => s.entity_domain !== targetDomain && s.topic === "all");
  if (competitors.length > 0) {
    lines.push("Competitors (all topics):");
    for (const s of competitors) {
      lines.push(`- ${s.engine} ${s.entity_domain}: cited ${fmtInterval(s.citation)}; share of voice ${fmtInterval(s.share_of_voice)}.`);
    }
  }
  for (const p of data.provider_snapshots) {
    lines.push(
      `Provider snapshot ${p.platform} (DataForSEO records, not panel answers): ${p.distinct_records} distinct records; ${p.freshness.status}${p.freshness.reason ? ` (${p.freshness.reason})` : ""}.`,
    );
  }
  if (data.series.length === 0) lines.push("No stored panel answers for this window.");
  return lines.join("\n");
}

export function learningsSummary(data: SiteLearningsOutput): string {
  const lines = [
    `Site learnings for website ${data.website_id} (finalized experiment results only): ${data.items.length} returned.`,
    `Freshness: ${freshnessLine(data.freshness)}.`,
    ...data.items.map(
      (l) => `- ${l.type} [${l.page_types.join(", ") || "all pages"}]: ${l.summary} Effect ${fmtInterval(l.effect)}.`,
    ),
  ];
  if (data.next_cursor) lines.push(`More available: pass cursor "${data.next_cursor}".`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const STORED_ONLY =
  "Reads stored data in Robynn only: it never refreshes, crawls, queries an AI engine or Search Console, charges credits or writes anything. Sections with nothing stored come back as \"unavailable\" with null estimates, never as zero.";

export function registerDiscoverabilityTools(server: McpServer, client: RobynnClient) {
  server.registerTool(
    "robynn_site_health",
    {
      ...toolMetadata("Get Site Health", READ_ONLY_HINTS),
      description: `Discoverability health of one Robynn organization website: top issues with evidence (stored Auto-Healer scan, Search Console coverage gaps, crawl and fetch-parity failures), the Search Console clicks trend and the AI-answer mention-rate trend with 90% intervals (window vs the previous window; descriptive, not experiment verdicts), crawl/delivery status and data freshness. ${STORED_ONLY}`,
      inputSchema: siteHealthInputSchema,
      outputSchema: siteHealthOutputSchema,
    },
    async (args) => {
      try {
        const data = await client.discoverabilitySiteHealth(args);
        return toSuccessResult(
          data as unknown as Record<string, unknown>,
          siteHealthSummary(data, args.window_days),
        );
      } catch (err) {
        return toDiscoverabilityErrorResult(err);
      }
    },
  );

  server.registerTool(
    "robynn_ai_visibility_trend",
    {
      ...toolMetadata("Get AI Visibility Trend", READ_ONLY_HINTS),
      description: `AI-answer visibility of one Robynn organization website from its stored prompt panel: mention, citation and share-of-voice rates with prompt-clustered 90% intervals per engine (chatgpt, claude, gemini, perplexity) and topic, for the brand and its frozen competitors, with expected-vs-observed coverage and model-change segments kept apart. Google AI Overviews / ChatGPT provider snapshots are reported separately as distinct records, never as answer trials. competitors filters the returned series to domains in the panel's frozen competitor set (unknown domains are rejected). ${STORED_ONLY}`,
      inputSchema: aiVisibilityTrendInputSchema,
      outputSchema: aiVisibilityTrendOutputSchema,
    },
    async (args) => {
      try {
        const data = await client.discoverabilityAiVisibilityTrend(args);
        return toSuccessResult(
          data as unknown as Record<string, unknown>,
          trendSummary(data, args.window_days),
        );
      } catch (err) {
        return toDiscoverabilityErrorResult(err);
      }
    },
  );

  server.registerTool(
    "robynn_site_learnings",
    {
      ...toolMetadata("Get Site Learnings", READ_ONLY_HINTS),
      description: `Finalized learnings from completed discoverability experiments on one Robynn organization website: what changed, on which page types, with the measured effect and its 90% interval and evidence. Filter by experiment type or page type; page with limit and the returned cursor. ${STORED_ONLY}`,
      inputSchema: siteLearningsInputSchema,
      outputSchema: siteLearningsOutputSchema,
    },
    async (args) => {
      try {
        const data = await client.discoverabilitySiteLearnings(args);
        return toSuccessResult(
          data as unknown as Record<string, unknown>,
          learningsSummary(data),
        );
      } catch (err) {
        return toDiscoverabilityErrorResult(err);
      }
    },
  );
}
