import { describe, expect, it } from "vitest";

import {
  admitStartProps,
  admitUpgrade,
  bindingFromProps,
  isPlausibleSessionId,
  SESSION_BINDING_STORAGE_KEY,
  serializeBinding,
  shouldAdoptProps,
  stripInternalHeaders,
} from "./session-binding";

// COS-PLUGIN-001 P10: the immutable session binding (contract D7).

const A = { hostGrantId: "hostA", userId: "user-a", organizationId: "org-a", appGrantId: "grant-a" };
const B = { hostGrantId: "hostB", userId: "user-b", organizationId: "org-b", appGrantId: "grant-b" };

function storage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key: string) {
      return data.get(key);
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
  };
}

function jwtWithExp(exp: number) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ exp })}.sig`;
}

describe("admitStartProps (cold start, F17)", () => {
  it("binds the first complete props, then adopts only the same binding", async () => {
    const s = storage();
    expect(await admitStartProps(s, { ...A, accessToken: "a" })).toMatchObject({ outcome: "bound" });
    expect(s.data.get(SESSION_BINDING_STORAGE_KEY)).toEqual(A);
    expect(await admitStartProps(s, { ...A, accessToken: "a2" })).toMatchObject({ outcome: "matched" });
    expect(await admitStartProps(s, { ...B, accessToken: "b" })).toEqual({ adopt: undefined, outcome: "refused" });
    expect(s.data.get(SESSION_BINDING_STORAGE_KEY)).toEqual(A);
  });

  it.each([
    ["host grant", { hostGrantId: "other" }],
    ["user", { userId: "user-b" }],
    ["organization", { organizationId: "org-b" }],
    ["app grant", { appGrantId: "grant-b" }],
  ])("refuses props that differ only in the %s", async (_label, change) => {
    const s = storage({ [SESSION_BINDING_STORAGE_KEY]: A });
    expect((await admitStartProps(s, { ...A, ...change })).outcome).toBe("refused");
  });

  it("never binds incomplete props and passes through a props-less start", async () => {
    const s = storage();
    expect((await admitStartProps(s, { userId: "u", organizationId: "o" })).outcome).toBe("refused");
    expect(s.data.size).toBe(0);
    expect(await admitStartProps(s, undefined)).toEqual({ adopt: undefined, outcome: "no_props" });
  });
});

describe("admitUpgrade", () => {
  it("requires the Worker's header to match the stored binding", async () => {
    const s = storage({ [SESSION_BINDING_STORAGE_KEY]: A });
    expect(await admitUpgrade(s, serializeBinding(A))).toBe(true);
    expect(await admitUpgrade(s, serializeBinding(B))).toBe(false);
    expect(await admitUpgrade(s, null)).toBe(false);
    expect(await admitUpgrade(s, "{not json")).toBe(false);
    expect(await admitUpgrade(storage(), serializeBinding(A))).toBe(false); // unbound session
  });
});

describe("shouldAdoptProps (warm session)", () => {
  it("adopts a newer upstream token and never rolls back to an older one", () => {
    const older = { accessToken: jwtWithExp(1000) };
    const newer = { accessToken: jwtWithExp(2000) };
    expect(shouldAdoptProps(older, newer)).toBe(true);
    expect(shouldAdoptProps(newer, older)).toBe(false);
    expect(shouldAdoptProps(newer, newer)).toBe(false);
    expect(shouldAdoptProps(undefined, older)).toBe(true);
    expect(shouldAdoptProps({ accessToken: "opaque" }, newer)).toBe(true);
  });
});

describe("helpers", () => {
  it("strips client-supplied internal headers, case-insensitively", () => {
    const headers = new Headers({
      Authorization: "Bearer t",
      "X-Robynn-Session-Binding": "x",
      "x-robynn-preflight": "x",
      "X-PartyKit-Props": "{}",
      "x-partykit-room": "r",
      "CF-MCP-Message": "m",
      "mcp-session-id": "s",
    });
    expect([...stripInternalHeaders(headers).keys()].sort()).toEqual(["authorization", "mcp-session-id"]);
  });

  it("bounds session ids and requires complete binding fields", () => {
    expect(isPlausibleSessionId("abc123")).toBe(true);
    expect(isPlausibleSessionId("")).toBe(false);
    expect(isPlausibleSessionId("a".repeat(257))).toBe(false);
    expect(isPlausibleSessionId("has space")).toBe(false);
    expect(bindingFromProps({ ...A, appGrantId: "" })).toBeNull();
    expect(bindingFromProps(null)).toBeNull();
  });
});
