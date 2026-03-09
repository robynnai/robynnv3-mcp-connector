import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerGeoTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_geo_analysis",
    "Measure your brand's visibility across AI answer engines for a category or set of strategic questions. Returns citation breakdowns, query gaps, and recommended follow-up actions.",
    {
      company_name: z.string().describe("Your company or brand name"),
      category: z
        .string()
        .optional()
        .describe("Market category to benchmark visibility against"),
      questions: z
        .array(z.string())
        .optional()
        .describe("Specific AI-search questions to evaluate"),
      competitors: z
        .array(z.string())
        .optional()
        .describe("Optional competitor set for comparison"),
      analysis_depth: z
        .enum(["standard", "deep"])
        .optional()
        .describe("Standard or deeper analysis depth"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ company_name, category, questions, competitors, analysis_depth }) => {
      try {
        const result = await client.geoAnalysis({
          company_name,
          category,
          questions,
          competitors,
          analysis_depth,
        });

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error || "GEO analysis failed",
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
              text: `Error running GEO analysis: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
