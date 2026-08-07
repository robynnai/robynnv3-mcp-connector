import { describe, expect, it, vi, afterEach } from "vitest";

import { registerCmoAgentTools } from "./cmo-agent";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const toolConfigs = new Map<string, Record<string, unknown>>();

  const registerTool = vi.fn((name: string, config: unknown, handler: Handler) => {
    handlers.set(name, handler);
    toolConfigs.set(name, config as Record<string, unknown>);
  });

  const server = { registerTool } as never;
  return { server, handlers, toolConfigs };
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

  it("passes response_blocks through structuredContent and mentions decision questions", async () => {
    const { server, handlers } = createServerHarness();
    const decisionBlock = {
      id: "d1",
      type: "decision_card",
      decisionId: "d1",
      question: "Which channel first?",
      options: [
        { id: "linkedin", label: "LinkedIn" },
        { id: "email", label: "Email" },
      ],
    };
    const client = {
      cmoAgent: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Need a quick choice.",
          status: "success",
          output: "Need a quick choice.",
          thread_id: "thread-1",
          run_id: "run-1",
          tokens_used: 12,
          artifacts: {},
          recommended_actions: [],
          next_steps: [],
          response_blocks: [decisionBlock],
          has_decision_cards: true,
          clarify_pending: true,
        },
      }),
    };

    registerCmoAgentTools(server, client as never);

    const res = await handlers.get("robynn_cmo_agent")!({
      message: "Plan a campaign",
    });

    expect(res.structuredContent.response_blocks).toEqual([decisionBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(true);
    expect(res.structuredContent.clarify_pending).toBe(true);
    expect(res.content[0].text).toContain("Which channel first?");
    expect(res.content[0].text).toContain("LinkedIn");
    expect(res.content[0].text).toContain("decision_card");
  });

  it("keeps pending poll guidance and attaches live response_blocks", async () => {
    const { server, handlers } = createServerHarness();
    const progressBlock = {
      id: "p1",
      type: "progress_pipeline",
      title: "Researching channels",
    };
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
          response_blocks: [progressBlock],
          has_decision_cards: false,
          clarify_pending: false,
        },
      }),
    };

    registerCmoAgentTools(server, client as never);

    const res = await handlers.get("robynn_cmo_agent")!({
      message: "Create a launch plan",
    });

    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.response_blocks).toEqual([progressBlock]);
    expect(res.structuredContent.has_decision_cards).toBe(false);
    expect(res.structuredContent.clarify_pending).toBe(false);
    expect(res.content[0].text).toContain("still running");
    expect(res.content[0].text).toContain("robynn_run_status");
    expect(res.content[0].text).toContain("progress_pipeline");
  });

  it("documents CMO v3, route_hint, and decision_card clarify in the tool description", () => {
    const { server, toolConfigs } = createServerHarness();
    registerCmoAgentTools(server, { cmoAgent: vi.fn() } as never);

    const description = String(toolConfigs.get("robynn_cmo_agent")?.description || "");
    expect(description.toLowerCase()).toContain("cmo v3");
    expect(description).toContain("route_hint");
    expect(description).toContain("decision_card");
  });

  it("links the CMO AGUI MCP Apps report resource", () => {
    const { server, toolConfigs } = createServerHarness();
    registerCmoAgentTools(server, { cmoAgent: vi.fn() } as never);

    const meta = toolConfigs.get("robynn_cmo_agent")?._meta as
      | { ui?: { resourceUri?: string; visibility?: string[] } }
      | undefined;
    expect(meta?.ui?.resourceUri).toBe(REPORT_RESOURCE_URIS.cmoAgui);
    expect(meta?.ui?.visibility).toEqual(["model", "app"]);
  });
});
