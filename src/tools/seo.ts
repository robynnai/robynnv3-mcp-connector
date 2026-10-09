import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

export function registerSeoTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_seo_opportunities",
    {
      ...toolMetadata("Find SEO Opportunities", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      }),
      description:
        "Find SEO keyword gaps and content opportunities relative to your market and competitors; returns keyword gaps, recommended actions, and competitive comparison data. Queries external search and SEO data providers and reads company_url. Nothing is saved and no Robynn credits are charged, but each call runs a full analysis.",
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
          return toErrorResult(result.error || "SEO opportunities analysis failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error analyzing SEO opportunities: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
