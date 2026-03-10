import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";

function toErrorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

function toSuccessResult(result: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

export function registerWebsiteTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_website_audit",
    {
      description:
        "Run a structured website audit across messaging, SEO, GEO, conversion, and competitor context.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Optional explicit website URL override"),
        goals: z
          .array(z.string())
          .optional()
          .describe("Business goals to keep in view during the audit"),
        competitors: z
          .array(z.string())
          .optional()
          .describe("Competitors to emphasize during the website audit"),
        analysis_depth: z
          .enum(["standard", "deep"])
          .optional()
          .describe("Standard or deeper website audit mode"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ website_url, goals, competitors, analysis_depth }) => {
      try {
        const result = await client.websiteAudit({
          website_url,
          goals,
          competitors,
          analysis_depth,
        });

        if (!result.success || !result.data) {
          return toErrorResult(
            JSON.stringify({
              error: result.error || "Website audit failed",
            }),
          );
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error running website audit: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_strategy",
    {
      description:
        "Turn website findings into a prioritized improvement strategy tied to goals, pages, and measurement.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Optional explicit website URL override"),
        primary_goal: z
          .string()
          .optional()
          .describe("Primary business goal for the next website iteration"),
        constraints: z
          .array(z.string())
          .optional()
          .describe("Constraints to respect in the next website phase"),
        priority_pages: z
          .array(z.string())
          .optional()
          .describe("Pages or templates to prioritize first"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteStrategy,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ website_url, primary_goal, constraints, priority_pages }) => {
      try {
        const result = await client.websiteStrategy({
          website_url,
          primary_goal,
          constraints,
          priority_pages,
        });

        if (!result.success || !result.data) {
          return toErrorResult(
            JSON.stringify({
              error: result.error || "Website strategy failed",
            }),
          );
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error building website strategy: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
