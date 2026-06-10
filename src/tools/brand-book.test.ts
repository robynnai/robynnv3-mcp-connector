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
      triggerBrandReflections: vi.fn(),
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
      triggerBrandReflections: vi.fn(),
      publishBrandBookHtml: vi.fn(),
    };

    registerBrandBookTools(server as never, client as never);

    const response = await handlers.get("robynn_brand_book_status")?.({});

    expect(response?.isError).toBe(true);
  });

  it("returns the bulleted summary for robynn_trigger_brand_reflections", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      brandBookStatus: vi.fn(),
      brandBookGapAnalysis: vi.fn(),
      brandBookStrategy: vi.fn(),
      brandReflections: vi.fn(),
      triggerBrandReflections: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "1 reflection surfaced",
          status: "success",
          artifacts: { lookback_hours: 24, limit: 10, dry_run: false },
          recommended_actions: [],
          next_steps: [],
          patterns_detected: 3,
          patterns_queued: 1,
          changes_analyzed: 5,
          reflections: [],
          newly_accepted_rules: [],
          bulleted_summary: "- New reflection: voice drift detected",
        },
      }),
      publishBrandBookHtml: vi.fn(),
    };

    registerBrandBookTools(server as never, client as never);

    const response = await handlers
      .get("robynn_trigger_brand_reflections")
      ?.({ lookback_hours: 24, limit: 10, dry_run: false });

    expect(client.triggerBrandReflections).toHaveBeenCalledWith({
      lookback_hours: 24,
      limit: 10,
      dry_run: false,
    });
    expect(response?.content[0].text).toBe(
      "- New reflection: voice drift detected",
    );
    expect(response?.structuredContent.patterns_detected).toBe(3);
    expect(
      configs.get("robynn_trigger_brand_reflections")?.annotations?.readOnlyHint,
    ).toBe(false);
  });

  it("surfaces cooldown errors from robynn_trigger_brand_reflections", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      brandBookStatus: vi.fn(),
      brandBookGapAnalysis: vi.fn(),
      brandBookStrategy: vi.fn(),
      brandReflections: vi.fn(),
      triggerBrandReflections: vi.fn().mockResolvedValue({
        success: false,
        error: "Rate limited. Please wait before triggering reflections again",
      }),
      publishBrandBookHtml: vi.fn(),
    };

    registerBrandBookTools(server as never, client as never);

    const response = await handlers
      .get("robynn_trigger_brand_reflections")
      ?.({});

    expect(response?.isError).toBe(true);
    expect(response?.content[0].text).toContain("Rate limited");
  });
});
