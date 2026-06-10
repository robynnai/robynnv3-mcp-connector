import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult } from "./util";

export function registerBrandBookTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_brand_book_status",
    {
      description:
        "Inspect current brand-book completeness, missing sections, and readiness for downstream marketing work.",
      inputSchema: {
        include_recent_reflections: z
          .boolean()
          .optional()
          .describe("Include a recent reflection count alongside completeness"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStatus,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ include_recent_reflections }) => {
      try {
        const result = await client.brandBookStatus({
          include_recent_reflections,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Brand book status failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error loading brand book status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_brand_book_gap_analysis",
    {
      description:
        "Explain which brand-book gaps matter most, why they matter, and what inputs would improve Robynn's downstream outputs.",
      inputSchema: {
        focus_areas: z
          .array(z.string())
          .optional()
          .describe("Optional focus areas such as positioning, voice, or proof"),
        include_competitive_context: z
          .boolean()
          .optional()
          .describe("Highlight competitive implications in the gap analysis"),
        include_examples: z
          .boolean()
          .optional()
          .describe("Include sample source-of-truth examples for missing fields"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStatus,
          visibility: ["model"],
        },
      },
    },
    async ({ focus_areas, include_competitive_context, include_examples }) => {
      try {
        const result = await client.brandBookGapAnalysis({
          focus_areas,
          include_competitive_context,
          include_examples,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Brand book gap analysis failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error loading brand book gap analysis: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_brand_book_strategy",
    {
      description:
        "Turn the current brand-book state into a prioritized improvement strategy for positioning, voice, competition, and proof.",
      inputSchema: {
        goals: z
          .array(z.string())
          .optional()
          .describe("Optional business or messaging goals to optimize for"),
        focus_areas: z
          .array(z.string())
          .optional()
          .describe("Specific brand areas to emphasize"),
        include_intelligence_signals: z
          .boolean()
          .optional()
          .describe("Include follow-up recommendations for GEO, SEO, and battlecard signals"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStrategy,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ goals, focus_areas, include_intelligence_signals }) => {
      try {
        const result = await client.brandBookStrategy({
          goals,
          focus_areas,
          include_intelligence_signals,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Brand book strategy failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error loading brand book strategy: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_brand_reflections",
    {
      description:
        "List pending and recent brand reflections from the brand_hub_docs changelog pipeline.",
      inputSchema: {
        status_filter: z
          .enum(["pending", "recent", "all"])
          .optional()
          .describe("Choose whether to view pending, recent, or all reflections"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum number of reflections to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStatus,
          visibility: ["model"],
        },
      },
    },
    async ({ status_filter, limit }) => {
      try {
        const result = await client.brandReflections({
          status_filter,
          limit,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Brand reflections failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error loading brand reflections: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_trigger_brand_reflections",
    {
      description:
        "Manually trigger the nightly brand-reflection pipeline for the caller's organization. Pulls the latest brand-hub docs, runs aggregate pattern analysis, and returns a bulleted summary of new reflections plus any rules accepted in the lookback window. Subject to a 5-minute per-org cooldown.",
      inputSchema: {
        lookback_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("How many hours of changelog history to analyze (default 24, max 168)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum reflections to return in the response (default 10)"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Run the full analysis but skip persisting new changelog entries"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStatus,
          visibility: ["model"],
        },
      },
    },
    async ({ lookback_hours, limit, dry_run }) => {
      try {
        const result = await client.triggerBrandReflections({
          lookback_hours,
          limit,
          dry_run,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Trigger brand reflections failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        const summary =
          (data.bulleted_summary as string) ||
          (data.summary as string) ||
          undefined;
        return toSuccessResult(data, summary);
      } catch (err) {
        return toErrorResult(
          `Error triggering brand reflections: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_publish_brand_book_html",
    {
      description:
        "Generate an exportable HTML brand book artifact from the current source-of-truth brand context.",
      inputSchema: {
        theme: z
          .string()
          .optional()
          .describe("Optional future-facing theme hint for the export pipeline"),
        include_private_sections: z
          .boolean()
          .optional()
          .describe("Reserved flag for future export filtering"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.brandBookStatus,
          visibility: ["model"],
        },
      },
    },
    async ({ theme, include_private_sections }) => {
      try {
        const result = await client.publishBrandBookHtml({
          theme,
          include_private_sections,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Brand book HTML export failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error exporting brand book HTML: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
