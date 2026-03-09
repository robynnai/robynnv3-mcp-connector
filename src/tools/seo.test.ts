import { describe, expect, it, vi } from "vitest";

import { registerSeoTools } from "./seo";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";

function createServerHarness() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const configs = new Map<string, Record<string, any>>();
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        config: Record<string, any>,
        handler: (args: any) => Promise<any>
      ) => {
        configs.set(name, config);
        handlers.set(name, handler);
      }
    ),
  };

  return { server, handlers, configs };
}

describe("registerSeoTools", () => {
  it("returns structured SEO opportunity results on success", async () => {
    const { server, handlers, configs } = createServerHarness();
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
    expect(configs.get("robynn_seo_opportunities")?._meta?.ui?.resourceUri).toBe(
      REPORT_RESOURCE_URIS.seo
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
