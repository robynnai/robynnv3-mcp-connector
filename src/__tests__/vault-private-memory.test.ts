/**
 * COS-PLUGIN-001 P16 — robynn_vault_list / robynn_vault_read never return
 * another user's private memory (plan §5 "Memory privacy differs by backend";
 * P09b handoff §7).
 *
 * The vault is the app materializer's output in R2, served org-wide. P09b
 * keeps user-private and session-scope rows out of it; the Worker adds a
 * path-level refusal for the agent-memory files those rows were written to
 * (`VAULT_HIDES_PRIVATE_MEMORY_PATHS`, src/vault-r2.ts) until every org's
 * vault is rebuilt or purged.
 *
 * Every call goes through the real Worker: provider token check → P10
 * preflight (session binding, introspection, TOOL_POLICY) → RobynnMCP → Vault
 * gate → VaultR2 → (fake) R2. Each tool result is checked with P09b's
 * contract helper, exactly as P09b specified for P16: page through
 * robynn_vault_list, read every listed key and every forbidden path, and
 * expect no exposure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => import("./harness/cloudflare-workers-stub"));
vi.mock("agents/mcp", () => import("./harness/agents-mcp-emulation"));

import { isPrivateMemoryVaultPath, VAULT_HIDES_PRIVATE_MEMORY_PATHS } from "../vault-r2";
import { doEvents } from "./harness/agents-mcp-emulation";
import {
  findPrivateMemoryExposure,
  materializedVault,
  preP09bLeakyVault,
  PRIVATE_MEMORY_VAULT_CONTRACT as CONTRACT,
} from "./harness/private-memory-vault-contract";
import { callTool, connect, createHarness, initialize, type Harness } from "./harness/worker-harness";

const ORG = CONTRACT.organization_id;
const USER_A = CONTRACT.users.a;
const USER_B = CONTRACT.users.b;
const OTHER_ORG = "09b00000-0000-4000-8000-0000000000ff";
const GRANT_A = "6f0c0000-0000-4000-8000-0000000009ba";
const GRANT_B = "6f0c0000-0000-4000-8000-0000000009bb";

/** Same files under the bound org, plus another org's private memory that must never surface. */
function bucketObjects(files: Record<string, string>) {
  const objects: Record<string, string> = {};
  for (const [path, body] of Object.entries(files)) objects[`orgs/${ORG}/${path}`] = body;
  objects[`orgs/${ORG}/brand/voice/direct.md`] = "Org voice (shared)";
  objects[`orgs/${OTHER_ORG}/sources/agent-memory/org-brand-voice.md`] = "OTHER-ORG P09B-PRIVATE-USER-B-MEMORY";
  return objects;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function vaultSession(h: Harness, userId: string, appGrantId: string) {
  const conn = await connect(h, { userId, organizationId: ORG, appGrantId, scopes: ["brand:read"] });
  const { sessionId } = await initialize(h, conn.access);
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await callTool(h, conn.access, sessionId, name, args);
    expect(out.status).toBe(200);
    return out.json.result as ToolResult;
  };

  /** Every key robynn_vault_list returns, following cursors. */
  const listAll = async (prefix?: string) => {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await call("robynn_vault_list", { ...(prefix ? { prefix } : {}), limit: 2, ...(cursor ? { cursor } : {}) });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      const body = result.structuredContent as { entries: Array<{ path: string }>; cursor: string | null };
      keys.push(...body.entries.map((e) => e.path));
      if (!body.cursor) return keys;
      cursor = body.cursor;
    }
    throw new Error("vault list did not terminate");
  };

  /** robynn_vault_read text, or null when the tool reports not_found. */
  const read = async (path: string) => {
    const result = await call("robynn_vault_read", { path });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const body = result.structuredContent!;
    return body.not_found === true ? null : (body.text as string);
  };

  return { listAll, read };
}

beforeEach(() => {
  doEvents.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("contract fixtures", () => {
  it("the post-P09b vault built from the contract is exactly expected_sources_keys", () => {
    expect(Object.keys(materializedVault()).sort()).toEqual([...CONTRACT.expected_sources_keys].sort());
  });

  it("the pre-P09b vault holds every forbidden path (the leak P09b fixed)", () => {
    const leaky = Object.keys(preP09bLeakyVault());
    for (const path of CONTRACT.forbidden_paths) expect(leaky).toContain(path);
  });

  it("the Worker path rule matches exactly the contract's agent-memory private and session paths", () => {
    expect(VAULT_HIDES_PRIVATE_MEMORY_PATHS).toBe(true);
    const memoryForbidden = CONTRACT.forbidden_paths.filter((p) => p.startsWith("sources/agent-memory/"));
    expect(memoryForbidden.length).toBe(8);
    for (const path of memoryForbidden) expect(isPrivateMemoryVaultPath(path), path).toBe(true);
    for (const path of CONTRACT.expected_sources_keys) expect(isPrivateMemoryVaultPath(path), path).toBe(false);
  });
});

describe("robynn_vault_list / robynn_vault_read through the real Worker (P09b output contract)", () => {
  it.each([
    ["user a", USER_A, GRANT_A],
    ["user b", USER_B, GRANT_B],
  ])("post-P09b vault: %s sees only org-shared sources, no private memory of anyone", async (_label, userId, grantId) => {
    const h = await createHarness({ vaultObjects: bucketObjects(materializedVault()) });
    const vault = await vaultSession(h, userId, grantId);

    const keys = await vault.listAll();
    expect(keys).toContain("brand/voice/direct.md");
    const report = await findPrivateMemoryExposure({ keys, read: vault.read });
    expect(report.exposures).toEqual([]);
    expect(report.missingExpectedKeys).toEqual([]);

    // Narrow prefixes return nothing private either.
    expect((await vault.listAll("sources/agent-memory/")).sort()).toEqual([
      "sources/agent-memory/org-brand-voice.embedding.json",
      "sources/agent-memory/org-brand-voice.md",
    ]);
    expect(await vault.listAll("sources/agent-memory/user-")).toEqual([]);
    // The bucket is only ever addressed under the bound org.
    for (const call of h.vaultCalls) expect(call).toMatch(new RegExp(`^(list|get):orgs/${ORG}/`));
    expect(JSON.stringify(keys)).not.toContain(OTHER_ORG);
  });

  it("pre-P09b leaky vault: no agent-memory private or session object is listed or read, and R2 is never asked for one", async () => {
    const h = await createHarness({ vaultObjects: bucketObjects(preP09bLeakyVault()) });
    const vault = await vaultSession(h, USER_A, GRANT_A);

    const keys = await vault.listAll();
    const report = await findPrivateMemoryExposure({ keys, read: vault.read });
    const memoryForbidden = CONTRACT.forbidden_paths.filter((p) => p.startsWith("sources/agent-memory/"));
    for (const path of memoryForbidden) {
      expect(keys).not.toContain(path);
      expect(await vault.read(path)).toBeNull();
      expect(h.vaultCalls).not.toContain(`get:orgs/${ORG}/${path}`);
    }
    for (const exposure of report.exposures) {
      expect(exposure.path.startsWith("sources/agent-memory/"), JSON.stringify(exposure)).toBe(false);
    }
    for (const marker of ["P09B-PRIVATE-USER-A-MEMORY", "P09B-PRIVATE-USER-B-MEMORY", "P09B-PRIVATE-LEGACY-OWNERLESS-MEMORY", "P09B-SESSION-SCOPE-MEMORY"]) {
      expect(report.exposures.some((e) => e.detail === marker), marker).toBe(false);
    }
    // Residual, by design: non-memory private documents (visible_to_user_id on
    // a Drive file or a website row) are not path-distinguishable. Only the
    // P09b materializer reconcile or the P09b purge removes them, which is
    // why that purge is a ship step.
    expect(new Set(report.exposures.map((e) => e.path.split("/")[1]))).toEqual(new Set(["google-drive", "website"]));
  });

  it("spelling tricks do not reach R2 for a private-memory path", async () => {
    const h = await createHarness({ vaultObjects: bucketObjects(preP09bLeakyVault()) });
    const vault = await vaultSession(h, USER_B, GRANT_B);
    const target = "sources/agent-memory/user-09b00000-0000-4000-8000-00000000000b-voice.md";
    for (const path of [target, `./${target}`, target.replace("sources/", "sources//"), target.toUpperCase().replace("SOURCES/AGENT-MEMORY/USER", "sources/agent-memory/USER")]) {
      expect(await vault.read(path), path).toBeNull();
    }
    expect(h.vaultCalls.filter((c) => c.includes("user-09b"))).toEqual([]);
  });
});
