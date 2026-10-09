import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

export function registerContextTools(server: McpServer, client: RobynnClient) {
  server.registerTool(
    "robynn_brand_context",
    {
      ...toolMetadata("Get Brand Context", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Read the organization's brand context for one scope: summary (company info, tagline), voice (writing style, tone), positioning (elevator pitch, messaging), competitors (competitive intel), audience (personas, pain points), products (features, differentiators), rules (brand rules, vocabulary), or full (everything). Read-only.",
      inputSchema: {
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
    },
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

  server.registerTool(
    "robynn_brand_context_search",
    {
      ...toolMetadata("Search Brand Context", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Search the organization's brand context for guidance relevant to one task or query, such as SEO, content, positioning, competitive analysis, or page optimization. Read-only.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("The brand-context question or task to retrieve guidance for"),
        profile: z
          .enum(["seo", "core", "content", "competitive", "full"])
          .optional()
          .describe("Retrieval profile. Use seo for on-page SEO and GEO audits."),
        max_tokens: z
          .number()
          .int()
          .min(200)
          .max(4000)
          .optional()
          .describe("Approximate maximum tokens of prompt_context to return"),
        organization_website_id: z
          .string()
          .uuid()
          .optional()
          .describe("Optional organization website id to scope the lookup"),
        sub_brand_id: z
          .string()
          .uuid()
          .optional()
          .describe("Optional sub-brand id to apply brand overlay context"),
      },
    },
    async ({
      query,
      profile,
      max_tokens,
      organization_website_id,
      sub_brand_id,
    }) => {
      try {
        const result = await client.brandContextSearch({
          query,
          profile,
          max_tokens,
          organization_website_id,
          sub_brand_id,
        });

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "No matching brand context found. Has the brand been set up?",
          );
        }

        return toSuccessResult(
          result.data as unknown as Record<string, unknown>,
          result.data.summary,
        );
      } catch (err) {
        return toErrorResult(
          `Error searching brand context: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
