import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

const assistantIdSchema = z.enum(["cmo_v2", "cmo_v3", "auto"]);
const routeHintSchema = z.enum(["fast", "deep", "auto"]);
const requestedCapabilitySchema = z.enum(["article", "image", "research", "general"]);

function buildPendingText(threadId: string | undefined, runId: string | undefined) {
  const lines = [
    "CMO agent request is still running.",
    threadId ? `thread_id: ${threadId}` : undefined,
    runId ? `run_id: ${runId}` : undefined,
    "Next step: call robynn_run_status with the exact run_id above to fetch the latest status or completed output.",
  ].filter(Boolean);

  return lines.join("\n");
}

export function registerCmoAgentTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_cmo_agent",
    {
      description:
        "Run the Robynn CMO orchestrator directly. Use this for Rory-style strategic marketing work that may route across specialized sub-agents and preserve thread context.",
      inputSchema: {
        message: z.string().describe("The user message or request to send to Robynn"),
        thread_id: z.string().optional().describe("Continue in an existing conversation thread"),
        assistant_id: assistantIdSchema.optional().describe("Optional assistant override hint"),
        route_hint: routeHintSchema.optional().describe("Optional routing preference for the backend assistant"),
        requested_capability: requestedCapabilitySchema.optional().describe("Optional capability hint for the backend assistant"),
        claude_skill_slug: z.string().optional().describe("Optional Claude skill slug to preserve"),
        history_summary: z.string().optional().describe("Optional summary of prior thread history"),
        memory_enabled: z.boolean().optional().describe("Whether backend memory should be enabled for this run"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    async ({
      message,
      thread_id,
      assistant_id,
      route_hint,
      requested_capability,
      claude_skill_slug,
      history_summary,
      memory_enabled,
    }) => {
      try {
        const result = await client.cmoAgent({
          message,
          ...(thread_id ? { thread_id } : {}),
          ...(assistant_id ? { assistant_id } : {}),
          ...(route_hint ? { route_hint } : {}),
          ...(requested_capability ? { requested_capability } : {}),
          ...(claude_skill_slug ? { claude_skill_slug } : {}),
          ...(history_summary ? { history_summary } : {}),
          ...(memory_enabled !== undefined ? { memory_enabled } : {}),
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to run CMO agent");
        }

        const data = result.data as unknown as Record<string, unknown>;
        if (data.status === "failed") {
          return toErrorResult(
            typeof data.output === "string"
              ? data.output
              : typeof data.summary === "string"
                ? data.summary
                : "CMO agent failed",
          );
        }

        const summary =
          typeof data.output === "string"
            ? data.output
            : typeof data.summary === "string"
              ? data.summary
              : "CMO agent completed.";

        if (data.status === "pending") {
          return toSuccessResult(data, buildPendingText(
            typeof data.thread_id === "string" ? data.thread_id : undefined,
            typeof data.run_id === "string" ? data.run_id : undefined,
          ));
        }

        return toSuccessResult(data, summary);
      } catch (err) {
        return toErrorResult(
          `Error running CMO agent: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
