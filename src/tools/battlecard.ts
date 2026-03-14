import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult } from "./util";

export function registerBattlecardTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_competitive_battlecard",
    {
      description:
        "Generate a current competitive battlecard against a named competitor using Robynn's market and brand context. Returns comparison sections, objections, differentiators, risks, and recommended actions.",
      inputSchema: {
        competitor_name: z.string().describe("The competitor to analyze"),
        company_name: z
          .string()
          .optional()
          .describe("Optional explicit company name override"),
        focus_areas: z
          .array(z.string())
          .optional()
          .describe(
            "Specific areas to emphasize, such as pricing, positioning, or integrations",
          ),
        include_objections: z
          .boolean()
          .optional()
          .describe("Whether to include objection handling in the battlecard"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.battlecard,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ competitor_name, company_name, focus_areas, include_objections }) => {
      try {
        const result = await client.competitiveBattlecard({
          competitor_name,
          company_name,
          focus_areas,
          include_objections,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Competitive battlecard failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error generating competitive battlecard: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
