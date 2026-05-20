import { describe, expect, it, vi } from "vitest";

import { registerContentPlanTools } from "./content-plan";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function createHarness(client: { contentPlan: ReturnType<typeof vi.fn> }) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    }),
  } as never;

  registerContentPlanTools(server, client as never);
  return { handlers };
}

describe("robynn_content_plan", () => {
  it("returns a successful structured Content Planner V2 result", async () => {
    const client = {
      contentPlan: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Content plan ready",
          status: "success",
          project_id: "project-1",
          planner_version: "v2",
          content_plan_rows: [
            {
              title: "Refresh homepage proof",
              target_slug: "/",
              premise: "GEO prompts show proof gaps.",
              source_references: ["geo:prompt-1"],
              proof_assets_needed: ["customer quote"],
              target_geo_prompts: ["best AI marketing platform"],
              distribution_derivatives: ["LinkedIn post"],
              existing_content_decision: "refresh_existing_page",
            },
          ],
        },
      }),
    };
    const { handlers } = createHarness(client);

    const result = await handlers.get("robynn_content_plan")!({
      project_id: "project-1",
      max_rows: 10,
    }) as {
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Content plan ready");
    expect(result.structuredContent.planner_version).toBe("v2");
    expect(client.contentPlan).toHaveBeenCalledWith({
      project_id: "project-1",
      max_rows: 10,
    });
  });

  it("returns missing_context as successful guidance, not a tool error", async () => {
    const client = {
      contentPlan: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Missing research context",
          status: "missing_context",
          planner_version: "v2",
          content_plan_rows: [],
          missing: ["project_id_or_research_packet"],
          next_step: "Pass a Content Studio project_id.",
        },
      }),
    };
    const { handlers } = createHarness(client);

    const result = await handlers.get("robynn_content_plan")!({
      brand_or_topic: "Acme",
    }) as {
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("missing_context");
    expect(result.content[0].text).toContain("Missing research context");
    expect(result.content[0].text).toContain("Pass a Content Studio project_id.");
  });

  it("returns failed planner output as a tool error", async () => {
    const client = {
      contentPlan: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Planner failed validation",
          status: "failed",
          content_plan_rows: [],
        },
      }),
    };
    const { handlers } = createHarness(client);

    const result = await handlers.get("robynn_content_plan")!({
      project_id: "project-1",
    }) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Planner failed validation");
  });
});
