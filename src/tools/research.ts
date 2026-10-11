import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import {
  getShortSyncWaitMs,
  isRunTimeoutError,
  isSafePathId,
  toErrorResult,
  toPendingRunResult,
  toSuccessResult,
  toolMetadata,
} from "./util";

export function registerResearchTools(
  server: McpServer,
  client: RobynnClient,
) {
  const syncWaitMs = getShortSyncWaitMs();

  server.registerTool(
    "robynn_research",
    {
      ...toolMetadata("Run Market Research", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      }),
      description:
        "Research companies, competitors, markets, or topics with the Robynn CMO agent and return findings with sources. Starts an agent run that uses Robynn credits, saves the conversation to a Robynn thread (a new one unless thread_id is given; a new thread is private to you on plugin connections and visible to your organization with a CLI API key; anything the run saves as a Robynn artifact is visible to your organization), and may use external sources and your organization's connected apps. Each call starts a new run. If the run is still going after a short wait, returns run_id; poll it with robynn_run_status.",
      inputSchema: {
        query: z
          .string()
          .describe("The research query or topic to investigate"),
        type: z
          .enum(["competitor", "market", "company", "general"])
          .optional()
          .describe("Type of research to perform"),
        thread_id: z
          .string()
          .optional()
          .describe("Continue in an existing conversation thread"),
      },
    },
    async ({ query, type, thread_id }) => {
      if (thread_id && !isSafePathId(thread_id)) {
        return toErrorResult("Invalid thread_id.");
      }

      try {
        let threadId = thread_id;
        if (!threadId) {
          const threadResult = await client.createThread(
            `Research: ${query.slice(0, 50)}`,
          );
          if (!threadResult.success || !threadResult.data) {
            return toErrorResult("Failed to create research thread");
          }
          threadId = threadResult.data.id;
        }

        const message = type
          ? `Perform ${type} research on: ${query}`
          : `Research: ${query}`;

        const runResult = await client.startRun(threadId, {
          message,
          type: "research",
        });

        if (!runResult.success || !runResult.data) {
          return toErrorResult(runResult.error || "Failed to start research");
        }

        let result;
        try {
          result = await client.pollRun(runResult.data.run_id, syncWaitMs);
        } catch (err) {
          if (isRunTimeoutError(err)) {
            return toPendingRunResult("Research", runResult.data.run_id, threadId);
          }
          throw err;
        }

        if (!result.success || !result.data) {
          return toErrorResult("Research failed");
        }

        const responseData = {
          findings: result.data.output,
          thread_id: threadId,
          run_id: result.data.id,
          tokens_used: result.data.tokens_used,
          status: result.data.status,
        };

        return toSuccessResult(responseData as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error during research: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
