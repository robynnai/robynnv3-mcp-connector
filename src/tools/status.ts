import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

const STATUS_TITLE = "Check Robynn Connection";

export const UNAUTHENTICATED_STATUS_MESSAGE =
  "Not authenticated. Disconnect and reconnect Robynn in your AI client, then try again.";

export function registerStatusTools(server: McpServer, client: RobynnClient) {
  server.registerTool(
    "robynn_status",
    {
      ...toolMetadata(STATUS_TITLE, {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the Robynn connection and the connected organization's name, company info, and connection health. Read-only.",
    },
    async () => {
      try {
        const result = await client.getStatus();
        const statusData = {
          connected: result.success,
          ...(result.data || {}),
        };

        return toSuccessResult(statusData as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error checking status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "robynn_usage",
    {
      ...toolMetadata("Check Credit Balance", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the connected organization's credit (token) balance, usage, and quota. Read-only; does not spend credits.",
    },
    async () => {
      try {
        const result = await client.getUsage();

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to fetch usage");
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error fetching usage: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}

/**
 * The `robynn_status` registration used when a session has no access token.
 * Same title and hints as the authenticated tool, host-neutral copy.
 * Not wired in yet: `RobynnMCP.init()` (src/index.ts, owned by P10) still
 * registers its own unannotated fallback and should call this instead.
 */
export function registerUnauthenticatedStatusTool(server: McpServer) {
  server.registerTool(
    "robynn_status",
    {
      ...toolMetadata(STATUS_TITLE, {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the Robynn connection. This session is not authenticated; reconnect Robynn to use its tools.",
    },
    async () => toErrorResult(UNAUTHENTICATED_STATUS_MESSAGE),
  );
}
