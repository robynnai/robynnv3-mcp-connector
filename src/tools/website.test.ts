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

  it("registers and calls website audit v2", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      websiteAudit: vi.fn(),
      websiteAuditStatus: vi.fn(),
      websiteStrategy: vi.fn(),
      websiteAuditV2: vi.fn().mockResolvedValue({
        success: true,
        data: {
          version: "v2",
          status: "pending",
          scan_id: "11111111-1111-4111-8111-111111111111",
          summary: "Started Website Auto-Healer v2 audit.",
          goal_contract: { label: "Improve pricing demo clicks" },
          healing_plan: { groups: { draft_fix: [] } },
          recommendations: [],
          next_steps: ["Poll robynn_website_audit_v2_status."],
        },
      }),
      websiteAuditV2Status: vi.fn(),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers.get("robynn_website_audit_v2")?.({
      website_url: "https://example.com",
      goal: {
        label: "Improve pricing demo clicks",
        type: "conversion_event",
        target: "Reach 4%",
        page_url: "https://example.com/pricing",
      },
    });

    expect(client.websiteAuditV2).toHaveBeenCalledWith({
      website_url: "https://example.com",
      site_id: undefined,
      goal_id: undefined,
      goal: {
        label: "Improve pricing demo clicks",
        type: "conversion_event",
        target: "Reach 4%",
        page_url: "https://example.com/pricing",
      },
      manual_pages: undefined,
      mode: undefined,
    });
    expect(response?.structuredContent.version).toBe("v2");
    expect(response?.content[0].text).toContain(
      "Started Website Auto-Healer v2 audit."
    );
    expect(
      configs.get("robynn_website_audit_v2")?.annotations?.readOnlyHint
    ).toBe(true);
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

  it("registers and calls website audit orchestrator", async () => {
    const { server, handlers, configs } = createServerHarness();
    const client = {
      websiteAuditOrchestrator: vi.fn().mockResolvedValue({
        success: true,
        data: {
          run_id: "11111111-1111-4111-8111-111111111111",
          scan_id: "11111111-1111-4111-8111-111111111111",
          status: "pending",
          version: "orchestrator_v1",
          audit_depth: "top_level",
          report_mode: "full",
          summary: "Started website audit orchestrator.",
          next_steps: ["Poll status."],
        },
      }),
      websiteAuditOrchestratorStatus: vi.fn(),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers.get("robynn_website_audit_orchestrator")?.({
      website_url: "https://example.com",
      audit_depth: "top_level",
      max_pages: 25,
    });

    expect(client.websiteAuditOrchestrator).toHaveBeenCalledWith({
      website_url: "https://example.com",
      audit_depth: "top_level",
      max_pages: 25,
    });
    expect(response?.structuredContent.version).toBe("orchestrator_v1");
    expect(response?.content[0].text).toContain(
      "Started website audit orchestrator."
    );
    expect(
      configs.get("robynn_website_audit_orchestrator")?.annotations
        ?.readOnlyHint
    ).toBe(true);
  });

  it("polls website audit orchestrator status with pagination", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      websiteAuditOrchestrator: vi.fn(),
      websiteAuditOrchestratorStatus: vi.fn().mockResolvedValue({
        success: true,
        data: {
          run_id: "11111111-1111-4111-8111-111111111111",
          scan_id: "11111111-1111-4111-8111-111111111111",
          status: "completed",
          version: "orchestrator_v1",
          audit_depth: "top_level",
          report_mode: "full",
          summary: "Website audit completed.",
          page_reports: [],
          accepted_recommendations: [],
          pagination: {
            page_reports: {
              limit: 2,
              returned: 2,
              total: 3,
              next_cursor: "2",
              has_more: true,
            },
          },
        },
      }),
    };

    registerWebsiteTools(server as never, client as never);

    const response = await handlers
      .get("robynn_website_audit_orchestrator_status")
      ?.({
        run_id: "11111111-1111-4111-8111-111111111111",
        page_limit: 2,
        page_cursor: "2",
        include_sections: ["page_reports"],
      });

    expect(client.websiteAuditOrchestratorStatus).toHaveBeenCalledWith({
      run_id: "11111111-1111-4111-8111-111111111111",
      page_limit: 2,
      page_cursor: "2",
      include_sections: ["page_reports"],
    });
    expect(response?.structuredContent.pagination).toBeDefined();
    expect(response?.content[0].text).toContain(
      "Large arrays may be paginated"
    );
  });
});
