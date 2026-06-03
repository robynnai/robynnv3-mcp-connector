import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

/**
 * Registers the write-action tool for connected apps. Uses the same
 * /api/cli/connectors/act endpoint as Claude Desktop will, so both MCP
 * surfaces advertise the same shape.
 */
export function registerConnectorActionTools(
  server: McpServer,
  client: RobynnClient,
) {
  server.tool(
    "robynn_connected_app_action",
    "Execute a write action (create/update) against a connected app like HubSpot, Salesforce, or HighLevel. Audit-logged and idempotent — pass the same idempotency_key to replay a prior successful call without re-executing. HighLevel guarded writes such as highlevel.publish_email_template require explicit user confirmation and write_confirmed=true.",
    {
      service: z
        .string()
        .describe(
          "Connected app identifier, e.g. 'hubspot', 'salesforce', 'highlevel'.",
        ),
      action: z
        .string()
        .describe(
          "Action key scoped to the service, e.g. 'create_task', 'log_activity', 'highlevel.publish_email_template'. Call robynn_connected_app_capabilities to discover what's available.",
        ),
      parameters: z
        .record(z.unknown())
        .describe("Action-specific parameters; validated server-side."),
      idempotency_key: z
        .string()
        .describe(
          "UUID unique to this logical action. Replays with the same key return the stored result.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "If true, validate policy and connection availability but do NOT call the provider.",
        ),
      write_confirmed: z
        .boolean()
        .optional()
        .describe(
          "Set true after the user confirms a write action. Required by org policy for protected writes.",
        ),
      connection_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional specific connected-account id. Omit to use the provider default.",
        ),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (args) => {
      try {
        const result = await client.actOnConnectedApp(args);
        if (!result.ok) {
          return toErrorResult(
            typeof result.error === "string"
              ? result.error
              : "Connected app action was blocked or failed",
          );
        }
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_connected_app_action failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
