/**
 * COS-PLUGIN-001 P16 — live proof that robynn_vault_list / robynn_vault_read
 * never return another user's private memory (P09b handoff §7, steps 1–4).
 *
 *   1. robynnv3 `private-memory.plugin-local-export.test.ts` seeds P09b's
 *      contract rows into the local Supabase (Synthetic Org B; users alpha
 *      and beta) and runs the real materializer into PLUGIN_LOCAL_VAULT_EXPORT_DIR.
 *   2. This suite uploads that export into the Worker's local R2
 *      (`wrangler r2 object put --local`, never remote) under `orgs/<org>/`,
 *      plus pre-P09b leftovers (private memory files an old run left behind).
 *   3. As alpha and as beta, over a real OAuth connection to org B, it pages
 *      through robynn_vault_list and reads every listed key and every
 *      forbidden path with robynn_vault_read.
 *   4. The results go through P09b's contract helper: no exposure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPrivateMemoryExposure, PRIVATE_MEMORY_VAULT_CONTRACT, type PrivateMemoryVaultContract } from "../harness/private-memory-vault-contract";
import { ALPHA, BETA, LIVE, ORG_B, explicitlySkipped, callTool, connectHost, logsContainingSensitiveValues, openSession, registerHost, toolOk } from "./live-stack";

const EXPORT_DIR = process.env.PLUGIN_LOCAL_VAULT_EXPORT_DIR ?? "";
const MCP_DIR = process.cwd();
const BUCKET = "robynn-materialized-plugin-local";
const PERSIST = ".wrangler/state/cos-plugin-001";

/** P09b's contract mapped onto the plugin-local seed exactly as the app export maps it. */
const CONTRACT = JSON.parse(
  JSON.stringify(PRIVATE_MEMORY_VAULT_CONTRACT)
    .replaceAll(PRIVATE_MEMORY_VAULT_CONTRACT.organization_id, ORG_B)
    .replaceAll(PRIVATE_MEMORY_VAULT_CONTRACT.users.a, ALPHA.id)
    .replaceAll(PRIVATE_MEMORY_VAULT_CONTRACT.users.b, BETA.id),
) as PrivateMemoryVaultContract;

/** Agent-memory files a pre-P09b run wrote for user-private and session rows. */
const LEFTOVER_PATHS = CONTRACT.forbidden_paths.filter((p) => p.startsWith("sources/agent-memory/"));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Local Miniflare R2 only: `--local` with the plugin-local persist dir and config. */
function putLocal(key: string, file: string) {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--local", "--persist-to", PERSIST, "--config", "wrangler.local.toml", "--file", file],
    { cwd: MCP_DIR, stdio: "pipe" },
  );
}

const SKIPPED = explicitlySkipped("vault");
// P16 review N1: a requested live run must not skip this suite silently.
if (LIVE && !SKIPPED && (EXPORT_DIR === "" || walkOrEmpty(EXPORT_DIR).length === 0)) {
  throw new Error(
    "PLUGIN_LOCAL_VAULT_EXPORT_DIR must name a non-empty robynnv3 materializer export (or set PLUGIN_LOCAL_SKIP=vault)",
  );
}

function walkOrEmpty(dir: string): string[] {
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

describe.skipIf(!LIVE || SKIPPED)("plugin-local: Vault tools over real OAuth never return private memory", () => {
  let clientId: string;
  let leftovers: string | undefined;

  afterAll(() => {
    // P16 review N10: no synthetic leftovers in $TMPDIR.
    if (leftovers) rmSync(leftovers, { recursive: true, force: true });
  });

  beforeAll(() => {
    const files = walk(EXPORT_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) putLocal(`orgs/${ORG_B}/${relative(EXPORT_DIR, file)}`, file);

    // What a pre-P09b run left in R2 before the purge: user-private and
    // session memory files under sources/agent-memory/.
    leftovers = mkdtempSync(join(tmpdir(), "p16-leftovers-"));
    for (const path of LEFTOVER_PATHS) {
      const file = join(leftovers!, path.replaceAll("/", "_"));
      writeFileSync(file, "leftover private memory from a pre-P09b run");
      putLocal(`orgs/${ORG_B}/${path}`, file);
    }
    // Positive control: the leftovers really are in the bucket the Worker reads.
    const probe = execFileSync(
      "pnpm",
      ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/orgs/${ORG_B}/${LEFTOVER_PATHS[0]}`, "--local", "--persist-to", PERSIST, "--config", "wrangler.local.toml", "--pipe"],
      { cwd: MCP_DIR, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    expect(probe).toContain("leftover private memory");
  }, 120_000);

  beforeAll(async () => {
    clientId = await registerHost("P16 Vault Host");
  });

  it.each([
    ["alpha (collaborator)", ALPHA],
    ["beta (admin)", BETA],
  ])("%s: org-shared sources only; no user-private or session memory, by list or by path", async (_label, user) => {
    const conn = await connectHost({ clientId, user, organizationId: ORG_B, scope: "brand:read" });
    const session = await openSession(conn.access);

    const keys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const reply = await callTool(conn.access, session, "robynn_vault_list", { limit: 3, ...(cursor ? { cursor } : {}) });
      expect(toolOk(reply)).toBe(true);
      const body = reply.json!.result!.structuredContent as { entries: Array<{ path: string }>; cursor: string | null };
      keys.push(...body.entries.map((e) => e.path));
      if (!body.cursor) break;
      cursor = body.cursor;
    }
    expect(keys.some((k) => k.startsWith("brand/"))).toBe(true);

    const read = async (path: string) => {
      const reply = await callTool(conn.access, session, "robynn_vault_read", { path });
      expect(toolOk(reply)).toBe(true);
      const body = reply.json!.result!.structuredContent!;
      return body.not_found === true ? null : (body.text as string);
    };
    const report = await findPrivateMemoryExposure({ keys, read, contract: CONTRACT });
    expect(report.exposures).toEqual([]);
    expect(report.missingExpectedKeys).toEqual([]);
  });

  it("no code, state, cookie, token or password seen by this suite appears in the app or Worker logs", () => {
    expect(logsContainingSensitiveValues()).toEqual([]);
  });
});
