import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

export function registerStrapiTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_publish_strapi_draft",
    {
      description:
        "Create or update a draft in the organization's connected self-hosted Strapi instance. Requires write_confirmed=true and never publishes live.",
      inputSchema: {
        write_confirmed: z
          .literal(true)
          .describe("Must be true to confirm this write action."),
        artifact_id: z
          .string()
          .uuid()
          .optional()
          .describe("Existing Rory artifact ID to publish as a Strapi draft."),
        title: z.string().optional().describe("Draft title for raw content."),
        content: z
          .string()
          .optional()
          .describe("Raw markdown or text content. Optional when artifact_id is provided."),
        excerpt: z.string().optional().describe("Optional draft excerpt."),
        website_id: z
          .string()
          .uuid()
          .optional()
          .describe("Optional Robynn website ID to choose a publish target."),
        website_publish_target_id: z
          .string()
          .uuid()
          .optional()
          .describe("Optional explicit website publish target ID."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          visibility: ["model"],
        },
      },
    },
    async (payload) => {
      if (!payload.write_confirmed) {
        return toErrorResult("write_confirmed must be true.");
      }
      if (!payload.artifact_id && !payload.content?.trim()) {
        return toErrorResult("Provide either artifact_id or content.");
      }

      try {
        const result = await client.publishStrapiDraft(payload);
        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to publish Strapi draft");
        }

        const documentId =
          result.data.publishing_metadata?.strapi_document_id ||
          result.data.platform_post_id ||
          "unknown";
        const summary = [
          "Strapi draft saved.",
          `documentId: ${documentId}`,
          result.data.published_url
            ? `edit_url: ${result.data.published_url}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");

        return toSuccessResult(result.data as unknown as Record<string, unknown>, summary);
      } catch (err) {
        return toErrorResult(
          `Error publishing Strapi draft: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
