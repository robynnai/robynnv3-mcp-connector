import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResponseBlock } from "../types";
import type { RobynnClient } from "../robynn-client";
import { buildCmoAguiTextFallback } from "./cmo-text";
import { isSafePathId, toErrorResult, toSuccessResult, toolMetadata } from "./util";

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
  server.registerTool(
    "robynn_run_status",
    {
      ...toolMetadata("Check Run Status", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Get the status or final output of a Robynn CMO run started by robynn_create_content, robynn_research, robynn_assist, or robynn_cmo_agent. The first poll after the run finishes saves its output (messages and artifacts) to Robynn and settles its credit reservation; repeat polls are safe and do not charge again.",
      inputSchema: {
        run_id: z.string().describe("The run_id returned by robynn_create_content, robynn_research, robynn_assist, or robynn_cmo_agent"),
      },
    },
    async ({ run_id }) => {
      if (!isSafePathId(run_id)) {
        return toErrorResult("Invalid run_id.");
      }

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
