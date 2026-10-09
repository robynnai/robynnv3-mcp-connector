import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the COS-PLUGIN-001 local Wrangler config: it must stay runnable
// against the production entry point while never reaching remote resources.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Entry {
  section: string;
  key: string;
  value: string;
}

// Minimal line-oriented reader; enough for the flat shape of our Wrangler files.
function readEntries(file: string): { text: string; entries: Entry[]; sections: string[] } {
  const text = readFileSync(join(ROOT, file), "utf8");
  const entries: Entry[] = [];
  const sections: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      section = header[1].trim();
      sections.push(section);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (kv) entries.push({ section, key: kv[1], value: kv[2].trim() });
  }
  return { text, entries, sections };
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function values(entries: Entry[], section: string, key: string): string[] {
  return entries.filter((e) => e.section === section && e.key === key).map((e) => unquote(e.value));
}

const local = readEntries("wrangler.local.toml");
const prod = readEntries("wrangler.toml");

describe("wrangler.local.toml", () => {
  it("keeps the production entry point, Durable Object class and migrations", () => {
    expect(values(local.entries, "", "main")).toEqual(values(prod.entries, "", "main"));
    expect(values(local.entries, "", "compatibility_date")).toEqual(values(prod.entries, "", "compatibility_date"));
    expect(values(local.entries, "", "compatibility_flags")).toEqual(values(prod.entries, "", "compatibility_flags"));
    const doLine = /\{\s*name\s*=\s*"MCP_OBJECT",\s*class_name\s*=\s*"RobynnMCP"\s*\}/;
    expect(local.text).toMatch(doLine);
    expect(prod.text).toMatch(doLine);
    expect(values(local.entries, "migrations", "tag")).toEqual(values(prod.entries, "migrations", "tag"));
    expect(values(local.entries, "migrations", "new_sqlite_classes")).toEqual(
      values(prod.entries, "migrations", "new_sqlite_classes"),
    );
  });

  it("declares the same bindings as production", () => {
    const names = (e: Entry[]) =>
      e
        .filter((x) => x.key === "binding")
        .map((x) => unquote(x.value))
        .sort();
    expect(names(local.entries)).toEqual(names(prod.entries));
  });

  it("uses a distinct Worker name and never shares production storage identifiers", () => {
    expect(values(local.entries, "", "name")).not.toEqual(values(prod.entries, "", "name"));
    const prodIds = new Set(values(prod.entries, "kv_namespaces", "id"));
    for (const id of values(local.entries, "kv_namespaces", "id")) {
      expect(prodIds.has(id)).toBe(false);
    }
    const prodBuckets = new Set(values(prod.entries, "r2_buckets", "bucket_name"));
    for (const bucket of values(local.entries, "r2_buckets", "bucket_name")) {
      expect(prodBuckets.has(bucket)).toBe(false);
    }
  });

  it("has no routes, account identifiers, workers.dev publishing or remote bindings", () => {
    expect(local.sections).not.toContain("routes");
    for (const { key, value } of local.entries) {
      expect(["route", "routes", "account_id", "custom_domain", "zone_id", "zone_name"]).not.toContain(key);
      if (key === "remote") expect(value).toBe("false");
      if (key === "workers_dev") expect(value).toBe("false");
    }
    expect(values(local.entries, "", "workers_dev")).toEqual(["false"]);
  });

  it("points every URL var at loopback and carries no secret values", () => {
    const vars = local.entries.filter((e) => e.section === "vars");
    expect(vars.map((v) => v.key).sort()).toEqual([
      "MCP_PUBLIC_BASE_URL",
      "MCP_SERVER_NAME",
      "MCP_SERVER_VERSION",
      "ROBYNN_API_BASE_URL",
    ]);
    expect(values(local.entries, "vars", "ROBYNN_API_BASE_URL")).toEqual(["http://localhost:5173"]);
    expect(values(local.entries, "vars", "MCP_PUBLIC_BASE_URL")).toEqual(["http://localhost:8787"]);
    for (const { key } of vars) {
      expect(key).not.toMatch(/SECRET|TOKEN|PASSWORD|_KEY$/);
    }
  });

  it("listens on loopback port 8787 in local dev", () => {
    expect(values(local.entries, "dev", "ip")).toEqual(["127.0.0.1"]);
    expect(values(local.entries, "dev", "port")).toEqual(["8787"]);
  });
});

describe(".dev.vars.example", () => {
  const text = readFileSync(join(ROOT, ".dev.vars.example"), "utf8");
  const assignments = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("lists names only", () => {
    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });

  it("lists exactly the Worker's secret env names", () => {
    // CONNECTOR_STATE_SECRET is app-only; the Worker must not receive it.
    expect(assignments).toEqual(["MCP_INTERNAL_AUTH_SECRET="]);
  });

  it("is the only committed dev-vars file", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain(".dev.vars");
    expect(ignore).toContain(".wrangler/");
  });
});
