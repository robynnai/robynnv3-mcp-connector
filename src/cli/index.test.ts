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
    expect(source).toContain("const openclaw = program.command('openclaw')");
    expect(source).toContain(".command('install')");
    expect(source).toContain(".requiredOption('--provision-token <token>'");
    expect(source).toContain(".command('doctor')");
    expect(source).not.toContain("install').description('Configure local agent runtimes'");
  });
});
