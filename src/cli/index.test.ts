import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("robynn mcp CLI", () => {
  it("registers connected app MCP tools for the local stdio bridge", () => {
    const source = readFileSync(
      decodeURIComponent(new URL("./index.ts", import.meta.url).pathname),
      "utf8",
    );

    expect(source).toContain('registerConnectorTools(server, client);');
    expect(source).toContain("program.command('assist')");
  });
});
