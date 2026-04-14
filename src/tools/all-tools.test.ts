import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContextTools } from "./context";
import { registerStatusTools } from "./status";
import { registerContentTools } from "./content";
import { registerResearchTools } from "./research";
import { registerAssistTools } from "./assist";
import { registerConversationTools } from "./conversations";
import { registerRunTools } from "./runs";
import { registerGeoTools } from "./geo";
import { registerBattlecardTools } from "./battlecard";
import { registerSeoTools } from "./seo";
import { registerBrandBookTools } from "./brand-book";
import { registerWebsiteTools } from "./website";
import { registerConnectorTools } from "./connectors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const toolMetadata = new Map<
    string,
    {
      description: string;
    }
  >();

  // server.tool() uses positional args: (name, desc, schema, annotations, handler)
  // or (name, desc, annotations, handler) for no-schema tools
  const tool = vi.fn((...args: unknown[]) => {
    const name = args[0] as string;
    const description = args[1] as string;
    const handler = args[args.length - 1] as Handler;
    handlers.set(name, handler);
    toolMetadata.set(name, { description });
  });

  // registerAppTool calls server.registerTool(name, config, handler)
  const registerTool = vi.fn(
    (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  );

  const server = { tool, registerTool } as never;

  return { server, handlers, toolMetadata };
}

function createFullMockClient() {
  return {
    getBrandContext: vi.fn().mockResolvedValue({
      success: true,
      data: { scope: "summary", company_name: "Acme", documents: {} },
    }),
    getStatus: vi.fn().mockResolvedValue({
      success: true,
      data: { company_name: "Acme" },
    }),
    getUsage: vi.fn().mockResolvedValue({
      success: true,
      data: { balance: 500, used: 100, limit: 1000, plan: "pro" },
    }),
    createThread: vi.fn().mockResolvedValue({
      success: true,
      data: { id: "thread-1", title: "Test", created_at: "2026-01-01" },
    }),
    listThreads: vi.fn().mockResolvedValue({
      success: true,
      data: { threads: [{ id: "t1", title: "Thread 1", created_at: "2026-01-01", updated_at: "2026-01-01" }] },
    }),
    startRun: vi.fn().mockResolvedValue({
      success: true,
      data: { run_id: "run-1" },
    }),
    getRun: vi.fn().mockResolvedValue({
      success: true,
      data: {
        id: "run-1",
        status: "completed",
        output: "Generated content here",
        thread_id: "thread-1",
        tokens_used: 50,
      },
    }),
    pollRun: vi.fn().mockResolvedValue({
      success: true,
      data: { id: "run-1", status: "completed", output: "Generated content here", tokens_used: 50 },
    }),
    geoAnalysis: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "GEO analysis complete",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        visibility_scores: [{ llm: "chatgpt", score: 72 }],
        citation_breakdown: { target_company: 5, competitor: 3, other: 2 },
        query_gaps: [],
      },
    }),
    competitiveBattlecard: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Battlecard ready",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        comparison: [{ title: "Pricing", bullets: ["Lower cost"] }],
        objections: ["Too expensive"],
        differentiators: ["Fast onboarding"],
        risks: [],
      },
    }),
    seoOpportunities: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "SEO analysis complete",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        opportunities: [{ keyword: "crm tool", opportunity_score: 85 }],
        keyword_gaps: [],
        competitor_comparison: [],
      },
    }),
    brandBookStatus: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Brand book 55% complete",
        status: "partial",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        completeness_score: 55,
        sections: [],
        missing_items: [],
        readiness_summary: "Partial",
      },
    }),
    brandBookGapAnalysis: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "3 high-priority gaps",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        highest_priority_gaps: [],
        section_findings: [],
        content_readiness_impact: [],
      },
    }),
    brandBookStrategy: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Strategy ready",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        strategic_priorities: [],
        positioning_recommendations: [],
        voice_recommendations: [],
        competitive_recommendations: [],
        proof_recommendations: [],
      },
    }),
    brandReflections: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "2 pending reflections",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        pending_reflections: [{ id: "r1", doc_name: "voice", operation: "update" }],
        recent_reflections: [],
      },
    }),
    publishBrandBookHtml: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Exported",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        company_name: "Acme",
        exported_at: "2026-01-01T00:00:00Z",
      },
    }),
    websiteAudit: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Website audit complete",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        website_url: "https://acme.test",
        messaging_findings: [],
        seo_findings: [],
        geo_findings: [],
        conversion_findings: [],
        competitor_findings: [],
      },
    }),
    websiteStrategy: vi.fn().mockResolvedValue({
      success: true,
      data: {
        summary: "Strategy complete",
        status: "success",
        artifacts: {},
        recommended_actions: [],
        next_steps: [],
        website_url: "https://acme.test",
        priority_plan: [],
        page_level_recommendations: [],
        messaging_changes: [],
        seo_geo_changes: [],
        measurement_plan: [],
      },
    }),
    getConnectedAppCapabilities: vi.fn().mockResolvedValue({
      success: true,
      data: {
        providers: [
          {
            provider_key: "hubspot",
            display_name: "HubSpot",
            status: "active",
            default_connection: {
              id: "conn-1",
              display_name: "Marketing Hub",
              status: "active",
              health_status: "healthy",
            },
            read_actions: [
              {
                action_key: "hubspot.list_contacts",
                label: "List contacts",
                description: "Read contacts from HubSpot.",
                result_kind: "list",
                input_schema: { type: "object", properties: {}, required: [] },
                example_prompts: ["How many contacts do I have in HubSpot?"],
              },
            ],
          },
        ],
      },
    }),
    readConnectedApp: vi.fn().mockResolvedValue({
      success: true,
      data: {
        provider_key: "hubspot",
        action_key: "hubspot.list_contacts",
        connection_id: "conn-1",
        result_kind: "list",
        summary: "HubSpot returned 128 contacts.",
        highlights: { count: 128 },
        raw_result: { results: [] },
      },
    }),
  };
}

function registerAllTools(
  server: never,
  client: ReturnType<typeof createFullMockClient>,
) {
  registerContextTools(server, client as never);
  registerStatusTools(server, client as never);
  registerContentTools(server, client as never);
  registerResearchTools(server, client as never);
  registerAssistTools(server, client as never);
  registerConversationTools(server, client as never);
  registerRunTools(server, client as never);
  registerGeoTools(server, client as never);
  registerBattlecardTools(server, client as never);
  registerSeoTools(server, client as never);
  registerBrandBookTools(server, client as never);
  registerWebsiteTools(server, client as never);
  registerConnectorTools(server, client as never);
}

describe("all tools registration", () => {
  it("registers exactly 21 tools", () => {
    const { server, handlers } = createServerHarness();
    const client = createFullMockClient();
    registerAllTools(server, client);
    expect(handlers.size).toBe(21);
  });

  it("registers the expected tool names", () => {
    const { server, handlers } = createServerHarness();
    const client = createFullMockClient();
    registerAllTools(server, client);

    const expected = [
      "robynn_brand_context",
      "robynn_status",
      "robynn_usage",
      "robynn_create_content",
      "robynn_research",
      "robynn_assist",
      "robynn_conversations",
      "robynn_run_status",
      "robynn_geo_analysis",
      "robynn_competitive_battlecard",
      "robynn_seo_opportunities",
      "robynn_brand_book_status",
      "robynn_brand_book_gap_analysis",
      "robynn_brand_book_strategy",
      "robynn_brand_reflections",
      "robynn_publish_brand_book_html",
      "robynn_website_audit",
      "robynn_website_strategy",
      "robynn_connected_apps",
      "robynn_connected_app_capabilities",
      "robynn_query_connected_app",
    ];

    for (const name of expected) {
      expect(handlers.has(name), `missing tool: ${name}`).toBe(true);
    }

    expect(handlers.has("robynn_brand_rules")).toBe(false);
  });
});

describe("connector tool guidance", () => {
  it("describes capability discovery, read-only semantics, and summary-first usage", () => {
    const { server, toolMetadata } = createServerHarness();
    const client = createFullMockClient();
    registerAllTools(server, client);

    expect(
      toolMetadata.get("robynn_connected_apps")?.description,
    ).toContain("provider-specific operational questions");
    expect(
      toolMetadata.get("robynn_connected_app_capabilities")?.description,
    ).toContain("Use this before guessing actions");
    expect(
      toolMetadata.get("robynn_query_connected_app")?.description,
    ).toContain("structuredContent.summary");
    expect(
      toolMetadata.get("robynn_query_connected_app")?.description,
    ).toContain("structuredContent.highlights");
    expect(
      toolMetadata.get("robynn_query_connected_app")?.description,
    ).toContain("read-only");
  });
});

describe("all tools success path", () => {
  afterEach(() => vi.restoreAllMocks());

  let handlers: Map<string, Handler>;
  let client: ReturnType<typeof createFullMockClient>;

  function setup() {
    const harness = createServerHarness();
    handlers = harness.handlers;
    client = createFullMockClient();
    registerAllTools(harness.server, client);
  }

  it("robynn_brand_context returns structured content", async () => {
    setup();
    const res = await handlers.get("robynn_brand_context")!({ scope: "summary" });
    expect(res.structuredContent.company_name).toBe("Acme");
    expect(res.isError).toBeUndefined();
    expect(client.getBrandContext).toHaveBeenCalledWith("summary");
  });

  it("robynn_status returns connected status", async () => {
    setup();
    const res = await handlers.get("robynn_status")!({});
    expect(res.structuredContent.connected).toBe(true);
    expect(res.isError).toBeUndefined();
  });

  it("robynn_usage returns balance info", async () => {
    setup();
    const res = await handlers.get("robynn_usage")!({});
    expect(res.structuredContent.balance).toBe(500);
    expect(res.isError).toBeUndefined();
  });

  it("robynn_connected_apps returns connected app summaries", async () => {
    setup();
    const res = await handlers.get("robynn_connected_apps")!({});
    expect(res.structuredContent.count).toBe(1);
    expect(res.structuredContent.providers[0].provider_key).toBe("hubspot");
    expect(client.getConnectedAppCapabilities).toHaveBeenCalledWith();
  });

  it("robynn_connected_app_capabilities returns provider capability metadata", async () => {
    setup();
    const res = await handlers.get("robynn_connected_app_capabilities")!({
      provider_key: "hubspot",
    });
    expect(res.structuredContent.provider_key).toBe("hubspot");
    expect(res.structuredContent.read_actions[0].action_key).toBe(
      "hubspot.list_contacts",
    );
    expect(client.getConnectedAppCapabilities).toHaveBeenCalledWith("hubspot");
  });

  it("robynn_query_connected_app forwards read-only queries", async () => {
    setup();
    const res = await handlers.get("robynn_query_connected_app")!({
      provider_key: "hubspot",
      action_key: "hubspot.list_contacts",
      payload: {
        filters: {
          lifecycle_stage: "lead",
        },
      },
    });
    expect(res.structuredContent.summary).toBe("HubSpot returned 128 contacts.");
    expect(res.structuredContent.highlights.count).toBe(128);
    expect(client.readConnectedApp).toHaveBeenCalledWith({
      provider_key: "hubspot",
      action_key: "hubspot.list_contacts",
      payload: {
        filters: {
          lifecycle_stage: "lead",
        },
      },
      connection_id: undefined,
    });
  });

  it("robynn_create_content creates thread and polls run", async () => {
    setup();
    const res = await handlers.get("robynn_create_content")!({
      type: "blog_post",
      topic: "AI marketing",
    });
    expect(res.structuredContent.content).toBe("Generated content here");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(client.createThread).toHaveBeenCalled();
    expect(client.startRun).toHaveBeenCalled();
    expect(client.pollRun).toHaveBeenCalledWith("run-1", 8000);
  });

  it("robynn_create_content returns pending status when polling times out", async () => {
    setup();
    client.pollRun.mockRejectedValueOnce(new Error("Run timed out after 280 seconds"));
    const res = await handlers.get("robynn_create_content")!({
      type: "blog_post",
      topic: "AI marketing",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.run_id).toBe("run-1");
    expect(res.structuredContent.thread_id).toBe("thread-1");
    expect(res.content[0].text).toContain("still running");
    expect(res.content[0].text).toContain("run_id: run-1");
    expect(res.content[0].text).toContain("thread_id: thread-1");
  });

  it("robynn_create_content reuses existing thread_id", async () => {
    setup();
    await handlers.get("robynn_create_content")!({
      type: "email",
      topic: "Product launch",
      thread_id: "existing-thread",
    });
    expect(client.createThread).not.toHaveBeenCalled();
    expect(client.startRun).toHaveBeenCalledWith(
      "existing-thread",
      expect.objectContaining({ type: "email" }),
    );
  });

  it("robynn_research creates thread and returns findings", async () => {
    setup();
    const res = await handlers.get("robynn_research")!({
      query: "CRM market trends",
      type: "market",
    });
    expect(res.structuredContent.findings).toBe("Generated content here");
    expect(client.createThread).toHaveBeenCalled();
    expect(client.pollRun).toHaveBeenCalledWith("run-1", 8000);
  });

  it("robynn_assist creates thread and forwards routing hints", async () => {
    setup();
    const res = await handlers.get("robynn_assist")!({
      message: "Draft a strategy memo for the new launch",
      assistant_id: "cmo_v3",
      route_hint: "deep",
      requested_capability: "article",
      claude_skill_slug: "strategy-memo",
      history_summary: "Thread summary",
      memory_enabled: true,
    });
    expect(res.structuredContent.output).toBe("Generated content here");
    expect(client.createThread).toHaveBeenCalled();
    expect(client.startRun).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        message: "Draft a strategy memo for the new launch",
        assistant_id: "cmo_v3",
        route_hint: "deep",
        requested_capability: "article",
        claude_skill_slug: "strategy-memo",
        history_summary: "Thread summary",
        memory_enabled: true,
      }),
    );
    expect(client.pollRun).toHaveBeenCalledWith("run-1", 8000);
  });

  it("robynn_run_status returns completed output", async () => {
    setup();
    const res = await handlers.get("robynn_run_status")!({
      run_id: "run-1",
    });
    expect(res.structuredContent.status).toBe("completed");
    expect(res.structuredContent.output).toBe("Generated content here");
    expect(client.getRun).toHaveBeenCalledWith("run-1");
  });

  it("robynn_run_status returns pending output with the exact run identifiers in text", async () => {
    setup();
    client.getRun.mockResolvedValueOnce({
      success: true,
      data: {
        id: "run-1",
        status: "running",
        thread_id: "thread-1",
        output: undefined,
      },
    });

    const res = await handlers.get("robynn_run_status")!({
      run_id: "run-1",
    });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.status).toBe("pending");
    expect(res.content[0].text).toContain("run_id: run-1");
    expect(res.content[0].text).toContain("thread_id: thread-1");
  });

  it("robynn_conversations list returns threads", async () => {
    setup();
    const res = await handlers.get("robynn_conversations")!({ action: "list" });
    expect(res.structuredContent.count).toBe(1);
    expect(res.structuredContent.threads).toHaveLength(1);
  });

  it("robynn_conversations create returns new thread", async () => {
    setup();
    const res = await handlers.get("robynn_conversations")!({
      action: "create",
      title: "New convo",
    });
    expect(res.structuredContent.thread.id).toBe("thread-1");
  });

  it("robynn_geo_analysis returns summary as text and full data as structured", async () => {
    setup();
    const res = await handlers.get("robynn_geo_analysis")!({
      company_name: "Acme",
    });
    expect(res.content[0].text).toBe("GEO analysis complete");
    expect(res.structuredContent.visibility_scores).toHaveLength(1);
    expect(res.isError).toBeUndefined();
  });

  it("robynn_competitive_battlecard returns summary text", async () => {
    setup();
    const res = await handlers.get("robynn_competitive_battlecard")!({
      competitor_name: "Salesforce",
    });
    expect(res.content[0].text).toBe("Battlecard ready");
    expect(res.structuredContent.differentiators).toContain("Fast onboarding");
  });

  it("robynn_seo_opportunities returns summary text", async () => {
    setup();
    const res = await handlers.get("robynn_seo_opportunities")!({
      company_name: "Acme",
    });
    expect(res.content[0].text).toBe("SEO analysis complete");
    expect(res.structuredContent.opportunities[0].keyword).toBe("crm tool");
  });

  it("robynn_brand_book_status returns summary text", async () => {
    setup();
    const res = await handlers.get("robynn_brand_book_status")!({});
    expect(res.content[0].text).toBe("Brand book 55% complete");
    expect(res.structuredContent.completeness_score).toBe(55);
  });

  it("robynn_brand_book_gap_analysis returns structured data", async () => {
    setup();
    const res = await handlers.get("robynn_brand_book_gap_analysis")!({});
    expect(res.content[0].text).toBe("3 high-priority gaps");
    expect(res.isError).toBeUndefined();
  });

  it("robynn_brand_book_strategy returns structured data", async () => {
    setup();
    const res = await handlers.get("robynn_brand_book_strategy")!({});
    expect(res.content[0].text).toBe("Strategy ready");
    expect(res.isError).toBeUndefined();
  });

  it("robynn_brand_reflections returns pending reflections", async () => {
    setup();
    const res = await handlers.get("robynn_brand_reflections")!({});
    expect(res.content[0].text).toBe("2 pending reflections");
    expect(res.structuredContent.pending_reflections).toHaveLength(1);
  });

  it("robynn_publish_brand_book_html returns export data", async () => {
    setup();
    const res = await handlers.get("robynn_publish_brand_book_html")!({});
    expect(res.content[0].text).toBe("Exported");
    expect(res.structuredContent.company_name).toBe("Acme");
  });

  it("robynn_website_audit returns summary text", async () => {
    setup();
    const res = await handlers.get("robynn_website_audit")!({
      website_url: "https://acme.test",
    });
    expect(res.content[0].text).toBe("Website audit complete");
    expect(res.structuredContent.website_url).toBe("https://acme.test");
  });

  it("robynn_website_strategy returns summary text", async () => {
    setup();
    const res = await handlers.get("robynn_website_strategy")!({
      website_url: "https://acme.test",
    });
    expect(res.content[0].text).toBe("Strategy complete");
    expect(res.structuredContent.website_url).toBe("https://acme.test");
  });
});

describe("all tools error path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("every tool returns isError on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = createFullMockClient();

    // Override all methods to fail
    for (const key of Object.keys(client)) {
      (client as Record<string, unknown>)[key] = vi
        .fn()
        .mockResolvedValue({ success: false, error: "upstream failed" });
    }

    registerAllTools(server, client);

    // robynn_status returns { connected: false } on failure, not isError
    const statusOnlyTools = new Set(["robynn_status"]);

    for (const [name, handler] of handlers) {
      const args = getMinimalArgs(name);
      const res = await handler(args);
      if (statusOnlyTools.has(name)) {
        expect(res.structuredContent.connected, `${name} should show connected=false`).toBe(false);
      } else {
        expect(res.isError, `${name} should have isError=true`).toBe(true);
      }
      expect(res.content[0].text).toBeTruthy();
    }
  });

  it("every tool returns isError on thrown exception", async () => {
    const { server, handlers } = createServerHarness();
    const client = createFullMockClient();

    for (const key of Object.keys(client)) {
      (client as Record<string, unknown>)[key] = vi
        .fn()
        .mockRejectedValue(new Error("network timeout"));
    }

    registerAllTools(server, client);

    for (const [name, handler] of handlers) {
      const args = getMinimalArgs(name);
      const res = await handler(args);
      expect(res.isError, `${name} should have isError=true on throw`).toBe(true);
      expect(res.content[0].text).toContain("network timeout");
    }
  });
});

describe("RobynnClient retry logic", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries once on 500 and succeeds", async () => {
    const { RobynnClient } = await import("../robynn-client");
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, data: { ok: true } }));
    });

    const client = new RobynnClient("https://robynn.test", "tok");
    const result = await client.getStatus();
    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
  });

  it("does not retry on 401", async () => {
    const { RobynnClient } = await import("../robynn-client");
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const client = new RobynnClient("https://robynn.test", "tok");
    await expect(client.getStatus()).rejects.toThrow("API error 401");
    expect(callCount).toBe(1);
  });

  it("retries once on network error and gives up", async () => {
    const { RobynnClient } = await import("../robynn-client");
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      throw new TypeError("fetch failed");
    });

    const client = new RobynnClient("https://robynn.test", "tok");
    await expect(client.getStatus()).rejects.toThrow("fetch failed");
    expect(callCount).toBe(2);
  });
});

function getMinimalArgs(toolName: string): Record<string, unknown> {
  const argsMap: Record<string, Record<string, unknown>> = {
    robynn_brand_context: { scope: "summary" },
    robynn_status: {},
    robynn_usage: {},
    robynn_create_content: { type: "blog_post", topic: "test" },
    robynn_research: { query: "test" },
    robynn_assist: { message: "test" },
    robynn_conversations: { action: "list" },
    robynn_run_status: { run_id: "run-1" },
    robynn_geo_analysis: { company_name: "Acme" },
    robynn_competitive_battlecard: { competitor_name: "Rival" },
    robynn_seo_opportunities: { company_name: "Acme" },
    robynn_brand_book_status: {},
    robynn_brand_book_gap_analysis: {},
    robynn_brand_book_strategy: {},
    robynn_brand_reflections: {},
    robynn_publish_brand_book_html: {},
    robynn_website_audit: {},
    robynn_website_strategy: {},
  };
  return argsMap[toolName] ?? {};
}
