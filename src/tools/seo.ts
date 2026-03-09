import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";

export function registerSeoTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_seo_opportunities",
    {
      description:
        "Identify SEO keyword gaps and content opportunities relative to your market and competitors. Returns keyword gaps, recommended actions, and competitive SEO comparison data.",
      inputSchema: {
        company_name: z.string().describe("Your company or brand name"),
        company_url: z
          .string()
          .optional()
          .describe("Optional company URL to ground the analysis"),
        competitors: z
          .array(z.string())
          .optional()
          .describe("Competitors to benchmark against"),
        keywords: z
          .array(z.string())
          .optional()
          .describe("Optional seed keywords to include in the analysis"),
        market_context: z
          .string()
          .optional()
          .describe("Additional market or category context"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.seo,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ company_name, company_url, competitors, keywords, market_context }) => {
      try {
        const result = await client.seoOpportunities({
          company_name,
          company_url,
          competitors,
          keywords,
          market_context,
        });

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error || "SEO opportunities analysis failed",
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
              text: `Error analyzing SEO opportunities: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
