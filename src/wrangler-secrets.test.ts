import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// COS-PLUGIN-001 P03: committed Wrangler config must never carry secrets.
// Secrets (MCP_INTERNAL_AUTH_SECRET) are set out of band by the release owner.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|_KEY$)/i;
// 32+ hex chars or 40+ base64-ish chars look like key material.
const SECRET_VALUE = /^"?([0-9a-f]{32,}|[A-Za-z0-9+/_=-]{40,})"?$/i;

function varsEntries(file: string): Array<{ key: string; value: string }> {
  const text = readFileSync(join(ROOT, file), "utf8");
  const entries: Array<{ key: string; value: string }> = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (kv && (section === "vars" || section.endsWith(".vars"))) {
      entries.push({ key: kv[1], value: kv[2].trim() });
    }
  }
  return entries;
}

describe("wrangler.toml secrets hygiene", () => {
  const vars = varsEntries("wrangler.toml");

  it("still declares the non-secret vars", () => {
    expect(vars.map((v) => v.key)).toEqual(
      expect.arrayContaining(["ROBYNN_API_BASE_URL", "MCP_PUBLIC_BASE_URL"]),
    );
  });

  it("does not commit CONNECTOR_STATE_SECRET or MCP_INTERNAL_AUTH_SECRET", () => {
    const keys = vars.map((v) => v.key);
    expect(keys).not.toContain("CONNECTOR_STATE_SECRET");
    expect(keys).not.toContain("MCP_INTERNAL_AUTH_SECRET");
    expect(keys).not.toContain("OAUTH_JWT_SECRET");
  });

  it("has no secret-named vars and no key-material values", () => {
    for (const { key, value } of vars) {
      expect(key).not.toMatch(SECRET_NAME);
      expect(value).not.toMatch(SECRET_VALUE);
    }
  });
});
