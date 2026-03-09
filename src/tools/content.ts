import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerContentTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_create_content",
    "Create marketing content using the Robynn CMO agent. The content is generated using your brand voice, positioning, and guidelines. Supports blog posts, LinkedIn posts, emails, ad copy, and more.",
    {
      type: z
        .string()
        .describe(
          "Content type: linkedin_post, blog_post, email, ad_copy, social_media, landing_page, press_release, or general"
        ),
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
        // Create or reuse thread
        let threadId = thread_id;
        if (!threadId) {
          const threadResult = await client.createThread(`${type}: ${topic}`);
          if (!threadResult.success || !threadResult.data) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "Failed to create conversation thread",
                  }),
                },
              ],
              isError: true,
            };
          }
          threadId = threadResult.data.id;
        }

        const message = [
          `Create a ${type} about: ${topic}`,
          instructions ? `\nAdditional instructions: ${instructions}` : "",
        ].join("");

        const runResult = await client.startRun(threadId, { message, type });

        if (!runResult.success || !runResult.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    runResult.error || "Failed to start content generation",
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
                text: JSON.stringify({ error: "Content generation failed" }),
              },
            ],
            isError: true,
          };
        }

        const responseData = {
          content: result.data.output,
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
              text: `Error creating content: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
