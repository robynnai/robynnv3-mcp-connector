import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

function contentPlanSummary(data: Record<string, unknown>) {
  if (data.status === "missing_context") {
    const summary =
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary
        : "Content Planner V2 needs existing research context before it can plan.";
    const nextStep =
      typeof data.next_step === "string"
        ? data.next_step
        : "Pass a Content Studio project_id or a completed research_packet.";
    return `${summary}\n\nNext step: ${nextStep}`;
  }

  if (typeof data.summary === "string" && data.summary.trim()) {
    return data.summary;
  }

  const rows = Array.isArray(data.content_plan_rows)
    ? data.content_plan_rows.length
    : 0;
  return `Content Planner V2 generated ${rows} recommendation${rows === 1 ? "" : "s"}.`;
}

export function registerContentPlanTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_content_plan",
    {
      description:
        "Create a Content Studio content plan from existing Robynn research. Prefer passing project_id so Robynn can hydrate SEO, GEO, deep research, existing website content, and calendar rows server-side. This is synthesis-only: it does not run fresh keyword research, web search, scraping, or news search.",
      inputSchema: {
        project_id: z
          .string()
          .optional()
          .describe("Preferred Content Studio project id for server-side hydration"),
        research_artifact_id: z
          .string()
          .optional()
          .describe("Optional completed research artifact id to hydrate"),
        brand_or_topic: z
          .string()
          .optional()
          .describe("Fallback topic or brand label; returns missing_context unless research context is also supplied"),
        planning_goal: z
          .string()
          .optional()
          .describe("Optional planning objective, such as 'build a 90-day content plan'"),
        research_packet: z
          .record(z.unknown())
          .optional()
          .describe("Optional completed SEO/GEO/deep research packet plus brand and inventory context"),
        include_existing_calendar: z
          .boolean()
          .optional()
          .describe("Whether Robynn should include existing content calendar rows when hydrating"),
        include_existing_site_inventory: z
          .boolean()
          .optional()
          .describe("Whether Robynn should include existing site inventory when hydrating"),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of content plan rows to return"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Return the generated plan without saving rows to the calendar"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    async (payload) => {
      try {
        const result = await client.contentPlan(payload);

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to create content plan");
        }

        const data = result.data as unknown as Record<string, unknown>;
        if (data.status === "failed") {
          return toErrorResult(
            typeof data.summary === "string"
              ? data.summary
              : "Content Planner V2 failed",
          );
        }

        return toSuccessResult(data, contentPlanSummary(data));
      } catch (err) {
        return toErrorResult(
          `Error creating content plan: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
