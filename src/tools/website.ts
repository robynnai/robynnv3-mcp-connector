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
