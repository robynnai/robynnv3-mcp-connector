import { describe, expect, it, vi } from "vitest";

import { registerBattlecardTools } from "./battlecard";

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

describe("registerBattlecardTools", () => {
  it("returns structured battlecard results on success", async () => {
    const { server, handlers } = createServerHarness();
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
