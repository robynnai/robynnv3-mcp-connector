import type { ResponseBlock } from "../types";

function countByType(blocks: ResponseBlock[]): string {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    counts.set(block.type, (counts.get(block.type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

export function buildCmoAguiTextFallback(params: {
  output?: string | null;
  clarify_pending?: boolean;
  has_decision_cards?: boolean;
  response_blocks?: ResponseBlock[];
  defaultSummary?: string;
}): string {
  const blocks = params.response_blocks || [];
  const output = (params.output || "").trim();
  if (blocks.length === 0) {
    return output || params.defaultSummary || "CMO agent completed.";
  }

  const lines: string[] = [];
  if (output) lines.push(output);

  if (params.clarify_pending || params.has_decision_cards) {
    for (const block of blocks) {
      if (block.type !== "decision_card") continue;
      const question = String(block.question || block.title || "").trim();
      const options = Array.isArray(block.options)
        ? block.options
            .map((option) => {
              const row = option as { label?: unknown; id?: unknown };
              return String(row.label || row.id || "").trim();
            })
            .filter(Boolean)
        : [];
      if (question) {
        lines.push(`Decision needed: ${question}`);
        if (options.length) lines.push(`Options: ${options.join(" | ")}`);
      }
    }
  }

  lines.push(`response_blocks: ${blocks.length} (${countByType(blocks)})`);
  return lines.join("\n");
}
