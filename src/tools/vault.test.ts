import { describe, expect, it, vi } from "vitest";

import { registerVaultTools } from "./vault";
import { isPrivateMemoryVaultPath, MAX_VAULT_OBJECT_BYTES, MAX_VAULT_PATH_LENGTH, VaultR2 } from "../vault-r2";
import { createVaultGate, type VaultGate } from "../authorization/vault-gate";
import { PREFLIGHT_HEADER } from "../authorization/session-binding";

/** Existing behaviour tests run behind an open gate; the gate is tested below. */
const ALLOW_ALL: VaultGate = () => true;

// ----------------------------------------------------------------------------
// Mock R2Bucket — only the methods VaultR2 calls (.list / .get).
// ----------------------------------------------------------------------------

interface FakeObject {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  contentType?: string;
  body: string;
}

function makeFakeBucket(objects: FakeObject[], calls: string[] = []) {
  const byKey = new Map(objects.map((o) => [o.key, o]));
  return {
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
      calls.push(`list:${opts.prefix ?? ""}`);
      const prefix = opts.prefix ?? "";
      const matched = objects.filter((o) => o.key.startsWith(prefix));
      const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      const limit = opts.limit ?? 100;
      const slice = matched.slice(start, start + limit);
      const truncated = start + slice.length < matched.length;
      return {
        objects: slice.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          etag: o.etag,
        })),
        truncated,
        cursor: truncated ? String(start + slice.length) : undefined,
      };
    },
    async get(key: string) {
      calls.push(`get:${key}`);
      const obj = byKey.get(key);
      if (!obj) return null;
      const cancel = vi.fn(async () => undefined);
      return {
        body: { cancel },
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
        etag: obj.etag,
        httpMetadata: { contentType: obj.contentType ?? "text/plain" },
        text: vi.fn(() => Promise.resolve(obj.body)),
      };
    },
  } as never;
}

// ----------------------------------------------------------------------------
// Server harness mirrors the project's existing pattern (all-tools.test.ts).
// ----------------------------------------------------------------------------

type Handler = (args: never) => Promise<never>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const registerTool = vi.fn((...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Handler;
    handlers.set(name, handler);
  });
  const server = { registerTool } as never;
  return { server, handlers };
}

const ORG = "11111111-1111-1111-1111-111111111111";

function fixture(): FakeObject[] {
  return [
    {
      key: `orgs/${ORG}/brand/voice-attribute/direct.md`,
      size: 200,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"e1"',
      contentType: "text/markdown; charset=utf-8",
      body: "---\nid: voice-direct\n---\n\nBe direct.",
    },
    {
      key: `orgs/${ORG}/brand/voice-attribute/accessible.md`,
      size: 300,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"e2"',
      body: "Be accessible.",
    },
    {
      key: `orgs/${ORG}/sources/website/about.md`,
      size: 1000,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"e3"',
      body: "Website content",
    },
    // Simulate a different org's object — must NEVER be returned.
    {
      key: "orgs/22222222-2222-2222-2222-222222222222/brand/secret/leak.md",
      size: 100,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"e4"',
      body: "secret",
    },
  ];
}

describe("registerVaultTools — robynn_vault_list", () => {
  it("lists objects scoped to the org and strips the org prefix from paths", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_list")!({
      prefix: "brand/",
    } as never)) as {
      structuredContent: {
        entries: { path: string }[]
        truncated: boolean
      }
    };

    const paths = res.structuredContent.entries.map((e) => e.path).sort();
    // Only this org's brand/ paths; no leak from the other org.
    expect(paths).toEqual([
      "brand/voice-attribute/accessible.md",
      "brand/voice-attribute/direct.md",
    ])
    expect(res.structuredContent.truncated).toBe(false)
  });

  it("paginates via cursor when limit is below the matching count", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const page1 = (await handlers.get("robynn_vault_list")!({
      prefix: "brand/",
      limit: 1,
    } as never)) as {
      structuredContent: {
        entries: { path: string }[]
        cursor: string | null
        truncated: boolean
      }
    };
    expect(page1.structuredContent.entries).toHaveLength(1)
    expect(page1.structuredContent.truncated).toBe(true)
    expect(page1.structuredContent.cursor).toBeTruthy()

    const page2 = (await handlers.get("robynn_vault_list")!({
      prefix: "brand/",
      limit: 1,
      cursor: page1.structuredContent.cursor!,
    } as never)) as {
      structuredContent: { entries: { path: string }[]; truncated: boolean }
    };
    expect(page2.structuredContent.entries).toHaveLength(1)
    expect(page2.structuredContent.truncated).toBe(false)
  });

  it("returns an isError result on path-traversal attempts", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_list")!({
      prefix: "../",
    } as never)) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/parent-directory/);
  });
});

describe("registerVaultTools — robynn_vault_read", () => {
  it("reads an object scoped to the org and returns text + metadata", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_read")!({
      path: "brand/voice-attribute/direct.md",
    } as never)) as {
      structuredContent: {
        path: string
        text: string
        contentType: string
        size: number
        etag: string | null
        uploaded: string
      }
    };

    expect(res.structuredContent.path).toBe("brand/voice-attribute/direct.md");
    expect(res.structuredContent.text).toContain("Be direct.");
    expect(res.structuredContent.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(res.structuredContent.size).toBe(200);
    expect(res.structuredContent.etag).toBe('"e1"');
  });

  it("returns { not_found: true } when the path does not exist (no isError)", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_read")!({
      path: "brand/missing.md",
    } as never)) as {
      isError?: boolean
      structuredContent: { not_found: boolean; path: string }
    };

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.not_found).toBe(true);
    expect(res.structuredContent.path).toBe("brand/missing.md");
  });

  it("refuses to read another org's object via path traversal (defense-in-depth)", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_read")!({
      path: "../22222222-2222-2222-2222-222222222222/brand/secret/leak.md",
    } as never)) as { isError: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/parent-directory/);
  });

  it("refuses absolute paths", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault, ALLOW_ALL);

    const res = (await handlers.get("robynn_vault_read")!({
      path: "/etc/passwd",
    } as never)) as { isError: boolean };
    expect(res.isError).toBe(true);
  });
});

describe("VaultR2 constructor", () => {
  it("requires organizationId", () => {
    const bucket = makeFakeBucket([]);
    expect(() => new VaultR2(bucket, "")).toThrow(/organizationId/);
  });
});

// ----------------------------------------------------------------------------
// COS-PLUGIN-001 P10: no R2 operation without the Worker preflight's stamp.
// ----------------------------------------------------------------------------

const APP_GRANT = "6f0c0000-0000-4000-8000-00000000000a";
const OTHER_GRANT = "6f0c0000-0000-4000-8000-00000000000b";
const hardenedProps = { authVersion: 2, appGrantId: APP_GRANT, organizationId: ORG };

function extraWith(stamp: unknown) {
  return {
    requestInfo: {
      headers: stamp === undefined ? {} : { [PREFLIGHT_HEADER]: typeof stamp === "string" ? stamp : JSON.stringify(stamp) },
    },
  };
}

async function callGated(
  tool: "robynn_vault_list" | "robynn_vault_read",
  gate: VaultGate | undefined,
  extra: unknown,
) {
  const calls: string[] = [];
  const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
  } as never;
  const vault = new VaultR2(makeFakeBucket(fixture(), calls), ORG);
  if (gate) registerVaultTools(server, vault, gate);
  else registerVaultTools(server, vault);
  const args = tool === "robynn_vault_list" ? { prefix: "brand/" } : { path: "brand/voice-attribute/direct.md" };
  const result = (await handlers.get(tool)!(args, extra)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: { error?: { code: string; retryable: boolean } };
  };
  return { result, calls };
}

describe("registerVaultTools — P10 authorization gate (fails closed before R2)", () => {
  const stamped = (tools: string[], appGrantId = APP_GRANT) => extraWith({ appGrantId, tools });

  it.each(["robynn_vault_list", "robynn_vault_read"] as const)(
    "%s: the default gate denies every call and never touches R2",
    async (tool) => {
      const { result, calls } = await callGated(tool, undefined, stamped([tool]));
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "authorization_unavailable", retryable: true });
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^authorization_unavailable: /) });
      expect(calls).toEqual([]);
    },
  );

  it.each(["robynn_vault_list", "robynn_vault_read"] as const)(
    "%s: runs only with a preflight stamp for this tool and this grant",
    async (tool) => {
      const gate = createVaultGate(() => hardenedProps);
      const ok = await callGated(tool, gate, stamped([tool]));
      expect(ok.result.isError).toBeFalsy();
      expect(ok.calls).toHaveLength(1);

      const denials = [
        extraWith(undefined), // no stamp: request did not pass the Worker preflight
        stamped([tool], OTHER_GRANT), // stamp for another grant
        stamped(["robynn_status"]), // stamp for another tool
        extraWith("{not json"),
        extraWith({ appGrantId: APP_GRANT, tools: tool }), // tools not a list
        undefined,
      ];
      for (const extra of denials) {
        const denied = await callGated(tool, gate, extra);
        expect(denied.result.isError).toBe(true);
        expect(denied.result.structuredContent?.error?.code).toBe("authorization_unavailable");
        expect(denied.calls).toEqual([]);
      }
    },
  );

  it("denies legacy (non-v2) or grant-less session props even with a stamp", async () => {
    for (const props of [
      undefined,
      { ...hardenedProps, authVersion: 1 },
      { ...hardenedProps, appGrantId: undefined },
      { ...hardenedProps, appGrantId: "not-a-uuid" },
    ]) {
      const gate = createVaultGate(() => props as never);
      const { result, calls } = await callGated("robynn_vault_read", gate, stamped(["robynn_vault_read"]));
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    }
  });
});

describe("VaultR2 — P10 bounds", () => {
  it("refuses an object over MAX_VAULT_OBJECT_BYTES without reading its body", async () => {
    const big: FakeObject = {
      key: `orgs/${ORG}/sources/website/huge.md`,
      size: MAX_VAULT_OBJECT_BYTES + 1,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"big"',
      body: "x",
    };
    const bucket = makeFakeBucket([big]) as unknown as { get(key: string): Promise<{ text: ReturnType<typeof vi.fn>; body: { cancel: ReturnType<typeof vi.fn> } }> };
    const gets: Array<Awaited<ReturnType<typeof bucket.get>>> = [];
    const original = bucket.get.bind(bucket);
    bucket.get = async (key: string) => {
      const obj = await original(key);
      gets.push(obj);
      return obj;
    };
    const vault = new VaultR2(bucket as never, ORG);
    await expect(vault.read("sources/website/huge.md")).rejects.toThrow(/too large/);
    expect(gets[0].text).not.toHaveBeenCalled();
    expect(gets[0].body.cancel).toHaveBeenCalledOnce();
  });

  it("reads an object exactly at the limit", async () => {
    const edge: FakeObject = {
      key: `orgs/${ORG}/edge.md`,
      size: MAX_VAULT_OBJECT_BYTES,
      uploaded: new Date("2026-04-29T05:00:00Z"),
      etag: '"edge"',
      body: "edge",
    };
    const vault = new VaultR2(makeFakeBucket([edge]), ORG);
    await expect(vault.read("edge.md")).resolves.toMatchObject({ text: "edge" });
  });

  it("refuses over-long paths, prefixes and cursors before calling R2", async () => {
    const calls: string[] = [];
    const vault = new VaultR2(makeFakeBucket(fixture(), calls), ORG);
    const long = "a".repeat(MAX_VAULT_PATH_LENGTH + 1);
    await expect(vault.read(long)).rejects.toThrow(/at most/);
    await expect(vault.list({ prefix: long })).rejects.toThrow(/at most/);
    await expect(vault.list({ cursor: "c".repeat(2000) })).rejects.toThrow(/cursor/);
    expect(calls).toEqual([]);
  });
});

describe("VaultR2 — private-memory paths (P16, defense in depth behind P09b)", () => {
  const memory = (name: string, body = "x"): FakeObject => ({
    key: `orgs/${ORG}/sources/agent-memory/${name}`,
    size: body.length,
    uploaded: new Date("2026-04-29T05:00:00Z"),
    etag: '"m"',
    body,
  });

  it.each([
    ["sources/agent-memory/user-0c05a001-voice.md", true],
    ["sources/agent-memory/user-tone.embedding.json", true],
    ["sources/agent-memory/session-run-1-notes.md", true],
    ["sources/agent-memory/USER-tone.md", true],
    ["./sources//agent-memory/user-tone.md", true],
    ["sources/agent-memory/org-brand-voice.md", false],
    ["sources/agent-memory/org-user-guide.md", false],
    ["sources/agent-memory/users-list.md", false],
    ["sources/website/user-guide.md", false],
    ["brand/user-personas/primary.md", false],
    // P16 review N7: only top-level sources/ holds agent memory.
    ["brand/agent-memory/user-tone.md", false],
    ["archive/agent-memory/session-run-1-notes.md", false],
    ["sources/agent-memory/", false],
  ])("isPrivateMemoryVaultPath(%s) = %s", (path, expected) => {
    expect(isPrivateMemoryVaultPath(path)).toBe(expected);
  });

  it("read() answers a private-memory path as not found without calling R2", async () => {
    const calls: string[] = [];
    const vault = new VaultR2(makeFakeBucket([memory("user-tone.md", "PRIVATE")], calls), ORG);
    await expect(vault.read("sources/agent-memory/user-tone.md")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("list() drops private-memory entries and keeps org-shared memory; the cursor still advances", async () => {
    const vault = new VaultR2(
      makeFakeBucket([memory("user-a-voice.md"), memory("org-brand-voice.md"), memory("session-1-notes.md"), memory("org-tone.md")]),
      ORG,
    );
    const first = await vault.list({ prefix: "sources/agent-memory/", limit: 2 });
    expect(first.entries.map((e) => e.path)).toEqual(["sources/agent-memory/org-brand-voice.md"]);
    expect(first.truncated).toBe(true);
    const second = await vault.list({ prefix: "sources/agent-memory/", limit: 2, cursor: first.cursor! });
    expect(second.entries.map((e) => e.path)).toEqual(["sources/agent-memory/org-tone.md"]);
    expect(second.cursor).toBeNull();
  });
});
