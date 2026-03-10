import { describe, expect, it, vi } from "vitest";

import { registerWebsiteTools } from "./website";
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

describe("registerWebsiteTools", () => {
  it("returns structured website audit results on success", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      websiteAudit: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "audit",
          status: "success",
          artifacts: {},
          recommended_actions: [],
          next_steps: [],
          website_url: "https://acme.test",
          messaging_findings: [],
          seo_findings: [],
          geo_findings: [],
          conversion_findings: [],
          competitor_findings: [],
        },
      }),
      websiteStrategy: vi.fn(),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers.get("robynn_website_audit")?.({
      website_url: "https://acme.test",
    });

    expect(client.websiteAudit).toHaveBeenCalled();
    expect(response?.structuredContent.website_url).toBe("https://acme.test");
    expect(configs.get("robynn_website_audit")?._meta?.ui?.resourceUri).toBe(
      REPORT_RESOURCE_URIS.websiteAudit
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      websiteAudit: vi.fn().mockResolvedValue({
        success: false,
        error: "website failed",
      }),
      websiteStrategy: vi.fn(),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers.get("robynn_website_audit")?.({});

    expect(response?.isError).toBe(true);
  });
});
