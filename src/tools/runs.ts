import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toPendingRunResult, toSuccessResult } from "./util";

export function registerRunTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_run_status",
    "Get the latest status for a long-running Robynn CMO run. Use this after robynn_create_content or robynn_research returns a pending run_id.",
    {
      run_id: z.string().describe("The Robynn run_id returned by a prior content or research request"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ run_id }) => {
      try {
        const result = await client.getRun(run_id);

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to fetch run status");
        }

        if (result.data.status === "completed") {
          const responseData = {
            status: result.data.status,
            run_id: result.data.id,
            thread_id: result.data.thread_id,
            output: result.data.output,
            tokens_used: result.data.tokens_used,
          };

          return toSuccessResult(
            responseData as Record<string, unknown>,
            result.data.output || "Run completed.",
          );
        }

        if (result.data.status === "failed") {
          return toErrorResult(result.data.output || "Run failed.");
        }

        return toPendingRunResult("Run", result.data.id, result.data.thread_id || "");
      } catch (err) {
        return toErrorResult(
          `Error fetching run status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
