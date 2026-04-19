import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCampaignTools } from "./campaign";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const registerTool = vi.fn((name: string, _config: unknown, handler: Handler) => {
    handlers.set(name, handler);
  });
  const server = { registerTool } as never;
  return { server, handlers };
}

describe("robynn_campaign_creator", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns completed markdown with artifact and langgraph ids", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignCreator: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Generated a campaign for Acme.",
          status: "success",
          markdown: "# Acme Marketing Campaign Strategy",
          thread_id: "rory-thread-1",
          artifact_id: "artifact-1",
          langgraph_thread_id: "lg-thread-1",
          langgraph_run_id: "lg-run-1",
          assistant_id: "marketing_campaign_builder",
          artifacts: {
            campaign_artifact_id: "artifact-1",
          },
          recommended_actions: [],
          next_steps: ["Open the saved Rory artifact to refine the campaign."],
        },
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_creator")!({
      company_name: "Acme",
      company_url: "https://acme.test",
      industry: "B2B SaaS",
      target_audience: "VP Marketing",
      goals: "Generate demo requests",
      budget_range: "$10k/month",
      geography: "United States",
      additional_context: "Focus on SEO and Google Ads",
    });

    expect(client.campaignCreator).toHaveBeenCalledWith(
      expect.objectContaining({
        company_name: "Acme",
        company_url: "https://acme.test",
        industry: "B2B SaaS",
        target_audience: "VP Marketing",
        goals: "Generate demo requests",
        budget_range: "$10k/month",
        geography: "United States",
        additional_context: "Focus on SEO and Google Ads",
      }),
    );
    expect(res.content[0].text).toContain("# Acme Marketing Campaign Strategy");
    expect(res.structuredContent.artifact_id).toBe("artifact-1");
    expect(res.structuredContent.thread_id).toBe("rory-thread-1");
    expect(res.structuredContent.langgraph_thread_id).toBe("lg-thread-1");
    expect(res.structuredContent.langgraph_run_id).toBe("lg-run-1");
    expect(res.structuredContent.status).toBe("success");
    expect(res.isError).toBeUndefined();
  });

  it("returns a pending response cleanly", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignCreator: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Campaign generation is still running.",
          status: "pending",
          langgraph_thread_id: "lg-thread-1",
          langgraph_run_id: "lg-run-1",
          poll_after_seconds: 5,
          assistant_id: "marketing_campaign_builder",
          artifacts: {},
          recommended_actions: [],
          next_steps: ["Call robynn_campaign_status with langgraph_thread_id and langgraph_run_id."],
        },
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_creator")!({
      company_name: "Acme",
    });

    expect(res.content[0].text).toContain("still running");
    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.langgraph_thread_id).toBe("lg-thread-1");
    expect(res.structuredContent.langgraph_run_id).toBe("lg-run-1");
    expect(res.isError).toBeUndefined();
  });

  it("returns an error result when the API fails", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignCreator: vi.fn().mockResolvedValue({
        success: false,
        error: "boom",
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_creator")!({
      company_name: "Acme",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });
});

describe("robynn_campaign_status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the same completed markdown shape from status lookups", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Generated a campaign for Acme.",
          status: "success",
          markdown: "# Acme Marketing Campaign Strategy",
          thread_id: "rory-thread-1",
          artifact_id: "artifact-1",
          langgraph_thread_id: "lg-thread-1",
          langgraph_run_id: "lg-run-1",
          assistant_id: "marketing_campaign_builder",
          artifacts: {
            campaign_artifact_id: "artifact-1",
          },
          recommended_actions: [],
          next_steps: [],
        },
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_status")!({
      langgraph_thread_id: "lg-thread-1",
      langgraph_run_id: "lg-run-1",
      company_name: "Acme",
      company_url: "https://acme.test",
    });

    expect(client.campaignStatus).toHaveBeenCalledWith({
      langgraph_thread_id: "lg-thread-1",
      langgraph_run_id: "lg-run-1",
      company_name: "Acme",
      company_url: "https://acme.test",
    });
    expect(res.content[0].text).toContain("# Acme Marketing Campaign Strategy");
    expect(res.structuredContent.artifact_id).toBe("artifact-1");
    expect(res.structuredContent.status).toBe("success");
    expect(res.isError).toBeUndefined();
  });

  it("returns a pending status response cleanly", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "Campaign generation is still running.",
          status: "pending",
          langgraph_thread_id: "lg-thread-1",
          langgraph_run_id: "lg-run-1",
          poll_after_seconds: 5,
          assistant_id: "marketing_campaign_builder",
          artifacts: {},
          recommended_actions: [],
          next_steps: ["Keep waiting."],
        },
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_status")!({
      langgraph_thread_id: "lg-thread-1",
      langgraph_run_id: "lg-run-1",
    });

    expect(res.content[0].text).toContain("still running");
    expect(res.structuredContent.status).toBe("pending");
    expect(res.structuredContent.langgraph_thread_id).toBe("lg-thread-1");
    expect(res.structuredContent.langgraph_run_id).toBe("lg-run-1");
    expect(res.isError).toBeUndefined();
  });

  it("returns an error result when status lookup fails", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      campaignStatus: vi.fn().mockResolvedValue({
        success: false,
        error: "boom",
      }),
    };

    registerCampaignTools(server, client as never);

    const res = await handlers.get("robynn_campaign_status")!({
      langgraph_thread_id: "lg-thread-1",
      langgraph_run_id: "lg-run-1",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });
});
