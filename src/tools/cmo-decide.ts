import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ResponseBlock } from "../types";
import type { RobynnClient } from "../robynn-client";
import { buildCmoAguiTextFallback } from "./cmo-text";
import { toErrorResult, toSuccessResult } from "./util";

function extractAguiFields(data: Record<string, unknown>) {
  const responseBlocks = Array.isArray(data.response_blocks)
    ? (data.response_blocks as ResponseBlock[])
    : [];

  return {
    response_blocks: responseBlocks,
    has_decision_cards: Boolean(data.has_decision_cards),
    clarify_pending: Boolean(data.clarify_pending),
  };
}

function buildPendingText(threadId: string | undefined, runId: string | undefined) {
  const lines = [
    "CMO decision follow-up is still running.",
    threadId ? `thread_id: ${threadId}` : undefined,
    runId ? `run_id: ${runId}` : undefined,
    "Next step: call robynn_run_status with the exact run_id above to fetch the latest status or completed output.",
  ].filter(Boolean);

  return lines.join("\n");
}

export function registerCmoDecideTools(server: McpServer, client: RobynnClient) {
  server.tool(
    "robynn_cmo_decide",
    "Continue a CMO clarify turn by selecting an option from a decision_card returned by robynn_cmo_agent or robynn_run_status.",
    {
      thread_id: z.string().describe("The conversation thread_id from the prior CMO response"),
      run_id: z.string().describe("The run_id from the prior CMO response that presented the decision_card"),
      decision_id: z.string().describe("The decision_id from the decision_card block"),
      option_id: z.string().describe("The option id selected from the decision_card"),
      note: z.string().optional().describe("Optional free-text note to accompany the selection"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ thread_id, run_id, decision_id, option_id, note }) => {
      try {
        const result = await client.cmoDecide({
          thread_id,
          run_id,
          decision_id,
          option_id,
          ...(note ? { note } : {}),
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to submit CMO decision");
        }

        const data = result.data as unknown as Record<string, unknown>;
        if (data.status === "failed") {
          return toErrorResult(
            typeof data.output === "string"
              ? data.output
              : typeof data.summary === "string"
                ? data.summary
                : "CMO decision follow-up failed",
          );
        }

        const agui = extractAguiFields(data);
        const payload = {
          ...data,
          ...agui,
        };

        const outputText =
          typeof data.output === "string"
            ? data.output
            : typeof data.summary === "string"
              ? data.summary
              : null;

        const aguiSummary = buildCmoAguiTextFallback({
          output: outputText,
          clarify_pending: agui.clarify_pending,
          has_decision_cards: agui.has_decision_cards,
          response_blocks: agui.response_blocks,
          defaultSummary: data.status === "pending" ? undefined : "CMO decision submitted.",
        });

        if (data.status === "pending") {
          const pendingText = buildPendingText(
            typeof data.thread_id === "string" ? data.thread_id : undefined,
            typeof data.run_id === "string" ? data.run_id : undefined,
          );
          const summary =
            agui.response_blocks.length > 0
              ? `${pendingText}\n${aguiSummary}`
              : pendingText;
          return toSuccessResult(payload, summary);
        }

        return toSuccessResult(payload, aguiSummary);
      } catch (err) {
        return toErrorResult(
          `Error submitting CMO decision: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
