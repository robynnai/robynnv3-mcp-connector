import { describe, expect, it, vi } from "vitest";

import { registerSeoTools } from "./seo";

function createServerHarness() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: (args: any) => Promise<any>
      ) => {
        handlers.set(name, handler);
      }
    ),
  };

  return { server, handlers };
}

describe("registerSeoTools", () => {
  it("returns structured SEO opportunity results on success", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      seoOpportunities: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "seo",
          status: "success",
          artifacts: {},
          recommended_actions: [],
          opportunities: [{ keyword: "crm migration software" }],
          keyword_gaps: [],
          competitor_comparison: [],
        },
      }),
    };

    registerSeoTools(server as never, client as never);

    const response = await handlers.get("robynn_seo_opportunities")?.({
      company_name: "Acme",
    });

    expect(client.seoOpportunities).toHaveBeenCalled();
    expect(response?.structuredContent.opportunities[0].keyword).toBe(
      "crm migration software"
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      seoOpportunities: vi.fn().mockResolvedValue({
        success: false,
        error: "seo failed",
      }),
    };

    registerSeoTools(server as never, client as never);

    const response = await handlers.get("robynn_seo_opportunities")?.({
      company_name: "Acme",
    });

    expect(response?.isError).toBe(true);
  });
});
