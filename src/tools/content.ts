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

export function registerContentTools(server: McpServer, client: RobynnClient) {
  const syncWaitMs = getShortSyncWaitMs();

  server.registerTool(
    "robynn_create_content",
    {
      ...toolMetadata("Draft Content with Robynn", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      }),
      description:
        "Draft marketing content in your brand voice with the Robynn CMO agent. Starts an agent run that uses Robynn credits, saves the conversation to a Robynn thread (a new one unless thread_id is given; a new thread is private to you on plugin connections and visible to your organization with a CLI API key; anything the run saves as a Robynn artifact is visible to your organization), and may use your organization's connected apps. Each call starts a new run. If the run is still going after a short wait, returns run_id; poll it with robynn_run_status.",
      inputSchema: {
        type: z
          .enum([
            "linkedin_post",
            "blog_post",
            "email",
            "ad_copy",
            "social_media",
            "landing_page",
            "press_release",
            "newsletter",
            "general",
          ])
          .describe("Content type to generate"),
        topic: z.string().describe("The topic or subject for the content"),
        instructions: z
          .string()
          .optional()
          .describe("Additional instructions or context for content generation"),
        thread_id: z
          .string()
          .optional()
          .describe("Continue in an existing conversation thread"),
      },
    },
    async ({ type, topic, instructions, thread_id }) => {
      if (thread_id && !isSafePathId(thread_id)) {
        return toErrorResult("Invalid thread_id.");
      }

      try {
        let threadId = thread_id;
        if (!threadId) {
          const threadResult = await client.createThread(`${type}: ${topic}`);
          if (!threadResult.success || !threadResult.data) {
            return toErrorResult("Failed to create conversation thread");
          }
          threadId = threadResult.data.id;
        }

        const message = [
          `Create a ${type} about: ${topic}`,
          instructions ? `\nAdditional instructions: ${instructions}` : "",
        ].join("");

        const runResult = await client.startRun(threadId, { message, type });

        if (!runResult.success || !runResult.data) {
          return toErrorResult(runResult.error || "Failed to start content generation");
        }

        let result;
        try {
          result = await client.pollRun(runResult.data.run_id, syncWaitMs);
        } catch (err) {
          if (isRunTimeoutError(err)) {
            return toPendingRunResult("Content generation", runResult.data.run_id, threadId);
          }
          throw err;
        }

        if (!result.success || !result.data) {
          return toErrorResult("Content generation failed");
        }

        const responseData = {
          content: result.data.output,
          thread_id: threadId,
          run_id: result.data.id,
          tokens_used: result.data.tokens_used,
          status: result.data.status,
        };

        return toSuccessResult(responseData as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error creating content: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
