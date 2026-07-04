import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import type { WeeklyVisibilityReportResult } from "../types";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult } from "./util";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeReport(
  data: WeeklyVisibilityReportResult,
): WeeklyVisibilityReportResult {
  const recommendations = Array.isArray(data.recommendations)
    ? data.recommendations
    : [];

  return {
    ...data,
    artifacts: isRecord(data.artifacts) ? data.artifacts : {},
    recommended_actions: recommendations,
  };
}

function percent(value: unknown) {
  const number = asNumber(value);
  if (number === null) return "unknown";
  return `${Math.round(number * 1000) / 10}%`;
}

function weeklyVisibilitySummary(data: WeeklyVisibilityReportResult) {
  const kpis = data.seo_kpis || {};
  const lines = [
    data.summary || "Weekly SEO/GEO visibility report completed.",
    `Website: ${data.website?.label || data.website?.hostname || data.website?.id}`,
    `Week: ${data.range?.current_start} to ${data.range?.current_end}`,
    `SEO: ${asNumber(kpis.organic_clicks) ?? 0} clicks, ${asNumber(kpis.organic_impressions) ?? 0} impressions, CTR ${percent(kpis.ctr)}, average position ${asNumber(kpis.average_position) ?? "unknown"}.`,
    `Keywords: ${asArray(data.keyword_table).length} rows; striking-distance: ${asArray(data.striking_distance_keywords).length}; non-ranking pages: ${asArray(data.non_ranking_pages).length}.`,
    `GEO: ${asNumber(data.geo_kpis?.prompts_checked) ?? 0} prompts checked, ${asNumber(data.geo_kpis?.brand_mentions) ?? 0} brand mentions, ${asNumber(data.geo_kpis?.competitor_mentions) ?? 0} competitor mentions.`,
  ];

  if (data.status === "missing_data" && data.missing_sources.length) {
    lines.push(`Missing sources: ${data.missing_sources.join(", ")}`);
  }

  if (data.next_steps.length) {
    lines.push(`Next steps: ${data.next_steps.join(" ")}`);
  }

  return lines.join("\n");
}

export function registerWeeklyVisibilityTools(
  server: McpServer,
  client: RobynnClient,
) {
  registerAppTool(
    server,
    "robynn_weekly_visibility_report",
    {
      description:
        "Build a weekly SEO and GEO visibility report for one connected Robynn website. Requires a Robynn organization website id with Google Search Console and GA4 data available through Brand Monitor. Returns SEO KPIs, keyword/page tables, non-ranking pages, striking-distance keywords, GEO prompt visibility, and recommendations.",
      inputSchema: {
        website_id: z
          .string()
          .uuid()
          .describe("Required Robynn organization website id to report on"),
        week_start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Optional week start date in YYYY-MM-DD; defaults to the latest 7-day window"),
        keyword_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum keyword table rows to return; capped at 200"),
        page_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum page table rows to return; capped at 200"),
        include_recommendations: z
          .boolean()
          .optional()
          .describe("Whether to include deterministic page, keyword, and GEO recommendations"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.weeklyVisibility,
          visibility: ["model", "app"],
        },
      },
    },
    async (payload) => {
      try {
        const result = await client.weeklyVisibilityReport(payload);

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "Failed to build weekly visibility report",
          );
        }

        const data = normalizeReport(result.data);
        return toSuccessResult(
          data as unknown as Record<string, unknown>,
          weeklyVisibilitySummary(data),
        );
      } catch (err) {
        return toErrorResult(
          `Error building weekly visibility report: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
