import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { isRunTimeoutError, toErrorResult, toPendingRunResult, toSuccessResult } from "./util";

export function registerContentTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_create_content",
    "Create marketing content using the Robynn CMO agent. The content is generated using your brand voice, positioning, and guidelines.",
    {
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
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ type, topic, instructions, thread_id }) => {
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
          result = await client.pollRun(runResult.data.run_id);
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
