import { describe, expect, it, vi } from "vitest";

import { registerGeoTools } from "./geo";
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

describe("registerGeoTools", () => {
  it("returns structured GEO results on success", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      geoAnalysis: vi.fn().mockResolvedValue({
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
    };

    registerGeoTools(server as never, client as never);

    const response = await handlers.get("robynn_geo_analysis")?.({
      company_name: "Acme",
      questions: ["How visible are we?"],
    });

    expect(client.geoAnalysis).toHaveBeenCalled();
    expect(response?.structuredContent.summary).toBe("done");
    expect(configs.get("robynn_geo_analysis")?._meta?.ui?.resourceUri).toBe(
      REPORT_RESOURCE_URIS.geo
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      geoAnalysis: vi.fn().mockResolvedValue({
        success: false,
        error: "geo failed",
      }),
    };

    registerGeoTools(server as never, client as never);

    const response = await handlers.get("robynn_geo_analysis")?.({
      company_name: "Acme",
      questions: ["How visible are we?"],
    });

    expect(response?.isError).toBe(true);
  });
});
