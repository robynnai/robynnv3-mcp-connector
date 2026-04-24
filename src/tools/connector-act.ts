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
    "Execute a write action (create/update) against a connected app like HubSpot or Salesforce. Audit-logged and idempotent — pass the same idempotency_key to replay a prior successful call without re-executing.",
    {
      service: z
        .string()
        .describe("Connected app identifier, e.g. 'hubspot', 'salesforce'."),
      action: z
        .string()
        .describe(
          "Action key scoped to the service, e.g. 'create_task', 'log_activity'. Call robynn_connected_app_capabilities to discover what's available.",
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
          "If true, validate parameters and record the intent but do NOT call the provider.",
        ),
      provider_access_token: z
        .string()
        .optional()
        .describe(
          "Temporary: supply the provider OAuth token. Will be removed once Composio handles token resolution server-side.",
        ),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (args) => {
      try {
        const result = await client.actOnConnectedApp(args);
        return toSuccessResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_connected_app_action failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
