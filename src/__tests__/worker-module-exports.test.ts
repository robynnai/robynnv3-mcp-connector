/**
 * workerd refuses to start a Worker whose main module exports anything other
 * than handlers, Durable Object / entrypoint classes or functions ("Incorrect
 * type for map entry ..."). Found live in P10 with an exported string; this
 * pins the rule so the next one fails here instead of at `wrangler dev`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, env: {} }));
vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));

describe("src/index.ts exports", () => {
  it("are only functions/classes plus the default fetch handler", async () => {
    const mod = (await import("../index")) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") {
        expect(typeof (value as { fetch?: unknown }).fetch).toBe("function");
        continue;
      }
      expect(typeof value, `export ${name}`).toBe("function");
    }
    expect(Object.keys(mod)).toEqual(expect.arrayContaining(["RobynnMCP", "RefreshCoordinator", "default"]));
  });
});
