import { afterEach, describe, expect, it, vi } from "vitest";
import { errorKind, redactLogString, safeLog } from "./safe-log";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExIiwib3JnIjoiYWFhYSJ9.c2lnbmF0dXJlLXZhbHVl";
const PROVIDER_TOKEN = "user-1234:grantABCDEFGH:secretSECRETsecret0123456789";

afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => void lines.push(line));
  }
  return lines;
}

describe("redactLogString", () => {
  it.each([
    [`https://host.test/callback?code=CANARY1&state=CANARY2#frag`, "https://host.test/callback"],
    [`robynn-host://oauth/cb?code=CANARY1`, "robynn-host://oauth/cb"],
    [`Bearer ${JWT}`, "Bearer [redacted]"],
    [`token ${PROVIDER_TOKEN}`, "token [redacted]"],
    ["code=CANARY1&state=CANARY2", "code=[redacted]&state=[redacted]"],
    ["refresh_token=CANARY3 other", "refresh_token=[redacted] other"],
    ["opaque Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA== end", "opaque [redacted] end"],
    ["line1\nline2\u2028x", "line1 line2 x"],
  ])("%j ⇒ %j", (input, expected) => {
    expect(redactLogString(input)).toBe(expected);
  });

  it("truncates long values", () => {
    expect(redactLogString("a ".repeat(200)).length).toBeLessThanOrEqual(161);
  });
});

describe("safeLog", () => {
  it("emits one JSON line with sanitized fields", () => {
    const lines = capture();
    safeLog.warn("oauth.callback.rejected", { reason: "upstream_exchange_rejected", upstreamStatus: 400, ok: false });
    expect(lines).toEqual(['{"event":"oauth.callback.rejected","reason":"upstream_exchange_rejected","upstreamStatus":400,"ok":false}']);
  });

  it("redacts sensitive field names regardless of value", () => {
    const lines = capture();
    safeLog.error("x.y", {
      code: "CANARY",
      state: "CANARY",
      accessToken: "CANARY",
      refresh_token: "CANARY",
      location: "CANARY",
      responseBody: "CANARY",
      cookie: "CANARY",
      authorization: "CANARY",
      codeVerifier: "CANARY",
      query: "CANARY",
      props: "CANARY",
      mcpSessionId: "CANARY",
    });
    expect(lines[0]).not.toContain("CANARY");
  });

  it("drops non-primitive values, invalid field names and invalid event names", () => {
    const lines = capture();
    safeLog.info("Bad Event!", {
      nested: { token: "CANARY" } as never,
      fn: (() => "CANARY") as never,
      "weird key": "CANARY",
      nan: Number.NaN,
      fine: 1,
    });
    expect(lines[0]).toBe('{"event":"invalid_event_name","fine":1}');
  });
});

describe("errorKind", () => {
  it("returns the error name only, never the message", () => {
    const err = new Error("upstream said code=CANARY body CANARY");
    expect(errorKind(err)).toBe("Error");
    class FancyError extends Error {
      name = "Fancy Error <x>";
    }
    expect(errorKind(new FancyError("CANARY"))).toBe("Error");
    expect(errorKind(new TypeError("CANARY"))).toBe("TypeError");
    expect(errorKind("CANARY")).toBe("string");
  });
});

describe("redactLogString is linear on hostile input (P06 review B1)", () => {
  it.each([
    ["word run", "a".repeat(100_000)],
    ["dotted", "a.".repeat(50_000)],
    ["colon runs", "aaaa:".repeat(20_000)],
    ["url-ish", "x://".repeat(25_000)],
    ["jwt-ish", "eyJ.".repeat(25_000)],
    ["key=value", "code=".repeat(20_000)],
  ])("100 KB %s in well under 50 ms", (_l, value) => {
    const lines = capture();
    const started = performance.now();
    safeLog.info("x.y", { reason: value });
    redactLogString(value);
    expect(performance.now() - started).toBeLessThan(50);
    expect(lines[0].length).toBeLessThan(300);
  });

  it("drops a token split by the input cap instead of leaking its prefix", () => {
    const secret = "Zm9vYmFyYmF6cXV4CANARYSECRET";
    const value = `${"a ".repeat(254)}x${secret}`;
    expect(redactLogString(value)).not.toContain("Zm9v");
  });
});
