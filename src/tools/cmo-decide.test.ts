import { describe, expect, it, vi, afterEach } from "vitest";

import { registerCmoDecideTools } from "./cmo-decide";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const toolMetadata = new Map<string, { description: string }>();

  const tool = vi.fn((...args: unknown[]) => {
    const name = args[0] as string;
    const description = args[1] as string;
    const handler = args[args.length - 1] as Handler;
    handlers.set(name, handler);
    toolMetadata.set(name, { description });
  });

  const server = { tool } as never;
  return { server, handlers, toolMetadata };
}

describe("robynn_cmo_decide", () => {
  afterEach(() => vi.restoreAllMocks());

  it("submits the decision and returns structured output with AGUI fields", async () => {
    const { server, handlers } = createServerHarness();
    const decisionBlock = {
      id: "d2",
      type: "decision_card",
      decisionId: "d2",
      question: "Which audience segment?",
      options: [
        { id: "enterprise", label: "Enterprise" },
        { id: "smb", label: "SMB" },
      ],
    };
    const client = {
      cmoDecide: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Decision recorded.",
          status: "success",
          output: "Continuing with enterprise segment.",
          thread_id: "thread-1",
          run_id: "run-2",
          tokens_used: 18,
          artifacts: {},
          recommended_actions: [],
          next_steps: [],
          response_blocks: [decisionBlock],
          has_decision_cards: true,
          clarify_pending: true,
        },
      }),
    };

    registerCmoDecideTools(server, client as never);

    const res = await handlers.get("robynn_cmo_decide")!({
      thread_id: "thread-1",
      run_id: "run-1",
      decision_id: "d1",
      option_id: "linkedin",
      note: "Prefer B2B channels",
    });

    expect(client.cmoDecide).toHaveBeenCalledWith({
      thread_id: "thread-1",
      run_id: "run-1",
      decision_id: "d1",
      option_id: "linkedin",
      note: "Prefer B2B channels",
    });
    expect(res.structuredContent.run_id).toBe("run-2");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(res.structuredContent.status).toBe("success");
    expect(res.structuredContent.response_blocks).toEqual([decisionBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(true);
    expect(res.structuredContent.clarify_pending).toBe(true);
    expect(res.content[0].text).toContain("Continuing with enterprise segment.");
    expect(res.content[0].text).toContain("Which audience segment?");
    expect(res.isError).toBeUndefined();
  });

  it("returns an error result when the API fails", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      cmoDecide: vi.fn().mockResolvedValue({
        success: false,
        error: "Invalid decision option",
      }),
    };

    registerCmoDecideTools(server, client as never);

    const res = await handlers.get("robynn_cmo_decide")!({
      thread_id: "thread-1",
      run_id: "run-1",
      decision_id: "d1",
      option_id: "invalid",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid decision option");
  });

  it("documents clarify continuation in the tool description", () => {
    const { server, toolMetadata } = createServerHarness();
    registerCmoDecideTools(server, { cmoDecide: vi.fn() } as never);

    const description = String(toolMetadata.get("robynn_cmo_decide")?.description || "");
    expect(description).toContain("decision_card");
    expect(description).toContain("robynn_cmo_agent");
  });
});
