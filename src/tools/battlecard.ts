import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerBattlecardTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_competitive_battlecard",
    "Generate a current competitive battlecard against a named competitor using Robynn's market and brand context. Returns comparison sections, objections, differentiators, risks, and recommended actions.",
    {
      competitor_name: z.string().describe("The competitor to analyze"),
      company_name: z
        .string()
        .optional()
        .describe("Optional explicit company name override"),
      focus_areas: z
        .array(z.string())
        .optional()
        .describe("Specific areas to emphasize, such as pricing, positioning, or integrations"),
      include_objections: z
        .boolean()
        .optional()
        .describe("Whether to include objection handling in the battlecard"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
