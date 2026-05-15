import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult } from "./util";

export function registerCapabilityTools(
  server: McpServer,
  client: RobynnClient,
) {
  server.tool(
    "robynn_capabilities",
    "Return Robynn's semantic capability manifest for Hermes and other MCP clients, including availability, safety metadata, required role, mapped MCP tools, and mapped robynnv3 API routes.",
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const result = await client.getBridgeCapabilities();

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "Failed to load Robynn capabilities",
          );
        }

        return toSuccessResult(
          result.data as unknown as Record<string, unknown>,
          `Loaded ${result.data.capabilities.length} Robynn bridge capabilities.`,
        );
      } catch (err) {
        return toErrorResult(
          `robynn_capabilities failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
