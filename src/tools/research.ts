import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerResearchTools(
  server: McpServer,
  client: RobynnClient
) {
  server.tool(
    "robynn_research",
    "Research companies, competitors, markets, or topics using Robynn's AI research capabilities. Returns structured findings with sources.",
    {
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
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ query, type, thread_id }) => {
      try {
        let threadId = thread_id;
        if (!threadId) {
          const threadResult = await client.createThread(
            `Research: ${query.slice(0, 50)}`
          );
          if (!threadResult.success || !threadResult.data) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "Failed to create research thread",
                  }),
                },
              ],
              isError: true,
            };
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
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: runResult.error || "Failed to start research",
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await client.pollRun(runResult.data.run_id);

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Research failed" }),
              },
            ],
            isError: true,
          };
        }

        const responseData = {
          findings: result.data.output,
          thread_id: threadId,
          run_id: result.data.id,
          tokens_used: result.data.tokens_used,
          status: result.data.status,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(responseData, null, 2),
            },
          ],
          structuredContent: responseData as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error during research: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
