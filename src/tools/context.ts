import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

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
          return toErrorResult(
            result.error || "No brand context found. Has the brand been set up?",
          );
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error fetching brand context: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
