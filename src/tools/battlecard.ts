import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

export function registerBattlecardTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_competitive_battlecard",
    {
      ...toolMetadata("Build a Competitive Battlecard", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      }),
      description:
        "Build a competitive battlecard against a named competitor: comparison, objections, differentiators, risks, and recommended actions. Researches the competitor through external data providers (search, SEO, and backlink services) and its website, saves a new battlecard to Robynn, and creates or updates the competitor's profile, including a weekly refresh schedule. No Robynn credits are charged; each call generates a new battlecard. focus_areas and include_objections are advisory. report_*_path values are server-side paths, not links.",
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
