import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";

export function registerContextTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_brand_context",
    "Get brand context by scope. Available scopes: summary (company info, tagline), voice (writing style, tone), positioning (elevator pitch, messaging), competitors (competitive intel), audience (personas, pain points), products (features, differentiators), rules (brand rules, vocabulary), full (everything).",
    {
      scope: z
        .enum([
          "summary",
          "voice",
          "positioning",
          "competitors",
          "audience",
          "products",
          "rules",
          "full",
        ])
        .describe("The brand context scope to retrieve"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ scope }) => {
      try {
        const result = await client.getBrandContext(scope);

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    result.error ||
                    "No brand context found. Has the brand been set up?",
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
          structuredContent: result.data as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching brand context: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "robynn_brand_rules",
    "Get brand rules, terminology guidelines, and style constraints. Returns vocabulary (terms to use/avoid), objection responses, and user-defined brand rules.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const result = await client.getBrandContext("rules");

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error || "No brand rules found.",
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
          structuredContent: result.data as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching brand rules: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
