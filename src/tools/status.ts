import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

export function registerStatusTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_status",
    "Check Robynn connection status and organization info. Returns the organization name, company info, and connection health.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  server.tool(
    "robynn_usage",
    "Check token balance, usage, and quota for the connected Robynn organization.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
