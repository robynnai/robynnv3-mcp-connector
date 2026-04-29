import { describe, expect, it, vi } from "vitest";

import { registerVaultTools } from "./vault";
import { VaultR2 } from "../vault-r2";

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

function makeFakeBucket(objects: FakeObject[]) {
  const byKey = new Map(objects.map((o) => [o.key, o]));
  return {
    async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
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
      const obj = byKey.get(key);
      if (!obj) return null;
      return {
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
        etag: obj.etag,
        httpMetadata: { contentType: obj.contentType ?? "text/plain" },
        text: () => Promise.resolve(obj.body),
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
  const tool = vi.fn((...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Handler;
    handlers.set(name, handler);
  });
  const server = { tool } as never;
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
    registerVaultTools(server, vault);

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
    registerVaultTools(server, vault);

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
    registerVaultTools(server, vault);

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
    registerVaultTools(server, vault);

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
    registerVaultTools(server, vault);

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
    registerVaultTools(server, vault);

    const res = (await handlers.get("robynn_vault_read")!({
      path: "../22222222-2222-2222-2222-222222222222/brand/secret/leak.md",
    } as never)) as { isError: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/parent-directory/);
  });

  it("refuses absolute paths", async () => {
    const { server, handlers } = createServerHarness();
    const vault = new VaultR2(makeFakeBucket(fixture()), ORG);
    registerVaultTools(server, vault);

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
