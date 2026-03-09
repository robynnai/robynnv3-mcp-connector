import { describe, expect, it, vi } from "vitest";

import { registerBattlecardTools } from "./battlecard";
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

describe("registerBattlecardTools", () => {
  it("returns structured battlecard results on success", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      competitiveBattlecard: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "battlecard",
          status: "success",
          artifacts: {},
          recommended_actions: [],
          comparison: [],
          objections: [],
          differentiators: ["Fast onboarding"],
          risks: [],
        },
      }),
    };

    registerBattlecardTools(server as never, client as never);

    const response = await handlers.get("robynn_competitive_battlecard")?.({
      competitor_name: "Salesforce",
    });

    expect(client.competitiveBattlecard).toHaveBeenCalled();
    expect(response?.structuredContent.differentiators).toContain("Fast onboarding");
    expect(
      configs.get("robynn_competitive_battlecard")?._meta?.ui?.resourceUri
    ).toBe(REPORT_RESOURCE_URIS.battlecard);
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      competitiveBattlecard: vi.fn().mockResolvedValue({
        success: false,
        error: "battlecard failed",
      }),
    };

    registerBattlecardTools(server as never, client as never);

    const response = await handlers.get("robynn_competitive_battlecard")?.({
      competitor_name: "Salesforce",
    });

    expect(response?.isError).toBe(true);
  });
});
