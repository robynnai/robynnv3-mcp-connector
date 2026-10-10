/**
 * COS-PLUGIN-001 P11 (plan §5 "OAuth codes and upstream errors can reach
 * logs/model errors"): RobynnClient errors and logs carry no upstream bodies,
 * tokens or query strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RobynnApiError, RobynnClient } from "./robynn-client";

const JWT_CANARY =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnktdXNlciJ9.c2lnbmF0dXJlLWNhbmFyeS12YWx1ZQ";
const REFRESH_CANARY = "rrt_CanaryRefreshToken0123456789abcdef";
const SECRET_CANARY = "CanarySecretValue9f8e7d6c5b4a39281706";

let logged: string[] = [];

function captureConsole() {
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
}

function respondWith(response: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

function client(options: ConstructorParameters<typeof RobynnClient>[2] = {}) {
  return new RobynnClient("https://robynn.test", "access-token-canary", {
    retryDelayMs: 0,
    ...options,
  });
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(RobynnApiError);
  return error as RobynnApiError;
}

function expectNoCanary(text: string) {
  for (const canary of [JWT_CANARY, REFRESH_CANARY, SECRET_CANARY, "access-token-canary", "canary-key"]) {
    expect(text).not.toContain(canary);
  }
}

beforeEach(captureConsole);
afterEach(() => vi.restoreAllMocks());

describe("RobynnApiError messages", () => {
  it("keeps the app's code, required scope and short message for a denial", async () => {
    respondWith(
      () =>
        new Response(
          JSON.stringify({
            message:
              "This connection is read-only. Reconnect Robynn and allow execution to use this tool.",
            code: "insufficient_scope",
            retryable: false,
            required_scope: "tools:execute",
          }),
          { status: 403 },
        ),
    );

    const error = await failure(client().websiteAudit({} as never));
    expect(error.status).toBe(403);
    expect(error.code).toBe("insufficient_scope");
    expect(error.requiredScope).toBe("tools:execute");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      "API error 403 (insufficient_scope): This connection is read-only. Reconnect Robynn and allow execution to use this tool.",
    );
  });

  it("reads the JSON-envelope error shape ({ success:false, error, error_code })", async () => {
    respondWith(
      () =>
        new Response(
          JSON.stringify({ success: false, error: "Membership is not active.", error_code: "membership_inactive" }),
          { status: 403 },
        ),
    );

    const error = await failure(client().getConnectedAppCapabilities());
    expect(error.message).toBe("API error 403 (membership_inactive): Membership is not active.");
  });

  it("never echoes a 5xx body, even a JSON one", async () => {
    respondWith(
      () =>
        new Response(
          JSON.stringify({
            message: `connector action failed: provider said ${SECRET_CANARY} at /internal/stack`,
            code: "upstream_failure",
            stack: `Error: boom\n    at ${REFRESH_CANARY}`,
          }),
          { status: 502 },
        ),
    );

    const error = await failure(client().actOnConnectedApp({} as never));
    expect(error.message).toBe(
      "API error 502 (upstream_failure): The Robynn service failed to complete the request.",
    );
    expectNoCanary(error.message);
  });

  it("never echoes a non-JSON body", async () => {
    respondWith(
      () =>
        new Response(`<html><body>Bearer ${JWT_CANARY} ${REFRESH_CANARY}</body></html>`, {
          status: 404,
        }),
    );

    const error = await failure(client().getStatus());
    expect(error.message).toBe("API error 404: Not found.");
  });

  it("redacts tokens and query strings inside a 4xx message", async () => {
    respondWith(
      () =>
        new Response(
          JSON.stringify({
            message: `Bad callback https://evil.test/cb?code=${SECRET_CANARY}&state=x with ${JWT_CANARY}`,
            code: "invalid_request",
          }),
          { status: 400 },
        ),
    );

    const error = await failure(client().getStatus());
    expect(error.message).toContain("API error 400 (invalid_request): Bad callback https://evil.test/cb");
    expectNoCanary(error.message);
  });

  it("drops codes that are not plain identifiers", async () => {
    respondWith(
      () =>
        new Response(JSON.stringify({ message: "nope", code: `x ${SECRET_CANARY}` }), { status: 409 }),
    );

    const error = await failure(client().getStatus());
    expect(error.code).toBeNull();
    expect(error.message).toBe("API error 409: nope");
  });

  it("caps a long 4xx message", async () => {
    respondWith(
      () => new Response(JSON.stringify({ message: "word ".repeat(400) }), { status: 400 }),
    );

    const error = await failure(client().getStatus());
    expect(error.message.length).toBeLessThan(220);
  });

  it("does not leak an unparseable success body", async () => {
    respondWith(() => new Response(`<!DOCTYPE html> ${SECRET_CANARY}`, { status: 200 }));

    const error = await failure(client().getStatus());
    expect(error.code).toBe("invalid_response");
    expectNoCanary(error.message);
  });

  it("does not leak a network error message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(`fetch failed https://robynn.test/api/cli/memory?key=canary-key&token=${SECRET_CANARY}`),
    );

    const error = await failure(client().getHermesMemory("org", "canary-key"));
    expect(error.code).toBe("network_error");
    expect(error.message).toBe("The Robynn API could not be reached.");
  });
});

describe("RobynnClient logs", () => {
  it("logs the pathname only, never the query string, token or body", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue(REFRESH_CANARY);
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(`expired ${JWT_CANARY}`, { status: 401 });
      if (call === 2) return new Response(`down ${SECRET_CANARY}`, { status: 503 });
      return new Response(`still down ${SECRET_CANARY}`, { status: 503 });
    });

    await failure(client({ refreshAccessToken }).getHermesMemory("org", "canary-key"));

    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join("\n");
    expectNoCanary(all);
    expect(all).not.toContain("?");
    expect(all).toContain('"route":"api.cli.memory"');
    expect(all).toContain('"event":"robynn_api.unauthorized"');
    expect(all).toContain('"event":"robynn_api.token_refreshed"');
    expect(all).toContain('"event":"robynn_api.retry"');
  });

  it("logs a network-error retry by error kind only", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(`connect failed ${SECRET_CANARY}`),
    );

    await failure(client().getUsage());
    const all = logged.join("\n");
    expectNoCanary(all);
    expect(all).toContain('"error_kind":"TypeError"');
  });
});
