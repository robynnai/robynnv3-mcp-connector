import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResponseBlock } from "../types";
import type { RobynnClient } from "../robynn-client";
import { buildCmoAguiTextFallback } from "./cmo-text";
import { toErrorResult, toSuccessResult } from "./util";

function extractAguiFields(data: {
  response_blocks?: ResponseBlock[];
  has_decision_cards?: boolean;
  clarify_pending?: boolean;
}) {
  const responseBlocks = Array.isArray(data.response_blocks)
    ? data.response_blocks
    : [];

  return {
    response_blocks: responseBlocks,
    has_decision_cards: Boolean(data.has_decision_cards),
    clarify_pending: Boolean(data.clarify_pending),
  };
}

function buildPendingPollText(runId: string, threadId: string) {
  return [
    "Run is still running in Robynn.",
    `run_id: ${runId}`,
    `thread_id: ${threadId}`,
    "Next step: call robynn_run_status with the exact run_id above to fetch the latest status or completed output.",
  ].join("\n");
}

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

        const agui = extractAguiFields(result.data);

        if (result.data.status === "completed") {
          const responseData = {
            status: result.data.status,
            run_id: result.data.id,
            thread_id: result.data.thread_id,
            output: result.data.output,
            tokens_used: result.data.tokens_used,
            ...agui,
          };

          return toSuccessResult(
            responseData as Record<string, unknown>,
            buildCmoAguiTextFallback({
              output: result.data.output,
              clarify_pending: agui.clarify_pending,
              has_decision_cards: agui.has_decision_cards,
              response_blocks: agui.response_blocks,
              defaultSummary: "Run completed.",
            }),
          );
        }

        if (result.data.status === "failed") {
          return toErrorResult(result.data.output || "Run failed.");
        }

        const threadId = result.data.thread_id || "";
        const pendingMessage = buildPendingPollText(result.data.id, threadId);
        const aguiSummary = buildCmoAguiTextFallback({
          output: result.data.output,
          clarify_pending: agui.clarify_pending,
          has_decision_cards: agui.has_decision_cards,
          response_blocks: agui.response_blocks,
        });
        const summary =
          agui.response_blocks.length > 0
            ? `${pendingMessage}\n${aguiSummary}`
            : pendingMessage;

        return toSuccessResult(
          {
            status: "pending",
            run_id: result.data.id,
            thread_id: threadId,
            poll_after_seconds: 5,
            message: pendingMessage,
            ...agui,
          },
          summary,
        );
      } catch (err) {
        return toErrorResult(
          `Error fetching run status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
