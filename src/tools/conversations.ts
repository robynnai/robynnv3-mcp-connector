import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerConversationTools(
  server: McpServer,
  client: RobynnClient
) {
  server.tool(
    "robynn_conversations",
    "Manage conversation threads with the Robynn CMO. List existing threads or create a new one.",
    {
      action: z
        .enum(["list", "create"])
        .describe(
          "Action to perform: list existing threads or create a new one"
        ),
      title: z
        .string()
        .optional()
        .describe("Title for a new thread (only used with action=create)"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ action, title }) => {
      try {
        if (action === "list") {
          const result = await client.listThreads();

          if (!result.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: result.error || "Failed to list threads",
                  }),
                },
              ],
              isError: true,
            };
          }

          const responseData = {
            threads: result.data?.threads || [],
            count: result.data?.threads?.length || 0,
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
        }

        if (action === "create") {
          const result = await client.createThread(title);

          if (!result.success || !result.data) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: result.error || "Failed to create thread",
                  }),
                },
              ],
              isError: true,
            };
          }

          const responseData = {
            thread: result.data,
            message: "Thread created successfully",
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
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown action: ${action}` }),
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error managing conversations: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
