import { describe, expect, it, vi, afterEach } from "vitest";

import { registerCmoAgentTools } from "./cmo-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();

  const registerTool = vi.fn((name: string, _config: unknown, handler: Handler) => {
    handlers.set(name, handler);
  });

  const server = { registerTool } as never;
  return { server, handlers };
}

describe("robynn_cmo_agent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns completed output text and structured ids", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      cmoAgent: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "CMO run completed.",
          status: "success",
          output: "Launch plan complete",
          thread_id: "thread-1",
          run_id: "run-1",
          tokens_used: 42,
          artifacts: {},
          recommended_actions: [],
          next_steps: [],
        },
      }),
    };

    registerCmoAgentTools(server, client as never);

    const res = await handlers.get("robynn_cmo_agent")!({
      message: "Create a launch plan",
      assistant_id: "cmo_v3",
      route_hint: "deep",
      requested_capability: "research",
      claude_skill_slug: "launch-plan",
      history_summary: "Prior context",
      memory_enabled: true,
    });

    expect(client.cmoAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Create a launch plan",
        assistant_id: "cmo_v3",
        route_hint: "deep",
        requested_capability: "research",
        claude_skill_slug: "launch-plan",
        history_summary: "Prior context",
        memory_enabled: true,
      }),
    );
    expect(res.content[0].text).toBe("Launch plan complete");
    expect(res.structuredContent.run_id).toBe("run-1");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(res.structuredContent.status).toBe("success");
    expect(res.isError).toBeUndefined();
  });

  it("returns a pending response cleanly", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      cmoAgent: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "CMO run is still running.",
          status: "pending",
          thread_id: "thread-1",
          run_id: "run-1",
          poll_after_seconds: 5,
          artifacts: {},
          recommended_actions: [],
          next_steps: ["Call robynn_run_status with this run_id."],
        },
      }),
    };

    registerCmoAgentTools(server, client as never);

    const res = await handlers.get("robynn_cmo_agent")!({
      message: "Create a launch plan",
    });

    expect(res.content[0].text).toContain("still running");
    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.run_id).toBe("run-1");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(res.isError).toBeUndefined();
  });

  it("returns an error result when the API fails", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      cmoAgent: vi.fn().mockResolvedValue({
        success: false,
        error: "boom",
      }),
    };

    registerCmoAgentTools(server, client as never);

    const res = await handlers.get("robynn_cmo_agent")!({
      message: "Create a launch plan",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });
});
