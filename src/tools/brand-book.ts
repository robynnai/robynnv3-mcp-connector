import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

/**
 * COS-PLUGIN-001 (†): flipped in P17. P07 removed the app's hidden write on the
 * brand-book read path (robynnv3 brand-book-adapters.ts passes
 * `persistCompleteness: false`; operation-policy.ts serves status, gap
 * analysis, strategy and the HTML export as brand:read), so these tools are
 * read-only and contracts/tool-route-map.json carries hintsAfterP07 and
 * requiredScope brand:read. Set back to true only together with the map.
 */
export const BRAND_BOOK_READS_PERSIST_COMPLETENESS = false;

const COMPLETENESS_EFFECT = BRAND_BOOK_READS_PERSIST_COMPLETENESS
  ? " Also refreshes Robynn's stored brand-completeness summary; repeat calls are safe."
  : " Read-only.";

export function registerBrandBookTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_brand_book_status",
    {
      ...toolMetadata("Check Brand Book Completeness", {
        readOnlyHint: !BRAND_BOOK_READS_PERSIST_COMPLETENESS,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        `Check brand-book completeness, missing sections, and readiness for downstream marketing work.${COMPLETENESS_EFFECT}`,
      inputSchema: {
        include_recent_reflections: z
          .boolean()
          .optional()
          .describe("Include a recent reflection count alongside completeness"),
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
      ...toolMetadata("Analyze Brand Book Gaps", {
        readOnlyHint: !BRAND_BOOK_READS_PERSIST_COMPLETENESS,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        `Explain which brand-book gaps matter most, why they matter, and what inputs would improve Robynn's downstream outputs.${COMPLETENESS_EFFECT}`,
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
      ...toolMetadata("Plan Brand Book Improvements", {
        readOnlyHint: !BRAND_BOOK_READS_PERSIST_COMPLETENESS,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        `Turn the current brand-book state into a prioritized improvement strategy for positioning, voice, competition, and proof.${COMPLETENESS_EFFECT}`,
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
      ...toolMetadata("List Brand Reflections", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "List pending and recent brand reflections from the Brand Hub changelog. Read-only.",
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
      ...toolMetadata("Generate Brand Reflections", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      }),
      description:
        "Run the brand-reflection pipeline now for your organization: analyzes recent Brand Hub changes with an AI model, saves new reflections to the changelog, and returns a bulleted summary plus rules accepted in the lookback window. Limited to once every 5 minutes per organization; each successful call processes pending changes again. dry_run previews detected patterns only (no AI synthesis, nothing saved). Read results later with robynn_brand_reflections.",
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
          .describe("Preview detected patterns only: skips the AI synthesis pass and saves nothing"),
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
      ...toolMetadata("Export Brand Book as HTML", {
        readOnlyHint: !BRAND_BOOK_READS_PERSIST_COMPLETENESS,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      }),
      description:
        `Export the current brand book as a self-contained HTML document returned inline in the response. This is an export, not a publication: nothing is hosted, shared, or published and no public URL is created. Robynn fetches the organization's stored logo image to embed it.${COMPLETENESS_EFFECT}`,
      inputSchema: {
        theme: z
          .string()
          .optional()
          .describe("Theme hint for the export (currently ignored)"),
        include_private_sections: z
          .boolean()
          .optional()
          .describe("Reserved for future export filtering (currently ignored)"),
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
