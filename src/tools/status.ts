import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RobynnClient } from "../robynn-client";

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(statusData, null, 2),
            },
          ],
          structuredContent: statusData as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking status: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "robynn_usage",
    "Check token balance, usage, and quota for the connected Robynn organization.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const result = await client.getUsage();

        if (!result.success || !result.data) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error || "Failed to fetch usage",
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
              text: `Error fetching usage: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
