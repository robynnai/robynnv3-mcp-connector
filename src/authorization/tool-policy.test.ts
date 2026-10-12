import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildToolPolicy, decideToolCall, TOOL_POLICY } from "./tool-policy";

// COS-PLUGIN-001 P10: TOOL_POLICY is built from contracts/tool-route-map.json.

const map = JSON.parse(readFileSync(join(process.cwd(), "contracts", "tool-route-map.json"), "utf8")) as {
  tools: Array<{ name: string; requiredScope: string; scopeByArgument?: Record<string, Record<string, string>> }>;
};
const READ_ONLY = ["brand:read"] as const;
const FULL = ["brand:read", "tools:execute"] as const;

describe("TOOL_POLICY", () => {
  it("covers exactly the map's 51 tools with the map's required scope", () => {
    expect(TOOL_POLICY.size).toBe(51);
    for (const tool of map.tools) {
      expect(TOOL_POLICY.get(tool.name)?.requiredScope, tool.name).toBe(tool.requiredScope);
    }
  });

  it("a read-only grant may call exactly the map's brand:read tools (no-argument form)", () => {
    const allowed = map.tools.filter((t) => decideToolCall(t.name, {}, READ_ONLY).allowed).map((t) => t.name);
    expect(allowed.sort()).toEqual(map.tools.filter((t) => t.requiredScope === "brand:read").map((t) => t.name).sort());
  });

  it("a full grant may call every tool", () => {
    for (const tool of map.tools) expect(decideToolCall(tool.name, {}, FULL).allowed, tool.name).toBe(true);
  });

  it("applies scopeByArgument (robynn_conversations) and falls back to requiredScope for other values", () => {
    expect(decideToolCall("robynn_conversations", { action: "list" }, READ_ONLY)).toEqual({ allowed: true, requiredScope: "brand:read" });
    expect(decideToolCall("robynn_conversations", { action: "create" }, READ_ONLY)).toMatchObject({ allowed: false, code: "insufficient_scope", requiredScope: "tools:execute" });
    expect(decideToolCall("robynn_conversations", { action: "delete" }, READ_ONLY)).toMatchObject({ allowed: false, code: "insufficient_scope" });
    expect(decideToolCall("robynn_conversations", {}, READ_ONLY)).toMatchObject({ allowed: false });
    // Prototype keys are not argument values.
    expect(decideToolCall("robynn_conversations", { action: "constructor" }, READ_ONLY)).toMatchObject({ allowed: false });
  });

  it("rejects session-scoped memory on every memory tool, whatever the scopes", () => {
    for (const name of ["robynn_memory_write", "robynn_memory_get", "robynn_memory_search"]) {
      expect(decideToolCall(name, { scope: "session" }, FULL)).toEqual({ allowed: false, code: "unsupported_memory_scope" });
      expect(decideToolCall(name, { scope: "user" }, FULL).allowed).toBe(true);
    }
  });

  it("denies unknown or malformed tool names", () => {
    for (const name of ["robynn_unknown", "", undefined, 42, "__proto__", "toString"]) {
      expect(decideToolCall(name, {}, FULL)).toEqual({ allowed: false, code: "tool_not_permitted" });
    }
  });

  it("refuses a map with an unknown scope or a duplicate tool", () => {
    expect(() => buildToolPolicy([{ name: "x", requiredScope: "admin:all" }])).toThrow(/unknown scope/);
    expect(() =>
      buildToolPolicy([
        { name: "x", requiredScope: "brand:read" },
        { name: "x", requiredScope: "brand:read" },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      buildToolPolicy([{ name: "x", requiredScope: "brand:read", scopeByArgument: { a: { b: "root" } } }]),
    ).toThrow(/unknown scope/);
  });
});
