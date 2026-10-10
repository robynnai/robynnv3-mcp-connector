/**
 * COS-PLUGIN-001 P11 review B2/B3: a failed or cancelled CMO run reaches the
 * model as an error carrying its reason, never as a generic outage and never
 * as a successful result.
 *
 * The app answers GET /api/agents/cmo/runs/{id} for a failed or cancelled run
 * with 200 `{ success: true, data: { status: "failed", cancelled, output:
 * "<short reason>" } }`. getRun returns that as data (robynn_run_status
 * reports it); pollRun rejects with RobynnRunFailedError, so the starter tools
 * and CLI commands that poll report an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RobynnApiError,
  RobynnClient,
  RobynnRunFailedError,
  UpstreamAuthorizationExpiredError,
} from "./robynn-client";
import { registerAssistTools } from "./tools/assist";
import { registerContentTools } from "./tools/content";
import { registerResearchTools } from "./tools/research";
import { registerRunTools } from "./tools/runs";

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Fake MCP server for both registration APIs: `server.tool(...)` (this
 * branch) and `server.registerTool(...)` (P12 and later). The handler is the
 * last argument in both.
 */
function fakeServer() {
  const handlers = new Map<string, Handler>();
  const register = (...args: unknown[]) => {
    handlers.set(args[0] as string, args[args.length - 1] as Handler);
  };
  return { server: { tool: register, registerTool: register } as never, handlers };
}

function failedRun(output: string, cancelled = false) {
  return {
    success: true,
    data: { id: "run-1", status: "failed", cancelled, thread_id: "thread-1", output, tokens_used: null },
  };
}

/** Thread create → run start → run poll, with the poll answering `run`. */
function stubApp(run: unknown) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/agents/cmo/threads") {
      return new Response(JSON.stringify({ success: true, data: { id: "thread-1" } }));
    }
    if (path.endsWith("/runs")) {
      return new Response(JSON.stringify({ success: true, data: { run_id: "run-1" } }));
    }
    return new Response(JSON.stringify(run));
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

describe("getRun and robynn_run_status", () => {
  it("getRun returns the failed run as data in one request", async () => {
    const requests = stubApp(failedRun("Run failed: brand context missing"));
    await expect(client().getRun("run-1")).resolves.toMatchObject({
      data: { status: "failed", output: "Run failed: brand context missing" },
    });
    expect(requests).toEqual(["GET /api/agents/cmo/runs/run-1"]);
  });

  it("robynn_run_status reports the failure reason as an error", async () => {
    stubApp(failedRun("Run failed: brand context missing"));
    const { server, handlers } = fakeServer();
    registerRunTools(server, client());

    const result = await handlers.get("robynn_run_status")!({ run_id: "run-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Run failed: brand context missing");
  });
});

describe("pollRun (B3)", () => {
  it("rejects a failed run with its reason after one poll", async () => {
    const requests = stubApp(failedRun("Run failed: brand context missing"));

    const error = await client()
      .pollRun("run-1", 60_000)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RobynnRunFailedError);
    expect(error).toBeInstanceOf(RobynnApiError);
    expect(error).toMatchObject({ code: "run_failed", cancelled: false, runId: "run-1" });
    expect((error as Error).message).toBe("Run failed: brand context missing");
    expect(requests).toHaveLength(1);
  });

  it("rejects a cancelled run (flag or raw status) as run_cancelled", async () => {
    for (const run of [
      failedRun("Run was cancelled.", true),
      { success: true, data: { id: "run-1", status: "cancelled" } },
    ]) {
      vi.restoreAllMocks();
      const requests = stubApp(run);
      await expect(client().pollRun("run-1", 60_000)).rejects.toMatchObject({
        code: "run_cancelled",
        cancelled: true,
        message: "Run was cancelled.",
      });
      expect(requests).toHaveLength(1);
    }
  });

  it("still resolves a completed run", async () => {
    stubApp({ success: true, data: { id: "run-1", status: "completed", output: "done" } });
    await expect(client().pollRun("run-1", 60_000)).resolves.toMatchObject({
      data: { status: "completed", output: "done" },
    });
  });

  it("scrubs tokens from the reason and never reads as a poll timeout", async () => {
    stubApp(
      failedRun(
        "Run failed: Run timed out calling eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWNhbmFyeQ",
      ),
    );

    const error = (await client()
      .pollRun("run-1", 60_000)
      .catch((err: unknown) => err)) as Error;

    expect(error.message).not.toContain("eyJ");
    expect(error.message).not.toMatch(/run timed out/i);
    expect(error.message).toContain("run hit a timeout");
  });
});

describe("starter tools report a failed run as an error (B3)", () => {
  const cases: Array<[string, (s: never, c: RobynnClient) => void, Record<string, unknown>]> = [
    ["robynn_create_content", registerContentTools, { type: "blog_post", topic: "pricing" }],
    ["robynn_research", registerResearchTools, { query: "competitors" }],
    ["robynn_assist", registerAssistTools, { message: "help" }],
  ];

  for (const [name, register, args] of cases) {
    it(`${name}: isError with the run's reason`, async () => {
      stubApp(failedRun("Run failed: brand context missing"));
      const { server, handlers } = fakeServer();
      register(server, client());

      const result = await handlers.get(name)!(args);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Run failed: brand context missing");
    });

    it(`${name}: a cancelled run is an error too`, async () => {
      stubApp(failedRun("Run was cancelled.", true));
      const { server, handlers } = fakeServer();
      register(server, client());

      const result = await handlers.get(name)!(args);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Run was cancelled.");
    });
  }
});

describe("401 without a refresh hook (P10-compatible)", () => {
  it("throws a fixed authorization_expired RobynnApiError after one request, keeping the app code", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({ message: "grant revoked canary-body", code: "grant_revoked" }),
        { status: 401 },
      );
    });

    const error = await client()
      .getStatus()
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UpstreamAuthorizationExpiredError);
    expect(error).toBeInstanceOf(RobynnApiError);
    expect(error).toMatchObject({
      status: 401,
      code: "authorization_expired",
      upstreamCode: "grant_revoked",
    });
    expect((error as Error).message).toMatch(/^authorization_expired: /);
    expect((error as Error).message).not.toContain("canary-body");
    expect(requests).toHaveLength(1);
  });
});
