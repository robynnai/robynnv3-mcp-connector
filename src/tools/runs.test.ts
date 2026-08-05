import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRunTools } from "./runs";

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

describe("robynn_run_status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes AGUI fields through on completed runs and uses text fallback", async () => {
    const { server, handlers } = createServerHarness();
    const decisionBlock = {
      id: "d1",
      type: "decision_card",
      decisionId: "d1",
      question: "Which audience segment?",
      options: [
        { id: "smb", label: "SMB" },
        { id: "enterprise", label: "Enterprise" },
      ],
    };
    const client = {
      getRun: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: "run-1",
          status: "completed",
          output: "Need a quick choice.",
          thread_id: "thread-1",
          tokens_used: 33,
          response_blocks: [decisionBlock],
          has_decision_cards: true,
          clarify_pending: true,
        },
      }),
    };

    registerRunTools(server, client as never);

    const res = await handlers.get("robynn_run_status")!({ run_id: "run-1" });

    expect(res.structuredContent.status).toBe("completed");
    expect(res.structuredContent.response_blocks).toEqual([decisionBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(true);
    expect(res.structuredContent.clarify_pending).toBe(true);
    expect(res.content[0].text).toContain("Which audience segment?");
    expect(res.content[0].text).toContain("SMB");
    expect(res.content[0].text).toContain("decision_card");
  });

  it("keeps pending poll guidance and attaches live response_blocks", async () => {
    const { server, handlers } = createServerHarness();
    const progressBlock = {
      id: "p1",
      type: "progress_pipeline",
      title: "Drafting outline",
    };
    const client = {
      getRun: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: "run-1",
          status: "running",
          thread_id: "thread-1",
          output: undefined,
          response_blocks: [progressBlock],
          has_decision_cards: false,
          clarify_pending: false,
        },
      }),
    };

    registerRunTools(server, client as never);

    const res = await handlers.get("robynn_run_status")!({ run_id: "run-1" });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.run_id).toBe("run-1");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(res.structuredContent.response_blocks).toEqual([progressBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(false);
    expect(res.structuredContent.clarify_pending).toBe(false);
    expect(res.content[0].text).toContain("run_id: run-1");
    expect(res.content[0].text).toContain("thread_id: thread-1");
    expect(res.content[0].text).toContain("robynn_run_status");
    expect(res.content[0].text).toContain("progress_pipeline");
  });

  it("returns an error result when the run failed", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      getRun: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: "run-1",
          status: "failed",
          output: "Agent crashed",
          thread_id: "thread-1",
        },
      }),
    };

    registerRunTools(server, client as never);

    const res = await handlers.get("robynn_run_status")!({ run_id: "run-1" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Agent crashed");
  });
});
