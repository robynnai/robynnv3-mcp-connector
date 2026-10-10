import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

/**
 * Registers the write-action tool for connected apps. Uses the same
 * /api/cli/connectors/act endpoint as Claude Desktop will, so both MCP
 * surfaces advertise the same shape.
 */
export function registerConnectorActionTools(
  server: McpServer,
  client: RobynnClient,
) {
  server.registerTool(
    "robynn_connected_app_action",
    {
      ...toolMetadata("Act in a Connected App", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      }),
      description:
        "Create or update records in a connected app such as HubSpot, Salesforce, or HighLevel. Changes data in that third-party service and is audit-logged in Robynn. Reusing an idempotency_key returns the stored result only when the earlier call completed successfully; after a failed or unfinished call the action can run again. dry_run checks policy and the connection without calling the provider. Protected writes such as highlevel.publish_email_template need explicit user confirmation and write_confirmed=true.",
      inputSchema: {
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
            "UUID unique to this logical action. A replay returns the stored result only if the earlier call with this key completed successfully.",
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
    },
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
