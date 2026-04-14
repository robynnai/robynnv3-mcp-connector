import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import {
  getShortSyncWaitMs,
  isRunTimeoutError,
  toErrorResult,
  toPendingRunResult,
  toSuccessResult,
} from "./util";

const assistantIdSchema = z.enum(["cmo_v2", "cmo_v3", "auto"]);
const routeHintSchema = z.enum(["fast", "deep", "auto"]);
const requestedCapabilitySchema = z.enum(["article", "image", "research", "general"]);

function buildThreadTitle(message: string) {
  const trimmed = message.trim();
  if (trimmed.length <= 50) {
    return `Assist: ${trimmed}`;
  }

  return `Assist: ${trimmed.slice(0, 47)}...`;
}

export function registerAssistTools(server: McpServer, client: RobynnClient) {
  const syncWaitMs = getShortSyncWaitMs();

  server.tool(
    "robynn_assist",
    "Run a general-purpose Robynn CMO assistant request. Use this when you want Robynn to choose the best assistant routing while still preserving thread history and caller hints.",
    {
      message: z.string().describe("The user message or request to send to Robynn"),
      thread_id: z.string().optional().describe("Continue in an existing conversation thread"),
      assistant_id: assistantIdSchema.optional().describe("Optional assistant override hint"),
      route_hint: routeHintSchema.optional().describe("Optional routing preference for the backend assistant"),
      requested_capability: requestedCapabilitySchema.optional().describe("Optional capability hint for the backend assistant"),
      claude_skill_slug: z.string().optional().describe("Optional Claude skill slug to preserve"),
      history_summary: z.string().optional().describe("Optional summary of prior thread history"),
      memory_enabled: z.boolean().optional().describe("Whether backend memory should be enabled for this run"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
        let threadId = thread_id;
        if (!threadId) {
          const threadResult = await client.createThread(buildThreadTitle(message));
          if (!threadResult.success || !threadResult.data) {
            return toErrorResult("Failed to create assist thread");
          }
          threadId = threadResult.data.id;
        }

        const runResult = await client.startRun(threadId, {
          message,
          ...(assistant_id ? { assistant_id } : {}),
          ...(route_hint ? { route_hint } : {}),
          ...(requested_capability ? { requested_capability } : {}),
          ...(claude_skill_slug ? { claude_skill_slug } : {}),
          ...(history_summary ? { history_summary } : {}),
          ...(memory_enabled !== undefined ? { memory_enabled } : {}),
        });

        if (!runResult.success || !runResult.data) {
          return toErrorResult(runResult.error || "Failed to start assist run");
        }

        let result;
        try {
          result = await client.pollRun(runResult.data.run_id, syncWaitMs);
        } catch (err) {
          if (isRunTimeoutError(err)) {
            return toPendingRunResult("Assist", runResult.data.run_id, threadId);
          }
          throw err;
        }

        if (!result.success || !result.data) {
          return toErrorResult("Assist run failed");
        }

        const responseData = {
          output: result.data.output,
          thread_id: threadId,
          run_id: result.data.id,
          tokens_used: result.data.tokens_used,
          status: result.data.status,
        };

        return toSuccessResult(
          responseData as Record<string, unknown>,
          result.data.output || "Assist run completed.",
        );
      } catch (err) {
        return toErrorResult(
          `Error running assist: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
