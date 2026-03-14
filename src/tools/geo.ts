import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult } from "./util";

export function registerGeoTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_geo_analysis",
    {
      description:
        "Measure your brand's visibility across AI answer engines for a category or set of strategic questions. Returns citation breakdowns, query gaps, and recommended follow-up actions.",
      inputSchema: {
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.geo,
          visibility: ["model", "app"],
        },
      },
    },
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
          return toErrorResult(result.error || "GEO analysis failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error running GEO analysis: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
