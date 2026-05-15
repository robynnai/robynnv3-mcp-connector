import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

export function registerBrandOperationTools(
  server: McpServer,
  client: RobynnClient,
) {
  server.tool(
    "robynn_brand_source_add",
    "Add a Brand Hub source through Robynn APIs. Supports website source drafts and text/markdown notes. Use an idempotency_key so repeated MCP calls do not create duplicate logical sources.",
    {
      source_type: z
        .enum(["website", "text"])
        .describe("The source kind to add: website or text."),
      url: z
        .string()
        .url()
        .optional()
        .describe("Required for website sources."),
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Source title. Required for text sources."),
      content: z
        .string()
        .min(1)
        .optional()
        .describe("Required for text sources. Markdown is supported."),
      content_type: z
        .enum(["markdown", "plain"])
        .optional()
        .describe("Text source content type. Defaults to markdown."),
      page_limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Optional crawl page limit for website source drafts."),
      idempotency_key: z
        .string()
        .min(1)
        .max(160)
        .describe("Stable key for this logical source add request."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      try {
        if (args.source_type === "website") {
          if (!args.url) {
            return toErrorResult("url is required for website sources");
          }

          const result = await client.addBrandSource({
            source_type: "website",
            url: args.url,
            title: args.title,
            page_limit: args.page_limit,
            idempotency_key: args.idempotency_key,
          });

          if (!result.success || !result.data) {
            return toErrorResult(
              result.error || "Failed to add website source",
            );
          }

          return toSuccessResult(
            result.data as unknown as Record<string, unknown>,
            `Added website source draft: ${result.data.title || result.data.url || result.data.source_id}`,
          );
        }

        if (!args.title || !args.content) {
          return toErrorResult("title and content are required for text sources");
        }

        const result = await client.addBrandSource({
          source_type: "text",
          title: args.title,
          content: args.content,
          content_type: args.content_type,
          idempotency_key: args.idempotency_key,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to add text source");
        }

        return toSuccessResult(
          result.data as unknown as Record<string, unknown>,
          `Added text source: ${result.data.title || result.data.source_id}`,
        );
      } catch (err) {
        return toErrorResult(
          `robynn_brand_source_add failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.tool(
    "robynn_brand_rebuild",
    "Rebuild the organization's Brand Context through Robynn APIs after Brand Hub source changes. Requires write_confirmed: true.",
    {
      write_confirmed: z
        .literal(true)
        .describe("Must be true to confirm the Brand Context rebuild."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ write_confirmed }) => {
      try {
        const result = await client.rebuildBrandContext({
          mode: "derive",
          write_confirmed,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to rebuild Brand Context");
        }

        return toSuccessResult(
          result.data as unknown as Record<string, unknown>,
          `Rebuilt Brand Context${result.data.company_name ? ` for ${result.data.company_name}` : ""}.`,
        );
      } catch (err) {
        return toErrorResult(
          `robynn_brand_rebuild failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
