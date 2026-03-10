import { describe, expect, it, vi } from "vitest";

import {
  REPORT_RESOURCE_URIS,
  buildReportAppHtml,
  getPublicBaseUrl,
  getReportAssetUrl,
  registerReportAppResources,
} from "./report-app";

describe("report-app helpers", () => {
  it("normalizes the public base URL and script asset URL", () => {
    expect(getPublicBaseUrl("https://mcp.robynn.ai/")).toBe(
      "https://mcp.robynn.ai"
    );
    expect(getReportAssetUrl("https://mcp.robynn.ai/")).toBe(
      "https://mcp.robynn.ai/app-assets/report-app.js"
    );
  });

  it("builds report HTML with the embedded config and shared asset", () => {
    const html = buildReportAppHtml({
      reportType: "geo",
      publicBaseUrl: "https://mcp.robynn.ai",
    });

    expect(html).toContain('id="__robynn-report-config"');
    expect(html).toContain('"reportType":"geo"');
    expect(html).toContain("https://mcp.robynn.ai/app-assets/report-app.js");
  });

  it("registers the shared report resources", async () => {
    const resources = new Map<string, { config: Record<string, any>; read: () => Promise<any> }>();
    const server = {
      registerResource: vi.fn(
        (
          _name: string,
          uri: string,
          config: Record<string, any>,
          read: () => Promise<any>
        ) => {
          resources.set(uri, { config, read });
        }
      ),
    };

    registerReportAppResources(server as never, "https://mcp.robynn.ai");

    expect(resources.has(REPORT_RESOURCE_URIS.geo)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.seo)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.battlecard)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.brandBookStatus)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.brandBookStrategy)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.websiteAudit)).toBe(true);
    expect(resources.has(REPORT_RESOURCE_URIS.websiteStrategy)).toBe(true);

    const geoResource = resources.get(REPORT_RESOURCE_URIS.geo);
    const geoRead = await geoResource?.read();

    expect(geoResource?.config._meta?.ui?.csp?.resourceDomains).toEqual([
      "https://mcp.robynn.ai",
    ]);
    expect(geoRead?.contents[0]?.text).toContain("Robynn GEO Report");
  });

  it("builds brand-book report HTML for the new guided surfaces", () => {
    const html = buildReportAppHtml({
      reportType: "brandBookStatus",
      publicBaseUrl: "https://mcp.robynn.ai",
    });

    expect(html).toContain('"reportType":"brandBookStatus"');
    expect(html).toContain("Robynn Brand Book Status");
  });
});
