import { describe, expect, it, vi } from "vitest";

import { registerBrandBookTools } from "./brand-book";
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

describe("registerBrandBookTools", () => {
  it("returns structured brand-book status results on success", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      brandBookStatus: vi.fn().mockResolvedValue({
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
          readiness_summary: "Partial",
        },
      }),
      brandBookGapAnalysis: vi.fn(),
      brandBookStrategy: vi.fn(),
      brandReflections: vi.fn(),
      publishBrandBookHtml: vi.fn(),
    };

    registerBrandBookTools(server as never, client as never);

    const response = await handlers.get("robynn_brand_book_status")?.({
      include_recent_reflections: true,
    });

    expect(client.brandBookStatus).toHaveBeenCalled();
    expect(response?.structuredContent.completeness_score).toBe(55);
    expect(configs.get("robynn_brand_book_status")?._meta?.ui?.resourceUri).toBe(
      REPORT_RESOURCE_URIS.brandBookStatus
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      brandBookStatus: vi.fn().mockResolvedValue({
        success: false,
        error: "brand book failed",
      }),
      brandBookGapAnalysis: vi.fn(),
      brandBookStrategy: vi.fn(),
      brandReflections: vi.fn(),
      publishBrandBookHtml: vi.fn(),
    };

    registerBrandBookTools(server as never, client as never);

    const response = await handlers.get("robynn_brand_book_status")?.({});

    expect(response?.isError).toBe(true);
  });
});
