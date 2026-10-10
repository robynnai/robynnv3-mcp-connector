/**
 * COS-PLUGIN-001 P11 review B2: a failed or cancelled CMO run reaches the
 * model as a terminal result with its reason, not as a generic outage.
 *
 * The app now answers GET /api/agents/cmo/runs/{id} for a failed or
 * cancelled run with 200 `{ success: true, data: { status: "failed",
 * cancelled, output: "<short reason>" } }` instead of a 500 (whose message
 * the client hides and which a retry-safe GET would resend).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RobynnClient } from "./robynn-client";
import { registerRunTools } from "./tools/runs";

function failedRun(cancelled = false) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        id: "run-1",
        status: "failed",
        cancelled,
        thread_id: "thread-1",
        output: cancelled ? "Run was cancelled." : "Run failed: brand context missing",
        tokens_used: null,
      },
    }),
  );
}

function stub(respond: () => Response) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    requests.push(new URL(String(input)).pathname);
    return respond();
  });
  return requests;
}

function client() {
  return new RobynnClient("https://robynn.test", "token", { retryDelayMs: 0 });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("failed and cancelled CMO runs", () => {
  it("getRun returns the failed run in one request", async () => {
    const requests = stub(() => failedRun());
    await expect(client().getRun("run-1")).resolves.toMatchObject({
      data: { status: "failed", output: "Run failed: brand context missing" },
    });
    expect(requests).toEqual(["/api/agents/cmo/runs/run-1"]);
  });

  it("pollRun stops at the first failed or cancelled answer", async () => {
    for (const cancelled of [false, true]) {
      vi.restoreAllMocks();
      const requests = stub(() => failedRun(cancelled));
      await expect(client().pollRun("run-1", 60_000)).resolves.toMatchObject({
        data: { status: "failed", cancelled },
      });
      expect(requests).toHaveLength(1);
    }
  });

  it("pollRun also treats a raw cancelled status as terminal", async () => {
    const requests = stub(
      () => new Response(JSON.stringify({ success: true, data: { id: "run-1", status: "cancelled" } })),
    );
    await expect(client().pollRun("run-1", 60_000)).resolves.toMatchObject({
      data: { status: "cancelled" },
    });
    expect(requests).toHaveLength(1);
  });

  it("robynn_run_status reports the failure reason to the model", async () => {
    stub(() => failedRun());
    const handlers = new Map<string, (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
    const server = {
      tool: (...args: unknown[]) => {
        handlers.set(args[0] as string, args[args.length - 1] as never);
      },
    };
    registerRunTools(server as never, client());

    const result = await handlers.get("robynn_run_status")!({ run_id: "run-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Run failed: brand context missing");
    expect(result.content[0].text).not.toContain("failed to complete the request");
  });
});

describe("401 without a refresh hook (P10-compatible)", () => {
  it("throws a fixed authorization_expired RobynnApiError after one request", async () => {
    const requests = stub(
      () => new Response(JSON.stringify({ message: "grant revoked canary-body", code: "grant_revoked" }), { status: 401 }),
    );

    const error = await client()
      .getStatus()
      .catch((err: unknown) => err);

    const { RobynnApiError, UpstreamAuthorizationExpiredError } = await import("./robynn-client");
    expect(error).toBeInstanceOf(UpstreamAuthorizationExpiredError);
    expect(error).toBeInstanceOf(RobynnApiError);
    expect(error).toMatchObject({ status: 401, code: "authorization_expired" });
    expect((error as Error).message).toMatch(/^authorization_expired: /);
    expect((error as Error).message).not.toContain("canary-body");
    expect(requests).toHaveLength(1);
  });
});
