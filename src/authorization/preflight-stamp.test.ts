import { describe, expect, it } from "vitest";

import { connectionFromStamp } from "../tools/status";
import { encodePreflightStamp, readPreflightStamp, type PreflightStamp } from "./preflight-stamp";
import { PREFLIGHT_HEADER } from "./session-binding";

const GRANT = "9a1b2c3d-0000-4000-8000-000000000001";
const ORG = "9a1b2c3d-0000-4000-8000-0000000000aa";

const extraWith = (raw: unknown) => ({ requestInfo: { headers: { [PREFLIGHT_HEADER]: raw } } });

describe("preflight stamp (P10 vault gate + P17 robynn_status)", () => {
  it("round-trips organization and effective scopes through a header-safe value", () => {
    const stamp: PreflightStamp = {
      appGrantId: GRANT,
      tools: ["robynn_status"],
      organization: { id: ORG, name: "Ünïcode Org 東京 🚀" },
      scopes: ["brand:read", "tools:execute"],
    };
    const encoded = encodePreflightStamp(stamp);
    // Headers are ByteStrings: a raw non-Latin-1 character would throw in Headers.set.
    expect(encoded).toMatch(/^[\x20-\x7e]*$/);
    expect(() => new Headers({ [PREFLIGHT_HEADER]: encoded })).not.toThrow();
    expect(readPreflightStamp(extraWith(encoded))).toEqual(stamp);
  });

  it("bounds the organization name and keeps a null name", () => {
    const long = encodePreflightStamp({ appGrantId: GRANT, tools: [], organization: { id: ORG, name: "x".repeat(500) } });
    expect(readPreflightStamp(extraWith(long))!.organization!.name).toHaveLength(200);
    const nameless = encodePreflightStamp({ appGrantId: GRANT, tools: [], organization: { id: ORG, name: null } });
    expect(readPreflightStamp(extraWith(nameless))!.organization).toEqual({ id: ORG, name: null });
  });

  it.each([
    ["absent", undefined],
    ["not JSON", "x"],
    ["not an object", "1"],
    ["no grant", JSON.stringify({ tools: [] })],
    ["tools not strings", JSON.stringify({ appGrantId: GRANT, tools: [1] })],
  ])("malformed stamp (%s) ⇒ null", (_label, raw) => {
    expect(readPreflightStamp(raw === undefined ? {} : extraWith(raw))).toBeNull();
  });

  it("drops unknown scopes and malformed organizations instead of trusting them", () => {
    const stamp = readPreflightStamp(
      extraWith(JSON.stringify({ appGrantId: GRANT, tools: [], organization: { name: "no id" }, scopes: ["brand:read", "admin"] })),
    );
    expect(stamp).toEqual({ appGrantId: GRANT, tools: [] });
  });
});

describe("robynn_status connection report", () => {
  const full: PreflightStamp = {
    appGrantId: GRANT,
    tools: ["robynn_status"],
    organization: { id: ORG, name: "Synthetic" },
    scopes: ["brand:read"],
  };

  it("reports the verified organization and permissions", () => {
    expect(connectionFromStamp(full, GRANT)).toEqual({
      organization: { id: ORG, name: "Synthetic" },
      permissions: ["brand:read"],
      can_execute: false,
    });
    expect(connectionFromStamp({ ...full, scopes: ["brand:read", "tools:execute"] }, GRANT)!.can_execute).toBe(true);
  });

  it("reports nothing for another grant's stamp, an incomplete stamp or no stamp (CLI)", () => {
    expect(connectionFromStamp(full, "9a1b2c3d-0000-4000-8000-000000000002")).toBeNull();
    expect(connectionFromStamp(full, undefined)).toBeNull();
    expect(connectionFromStamp({ appGrantId: GRANT, tools: [] }, GRANT)).toBeNull();
    expect(connectionFromStamp(null, GRANT)).toBeNull();
  });
});
