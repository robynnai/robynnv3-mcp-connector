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
