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
          prospect_audit_id: "33333333-3333-4333-8333-333333333333",
          website_url: "https://acme.test",
          audit_url:
            "https://robynn.ai/audit/acme/acm-abcdefg",
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
      company_name: "Acme",
    });

    expect(client.websiteAudit).toHaveBeenCalledWith({
      website_url: "https://acme.test",
      company_name: "Acme",
      booking_url: undefined,
      goals: undefined,
      competitors: undefined,
      analysis_depth: undefined,
    });
    expect(response?.structuredContent.website_url).toBe("https://acme.test");
    expect(response?.content[0].text).toContain(
      "Audit page: https://robynn.ai/audit/acme/acm-abcdefg"
    );
    expect(configs.get("robynn_website_audit")?._meta?.ui?.resourceUri).toBe(
      REPORT_RESOURCE_URIS.websiteAudit
    );
  });

  it("polls structured website audit status", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      websiteAudit: vi.fn(),
      websiteAuditStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          summary: "audit ready",
          status: "success",
          artifacts: {},
          recommended_actions: [],
          next_steps: [],
          prospect_audit_id: "33333333-3333-4333-8333-333333333333",
          website_url: "https://acme.test",
          audit_url: "https://robynn.ai/audit/acme/acm-abcdefg",
          html_url: "https://robynn.ai/audit/acme/acm-abcdefg/download?format=html",
          markdown_url: "https://robynn.ai/audit/acme/acm-abcdefg/download?format=md",
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

    const response = await handlers.get("robynn_website_audit_status")?.({
      prospect_audit_id: "33333333-3333-4333-8333-333333333333",
    });

    expect(client.websiteAuditStatus).toHaveBeenCalledWith({
      prospect_audit_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(response?.structuredContent.prospect_audit_id).toBe(
      "33333333-3333-4333-8333-333333333333"
    );
    expect(response?.content[0].text).toContain(
      "Audit page: https://robynn.ai/audit/acme/acm-abcdefg"
    );
    expect(response?.content[0].text).toContain(
      "HTML: https://robynn.ai/audit/acme/acm-abcdefg/download?format=html"
    );
  });

  it("returns an MCP error result on upstream failure", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      websiteAudit: vi.fn().mockResolvedValue({
        success: false,
        error: "website failed",
      }),
      websiteAuditStatus: vi.fn(),
      websiteStrategy: vi.fn(),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers.get("robynn_website_audit")?.({});

    expect(response?.isError).toBe(true);
  });
});
