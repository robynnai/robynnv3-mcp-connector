/**
 * COS-PLUGIN-001 P01 — provider/session behaviour contract.
 *
 * Proves, against the INSTALLED dependency code (not documentation), how
 * `@cloudflare/workers-oauth-provider` 0.3.0 and `agents` 0.7.5 (via
 * partyserver 0.3.3) expose token scopes, grant identity, refresh-callback
 * failures, revocation and McpAgent session props. Later packages (P06, P10,
 * P16) rely on these facts; if a dependency upgrade changes any of them this
 * suite must fail first. See docs/plugin-v1/AUTHORIZATION_CONTRACT.md §2.
 *
 * Everything runs in-process with an in-memory KV and fake Durable Object
 * namespace: no network, no Wrangler, no real credentials.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));
vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));

import OAuthProvider, {
  GrantType,
  getOAuthApi,
} from "@cloudflare/workers-oauth-provider";
import type {
  OAuthHelpers,
  OAuthProviderOptions,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";

const ORIGIN = "https://mcp.test";
const CALLBACK = "http://localhost:43123/callback";
const OTHER_CALLBACK = "http://localhost:43124/callback";
const USER_A = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UPSTREAM_CANARY = "upstream-access-CANARY-7f3c";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal in-memory KVNamespace with the subset the provider uses. */
class MemoryKV {
  readonly store = new Map<string, string>();

  async get(key: string, opts?: { type?: string } | string) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.store.set(key, String(value));
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(opts: { prefix?: string } = {}) {
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }

  keysWithPrefix(prefix: string) {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  dump() {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
  }
}

interface AuthorizationPlan {
  userId: string;
  scope: string[];
  props: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ApiObservation {
  path: string;
  props: unknown;
  summary: Awaited<ReturnType<OAuthHelpers["unwrapToken"]>>;
}

interface Harness {
  env: { OAUTH_KV: MemoryKV; OAUTH_PROVIDER?: OAuthHelpers };
  kv: MemoryKV;
  provider: OAuthProvider;
  options: OAuthProviderOptions;
  apiSeen: ApiObservation[];
  plan: AuthorizationPlan;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  helpers(): OAuthHelpers;
}

function createHarness(
  overrides: Partial<OAuthProviderOptions> = {},
): Harness {
  const kv = new MemoryKV();
  const env: Harness["env"] = { OAUTH_KV: kv };
  const apiSeen: ApiObservation[] = [];
  const harness = {
    plan: {
      userId: USER_A,
      scope: ["brand:read"],
      props: { accessToken: UPSTREAM_CANARY, userId: USER_A, organizationId: ORG_A },
    } as AuthorizationPlan,
  } as Harness;

  const options: OAuthProviderOptions = {
    apiRoute: ["/mcp", "/sse"],
    apiHandler: {
      async fetch(request: Request, handlerEnv: unknown, ctx: { props?: unknown }) {
        const bearer = request.headers.get("Authorization")!.slice("Bearer ".length);
        const helpers = (handlerEnv as Harness["env"]).OAUTH_PROVIDER!;
        apiSeen.push({
          path: new URL(request.url).pathname,
          props: ctx.props,
          summary: await helpers.unwrapToken(bearer),
        });
        return Response.json({ ok: true });
      },
    },
    defaultHandler: {
      async fetch(request: Request, handlerEnv: unknown) {
        const url = new URL(request.url);
        if (url.pathname !== "/authorize") return new Response("default", { status: 200 });
        const helpers = (handlerEnv as Harness["env"]).OAUTH_PROVIDER!;
        try {
          const authRequest = await helpers.parseAuthRequest(request);
          const { redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId: harness.plan.userId,
            metadata: harness.plan.metadata ?? {},
            scope: harness.plan.scope,
            props: harness.plan.props,
          });
          return new Response(null, { status: 302, headers: { Location: redirectTo } });
        } catch (err) {
          return new Response((err as Error).message, { status: 400 });
        }
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["brand:read", "tools:execute"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    ...overrides,
  };
  const provider = new OAuthProvider(options);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: undefined };

  return Object.assign(harness, {
    env,
    kv,
    provider,
    options,
    apiSeen,
    fetch: (path: string, init?: RequestInit) =>
      provider.fetch(new Request(`${ORIGIN}${path}`, init), env as never, ctx as never),
    helpers: () => getOAuthApi(options, env as never),
  });
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerPublicClient(h: Harness, redirectUris = [CALLBACK]) {
  const res = await h.fetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      client_name: "contract-test-host",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorize(
  h: Harness,
  params: Record<string, string | undefined>,
): Promise<{ status: number; code?: string; body: string }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
  const res = await h.fetch(`/authorize?${query}`);
  const location = res.headers.get("Location");
  return {
    status: res.status,
    code: location ? new URL(location).searchParams.get("code") ?? undefined : undefined,
    body: location ? "" : await res.text(),
  };
}

async function token(h: Harness, form: Record<string, string | undefined>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) if (value !== undefined) body.set(key, value);
  const res = await h.fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

function callApi(h: Harness, accessToken: string, path = "/mcp") {
  return h.fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
}

/** Full DCR → authorize (S256) → code exchange. */
async function connect(h: Harness, opts: { scope?: string; clientId?: string } = {}) {
  const clientId = opts.clientId ?? (await registerPublicClient(h));
  const { verifier, challenge } = pkcePair();
  const auth = await authorize(h, {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: opts.scope ?? "brand:read tools:execute",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  expect(auth.status).toBe(302);
  const exchanged = await token(h, {
    grant_type: "authorization_code",
    client_id: clientId,
    code: auth.code,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  return {
    clientId,
    accessToken: exchanged.json.access_token as string,
    refreshToken: exchanged.json.refresh_token as string,
    scope: exchanged.json.scope as string,
  };
}

const grantIdOf = (tokenString: string) => tokenString.split(":")[1];

// ---------------------------------------------------------------------------
// Baseline versions
// ---------------------------------------------------------------------------

describe("P01 baseline: installed dependency versions", () => {
  const versionOf = (pkg: string) =>
    (JSON.parse(readFileSync(join(process.cwd(), "node_modules", pkg, "package.json"), "utf8")) as {
      version: string;
    }).version;

  it("matches the plan baseline (provider 0.3.0, agents 0.7.5, MCP SDK 1.26.0)", () => {
    expect(versionOf("@cloudflare/workers-oauth-provider")).toBe("0.3.0");
    expect(versionOf("agents")).toBe("0.7.5");
    expect(versionOf("@modelcontextprotocol/sdk")).toBe("1.26.0");
  });
});

// ---------------------------------------------------------------------------
// workers-oauth-provider 0.3.0
// ---------------------------------------------------------------------------

describe("workers-oauth-provider 0.3.0: grant identity and token scopes", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    h.plan.scope = ["brand:read", "tools:execute"];
  });

  it("embeds userId and grantId in every token string and stores grant:{userId}:{grantId}", async () => {
    const { accessToken, refreshToken, clientId } = await connect(h);
    const [userId, grantId] = accessToken.split(":");
    expect(userId).toBe(USER_A);
    expect(refreshToken.split(":").slice(0, 2)).toEqual([USER_A, grantId]);

    const grant = await h.kv.get(`grant:${USER_A}:${grantId}`, { type: "json" });
    expect(grant).toMatchObject({ id: grantId, clientId, userId: USER_A, scope: ["brand:read", "tools:execute"] });
    expect(h.kv.keysWithPrefix(`token:${USER_A}:${grantId}:`)).toHaveLength(1);
  });

  it("encrypts props at rest: the upstream credential never appears in KV plaintext", async () => {
    await connect(h);
    expect(h.kv.dump()).not.toContain(UPSTREAM_CANARY);
  });

  it("passes ONLY decrypted props to the API handler — no scope, grantId or clientId", async () => {
    const { accessToken } = await connect(h);
    expect((await callApi(h, accessToken)).status).toBe(200);

    const seen = h.apiSeen[0];
    expect(seen.props).toEqual(h.plan.props);
    expect(Object.keys(seen.props as object)).not.toEqual(
      expect.arrayContaining(["scope"]),
    );
    expect(seen.props).not.toHaveProperty("grantId");
    expect(seen.props).not.toHaveProperty("clientId");
  });

  it("lets the API handler recover grantId, clientId and token scope via env.OAUTH_PROVIDER.unwrapToken(bearer)", async () => {
    const { accessToken, clientId } = await connect(h, { scope: "brand:read tools:execute" });
    // Host down-scopes on refresh: token scope narrower than grant scope.
    const { json } = await token(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: (await connect(h, { clientId })).refreshToken,
      scope: "brand:read",
    });
    await callApi(h, json.access_token);

    const summary = h.apiSeen[0].summary!;
    expect(summary.grantId).toBe(grantIdOf(json.access_token));
    expect(summary.userId).toBe(USER_A);
    expect(summary.grant.clientId).toBe(clientId);
    expect(summary.scope).toEqual(["brand:read"]);
    expect(summary.grant.scope).toEqual(["brand:read", "tools:execute"]);
    expect(summary.grant.props).toEqual(h.plan.props);
    expect(accessToken).not.toBe(json.access_token);
  });

  it("does NOT enforce token scope at API time: a brand:read-only token reaches the API handler", async () => {
    h.plan.scope = ["brand:read"];
    const { accessToken, scope } = await connect(h, { scope: "brand:read" });
    expect(scope).toBe("brand:read");
    expect((await callApi(h, accessToken)).status).toBe(200);
    expect(h.apiSeen).toHaveLength(1);
  });

  it("down-scopes silently: token requests can only narrow, unknown/extra scopes are dropped without error", async () => {
    h.plan.scope = ["brand:read"];
    const { clientId, refreshToken } = await connect(h, { scope: "brand:read" });
    const widened = await token(h, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      scope: "brand:read tools:execute admin:all",
    });
    expect(widened.status).toBe(200);
    expect(widened.json.scope).toBe("brand:read");
  });

  it("does not filter /authorize scopes against scopesSupported — the Worker must validate them", async () => {
    const clientId = await registerPublicClient(h);
    const helpers = h.helpers();
    const parsed = await helpers.parseAuthRequest(
      new Request(
        `${ORIGIN}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}&scope=brand:read%20admin:everything&code_challenge=x&code_challenge_method=S256`,
      ),
    );
    expect(parsed.scope).toEqual(["brand:read", "admin:everything"]);
  });

  it("does not validate grant identity: completeAuthorization accepts a sentinel userId such as \"unknown\"", async () => {
    h.plan.userId = "unknown";
    h.plan.props = { accessToken: UPSTREAM_CANARY, userId: "unknown", organizationId: "unknown" };
    const { accessToken } = await connect(h);
    expect(accessToken.startsWith("unknown:")).toBe(true);
    expect((await callApi(h, accessToken)).status).toBe(200);
  });
});

describe("workers-oauth-provider 0.3.0: PKCE and redirect binding", () => {
  it("default config: PKCE is optional (no code_challenge → code exchange succeeds without verifier)", async () => {
    const h = createHarness();
    const clientId = await registerPublicClient(h);
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: "brand:read",
      state: "s",
    });
    expect(auth.status).toBe(302);
    const exchanged = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: CALLBACK,
    });
    expect(exchanged.status).toBe(200);
  });

  it("default config: plain PKCE is accepted", async () => {
    const h = createHarness();
    const clientId = await registerPublicClient(h);
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge: "plain-verifier-value-0123456789012345678901234",
      code_challenge_method: "plain",
    });
    expect(auth.status).toBe(302);
  });

  it("allowPlainPKCE:false rejects plain AND an omitted method (the parser defaults it to plain)", async () => {
    const h = createHarness({ allowPlainPKCE: false });
    const clientId = await registerPublicClient(h);
    const base = { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "s" };

    const plain = await authorize(h, { ...base, code_challenge: "v".repeat(43), code_challenge_method: "plain" });
    expect(plain.status).toBe(400);
    expect(plain.body).toMatch(/plain PKCE method is not allowed/);

    const omitted = await authorize(h, base);
    expect(omitted.status).toBe(400);
  });

  it("allowPlainPKCE:false is NOT sufficient: method=S256 with no code_challenge still issues a non-PKCE code", async () => {
    const h = createHarness({ allowPlainPKCE: false });
    const clientId = await registerPublicClient(h);
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge_method: "S256",
    });
    expect(auth.status).toBe(302);
    const exchanged = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: CALLBACK,
    });
    expect(exchanged.status).toBe(200);
  });

  it("rejects a wrong S256 verifier and a replayed code (replay also revokes the grant)", async () => {
    const h = createHarness({ allowPlainPKCE: false });
    const clientId = await registerPublicClient(h);
    const { verifier, challenge } = pkcePair();
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const wrong = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: CALLBACK,
      code_verifier: pkcePair().verifier,
    });
    expect(wrong.json.error).toBe("invalid_grant");

    const ok = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    expect(ok.status).toBe(200);
    const replay = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    expect(replay.json.error).toBe("invalid_grant");
    expect((await callApi(h, ok.json.access_token)).status).toBe(401);
  });

  it("token exchange accepts ANY registered redirect_uri, not the one bound at /authorize", async () => {
    const h = createHarness();
    const clientId = await registerPublicClient(h, [CALLBACK, OTHER_CALLBACK]);
    const { verifier, challenge } = pkcePair();
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const exchanged = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      redirect_uri: OTHER_CALLBACK,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
  });
});

describe("workers-oauth-provider 0.3.0: tokenExchangeCallback (refresh) semantics", () => {
  let callback: ReturnType<typeof vi.fn>;
  let h: Harness;

  beforeEach(() => {
    callback = vi.fn();
    h = createHarness({
      tokenExchangeCallback: (opts: TokenExchangeCallbackOptions) =>
        callback(opts) as TokenExchangeCallbackResult | void,
    });
    h.plan.scope = ["brand:read", "tools:execute"];
  });

  it("receives clientId, userId, grant scope, requested scope and props — but NOT the grantId", async () => {
    const { clientId, refreshToken } = await connect(h);
    callback.mockClear();
    await token(h, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: "brand:read" });

    const opts = callback.mock.calls[0][0] as TokenExchangeCallbackOptions;
    expect(opts.grantType).toBe(GrantType.REFRESH_TOKEN);
    expect(Object.keys(opts).sort()).toEqual(["clientId", "grantType", "props", "requestedScope", "scope", "userId"]);
    expect(opts).toMatchObject({ clientId, userId: USER_A, scope: ["brand:read", "tools:execute"], requestedScope: ["brand:read"] });
  });

  it("FAILS OPEN when the callback returns nothing: refresh succeeds and keeps the stale props (current src/index.ts behaviour)", async () => {
    const { clientId, refreshToken } = await connect(h);
    callback.mockResolvedValue(undefined);
    const refreshed = await token(h, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(refreshed.status).toBe(200);
    await callApi(h, refreshed.json.access_token);
    expect(h.apiSeen[0].props).toEqual(h.plan.props);
  });

  it("a THROWING callback rejects provider.fetch (no OAuth error body) and leaves the grant un-rotated", async () => {
    const { clientId, refreshToken } = await connect(h);
    const grantKey = `grant:${USER_A}:${grantIdOf(refreshToken)}`;
    const before = h.kv.store.get(grantKey);

    callback.mockRejectedValueOnce(new Error("upstream refresh denied"));
    await expect(
      token(h, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
    ).rejects.toThrow("upstream refresh denied");
    expect(h.kv.store.get(grantKey)).toBe(before);

    // Same refresh token still works once the callback recovers → the Worker must
    // revoke the grant itself (grantId is parseable from the refresh token) on
    // permanent upstream denial, and map the throw to invalid_grant/503.
    callback.mockResolvedValueOnce(undefined);
    const retry = await token(h, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(retry.status).toBe(200);
  });

  it("returning refreshTokenTTL during refresh is a provider-native fail-closed path (invalid_request, no rotation)", async () => {
    const { clientId, refreshToken } = await connect(h);
    callback.mockResolvedValueOnce({ refreshTokenTTL: 0 });
    const res = await token(h, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_request");
  });

  it("accessTokenScope can only narrow; newProps replace grant props for NEW tokens while OLD access tokens keep their snapshot", async () => {
    const first = await connect(h);
    const newProps = { ...h.plan.props, accessToken: "rotated-upstream", organizationId: ORG_B };
    callback.mockResolvedValueOnce({ newProps, accessTokenScope: ["brand:read", "admin:all"] });
    const refreshed = await token(h, {
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: first.refreshToken,
    });
    expect(refreshed.json.scope).toBe("brand:read");

    await callApi(h, refreshed.json.access_token);
    await callApi(h, first.accessToken);
    expect(h.apiSeen[0].props).toEqual(newProps);
    expect(h.apiSeen[1].props).toEqual(h.plan.props);
  });
});

describe("workers-oauth-provider 0.3.0: rotation and revocation", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    h.plan.scope = ["brand:read", "tools:execute"];
  });

  it("refresh does not revoke the old access token, and the previous refresh token stays valid until the new one is used", async () => {
    const first = await connect(h);
    const r1 = await token(h, { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refreshToken });
    expect(r1.status).toBe(200);
    expect((await callApi(h, first.accessToken)).status).toBe(200);

    const graceReuse = await token(h, { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refreshToken });
    expect(graceReuse.status).toBe(200);
  });

  it("revokeGrant(grantId, userId) invalidates every access token and the refresh token of that grant", async () => {
    const first = await connect(h);
    const r1 = await token(h, { grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.refreshToken });

    await h.helpers().revokeGrant(grantIdOf(first.accessToken), USER_A);

    expect((await callApi(h, first.accessToken)).status).toBe(401);
    expect((await callApi(h, r1.json.access_token)).status).toBe(401);
    const refresh = await token(h, { grant_type: "refresh_token", client_id: first.clientId, refresh_token: r1.json.refresh_token });
    expect(refresh.json.error).toBe("invalid_grant");
    expect((await h.helpers().listUserGrants(USER_A)).items).toHaveLength(0);
  });

  it("RFC 7009 at /token: revoking a refresh token kills the grant; revoking an access token kills only that token", async () => {
    const a = await connect(h);
    await token(h, { client_id: a.clientId, token: a.accessToken });
    expect((await callApi(h, a.accessToken)).status).toBe(401);
    const stillRefreshes = await token(h, { grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refreshToken });
    expect(stillRefreshes.status).toBe(200);

    await token(h, { client_id: a.clientId, token: stillRefreshes.json.refresh_token });
    expect((await callApi(h, stillRefreshes.json.access_token)).status).toBe(401);
  });

  it("completeAuthorization revokes earlier grants for the same userId+clientId by default (reconnect to org B kills org A for that host client only)", async () => {
    const orgA = await connect(h);
    const otherHost = await connect(h);

    h.plan.props = { ...h.plan.props, organizationId: ORG_B };
    const orgB = await connect(h, { clientId: orgA.clientId });

    expect((await callApi(h, orgA.accessToken)).status).toBe(401);
    expect((await callApi(h, otherHost.accessToken)).status).toBe(200);
    expect((await callApi(h, orgB.accessToken)).status).toBe(200);
  });

  it("listUserGrants exposes grant metadata (non-secret) per user for a revocation UI/inventory", async () => {
    h.plan.metadata = { organizationId: ORG_A, appGrantId: "app-grant-1" };
    const { clientId } = await connect(h);
    const { items } = await h.helpers().listUserGrants(USER_A);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ clientId, userId: USER_A, metadata: { organizationId: ORG_A, appGrantId: "app-grant-1" } });
    expect(JSON.stringify(items)).not.toContain(UPSTREAM_CANARY);
  });
});

describe("workers-oauth-provider 0.3.0: API routing and audience", () => {
  it("apiRoute matching is a raw prefix: /mcpx, /mcp-lazy and /mcp/anything all require a token and reach the API handler", async () => {
    const h = createHarness();
    h.plan.scope = ["brand:read"];
    const { accessToken } = await connect(h);
    for (const path of ["/mcpx", "/mcp-lazy", "/mcp/openai", "/sse/anything"]) {
      expect((await h.fetch(path, { method: "POST" })).status).toBe(401);
      expect((await callApi(h, accessToken, path)).status).toBe(200);
    }
    expect(h.apiSeen.map((s) => s.path)).toEqual(["/mcpx", "/mcp-lazy", "/mcp/openai", "/sse/anything"]);
  });

  it("binds token audience to the authorize `resource` and enforces origin + path-prefix at API time", async () => {
    const h = createHarness();
    const clientId = await registerPublicClient(h);
    const { verifier, challenge } = pkcePair();
    const auth = await authorize(h, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    });
    const { json } = await token(h, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: auth.code,
      code_verifier: verifier,
    });
    expect(json.resource).toBe(`${ORIGIN}/mcp`);
    expect((await callApi(h, json.access_token, "/mcp")).status).toBe(200);
    expect((await callApi(h, json.access_token, "/mcp/extra")).status).toBe(200);
    expect((await callApi(h, json.access_token, "/sse")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// agents 0.7.5 / partyserver 0.3.3 — McpAgent session props
// ---------------------------------------------------------------------------

const MCP_ACCEPT = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

function fakeDurableObjectNamespace() {
  const seen: Array<{ name: string; props: unknown }> = [];
  const initialized = new Set<string>();
  const namespace = {
    newUniqueId: () => ({ toString: () => "unique-session-1" }),
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => ({
      async fetch(req: Request) {
        if (req.url.endsWith("/cdn-cgi/partyserver/set-name/")) {
          seen.push({ name: req.headers.get("x-partykit-room")!, props: JSON.parse(req.headers.get("x-partykit-props") ?? "null") });
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 200 }); // no webSocket → handler ends early
      },
      async getInitializeRequest() {
        return initialized.has(id.name) ? INITIALIZE : undefined;
      },
      async setInitializeRequest() {
        initialized.add(id.name);
      },
    }),
  };
  return { namespace, seen };
}

describe("agents 0.7.5 McpAgent: session addressing and props propagation", () => {
  const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});

  // Workers runtime global; Node 22 lacks it. Exact-pathname match is all serve("/mcp") needs.
  beforeEach(() => {
    if (!("URLPattern" in globalThis)) {
      vi.stubGlobal(
        "URLPattern",
        class {
          constructor(private readonly init: { pathname: string }) {}
          test(url: URL | string) {
            return new URL(String(url)).pathname === this.init.pathname;
          }
        },
      );
    }
  });

  it("keys the Durable Object ONLY by the client-supplied mcp-session-id, and forwards the current caller's ctx.props on every request", async () => {
    const restore = silence();
    const { namespace, seen } = fakeDurableObjectNamespace();
    const handler = McpAgent.serve("/mcp");
    const env = { MCP_OBJECT: namespace };
    const userAProps = { userId: USER_A, organizationId: ORG_A, accessToken: "a" };
    const userBProps = { userId: "22222222-2222-4222-8222-222222222222", organizationId: ORG_B, accessToken: "b" };

    await handler.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: MCP_ACCEPT, body: JSON.stringify(INITIALIZE) }),
      env,
      { props: userAProps } as never,
    );
    await handler.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...MCP_ACCEPT, "mcp-session-id": "unique-session-1" },
        body: JSON.stringify(TOOLS_LIST),
      }),
      env,
      { props: userBProps } as never,
    );
    restore.mockRestore();

    expect(seen).toEqual([
      { name: "streamable-http:unique-session-1", props: userAProps },
      { name: "streamable-http:unique-session-1", props: userBProps },
    ]);
  });

  it("returns 404 Session not found for an unknown session id (no implicit session creation)", async () => {
    const { namespace } = fakeDurableObjectNamespace();
    const res = await McpAgent.serve("/mcp").fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...MCP_ACCEPT, "mcp-session-id": "never-initialized" },
        body: JSON.stringify(TOOLS_LIST),
      }),
      { MCP_OBJECT: namespace },
      { props: {} } as never,
    );
    expect(res.status).toBe(404);
  });
});

describe("partyserver 0.3.3 + McpAgent.onStart: which props a session actually uses", () => {
  async function loadPartyServer() {
    const agentsDir = realpathSync(join(process.cwd(), "node_modules", "agents"));
    const entry = join(agentsDir, "..", "partyserver", "dist", "index.js");
    return (await import(/* @vite-ignore */ entry)) as {
      Server: new (ctx: unknown, env: unknown) => { fetch(req: Request): Promise<Response> };
    };
  }

  function fakeCtx(storage: Map<string, unknown>) {
    return {
      id: { toString: () => "do-id" },
      storage: {
        get: async (k: string) => storage.get(k),
        put: async (k: string, v: unknown) => void storage.set(k, v),
        delete: async (k: string) => storage.delete(k),
      },
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
      getWebSockets: () => [],
      waitUntil() {},
    };
  }

  const setName = (name: string, props: unknown) =>
    new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/", {
      headers: { "x-partykit-room": name, "x-partykit-props": JSON.stringify(props) },
    });

  it("calls onStart(props) once per activation: a warm DO ignores a later caller's props; a cold start adopts the latest caller's props", async () => {
    const { Server } = await loadPartyServer();
    const started: unknown[] = [];
    class SessionProbe extends Server {
      async onStart(props: unknown) {
        started.push(props);
      }
    }
    const storage = new Map<string, unknown>();
    const warm = new SessionProbe(fakeCtx(storage), {});
    await warm.fetch(setName("streamable-http:s1", { userId: "A" }));
    await warm.fetch(setName("streamable-http:s1", { userId: "B" }));
    expect(started).toEqual([{ userId: "A" }]);

    const afterEviction = new SessionProbe(fakeCtx(storage), {});
    await afterEviction.fetch(setName("streamable-http:s1", { userId: "B" }));
    expect(started).toEqual([{ userId: "A" }, { userId: "B" }]);
  });

  it("McpAgent.onStart persists incoming props to DO storage ('props' key) and otherwise reloads the stored props", async () => {
    const storage = new Map<string, unknown>([["props", { userId: "A" }]]);
    const self = {
      ctx: { storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => void storage.set(k, v) } },
      props: undefined as unknown,
      updateProps: McpAgent.prototype.updateProps,
      init: vi.fn(),
      server: { connect: vi.fn() },
      initTransport: () => ({}),
      reinitializeServer: vi.fn(),
    };
    const onStart = McpAgent.prototype.onStart as (this: unknown, props?: unknown) => Promise<void>;

    await onStart.call(self, undefined);
    expect(self.props).toEqual({ userId: "A" });

    await onStart.call(self, { userId: "B" });
    expect(storage.get("props")).toEqual({ userId: "B" });
    expect(self.props).toEqual({ userId: "B" });
    expect(self.init).toHaveBeenCalledTimes(2);
  });
});
