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

export function isRunTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Run timed out");
}

export function toPendingRunResult(
  label: string,
  runId: string,
  threadId: string,
) {
  const result = {
    status: "pending",
    run_id: runId,
    thread_id: threadId,
    poll_after_seconds: 10,
    message: `${label} is still running in Robynn. Call robynn_run_status with this run_id to fetch the latest status or completed output.`,
  };

  return toSuccessResult(result, result.message);
}
