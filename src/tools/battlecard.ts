import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";

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
            "Specific areas to emphasize, such as pricing, positioning, or integrations"
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
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error || "Competitive battlecard failed",
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
          structuredContent: result.data as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error generating competitive battlecard: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
