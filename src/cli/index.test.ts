import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("robynn mcp CLI", () => {
  const source = readFileSync(
    decodeURIComponent(new URL("./index.ts", import.meta.url).pathname),
    "utf8",
  );

  it("registers connected app MCP tools for the local stdio bridge", () => {
    expect(source).toContain("registerConnectorTools(server, client);");
    expect(source).toContain("program.command('assist')");
  });

  it("registers 0.4.0 marketer tools and trims the website audit family", () => {
    expect(source).toContain("registerCmoDecideTools(server, client);");
    expect(source).toContain("registerContentPlanTools(server, client);");
    expect(source).toContain("registerWeeklyVisibilityTools(server, client);");
    expect(source).toContain(
      'registerWebsiteTools(server, client, { family: "core" })',
    );
    expect(source).not.toMatch(
      /registerWebsiteTools\(server, client\);/,
    );
  });
});
