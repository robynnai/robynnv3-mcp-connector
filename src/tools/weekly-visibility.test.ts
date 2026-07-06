import { describe, expect, it, vi } from "vitest";

import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { registerWeeklyVisibilityTools } from "./weekly-visibility";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function createHarness(client: { weeklyVisibilityReport: ReturnType<typeof vi.fn> }) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: Handler,
      ) => {
        configs.set(name, config);
        handlers.set(name, handler);
      },
    ),
  } as never;

  registerWeeklyVisibilityTools(server, client as never);
  return { handlers, configs };
}

function reportFixture(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Weekly visibility improved.",
    status: "success",
    generated_at: "2026-07-04T00:00:00.000Z",
    website: {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Primary website",
      base_url: "https://acme.test",
      hostname: "acme.test",
    },
    range: {
      current_start: "2026-06-28",
      current_end: "2026-07-04",
      prior_start: "2026-06-21",
      prior_end: "2026-06-27",
    },
    source_freshness: {},
    missing_sources: [],
    source_warnings: [],
    seo_kpis: {
      organic_clicks: 42,
      organic_impressions: 1000,
      ctr: 0.042,
      average_position: 8.5,
      estimated_traffic: 42,
      organic_keywords_count: 12,
    },
    keyword_table: [],
    page_table: [],
    non_ranking_pages: [],
    striking_distance_keywords: [],
    geo_kpis: {
      citation_visibility: 25,
      ai_overview_share: 10,
      prompts_checked: 5,
      brand_mentions: 2,
      competitor_mentions: 1,
      model_scores: [],
    },
    geo_prompt_table: [],
    recommendations: [
      {
        type: "improve_title_meta",
        title: "Improve title and meta for med spa los angeles",
        priority: "high",
        rationale: "High impressions and low CTR.",
      },
    ],
    next_steps: [],
    ...overrides,
  };
}

describe("robynn_weekly_visibility_report", () => {
  it("returns a successful structured weekly visibility report", async () => {
    const client = {
      weeklyVisibilityReport: vi.fn().mockResolvedValue({
        success: true,
        data: reportFixture(),
      }),
    };
    const { handlers, configs } = createHarness(client);

    const result = (await handlers.get("robynn_weekly_visibility_report")!({
      website_id: "11111111-1111-4111-8111-111111111111",
      week_start: "2026-06-28",
    })) as {
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Weekly visibility improved.");
    expect(result.structuredContent.recommended_actions).toEqual(
      result.structuredContent.recommendations,
    );
    expect(client.weeklyVisibilityReport).toHaveBeenCalledWith({
      website_id: "11111111-1111-4111-8111-111111111111",
      week_start: "2026-06-28",
    });
    expect(
      configs.get("robynn_weekly_visibility_report")?._meta,
    ).toMatchObject({
      ui: {
        resourceUri: REPORT_RESOURCE_URIS.weeklyVisibility,
      },
    });
  });

  it("returns missing_data as actionable guidance", async () => {
    const client = {
      weeklyVisibilityReport: vi.fn().mockResolvedValue({
        success: true,
        data: reportFixture({
          summary:
            "Weekly visibility report needs GA4 data before it can summarize page-level SEO performance.",
          status: "missing_data",
          missing_sources: ["ga4"],
          source_warnings: ["gsc"],
          next_steps: [
            "Check Google Search Console in Integrations or refresh Brand Monitor.",
          ],
        }),
      }),
    };
    const { handlers } = createHarness(client);

    const result = (await handlers.get("robynn_weekly_visibility_report")!({
      website_id: "11111111-1111-4111-8111-111111111111",
    })) as {
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("missing_data");
    expect(result.content[0].text).toContain("Missing sources: ga4");
    expect(result.content[0].text).toContain("Source warnings: gsc");
  });

  it("reports missing GSC as a non-blocking source warning", async () => {
    const client = {
      weeklyVisibilityReport: vi.fn().mockResolvedValue({
        success: true,
        data: reportFixture({
          summary:
            "Google Search Console keyword evidence is unavailable for this report.",
          status: "partial",
          missing_sources: [],
          source_warnings: ["gsc"],
          keyword_table: [],
          striking_distance_keywords: [],
          next_steps: [
            "Check Google Search Console in Integrations or refresh Brand Monitor to add query clicks, impressions, CTR, and ranking movement.",
          ],
        }),
      }),
    };
    const { handlers } = createHarness(client);

    const result = (await handlers.get("robynn_weekly_visibility_report")!({
      website_id: "11111111-1111-4111-8111-111111111111",
    })) as {
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("partial");
    expect(result.structuredContent.source_warnings).toEqual(["gsc"]);
    expect(result.content[0].text).toContain("Source warnings: gsc");
    expect(result.content[0].text).toContain(
      "Next steps: Check Google Search Console",
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const client = {
      weeklyVisibilityReport: vi.fn().mockResolvedValue({
        success: false,
        error: "Weekly visibility report failed",
      }),
    };
    const { handlers } = createHarness(client);

    const result = (await handlers.get("robynn_weekly_visibility_report")!({
      website_id: "11111111-1111-4111-8111-111111111111",
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Weekly visibility report failed");
  });
});
