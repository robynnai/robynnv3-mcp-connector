import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  introspectUpstreamGrant,
  parseUpstreamTokenResponse,
  readUpstreamGrantCandidate,
  type UpstreamGrantCandidate,
} from "./upstream-grant";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "6f0c0000-0000-4000-8000-00000000000a";
const NOW = 1_800_000_000;

function jwt(claims: Record<string, unknown>) {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}.sig`;
}

const validClaims = {
  iss: "robynn.ai",
  aud: "robynn-api:mcp",
  type: "access",
  sub: USER,
  org: ORG,
  gid: GRANT,
  ver: 3,
  cid: "robynn-mcp-worker",
  scope: "brand:read tools:execute",
  iat: NOW,
  exp: NOW + 3600,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseUpstreamTokenResponse", () => {
  it("accepts a well-formed response", () => {
    expect(parseUpstreamTokenResponse({ access_token: "a.b.c", refresh_token: "r", expires_in: 3600 })).toEqual({
      accessToken: "a.b.c",
      refreshToken: "r",
      expiresIn: 3600,
    });
  });

  it.each([
    [null],
    ["string"],
    [{ access_token: "a" }],
    [{ refresh_token: "r" }],
    [{ access_token: "", refresh_token: "r" }],
    [{ access_token: "a b", refresh_token: "r" }],
    [{ access_token: "a", refresh_token: "r", expires_in: "3600" }],
    [{ access_token: "a", refresh_token: "r", expires_in: -1 }],
    [{ access_token: "a".repeat(9000), refresh_token: "r" }],
  ])("rejects %j", (body) => {
    expect(parseUpstreamTokenResponse(body)).toBeNull();
  });
});

describe("readUpstreamGrantCandidate", () => {
  it("reads a valid candidate", () => {
    expect(readUpstreamGrantCandidate(jwt(validClaims), NOW)).toEqual({
      ok: true,
      candidate: {
        userId: USER,
        organizationId: ORG,
        grantId: GRANT,
        credentialVersion: 3,
        scopes: ["brand:read", "tools:execute"],
      },
    });
  });

  it.each([
    ["not a JWT", "opaque", "upstream_token_malformed"],
    ["bad base64", "a.!!!.c", "upstream_token_malformed"],
    ["array payload", `x.${Buffer.from("[1]").toString("base64url")}.y`, "upstream_token_malformed"],
  ])("rejects %s", (_l, token, reason) => {
    expect(readUpstreamGrantCandidate(token, NOW)).toEqual({ ok: false, reason });
  });

  it.each([
    ["wrong type", { type: "agent_run" }, "upstream_token_wrong_type"],
    ["wrong aud", { aud: "robynn-api:agent-run" }, "upstream_token_wrong_type"],
    ["wrong iss", { iss: "evil" }, "upstream_token_wrong_type"],
    ["wrong cid", { cid: "robynn-cli" }, "upstream_token_wrong_client"],
    ["exp == now", { exp: NOW }, "upstream_token_expired"],
    ["exp string", { exp: String(NOW + 10) }, "upstream_token_expired"],
    ["exp missing", { exp: undefined }, "upstream_token_expired"],
    ["sub unknown", { sub: "unknown" }, "upstream_identity_invalid"],
    ["sub master key", { sub: "organization_master_key" }, "upstream_identity_invalid"],
    ["sub nil", { sub: "00000000-0000-0000-0000-000000000000" }, "upstream_identity_invalid"],
    ["org unknown", { org: "unknown" }, "upstream_identity_invalid"],
    ["org number", { org: 7 }, "upstream_identity_invalid"],
    ["gid missing", { gid: undefined }, "upstream_grant_id_missing"],
    ["gid not uuid", { gid: "grant" }, "upstream_grant_id_invalid"],
    ["ver missing", { ver: undefined }, "upstream_credential_version_invalid"],
    ["ver zero", { ver: 0 }, "upstream_credential_version_invalid"],
    ["ver fraction", { ver: 1.5 }, "upstream_credential_version_invalid"],
    ["scope empty", { scope: "" }, "upstream_scope_invalid"],
    ["scope unknown", { scope: "brand:read admin" }, "upstream_scope_invalid"],
    ["scope duplicate", { scope: "brand:read brand:read" }, "upstream_scope_invalid"],
    ["scope array", { scope: ["brand:read"] }, "upstream_scope_invalid"],
  ])("rejects %s", (_l, override, reason) => {
    const claims: Record<string, unknown> = { ...validClaims, ...override };
    for (const [k, v] of Object.entries(override)) if (v === undefined) delete claims[k];
    expect(readUpstreamGrantCandidate(jwt(claims), NOW)).toEqual({ ok: false, reason });
  });
});

describe("introspectUpstreamGrant", () => {
  const candidate: UpstreamGrantCandidate = {
    userId: USER,
    organizationId: ORG,
    grantId: GRANT,
    credentialVersion: 3,
    scopes: ["brand:read", "tools:execute"],
  };
  const active = {
    active: true,
    grant_id: GRANT,
    user_id: USER,
    organization_id: ORG,
    organization: { id: ORG, name: "Synthetic Org A" },
    client_id: "robynn-mcp-worker",
    scopes: ["tools:execute", "brand:read"],
    credential_version: 3,
  };

  function stub(response: Response | Error) {
    const fn = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("sends a v2-signed request with the identity tuple and no credentials", async () => {
    const fn = stub(Response.json(active));
    const outcome = await introspectUpstreamGrant({ apiBaseUrl: "https://app.test/", secret: "s3cret", candidate });
    expect(outcome).toEqual({
      status: "active",
      grant: { ...candidate, scopes: ["brand:read", "tools:execute"], organizationName: "Synthetic Org A" },
    });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.test/api/oauth/introspect");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      grant_id: GRANT,
      user_id: USER,
      organization_id: ORG,
      client_id: "robynn-mcp-worker",
      credential_version: 3,
    });
    const h = init.headers as Record<string, string>;
    const payload = [
      "v2",
      h["x-robynn-mcp-timestamp"],
      h["x-robynn-mcp-nonce"],
      "POST",
      "/api/oauth/introspect",
      createHash("sha256").update(body).digest("base64url"),
    ].join(".");
    expect(h["x-robynn-mcp-signature"]).toBe(`v2.${createHmac("sha256", "s3cret").update(payload).digest("base64url")}`);
  });

  it.each([
    ["404 (endpoint not deployed)", new Response("nope", { status: 404 }), "introspection_http_404"],
    ["401", new Response("", { status: 401 }), "introspection_http_401"],
    ["500", new Response("", { status: 500 }), "introspection_http_500"],
    ["201", new Response("{}", { status: 201 }), "introspection_http_201"],
    ["non-JSON", new Response("<html>", { status: 200 }), "introspection_malformed"],
    ["active missing", Response.json({}), "introspection_malformed"],
    ["bad scopes", Response.json({ ...active, scopes: ["root"] }), "introspection_malformed"],
    ["empty scopes", Response.json({ ...active, scopes: [] }), "introspection_malformed"],
    ["network", new TypeError("fetch failed"), "introspection_network"],
  ])("%s ⇒ unavailable", async (_l, response, reason) => {
    stub(response);
    expect(await introspectUpstreamGrant({ apiBaseUrl: "https://app.test", secret: "s", candidate })).toEqual({
      status: "unavailable",
      reason,
    });
  });

  it.each([
    ["revoked", { active: false, reason: "grant_revoked" }, "grant_revoked"],
    ["unknown reason", { active: false, reason: "<script>" }, "inactive_unknown"],
    ["other grant", { ...active, grant_id: "6f0c0000-0000-4000-8000-00000000000b" }, "identity_mismatch"],
    ["other user", { ...active, user_id: "22222222-2222-4222-8222-222222222222" }, "identity_mismatch"],
    ["other org", { ...active, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, "identity_mismatch"],
    ["other client", { ...active, client_id: "robynn-cli" }, "identity_mismatch"],
    ["stale version", { ...active, credential_version: 2 }, "identity_mismatch"],
  ])("%s ⇒ inactive", async (_l, body, reason) => {
    stub(Response.json(body));
    expect(await introspectUpstreamGrant({ apiBaseUrl: "https://app.test", secret: "s", candidate })).toEqual({
      status: "inactive",
      reason,
    });
  });
});
