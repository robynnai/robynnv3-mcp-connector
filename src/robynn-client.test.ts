import { afterEach, describe, expect, it, vi } from "vitest";

import { RobynnClient } from "./robynn-client";

describe("RobynnClient intelligence routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts GEO analysis requests to the MCP-safe API route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "done",
            status: "success",
            artifacts: {},
            recommended_actions: [],
            next_steps: [],
            visibility_scores: [],
            citation_breakdown: {
              target_company: 1,
              competitor: 2,
              other: 3,
            },
            query_gaps: [],
          },
        }),
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.geoAnalysis({
      company_name: "Acme",
      questions: ["How visible are we?"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/geo-analysis",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
    expect(result.success).toBe(true);
  });

  it("posts competitive battlecard requests to the MCP-safe API route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "battlecard",
            status: "success",
            artifacts: {},
            recommended_actions: [],
            next_steps: [],
            comparison: [],
            objections: [],
            differentiators: [],
            risks: [],
          },
        })
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.competitiveBattlecard({
      competitor_name: "Salesforce",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/competitive-battlecard",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.success).toBe(true);
  });

  it("posts SEO opportunity requests to the MCP-safe API route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "seo",
            status: "success",
            artifacts: {},
            recommended_actions: [],
            next_steps: [],
            opportunities: [],
            keyword_gaps: [],
            competitor_comparison: [],
          },
        })
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.seoOpportunities({
      company_name: "Acme",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/seo-opportunities",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.success).toBe(true);
  });

  it("forwards catch-all CMO run payload fields to the thread run endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { run_id: "run-123" } }))
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const payload = {
      message: "Draft a launch plan",
      assistant_id: "cmo_v3" as const,
      route_hint: "deep" as const,
      requested_capability: "article" as const,
      claude_skill_slug: "launch-plan",
      history_summary: "Previous thread summary",
      memory_enabled: true,
    };

    const result = await client.startRun("thread-123", payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/agents/cmo/threads/thread-123/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
    expect(result.success).toBe(true);
  });

  it("calls the brand-book status MCP-safe route with query params", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "status",
            status: "partial",
            artifacts: {},
            recommended_actions: [],
            next_steps: [],
            completeness_score: 55,
            sections: [],
            missing_items: [],
            readiness_summary: "partial",
          },
        })
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.brandBookStatus({
      include_recent_reflections: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/brand-book/status?include_recent_reflections=true",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
    expect(result.success).toBe(true);
  });

  it("calls the brand reflections MCP-safe route with query params", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "reflections",
            status: "success",
            artifacts: {},
            recommended_actions: [],
            next_steps: [],
            pending_reflections: [],
            recent_reflections: [],
          },
        })
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.brandReflections({
      status_filter: "pending",
      limit: 5,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/brand-book/reflections?status_filter=pending&limit=5",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
    expect(result.success).toBe(true);
  });

  it("posts website strategy requests to the MCP-safe API route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            summary: "website strategy",
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
        })
      )
    );

    const client = new RobynnClient("https://robynn.test", "token-123");
    const result = await client.websiteStrategy({
      website_url: "https://acme.test",
      primary_goal: "Increase qualified demos",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/cli/mcp/website/strategy",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.success).toBe(true);
  });

  it("redeems an OpenClaw provision token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            install_id: "install-1",
            organization_id: "org-1",
            organization_name: "Acme",
            robynn_auth: {
              api_key: "rbo_test_key",
              base_url: "https://robynn.test",
            },
            profile: {
              slug: "robynn-cmo",
              version: "2026-04-14.1",
            },
            runtime_token: "rclaw_rt_123",
          },
        }),
      ),
    );

    const client = new RobynnClient("https://robynn.test", "");
    const result = await client.redeemOpenClawProvisionToken({
      token: "rclaw_pt_123",
      hostname: "srv1369857",
      machine_label: "telegram-prod-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/robynnclaw/provision/redeem",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          token: "rclaw_pt_123",
          hostname: "srv1369857",
          machine_label: "telegram-prod-1",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("posts install heartbeats with the runtime token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            install_id: "install-1",
            last_health_status: "healthy",
          },
        }),
      ),
    );

    const client = new RobynnClient("https://robynn.test", "");
    const result = await client.heartbeatOpenClawInstall(
      "install-1",
      {
        status: "healthy",
        gateway_running: true,
      },
      "rclaw_rt_123",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/robynnclaw/installs/install-1/heartbeat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer rclaw_rt_123",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("fetches the versioned install manifest with the runtime token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            install_id: "install-1",
            profile: {
              slug: "robynn-cmo",
              version: "2026-04-14.1",
            },
          },
        }),
      ),
    );

    const client = new RobynnClient("https://robynn.test", "");
    const result = await client.getOpenClawManifest(
      "install-1",
      "rclaw_rt_123",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://robynn.test/api/robynnclaw/installs/install-1/manifest",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer rclaw_rt_123",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });
});
