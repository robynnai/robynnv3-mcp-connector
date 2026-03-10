import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ReportType =
  | "geo"
  | "seo"
  | "battlecard"
  | "brandBookStatus"
  | "brandBookStrategy"
  | "websiteAudit"
  | "websiteStrategy";

export const REPORT_RESOURCE_URIS: Record<ReportType, string> = {
  geo: "ui://reports/geo.html",
  seo: "ui://reports/seo.html",
  battlecard: "ui://reports/battlecard.html",
  brandBookStatus: "ui://reports/brand-book-status.html",
  brandBookStrategy: "ui://reports/brand-book-strategy.html",
  websiteAudit: "ui://reports/website-audit.html",
  websiteStrategy: "ui://reports/website-strategy.html",
};

interface ReportAppDefinition {
  reportType: ReportType;
  title: string;
  description: string;
}

const REPORT_DEFINITIONS: ReportAppDefinition[] = [
  {
    reportType: "geo",
    title: "Robynn GEO Report",
    description: "Interactive AI visibility report",
  },
  {
    reportType: "seo",
    title: "Robynn SEO Opportunities Report",
    description: "Interactive SEO opportunity report",
  },
  {
    reportType: "battlecard",
    title: "Robynn Competitive Battlecard",
    description: "Interactive competitive intelligence report",
  },
  {
    reportType: "brandBookStatus",
    title: "Robynn Brand Book Status",
    description: "Interactive brand-book completeness report",
  },
  {
    reportType: "brandBookStrategy",
    title: "Robynn Brand Book Strategy",
    description: "Interactive brand-book improvement strategy",
  },
  {
    reportType: "websiteAudit",
    title: "Robynn Website Audit",
    description: "Interactive website audit report",
  },
  {
    reportType: "websiteStrategy",
    title: "Robynn Website Strategy",
    description: "Interactive website improvement strategy",
  },
];

export function getPublicBaseUrl(rawUrl?: string): string {
  return (rawUrl || "https://mcp.robynn.ai").replace(/\/+$/, "");
}

export function getReportAssetUrl(publicBaseUrl: string): string {
  return `${getPublicBaseUrl(publicBaseUrl)}/app-assets/report-app.js`;
}

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function buildReportAppHtml(params: {
  reportType: ReportType;
  publicBaseUrl: string;
}): string {
  const { reportType, publicBaseUrl } = params;
  const assetUrl = getReportAssetUrl(publicBaseUrl);
  const definition = REPORT_DEFINITIONS.find((item) => item.reportType === reportType);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${definition?.title ?? "Robynn Report"}</title>
    <style>
      :root {
        color-scheme: light;
        --robynn-cream: #fbf6eb;
        --robynn-paper: rgba(255, 255, 255, 0.88);
        --robynn-ink: #152033;
        --robynn-muted: #64748b;
        --robynn-line: rgba(21, 32, 51, 0.12);
        --robynn-accent: #ff725c;
        --robynn-accent-soft: rgba(255, 114, 92, 0.14);
        --robynn-green: #157f66;
        --robynn-gold: #b06b00;
        --robynn-shadow: 0 20px 50px rgba(21, 32, 51, 0.12);
        --robynn-radius: 22px;
        --robynn-radius-sm: 14px;
      }

      :root[data-theme="dark"] {
        color-scheme: dark;
        --robynn-cream: #111827;
        --robynn-paper: rgba(17, 24, 39, 0.9);
        --robynn-ink: #f8fafc;
        --robynn-muted: #cbd5e1;
        --robynn-line: rgba(248, 250, 252, 0.12);
        --robynn-accent-soft: rgba(255, 114, 92, 0.22);
        --robynn-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Inter", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(255, 114, 92, 0.18), transparent 34%),
          radial-gradient(circle at top right, rgba(21, 127, 102, 0.12), transparent 30%),
          var(--robynn-cream);
        color: var(--robynn-ink);
      }

      button, input, textarea, select {
        font: inherit;
      }

      .app-shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px;
      }

      .hero-card,
      .report-section {
        background: var(--robynn-paper);
        border: 1px solid var(--robynn-line);
        border-radius: var(--robynn-radius);
        box-shadow: var(--robynn-shadow);
        backdrop-filter: blur(12px);
        margin-bottom: 20px;
        padding: 24px;
      }

      .hero-meta,
      .section-head,
      .action-title-row,
      .detail-row,
      .meta-row,
      .form-actions,
      .tab-row,
      .summary-grid,
      .score-grid,
      .comparison-grid,
      .action-grid {
        display: flex;
        gap: 12px;
      }

      .hero-meta,
      .section-head,
      .action-title-row,
      .detail-row,
      .form-actions {
        justify-content: space-between;
        align-items: center;
      }

      .section-head {
        margin-bottom: 16px;
        flex-wrap: wrap;
      }

      .hero-card h1,
      .report-section h3,
      .report-section h4,
      .action-card h4 {
        margin: 0;
        font-family: "Fraunces", "Georgia", serif;
        letter-spacing: -0.02em;
      }

      .hero-card h1 {
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.05;
        margin-top: 12px;
      }

      .hero-summary,
      .list-card p,
      .action-card p,
      .muted {
        color: var(--robynn-muted);
      }

      .eyebrow,
      .pill,
      .status-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        font-size: 0.8rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 0.35rem 0.7rem;
      }

      .eyebrow {
        background: rgba(21, 32, 51, 0.08);
      }

      .status-badge,
      .pill {
        background: var(--robynn-accent-soft);
        color: var(--robynn-ink);
      }

      .summary-grid,
      .score-grid,
      .comparison-grid,
      .action-grid {
        flex-wrap: wrap;
      }

      .summary-card,
      .score-card,
      .detail-card,
      .action-card,
      .list-card {
        border: 1px solid var(--robynn-line);
        border-radius: var(--robynn-radius-sm);
        background: rgba(255, 255, 255, 0.56);
      }

      .summary-card,
      .detail-card,
      .action-card,
      .list-card {
        padding: 16px;
      }

      .summary-card {
        min-width: 180px;
        flex: 1 1 180px;
      }

      .summary-label {
        color: var(--robynn-muted);
        font-size: 0.85rem;
      }

      .summary-value {
        margin-top: 8px;
        font-size: 1.5rem;
        font-weight: 700;
      }

      .tone-success .summary-value { color: var(--robynn-green); }
      .tone-warning .summary-value { color: var(--robynn-gold); }

      .score-card {
        flex: 1 1 180px;
        padding: 18px;
        text-align: left;
        cursor: pointer;
      }

      .score-card.active {
        border-color: var(--robynn-accent);
        box-shadow: inset 0 0 0 1px var(--robynn-accent);
      }

      .score-label,
      .score-subtle {
        display: block;
      }

      .score-value {
        display: block;
        font-size: 1.9rem;
        font-weight: 700;
        margin: 10px 0 6px;
      }

      .score-subtle {
        color: var(--robynn-muted);
        font-size: 0.9rem;
      }

      .detail-card,
      .action-card,
      .list-card {
        flex: 1 1 260px;
      }

      .detail-row,
      .meta-row {
        color: var(--robynn-muted);
        font-size: 0.92rem;
        margin-top: 10px;
        flex-wrap: wrap;
      }

      .detail-row strong,
      .meta-row span {
        color: var(--robynn-ink);
      }

      .inline-control,
      label {
        display: grid;
        gap: 8px;
        color: var(--robynn-muted);
        font-size: 0.92rem;
      }

      .form-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .form-grid .full {
        grid-column: 1 / -1;
      }

      input,
      textarea,
      select {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--robynn-line);
        background: rgba(255, 255, 255, 0.78);
        color: var(--robynn-ink);
        min-height: 46px;
        padding: 0.8rem 0.9rem;
      }

      textarea {
        min-height: 120px;
        resize: vertical;
      }

      .checkbox-row {
        align-items: center;
        display: flex;
        gap: 10px;
      }

      .checkbox-row input {
        width: auto;
        min-height: 0;
      }

      .primary-button,
      .ghost-button,
      .tab-button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        padding: 0.8rem 1rem;
      }

      .primary-button {
        background: linear-gradient(135deg, var(--robynn-accent), #ff9d71);
        color: white;
        font-weight: 700;
      }

      .ghost-button,
      .tab-button {
        background: rgba(21, 32, 51, 0.08);
        color: var(--robynn-ink);
      }

      .tab-button.active {
        background: var(--robynn-ink);
        color: white;
      }

      .list-stack {
        display: grid;
        gap: 12px;
      }

      .bullet-list {
        margin: 14px 0 0;
        padding-left: 1.1rem;
      }

      .bullet-list li + li {
        margin-top: 6px;
      }

      .empty-state,
      .error-card {
        border-radius: var(--robynn-radius-sm);
        border: 1px dashed var(--robynn-line);
        color: var(--robynn-muted);
        padding: 18px;
      }

      .error-card {
        border-style: solid;
        background: rgba(255, 114, 92, 0.08);
      }

      .table-shell {
        overflow-x: auto;
      }

      table {
        border-collapse: collapse;
        min-width: 720px;
        width: 100%;
      }

      th,
      td {
        border-bottom: 1px solid var(--robynn-line);
        padding: 12px 10px;
        text-align: left;
      }

      th {
        color: var(--robynn-muted);
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      @media (max-width: 720px) {
        .app-shell {
          padding: 14px;
        }

        .hero-card,
        .report-section {
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <main class="app-shell">
      <div id="robynn-report-root"></div>
    </main>
    <script id="__robynn-report-config" type="application/json">${escapeJsonForHtml({
      reportType,
      title: definition?.title ?? "Robynn Report",
      toolName:
        reportType === "geo"
          ? "robynn_geo_analysis"
          : reportType === "seo"
            ? "robynn_seo_opportunities"
            : reportType === "battlecard"
              ? "robynn_competitive_battlecard"
              : reportType === "brandBookStatus"
                ? "robynn_brand_book_status"
                : reportType === "brandBookStrategy"
                  ? "robynn_brand_book_strategy"
                  : reportType === "websiteAudit"
                    ? "robynn_website_audit"
                    : "robynn_website_strategy",
    })}</script>
    <script type="module" src="${assetUrl}"></script>
  </body>
</html>`;
}

export function registerReportAppResources(server: McpServer, publicBaseUrl: string) {
  const normalizedBaseUrl = getPublicBaseUrl(publicBaseUrl);
  const resourceDomain = new URL(normalizedBaseUrl).origin;

  for (const definition of REPORT_DEFINITIONS) {
    const resourceUri = REPORT_RESOURCE_URIS[definition.reportType];

    registerAppResource(
      server,
      definition.title,
      resourceUri,
      {
        description: definition.description,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              resourceDomains: [resourceDomain],
            },
          },
        },
      },
      async () => ({
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: buildReportAppHtml({
              reportType: definition.reportType,
              publicBaseUrl: normalizedBaseUrl,
            }),
            _meta: {
              ui: {
                prefersBorder: false,
                csp: {
                  resourceDomains: [resourceDomain],
                },
              },
            },
          },
        ],
      })
    );
  }
}
