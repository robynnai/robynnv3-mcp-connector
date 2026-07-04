import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RobynnClient } from "../robynn-client";
import { REPORT_RESOURCE_URIS } from "../ui/report-app";
import { toErrorResult, toSuccessResult } from "./util";

function appendReportLinks(
  summary: string | undefined,
  data: Record<string, unknown>,
) {
  const lines = [summary || (data.summary as string) || "Website audit completed."];
  if (typeof data.audit_url === "string" && data.audit_url.trim()) {
    lines.push(`Audit page: ${data.audit_url}`);
  }
  if (typeof data.report_url === "string" && data.report_url.trim()) {
    lines.push(`Report: ${data.report_url}`);
  }
  if (typeof data.pdf_url === "string" && data.pdf_url.trim()) {
    lines.push(`PDF: ${data.pdf_url}`);
  }
  if (typeof data.html_url === "string" && data.html_url.trim()) {
    lines.push(`HTML: ${data.html_url}`);
  }
  if (typeof data.markdown_url === "string" && data.markdown_url.trim()) {
    lines.push(`Markdown: ${data.markdown_url}`);
  }
  if (data.status === "pending" && typeof data.prospect_audit_id === "string") {
    lines.push(`Poll with robynn_website_audit_status using prospect_audit_id=${data.prospect_audit_id}`);
  }
  if (data.status === "pending" && typeof data.scan_id === "string") {
    lines.push(`Poll with robynn_website_audit_v2_status using scan_id=${data.scan_id}`);
  }
  return lines.join("\n");
}

const websiteAuditV2GoalSchema = z
  .object({
    label: z.string(),
    type: z.enum([
      "seo_score",
      "geo_visibility",
      "keyword_visibility",
      "conversion_event",
      "page_event",
    ]),
    target: z.string(),
    page_url: z.string().optional(),
  })
  .optional()
  .describe("Optional goal to bind the audit to");

const websiteAuditOrchestratorSectionSchema = z.enum([
  "website_report",
  "page_reports",
  "accepted_recommendations",
  "rejected_recommendations",
  "url_action_queue",
  "source_coverage",
  "worker_trace",
]);

function appendOrchestratorSummary(data: Record<string, unknown>) {
  const lines = [
    typeof data.summary === "string"
      ? data.summary
      : "Website audit orchestrator status returned.",
  ];
  if (typeof data.run_id === "string" && data.run_id.trim()) {
    lines.push(`Run ID: ${data.run_id}`);
  }
  if (data.status === "pending" || data.status === "needs_confirmation") {
    lines.push("Poll with robynn_website_audit_orchestrator_status using run_id.");
  }
  const pagination = data.pagination as Record<string, unknown> | undefined;
  if (pagination) {
    lines.push("Large arrays may be paginated; use returned cursors to fetch more.");
  }
  return lines.join("\n");
}

export function registerWebsiteTools(server: McpServer, client: RobynnClient) {
  registerAppTool(
    server,
    "robynn_website_audit",
    {
      description:
        "Create a Robynn prospect audit that renders on the public designed audit page.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Optional explicit website URL override"),
        company_name: z
          .string()
          .optional()
          .describe("Company name to audit; inferred from the domain if omitted"),
        booking_url: z
          .string()
          .optional()
          .describe("Optional booking URL shown on the public prospect audit page"),
        goals: z
          .array(z.string())
          .optional()
          .describe("Business goals to keep in view during the audit"),
        competitors: z
          .array(z.string())
          .optional()
          .describe("Competitors to emphasize during the website audit"),
        analysis_depth: z
          .enum(["standard", "deep"])
          .optional()
          .describe("Standard or deeper website audit mode"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ website_url, company_name, booking_url, goals, competitors, analysis_depth }) => {
      try {
        const result = await client.websiteAudit({
          website_url,
          company_name,
          booking_url,
          goals,
          competitors,
          analysis_depth,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website audit failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(
          data,
          appendReportLinks((data.summary as string) || undefined, data),
        );
      } catch (err) {
        return toErrorResult(
          `Error running website audit: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_audit_status",
    {
      description:
        "Poll a Robynn prospect audit created by robynn_website_audit and return its designed audit page plus artifacts when ready.",
      inputSchema: {
        prospect_audit_id: z
          .string()
          .describe("UUID returned by robynn_website_audit"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ prospect_audit_id }) => {
      try {
        const result = await client.websiteAuditStatus({
          prospect_audit_id,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website audit status failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(
          data,
          appendReportLinks((data.summary as string) || undefined, data),
        );
      } catch (err) {
        return toErrorResult(
          `Error polling website audit: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_audit_v2",
    {
      description:
        "Start a Website Auto-Healer v2 audit for an owned or external site.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Optional explicit website URL override"),
        site_id: z
          .string()
          .optional()
          .describe("Optional Robynn organization website ID"),
        goal_id: z
          .string()
          .optional()
          .describe("Optional existing website goal ID to bind the audit to"),
        goal: websiteAuditV2GoalSchema,
        manual_pages: z
          .array(z.string())
          .optional()
          .describe("Optional page URLs to include in the audit"),
        mode: z
          .enum(["owned", "external"])
          .optional()
          .describe("Audit mode for owned Robynn sites or external URLs"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ website_url, site_id, goal_id, goal, manual_pages, mode }) => {
      try {
        const result = await client.websiteAuditV2({
          website_url,
          site_id,
          goal_id,
          goal,
          manual_pages,
          mode,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website audit v2 failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(
          data,
          appendReportLinks((data.summary as string) || undefined, data),
        );
      } catch (err) {
        return toErrorResult(
          `Error running website audit v2: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_audit_v2_status",
    {
      description:
        "Poll a Website Auto-Healer v2 audit created by robynn_website_audit_v2.",
      inputSchema: {
        scan_id: z.string().describe("Scan ID returned by robynn_website_audit_v2"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ scan_id }) => {
      try {
        const result = await client.websiteAuditV2Status({ scan_id });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website audit v2 status failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(
          data,
          appendReportLinks((data.summary as string) || undefined, data),
        );
      } catch (err) {
        return toErrorResult(
          `Error polling website audit v2: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_audit_orchestrator",
    {
      description:
        "Start a read-only multi-agent website audit orchestrator run that returns full-site and page-level recommendations as structured JSON.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Website URL to audit; required when site_id is omitted"),
        site_id: z
          .string()
          .optional()
          .describe("Optional Robynn Website Studio site ID"),
        audit_depth: z
          .enum(["top_level", "top_plus_1", "full"])
          .describe("Required scan depth. full requires estimate confirmation."),
        report_mode: z
          .enum(["full", "prospecting_abridged"])
          .optional()
          .describe("Report shape; defaults to full"),
        audit_goal: z
          .enum([
            "increase_conversions",
            "improve_seo",
            "improve_geo",
            "find_broken_experience",
            "sales_brief",
          ])
          .optional()
          .describe("Primary audit goal"),
        manual_pages: z
          .array(z.string())
          .optional()
          .describe("Optional explicit pages or paths to include"),
        account_name: z.string().optional().describe("Optional account name"),
        industry: z.string().optional().describe("Optional industry context"),
        source_preferences: z
          .object({
            firecrawl: z.boolean().optional(),
            dataforseo: z.boolean().optional(),
            semrush: z.boolean().optional(),
            ga4: z.boolean().optional(),
            browserRuntime: z.boolean().optional(),
            model_synthesis: z.boolean().optional(),
            model_recommendations: z.boolean().optional(),
          })
          .optional()
          .describe("Optional source toggles"),
        estimate_only: z
          .boolean()
          .optional()
          .describe("Return estimate without starting the audit"),
        confirmed_estimate_id: z
          .string()
          .optional()
          .describe("Estimate ID required for full scans"),
        allow_over_100_pages: z
          .boolean()
          .optional()
          .describe("Required with matching estimate for full scans above 100 pages"),
        max_pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional page cap"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      try {
        const result = await client.websiteAuditOrchestrator(args);

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website audit orchestrator failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, appendOrchestratorSummary(data));
      } catch (err) {
        return toErrorResult(
          `Error running website audit orchestrator: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_audit_orchestrator_status",
    {
      description:
        "Poll a Website Audit Orchestrator run and return structured JSON with paginated site/page recommendations.",
      inputSchema: {
        run_id: z.string().describe("Run ID returned by robynn_website_audit_orchestrator"),
        page_limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Page size for paginated arrays; max 100"),
        page_cursor: z.string().optional().describe("Cursor for page_reports"),
        recommendation_cursor: z
          .string()
          .optional()
          .describe("Cursor for accepted_recommendations"),
        rejected_recommendation_cursor: z
          .string()
          .optional()
          .describe("Cursor for rejected_recommendations"),
        action_cursor: z.string().optional().describe("Cursor for url_action_queue"),
        include_sections: z
          .array(websiteAuditOrchestratorSectionSchema)
          .optional()
          .describe("Optional status sections to include"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteAudit,
          visibility: ["model", "app"],
        },
      },
    },
    async (args) => {
      try {
        const result = await client.websiteAuditOrchestratorStatus(args);

        if (!result.success || !result.data) {
          return toErrorResult(
            result.error || "Website audit orchestrator status failed",
          );
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, appendOrchestratorSummary(data));
      } catch (err) {
        return toErrorResult(
          `Error polling website audit orchestrator: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  registerAppTool(
    server,
    "robynn_website_strategy",
    {
      description:
        "Turn website findings into a prioritized improvement strategy tied to goals, pages, and measurement.",
      inputSchema: {
        website_url: z
          .string()
          .optional()
          .describe("Optional explicit website URL override"),
        primary_goal: z
          .string()
          .optional()
          .describe("Primary business goal for the next website iteration"),
        constraints: z
          .array(z.string())
          .optional()
          .describe("Constraints to respect in the next website phase"),
        priority_pages: z
          .array(z.string())
          .optional()
          .describe("Pages or templates to prioritize first"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: REPORT_RESOURCE_URIS.websiteStrategy,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ website_url, primary_goal, constraints, priority_pages }) => {
      try {
        const result = await client.websiteStrategy({
          website_url,
          primary_goal,
          constraints,
          priority_pages,
        });

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Website strategy failed");
        }

        const data = result.data as unknown as Record<string, unknown>;
        return toSuccessResult(data, (data.summary as string) || undefined);
      } catch (err) {
        return toErrorResult(
          `Error building website strategy: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}
