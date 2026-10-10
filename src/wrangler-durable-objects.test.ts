import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// COS-PLUGIN-001 P10 (review N3): the deployed Worker must bind the per-grant
// refresh serializer. Without it a non-loopback Worker refuses refreshes
// (503) rather than refreshing unserialized.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8").replace(/^\s*#.*$/gm, "");

describe("wrangler.toml Durable Objects", () => {
  it("binds MCP_OBJECT and REFRESH_COORDINATOR to their classes", () => {
    expect(toml).toMatch(/\{\s*name\s*=\s*"MCP_OBJECT",\s*class_name\s*=\s*"RobynnMCP"\s*\}/);
    expect(toml).toMatch(/\{\s*name\s*=\s*"REFRESH_COORDINATOR",\s*class_name\s*=\s*"RefreshCoordinator"\s*\}/);
  });

  it("keeps migration v1 and adds RefreshCoordinator as a new sqlite class in v2", () => {
    const migrations = [...toml.matchAll(/\[\[migrations\]\]\s*\ntag\s*=\s*"([^"]+)"\s*\nnew_sqlite_classes\s*=\s*\[([^\]]*)\]/g)].map(
      (m) => ({ tag: m[1], classes: m[2].split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean) }),
    );
    expect(migrations).toEqual([
      { tag: "v1", classes: ["RobynnMCP"] },
      { tag: "v2", classes: ["RefreshCoordinator"] },
    ]);
  });
});
