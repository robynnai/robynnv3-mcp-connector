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
});
