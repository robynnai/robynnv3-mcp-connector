export function toErrorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

export function toSuccessResult(
  result: Record<string, unknown>,
  summary?: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: summary || JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

const DEFAULT_SYNC_WAIT_MS = 8_000;
const MAX_SYNC_WAIT_MS = 30_000;

export function getShortSyncWaitMs() {
  const envValue =
    typeof process !== "undefined"
      ? process.env.ROBYNN_MCP_SYNC_WAIT_MS
      : undefined;
  const parsed = Number.parseInt(envValue || "", 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_SYNC_WAIT_MS;
  }

  return Math.max(0, Math.min(parsed, MAX_SYNC_WAIT_MS));
}

export function isRunTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Run timed out");
}

export function toPendingRunResult(
  label: string,
  runId: string,
  threadId: string,
) {
  const lines = [
    `${label} is still running in Robynn.`,
    `run_id: ${runId}`,
    `thread_id: ${threadId}`,
    "Next step: call robynn_run_status with the exact run_id above to fetch the latest status or completed output.",
  ];

  const result = {
    status: "pending",
    run_id: runId,
    thread_id: threadId,
    poll_after_seconds: 5,
    message: lines.join("\n"),
  };

  return toSuccessResult(result, result.message);
}

export interface ToolSafetyHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  /** Set only with evidence that a repeat call has no additional effect (true) or duplicates work (false). */
  idempotentHint?: boolean;
}

/**
 * Display title plus the explicit safety hints for `registerTool` /
 * `registerAppTool`. The title is mirrored into `annotations.title` for hosts
 * that only read the annotation. Values follow contracts/tool-route-map.json.
 */
export function toolMetadata(title: string, hints: ToolSafetyHints) {
  return { title, annotations: { title, ...hints } };
}

const SAFE_PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Ids that the Robynn client interpolates into API paths (thread/run ids).
 * Rejects `/`, `.`, `?`, `%` and friends so a caller-supplied id cannot
 * redirect the request to another same-origin route.
 */
export function isSafePathId(value: string): boolean {
  return SAFE_PATH_ID.test(value);
}
