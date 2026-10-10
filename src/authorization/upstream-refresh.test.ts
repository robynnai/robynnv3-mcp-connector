import { describe, expect, it, vi } from "vitest";

import {
  RefreshScopeError,
  refreshUpstreamGrant,
  UpstreamGrantRevokedError,
  UpstreamUnavailableError,
} from "./upstream-refresh";
import type { IntrospectionOutcome } from "./upstream-grant";

// COS-PLUGIN-001 P10: the host refresh never renews access after a failed
// upstream refresh (F12), never widens scope, and only revokes on proof.

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT = "6f0c0000-0000-4000-8000-00000000000a";
const env = { ROBYNN_API_BASE_URL: "https://app.test", MCP_INTERNAL_AUTH_SECRET: "s" } as never;

function jwt(claims: Record<string, unknown> = {}) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: "robynn.ai",
    aud: "robynn-api:mcp",
    type: "access",
    sub: USER,
    org: ORG,
    gid: GRANT,
    ver: 2,
    cid: "robynn-mcp-worker",
    scope: "brand:read tools:execute",
    iat: now,
    exp: now + 3600,
    ...claims,
  })}.c2ln`;
}

const props = {
  accessToken: "old",
  refreshToken: "rrt_old",
  userId: USER,
  organizationId: ORG,
  appGrantId: GRANT,
  credentialVersion: 1,
  scopes: ["brand:read", "tools:execute"],
  authVersion: 2,
  _apiBaseUrl: "https://evil.test",
};

const options = (overrides: Record<string, unknown> = {}) =>
  ({
    grantType: "refresh_token",
    clientId: "host",
    userId: USER,
    scope: ["brand:read", "tools:execute"],
    requestedScope: ["brand:read", "tools:execute"],
    props,
    ...overrides,
  }) as never;

const active = (scopes = ["brand:read", "tools:execute"]): IntrospectionOutcome => ({
  status: "active",
  grant: { userId: USER, organizationId: ORG, grantId: GRANT, credentialVersion: 2, scopes: scopes as never, organizationName: null },
});

function tokenResponse(body: unknown = { access_token: jwt(), refresh_token: "rrt_new", expires_in: 3600 }, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("refreshUpstreamGrant", () => {
  it("success: new upstream pair, credential version from the token, TTL under the upstream expiry", async () => {
    const fetchImpl = tokenResponse();
    const introspect = vi.fn(async (_params: unknown) => active());
    const result = await refreshUpstreamGrant(options(), env, { fetchImpl: fetchImpl as never, introspect });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://app.test/api/oauth/token"); // never props._apiBaseUrl
    expect(result.newProps).toMatchObject({ refreshToken: "rrt_new", credentialVersion: 2, scopes: ["brand:read", "tools:execute"] });
    expect(result.newProps).not.toHaveProperty("_apiBaseUrl");
    expect(result.accessTokenTTL).toBe(3540);
    expect(result.accessTokenScope).toEqual(["brand:read", "tools:execute"]);
    expect(introspect.mock.calls[0][0]).toMatchObject({ candidate: { grantId: GRANT, credentialVersion: 2 } });
  });

  it("never widens: scopes ⊆ consented props ∩ token ∩ introspection; the host token ⊆ its request", async () => {
    const narrowProps = { ...props, scopes: ["brand:read"] };
    const result = await refreshUpstreamGrant(options({ props: narrowProps }), env, {
      fetchImpl: tokenResponse() as never,
      introspect: async () => active(),
    });
    expect(result.newProps.scopes).toEqual(["brand:read"]);

    const roleNarrowed = await refreshUpstreamGrant(options(), env, {
      fetchImpl: tokenResponse() as never,
      introspect: async () => active(["brand:read"]),
    });
    expect(roleNarrowed.newProps.scopes).toEqual(["brand:read"]);

    const downscoped = await refreshUpstreamGrant(options({ requestedScope: ["brand:read"] }), env, {
      fetchImpl: tokenResponse() as never,
      introspect: async () => active(),
    });
    expect(downscoped.accessTokenScope).toEqual(["brand:read"]);
    expect(downscoped.newProps.scopes).toEqual(["brand:read", "tools:execute"]);
  });

  it("caps the TTL at 3600 - 60 and floors it at 60", async () => {
    const long = await refreshUpstreamGrant(options(), env, {
      fetchImpl: tokenResponse({ access_token: jwt(), refresh_token: "r", expires_in: 86400 }) as never,
      introspect: async () => active(),
    });
    expect(long.accessTokenTTL).toBe(3540);
    const short = await refreshUpstreamGrant(options(), env, {
      fetchImpl: tokenResponse({ access_token: jwt(), refresh_token: "r", expires_in: 30 }) as never,
      introspect: async () => active(),
    });
    expect(short.accessTokenTTL).toBe(60);
  });

  it.each([
    ["no props", undefined],
    ["authVersion 1", { ...props, authVersion: 1 }],
    ["no app grant", { ...props, appGrantId: undefined }],
    ["no refresh token", { ...props, refreshToken: "" }],
    ["user mismatch", { ...props, userId: "22222222-2222-4222-8222-222222222222" }],
  ])("legacy/incomplete grant (%s) ⇒ revoked, app never called", async (_label, legacyProps) => {
    const fetchImpl = tokenResponse();
    await expect(refreshUpstreamGrant(options({ props: legacyProps }), env, { fetchImpl: fetchImpl as never })).rejects.toBeInstanceOf(
      UpstreamGrantRevokedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("missing secret ⇒ unavailable, app never called", async () => {
    const fetchImpl = tokenResponse();
    await expect(
      refreshUpstreamGrant(options(), { ROBYNN_API_BASE_URL: "https://app.test" } as never, { fetchImpl: fetchImpl as never }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["400 invalid_grant", 400, { error: "invalid_grant" }, UpstreamGrantRevokedError],
    ["400 invalid_request", 400, { error: "invalid_request" }, UpstreamUnavailableError],
    ["401 invalid_client (our signature)", 401, { error: "invalid_client" }, UpstreamUnavailableError],
    ["429", 429, {}, UpstreamUnavailableError],
    ["500", 500, {}, UpstreamUnavailableError],
    ["503", 503, { error: "temporarily_unavailable" }, UpstreamUnavailableError],
  ])("upstream %s ⇒ %s", async (_label, status, body, errorClass) => {
    const introspect = vi.fn();
    await expect(
      refreshUpstreamGrant(options(), env, { fetchImpl: tokenResponse(body, status) as never, introspect }),
    ).rejects.toBeInstanceOf(errorClass);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("network failure ⇒ unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(refreshUpstreamGrant(options(), env, { fetchImpl: fetchImpl as never })).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it.each([
    ["malformed body", { access_token: "", refresh_token: "r" }],
    ["no refresh token", { access_token: jwt() }],
    ["other user", { access_token: jwt({ sub: "22222222-2222-4222-8222-222222222222" }), refresh_token: "r" }],
    ["other org", { access_token: jwt({ org: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), refresh_token: "r" }],
    ["other grant", { access_token: jwt({ gid: "6f0c0000-0000-4000-8000-00000000000b" }), refresh_token: "r" }],
    ["no gid", { access_token: jwt({ gid: undefined }), refresh_token: "r" }],
    ["wrong audience", { access_token: jwt({ aud: "robynn-api:agent-run" }), refresh_token: "r" }],
  ])("an unusable rotated answer (%s) ⇒ revoked", async (_label, body) => {
    await expect(
      refreshUpstreamGrant(options(), env, { fetchImpl: tokenResponse(body) as never, introspect: async () => active() }),
    ).rejects.toBeInstanceOf(UpstreamGrantRevokedError);
  });

  it("refresh-time introspection inactive ⇒ revoked with its reason", async () => {
    await expect(
      refreshUpstreamGrant(options(), env, {
        fetchImpl: tokenResponse() as never,
        introspect: async () => ({ status: "inactive", reason: "membership_inactive" }),
      }),
    ).rejects.toMatchObject({ name: "UpstreamGrantRevokedError", reason: "membership_inactive" });
  });

  it("refresh-time introspection unavailable ⇒ proceeds, narrowed to the token's scope (per-call checks still run)", async () => {
    const result = await refreshUpstreamGrant(options(), env, {
      fetchImpl: tokenResponse({ access_token: jwt({ scope: "brand:read" }), refresh_token: "r" }) as never,
      introspect: async () => ({ status: "unavailable", reason: "introspection_http_503" }),
    });
    expect(result.newProps.scopes).toEqual(["brand:read"]);
  });

  it("nothing left of the requested scope ⇒ RefreshScopeError (no revoke)", async () => {
    await expect(
      refreshUpstreamGrant(options({ requestedScope: ["tools:execute"] }), env, {
        fetchImpl: tokenResponse() as never,
        introspect: async () => active(["brand:read"]),
      }),
    ).rejects.toBeInstanceOf(RefreshScopeError);
  });
});
