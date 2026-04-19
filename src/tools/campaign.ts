import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

function buildCampaignPendingText(threadId: string | undefined, runId: string | undefined) {
  const lines = [
    "Campaign generation is still running.",
    threadId ? `langgraph_thread_id: ${threadId}` : undefined,
    runId ? `langgraph_run_id: ${runId}` : undefined,
    "Next step: call robynn_campaign_status with the exact thread and run ids above to fetch the latest status or completed output.",
  ].filter(Boolean);

  return lines.join("\n");
}

function campaignResponseSummary(data: Record<string, unknown>) {
  if (typeof data.markdown === "string" && data.markdown.trim()) {
    return data.markdown;
  }

  if (typeof data.summary === "string" && data.summary.trim()) {
    return data.summary;
  }

  return "Campaign generation completed.";
}

export function registerCampaignTools(server: McpServer, client: RobynnClient) {
  const campaignRequestSchema = {
    company_name: z.string().describe("The company name to build the campaign for"),
    company_url: z.string().url().optional().describe("Optional company website URL"),
    industry: z.string().optional().describe("Industry context for the campaign"),
    target_audience: z.string().optional().describe("Target audience or buyer segment"),
    goals: z.string().optional().describe("Primary campaign goals"),
    budget_range: z.string().optional().describe("Budget range for the campaign"),
    geography: z.string().optional().describe("Target geography or market"),
    additional_context: z.string().optional().describe("Additional context for the campaign"),
  } as const;

  const statusSchema = {
    langgraph_thread_id: z.string().describe("The LangGraph thread_id for the campaign run"),
    langgraph_run_id: z.string().describe("The LangGraph run_id for the campaign run"),
    company_name: z.string().optional().describe("Optional company name for display"),
    company_url: z.string().optional().describe("Optional company URL for display"),
  } as const;

  registerAppTool(
    server,
    "robynn_campaign_creator",
    {
      description:
        "Generate a full marketing campaign strategy using Robynn's specialist campaign creator. Produces a 12-week SEO/content plan and Google Ads strategy, saves completed campaigns as Rory artifacts, and returns pending run IDs if generation is still running.",
      inputSchema: campaignRequestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    async (payload) => {
      try {
        const result = await client.campaignCreator(payload);

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to generate marketing campaign");
        }

        const data = result.data as unknown as Record<string, unknown>;
        if (data.status === "failed") {
          return toErrorResult(
            typeof data.summary === "string"
              ? data.summary
              : "Marketing campaign generation failed",
          );
        }

        if (data.status === "pending") {
          return toSuccessResult(
            data,
            buildCampaignPendingText(
              typeof data.langgraph_thread_id === "string"
                ? data.langgraph_thread_id
                : undefined,
              typeof data.langgraph_run_id === "string"
                ? data.langgraph_run_id
                : undefined,
            ),
          );
        }

        return toSuccessResult(data, campaignResponseSummary(data));
      } catch (err) {
        return toErrorResult(
          `Error generating marketing campaign: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_campaign_status",
    {
      description:
        "Check a pending Robynn campaign creator run and save the generated campaign artifact when complete.",
      inputSchema: statusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    async ({ langgraph_thread_id, langgraph_run_id, company_name, company_url }) => {
      try {
        const result = await client.campaignStatus({
          langgraph_thread_id,
          langgraph_run_id,
          company_name,
          company_url,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to fetch marketing campaign status");
        }

        const data = result.data as unknown as Record<string, unknown>;
        if (data.status === "failed") {
          return toErrorResult(
            typeof data.summary === "string"
              ? data.summary
              : "Marketing campaign status lookup failed",
          );
        }

        if (data.status === "pending") {
          return toSuccessResult(
            data,
            buildCampaignPendingText(
              typeof data.langgraph_thread_id === "string"
                ? data.langgraph_thread_id
                : langgraph_thread_id,
              typeof data.langgraph_run_id === "string"
                ? data.langgraph_run_id
                : langgraph_run_id,
            ),
          );
        }

        return toSuccessResult(data, campaignResponseSummary(data));
      } catch (err) {
        return toErrorResult(
          `Error fetching marketing campaign status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
