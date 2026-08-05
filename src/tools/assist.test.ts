import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAssistTools } from "./assist";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();

  const tool = vi.fn((...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Handler;
    handlers.set(name, handler);
  });

  const server = { tool } as never;
  return { server, handlers };
}

describe("robynn_assist", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes AGUI fields from pollRun through structuredContent", async () => {
    const { server, handlers } = createServerHarness();
    const decisionBlock = {
      id: "d1",
      type: "decision_card",
      decisionId: "d1",
      question: "Which CTA tone?",
      options: [
        { id: "direct", label: "Direct" },
        { id: "warm", label: "Warm" },
      ],
    };
    const client = {
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: { id: "thread-1", title: "Assist", created_at: "2026-01-01" },
      }),
      startRun: vi.fn().mockResolvedValue({
        success: true,
        data: { run_id: "run-1" },
      }),
      pollRun: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: "run-1",
          status: "completed",
          output: "Need a quick choice.",
          tokens_used: 18,
          response_blocks: [decisionBlock],
          has_decision_cards: true,
          clarify_pending: true,
        },
      }),
    };

    registerAssistTools(server, client as never);

    const res = await handlers.get("robynn_assist")!({
      message: "Help me draft a CTA",
      thread_id: "thread-1",
    });

    expect(client.createThread).not.toHaveBeenCalled();
    expect(res.structuredContent.output).toBe("Need a quick choice.");
    expect(res.structuredContent.response_blocks).toEqual([decisionBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(true);
    expect(res.structuredContent.clarify_pending).toBe(true);
    expect(res.content[0].text).toContain("Which CTA tone?");
    expect(res.content[0].text).toContain("Direct");
    expect(res.content[0].text).toContain("decision_card");
  });

  it("leaves completed behavior unchanged when AGUI fields are absent", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: { id: "thread-1", title: "Assist", created_at: "2026-01-01" },
      }),
      startRun: vi.fn().mockResolvedValue({
        success: true,
        data: { run_id: "run-1" },
      }),
      pollRun: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: "run-1",
          status: "completed",
          output: "Assist run completed.",
          tokens_used: 9,
        },
      }),
    };

    registerAssistTools(server, client as never);

    const res = await handlers.get("robynn_assist")!({
      message: "Draft a memo",
    });

    expect(res.structuredContent.output).toBe("Assist run completed.");
    expect(res.structuredContent.response_blocks).toEqual([]);
    expect(res.structuredContent.has_decision_cards).toBe(false);
    expect(res.structuredContent.clarify_pending).toBe(false);
    expect(res.content[0].text).toBe("Assist run completed.");
  });
});
