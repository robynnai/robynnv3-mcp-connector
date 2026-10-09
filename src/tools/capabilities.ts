import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

export function registerCapabilityTools(
  server: McpServer,
  client: RobynnClient,
) {
  server.registerTool(
    "robynn_capabilities",
    {
      ...toolMetadata("List Robynn Capabilities", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Return Robynn's capability manifest for MCP clients: availability, safety metadata, required role, and the MCP tools and Robynn API routes behind each capability. Read-only.",
    },
    async () => {
      try {
        const result = await client.getBridgeCapabilities();

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "Failed to load Robynn capabilities",
          );
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `robynn_capabilities failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
