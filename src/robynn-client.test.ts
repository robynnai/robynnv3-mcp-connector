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
});
