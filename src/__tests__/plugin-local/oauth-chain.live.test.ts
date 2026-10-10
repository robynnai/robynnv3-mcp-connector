/**
 * COS-PLUGIN-001 P16 — the real OAuth chain on the plugin-local stack (plan
 * §10 P16; §8 "Required security cases"). Real Worker (`wrangler dev
 * --local`), real app (SvelteKit), real local Supabase with the synthetic
 * seed; no step is stubbed:
 *
 *   DCR → /authorize (S256) → real sign-in → real consent form action →
 *   Worker /callback (signed exchange + introspection) → host /token (PKCE)
 *   → /mcp → refresh (RefreshCoordinator → app rotation RPC) → revocation
 *   (the user's own DELETE /api/user/connected-apps/:id)
 *
 * plus the negative cases at both token layers. Run with
 * `pnpm test:plugin-local` (docs/plugin-v1/OAUTH_INTEGRATION_TESTS.md);
 * skipped otherwise. It writes only to the isolated local database and
 * restores the seeded memberships it flips.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ALPHA,
  APP,
  BETA,
  Browser,
  HOST_CALLBACK,
  LIVE,
  ORG_A,
  ORG_B,
  STRANGER_ORG,
  WORKER,
  appBearer,
  appInternal,
  authorizeAtWorker,
  browserFor,
  callTool,
  connectHost,
  consentAtApp,
  followToWorkerCallback,
  generatedValue,
  hostRefresh,
  hostToken,
  lit,
  listTools,
  logsContainingSensitiveValues,
  mcp,
  openSession,
  ping,
  registerHost,
  remember,
  setMembershipStatus,
  sql,
  toolErrorCode,
  toolOk,
  type HostConnection,
} from "./live-stack";

const WORKER_CALLBACK = `${WORKER}/callback`;
const LONG = 60_000;

const count = (query: string) => Number(sql(query));
const grantRow = (id: string) => sql(`select status || '|' || coalesce(revoked_reason, '') || '|' || credential_version from public.oauth_grants where id=${lit(id)}`);
const codeUsed = (code: string) => sql(`select used from public.oauth_authorization_codes where code=${lit(code)}`);

/** A signed-in browser with a fresh Worker transaction, stopped at the consent page. */
async function atConsent(clientId: string, user: { email: string }, scope: string) {
  const browser = await browserFor(user);
  const auth = await authorizeAtWorker(browser, { clientId, scope });
  expect(auth.status).toBe(302);
  return { browser, auth, appUrl: auth.appUrl! };
}

/** HS256 JWT signed with the local app secret: used only to forge a legacy (pre-P05) access token. */
function legacyAccessJwt(sub: string, org: string) {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    iss: "robynn.ai",
    aud: "robynn-api:mcp",
    type: "access",
    sub,
    org,
    cid: "robynn-mcp-worker",
    scope: "brand:read",
    iat: now,
    exp: now + 600,
    jti: randomUUID(),
  })}`;
  const sig = createHmac("sha256", generatedValue("secrets.env", "OAUTH_JWT_SECRET")).update(head).digest("base64url");
  return remember(`${head}.${sig}`);
}

describe.skipIf(!LIVE)("plugin-local: host OAuth chain end to end (real app, Worker and DB)", () => {
  let clientId: string;
  let otherClientId: string;

  beforeAll(async () => {
    expect((await fetch(`${WORKER}/`)).status).toBe(200);
    expect(count(`select count(*) from public.organizations where id in (${lit(ORG_A)}, ${lit(ORG_B)})`)).toBe(2);
    clientId = await registerHost();
    otherClientId = await registerHost("P16 Other Host");
  });

  afterAll(() => {
    // Leave the seed as it was for the next suite.
    setMembershipStatus(ALPHA.id, ORG_B, "active");
  });

  describe("happy path: consent, exchange, tools, refresh, revocation", () => {
    let conn: HostConnection & { session: string; appCode: string };

    it("DCR + /authorize hand the browser to the local app with the Worker's own client, callback and exact scope", async () => {
      const browser = new Browser();
      const auth = await authorizeAtWorker(browser, { clientId, scope: "brand:read tools:execute" });
      expect(auth.status).toBe(302);
      expect(auth.appUrl!.origin + auth.appUrl!.pathname).toBe(`${APP}/oauth/authorize`);
      expect(auth.appUrl!.searchParams.get("client_id")).toBe("robynn-mcp-worker");
      expect(auth.appUrl!.searchParams.get("redirect_uri")).toBe(WORKER_CALLBACK);
      expect(auth.appUrl!.searchParams.get("scope")).toBe("brand:read tools:execute");
      expect(auth.appUrl!.searchParams.get("client_name")).toBe("P16 Live Host");
    });

    it("real sign-in and consent bind the chosen org and the opted-in scope to one grant; /callback and the host's PKCE exchange complete", async () => {
      const { browser, auth, appUrl } = await atConsent(clientId, ALPHA, "brand:read tools:execute");
      const page = await browser.fetch(appUrl.href);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Synthetic Org A");
      expect(html).toContain("Synthetic Org B");
      expect(html).not.toMatch(/Claude/);

      const grantsBefore = count(`select count(*) from public.oauth_grants where user_id=${lit(ALPHA.id)}`);
      const consent = await consentAtApp(browser, appUrl, { organizationId: ORG_A, allowExecute: true });
      expect(consent.status).toBe(302);
      expect(consent.callback!.origin + consent.callback!.pathname).toBe(WORKER_CALLBACK);
      const appCode = consent.callback!.searchParams.get("code")!;
      expect(count(`select count(*) from public.oauth_grants where user_id=${lit(ALPHA.id)}`)).toBe(grantsBefore + 1);
      expect(
        sql(
          `select g.organization_id || '|' || array_to_string(g.scopes, ' ') || '|' || g.client_id || '|' || c.used from public.oauth_authorization_codes c join public.oauth_grants g on g.id = c.grant_id where c.code=${lit(appCode)}`,
        ),
      ).toBe(`${ORG_A}|brand:read tools:execute|robynn-mcp-worker|false`);

      // The Worker's /callback: signed exchange + live introspection, then the host redirect.
      const back = await followToWorkerCallback(browser, consent.callback!);
      expect(back.status).toBe(302);
      expect(back.hostUrl!.origin + back.hostUrl!.pathname).toBe(HOST_CALLBACK);
      expect(back.hostUrl!.searchParams.get("state")).toBe("p16-host-state");
      expect(codeUsed(appCode)).toBe("t");
      const appGrantId = sql(`select grant_id from public.oauth_authorization_codes where code=${lit(appCode)}`);
      expect(count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(appGrantId)}`)).toBe(1);

      const token = await hostToken({
        grant_type: "authorization_code",
        code: back.hostUrl!.searchParams.get("code")!,
        client_id: clientId,
        redirect_uri: HOST_CALLBACK,
        code_verifier: auth.verifier,
        resource: `${WORKER}/mcp`,
      });
      expect(token.status).toBe(200);
      expect(token.body.scope).toBe("brand:read tools:execute");
      conn = { clientId, access: token.body.access_token, refresh: token.body.refresh_token, scope: token.body.scope, appGrantId, session: "", appCode };
    });

    it("MCP: initialize binds a session; tools serve the bound org's data only", async () => {
      const session = await openSession(conn.access);
      conn = { ...conn, session };
      const tools = await listTools(conn.access, session);
      expect(tools.json?.result?.tools?.length).toBe(48);
      const context = await callTool(conn.access, session, "robynn_brand_context", { scope: "summary" });
      expect(toolOk(context)).toBe(true);
      const text = JSON.stringify(context.json?.result);
      expect(text).toContain("COSPLUGIN-MARKER-ORG-A");
      expect(text).not.toContain("COSPLUGIN-MARKER-ORG-B");
      expect(toolOk(await callTool(conn.access, session, "robynn_status"))).toBe(true);
    });

    it("refresh rotates both layers once; the new host token works on the same session", async () => {
      const rowsBefore = count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)}`);
      const refreshed = await hostRefresh(clientId, conn.refresh);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.access_token).not.toBe(conn.access);
      expect(refreshed.body.scope).toBe("brand:read tools:execute");
      expect(count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)}`)).toBe(rowsBefore + 1);
      expect(count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)} and used_at is null and not revoked`)).toBe(1);
      conn = { ...conn, access: refreshed.body.access_token, refresh: refreshed.body.refresh_token };
      expect(toolOk(await callTool(conn.access, conn.session, "robynn_status"))).toBe(true);
    });

    it("three concurrent host refreshes share one upstream rotation and keep the grant active", async () => {
      const rowsBefore = count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)}`);
      const results = await Promise.all([1, 2, 3].map(() => hostRefresh(clientId, conn.refresh)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(new Set(results.map((r) => r.body.access_token)).size).toBe(1);
      expect(count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)}`)).toBe(rowsBefore + 1);
      expect(grantRow(conn.appGrantId)).toMatch(/^active\|/);
      conn = { ...conn, access: results[0].body.access_token, refresh: results[0].body.refresh_token };
    });

    it("the user revokes the connection in Robynn: tools, Vault, listing and refresh all stop", async () => {
      const browser = await browserFor(ALPHA);
      // Another user cannot revoke it (owner-scoped, 404).
      const stranger = await browserFor(BETA);
      const foreign = await stranger.fetch(`${APP}/api/user/connected-apps/${conn.appGrantId}`, { method: "DELETE", headers: { origin: APP } });
      expect(foreign.status).toBe(404);
      expect(grantRow(conn.appGrantId)).toMatch(/^active\|/);

      const res = await browser.fetch(`${APP}/api/user/connected-apps/${conn.appGrantId}`, { method: "DELETE", headers: { origin: APP } });
      expect(res.status).toBe(200);
      expect(grantRow(conn.appGrantId)).toMatch(/^revoked\|user_revoked\|/);
      expect(count(`select count(*) from public.oauth_refresh_tokens where grant_id=${lit(conn.appGrantId)} and not revoked`)).toBe(0);

      const tool = await callTool(conn.access, conn.session, "robynn_status");
      expect(tool.status).toBe(401);
      expect(tool.www).toMatch(/invalid_token/);
      expect(tool.www).toMatch(/resource_metadata=/);
      expect((await callTool(conn.access, conn.session, "robynn_vault_read", { path: "brand/none.md" })).status).toBe(401);
      expect((await listTools(conn.access, conn.session)).status).toBe(401);
      const refresh = await hostRefresh(clientId, conn.refresh);
      expect(refresh.status).toBe(400);
      expect(refresh.body.error).toBe("invalid_grant");
    });
  });

  describe("consent defaults and scope enforcement", () => {
    it("execution left unchecked ⇒ brand:read only; every write is refused before the app and nothing is written", async () => {
      const ro = await connectHost({ clientId, user: ALPHA, organizationId: ORG_B, scope: "brand:read tools:execute" });
      expect(ro.scope).toBe("brand:read");
      const session = await openSession(ro.access);
      const before = count(`select count(*) from public.hermes_memories where organization_id=${lit(ORG_B)}`);
      const write = await callTool(ro.access, session, "robynn_memory_write", { scope: "user", key: "p16-live", content: "x" });
      expect(toolErrorCode(write)).toBe("insufficient_scope");
      expect(toolErrorCode(await callTool(ro.access, session, "robynn_conversations", { action: "create", title: "p16" }))).toBe("insufficient_scope");
      expect(count(`select count(*) from public.hermes_memories where organization_id=${lit(ORG_B)}`)).toBe(before);
      const read = await callTool(ro.access, session, "robynn_brand_context", { scope: "summary" });
      expect(JSON.stringify(read.json?.result)).toContain("COSPLUGIN-MARKER-ORG-B");
      expect(toolErrorCode(await callTool(ro.access, session, "robynn_memory_get", { scope: "session", key: "k" }))).toBe("unsupported_memory_scope");
    });

    it("a refresh can narrow a host token but never widen it; the narrowed token cannot execute", async () => {
      const full = await connectHost({ clientId, user: ALPHA, organizationId: ORG_A, scope: "brand:read tools:execute", allowExecute: true });
      const session = await openSession(full.access);
      const narrowed = await hostRefresh(clientId, full.refresh, { scope: "brand:read" });
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.scope).toBe("brand:read");
      expect(toolErrorCode(await callTool(narrowed.body.access_token, session, "robynn_memory_write", { scope: "user", key: "p16", content: "x" }))).toBe("insufficient_scope");
      const widened = await hostRefresh(clientId, narrowed.body.refresh_token, { scope: "brand:read tools:execute admin" });
      expect(widened.body.scope ?? "").not.toContain("admin");
    });
  });

  describe("Worker front door negatives (host layer)", () => {
    it.each([
      ["missing PKCE", { challenge: null, method: null }],
      ["plain PKCE", { method: "plain" }],
      ["S256 named but no challenge", { challenge: null }],
    ])("/authorize refuses %s before any hand-off to the app", async (_label, overrides) => {
      const auth = await authorizeAtWorker(new Browser(), { clientId, scope: "brand:read", ...overrides });
      // Either an error page, or an OAuth error back to the registered host redirect.
      if (auth.status === 302) {
        expect(auth.appUrl!.origin + auth.appUrl!.pathname).toBe(HOST_CALLBACK);
        expect(auth.appUrl!.searchParams.get("error")).toBe("invalid_request");
      } else {
        expect(auth.status).toBe(400);
        expect(auth.appUrl).toBeNull();
      }
    });

    it("/authorize refuses an unregistered redirect without redirecting, and an unknown client", async () => {
      const wrongRedirect = await authorizeAtWorker(new Browser(), { clientId, scope: "brand:read", redirectUri: "http://127.0.0.1:1/evil" });
      expect(wrongRedirect.status).toBe(400);
      expect(wrongRedirect.appUrl).toBeNull();
      const unknown = await authorizeAtWorker(new Browser(), { clientId: "not-a-client", scope: "brand:read" });
      expect(unknown.status).toBe(400);
    });

    it("/authorize sends an unknown scope back to the host as invalid_scope (never to consent)", async () => {
      const auth = await authorizeAtWorker(new Browser(), { clientId, scope: "brand:read admin" });
      expect(auth.status).toBe(302);
      expect(auth.appUrl!.origin + auth.appUrl!.pathname).toBe(HOST_CALLBACK);
      expect(auth.appUrl!.searchParams.get("error")).toBe("invalid_scope");
    });

    it("/token refuses a wrong verifier, another client and another redirect without minting; the real host completes once, and a replay revokes", async () => {
      const { browser, auth, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
      const consent = await consentAtApp(browser, appUrl, { organizationId: ORG_A });
      const back = await followToWorkerCallback(browser, consent.callback!);
      const code = back.hostUrl!.searchParams.get("code")!;
      const base = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: HOST_CALLBACK, code_verifier: auth.verifier, resource: `${WORKER}/mcp` };

      expect((await hostToken({ ...base, client_id: otherClientId })).body.error).toBe("invalid_grant");
      expect((await hostToken({ ...base, redirect_uri: "http://127.0.0.1:33916/other" })).body.error).toBe("invalid_grant");
      const wrongVerifier = await hostToken({ ...base, code_verifier: randomBytes(32).toString("base64url") });
      expect(wrongVerifier.body.error).toBe("invalid_grant");

      // None of the failed attempts minted anything; the legitimate host,
      // holding the verifier, still completes once.
      const real = await hostToken(base);
      expect(real.status).toBe(200);
      const session = await openSession(real.body.access_token);
      const replay = await hostToken(base);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      // A replay is treated as a stolen code: the grant it minted is revoked.
      expect((await ping(real.body.access_token, session)).status).toBe(401);
    });

    it("D-C: SSE is neither served nor advertised, even with a valid token", async () => {
      const conn = await connectHost({ clientId, user: ALPHA, organizationId: ORG_A, scope: "brand:read" });
      for (const path of ["/sse", "/sse/message?sessionId=p16"]) {
        const res = await fetch(`${WORKER}${path}`, { headers: { authorization: `Bearer ${conn.access}` } });
        await res.body?.cancel();
        expect(res.status, path).toBe(404);
      }
      const landing = (await (await fetch(`${WORKER}/`)).json()) as { endpoints: Record<string, string> };
      expect(landing.endpoints).not.toHaveProperty("sse");
      expect((await fetch(`${WORKER}/.well-known/oauth-protected-resource/sse`)).status).toBe(404);
      expect((await fetch(`${WORKER}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    });

    it("/callback state is single use and bound to the browser that started /authorize", async () => {
      const { browser, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
      const consent = await consentAtApp(browser, appUrl, { organizationId: ORG_A });
      // Another browser (no state cookie) presenting the same callback URL.
      const thief = await followToWorkerCallback(new Browser(), consent.callback!);
      expect(thief.status).toBe(400);
      const owner = await followToWorkerCallback(browser, consent.callback!);
      expect(owner.status).toBe(302);
      expect(owner.hostUrl!.searchParams.get("code")).toBeTruthy();
      const again = await followToWorkerCallback(browser, consent.callback!);
      expect(again.status).toBe(400);
    });
  });

  describe("app consent and token negatives (app layer)", () => {
    it("tampered org: a workspace the user does not belong to, or was removed from, gets 403 and no code", async () => {
      sql(`insert into public.organizations (id, name, slug) values (${lit(STRANGER_ORG)}, 'P16 Stranger Org', 'p16-stranger-org') on conflict (id) do nothing`);
      const codesBefore = count(`select count(*) from public.oauth_authorization_codes`);

      const alpha = await atConsent(clientId, ALPHA, "brand:read");
      const stranger = await consentAtApp(alpha.browser, alpha.appUrl, { organizationId: STRANGER_ORG });
      expect(stranger.status).toBe(403);
      expect(stranger.callback).toBeNull();

      const beta = await atConsent(clientId, BETA, "brand:read");
      const removed = await consentAtApp(beta.browser, beta.appUrl, { organizationId: ORG_A });
      expect(removed.status).toBe(403);

      const twoOrgs = await consentAtApp(alpha.browser, alpha.appUrl, { organizationId: ORG_A, tamper: (f) => f.append("organization_id", ORG_B) });
      expect(twoOrgs.status).toBe(400);
      expect(count(`select count(*) from public.oauth_authorization_codes`)).toBe(codesBefore);
    });

    it("tampered scope or flow: opt-in not requested, unknown scopes, foreign redirect or client are refused with no code", async () => {
      const codesBefore = count(`select count(*) from public.oauth_authorization_codes`);
      const { browser, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
      const cases: Array<(f: URLSearchParams) => void> = [
        (f) => f.set("grant_scope", "tools:execute"),
        (f) => f.set("grant_scope", "admin"),
        (f) => f.set("scope", "brand:read admin"),
        (f) => f.set("scope", ""),
        (f) => f.set("redirect_uri", "http://127.0.0.1:1/evil"),
        (f) => f.set("client_id", "robynn-cli"),
      ];
      for (const tamper of cases) {
        const res = await consentAtApp(browser, appUrl, { organizationId: ORG_A, tamper });
        expect(res.status, tamper.toString()).toBeGreaterThanOrEqual(400);
        expect(res.callback).toBeNull();
      }
      expect(count(`select count(*) from public.oauth_authorization_codes`)).toBe(codesBefore);
    });

    it("the app refuses an unsigned exchange, another client and another redirect without consuming the code; a replay revokes the family", async () => {
      const { browser, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
      const consent = await consentAtApp(browser, appUrl, { organizationId: ORG_A });
      const appCode = consent.callback!.searchParams.get("code")!;
      const grantId = sql(`select grant_id from public.oauth_authorization_codes where code=${lit(appCode)}`);
      const exchange = { grant_type: "authorization_code", code: appCode, redirect_uri: WORKER_CALLBACK, client_id: "robynn-mcp-worker" };

      const unsigned = await appInternal("/api/oauth/token", exchange, { sign: false });
      expect(unsigned.status).toBe(401);
      expect(unsigned.json.error).toBe("invalid_client");
      expect((await appInternal("/api/oauth/token", { ...exchange, client_id: "robynn-cli" })).status).toBe(401);
      const redirect = await appInternal("/api/oauth/token", { ...exchange, redirect_uri: `${WORKER}/other` });
      expect(redirect.status).toBe(400);
      expect(redirect.json.error).toBe("invalid_grant");
      expect(codeUsed(appCode)).toBe("f");

      const first = await appInternal("/api/oauth/token", exchange);
      expect(first.status).toBe(200);
      expect(typeof first.json.access_token).toBe("string");
      expect(await appBearer("/api/cli/context/summary", first.json.access_token)).toBe(200);
      const replay = await appInternal("/api/oauth/token", exchange);
      expect(replay.json.error).toBe("invalid_grant");
      expect(grantRow(grantId)).toMatch(/^revoked\|code_reuse\|/);
      expect(await appBearer("/api/cli/context/summary", first.json.access_token)).toBe(401);
      const refresh = await appInternal("/api/oauth/token", { grant_type: "refresh_token", refresh_token: first.json.refresh_token, client_id: "robynn-mcp-worker" });
      expect(refresh.json.error).toBe("invalid_grant");
    });

    it("upstream refresh reuse outside the grace window revokes the whole family", async () => {
      const { browser, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
      const consent = await consentAtApp(browser, appUrl, { organizationId: ORG_A });
      const appCode = consent.callback!.searchParams.get("code")!;
      const grantId = sql(`select grant_id from public.oauth_authorization_codes where code=${lit(appCode)}`);
      const issued = await appInternal("/api/oauth/token", { grant_type: "authorization_code", code: appCode, redirect_uri: WORKER_CALLBACK, client_id: "robynn-mcp-worker" });
      const rotate = (token: string) => appInternal("/api/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: "robynn-mcp-worker" });

      const unsigned = await appInternal("/api/oauth/token", { grant_type: "refresh_token", refresh_token: issued.json.refresh_token, client_id: "robynn-mcp-worker" }, { sign: false });
      expect(unsigned.status).toBe(401);
      const child = await rotate(issued.json.refresh_token);
      expect(child.status).toBe(200);
      // Inside the 30 s grace window a retry gets the same child and revokes nothing.
      const graced = await rotate(issued.json.refresh_token);
      expect(graced.json.refresh_token).toBe(child.json.refresh_token);
      expect(grantRow(grantId)).toMatch(/^active\|/);

      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const reuse = await rotate(issued.json.refresh_token);
      expect(reuse.json.error).toBe("invalid_grant");
      expect(grantRow(grantId)).toMatch(/^revoked\|refresh_reuse\|/);
      expect((await rotate(child.json.refresh_token)).json.error).toBe("invalid_grant");
      expect(await appBearer("/api/cli/context/summary", child.json.access_token)).toBe(401);
    }, LONG);

    it("legacy credentials: a pre-P05 Worker refresh token is refused and not consumed; a grant-less access JWT is refused", async () => {
      const legacy = remember(`rrt_${randomBytes(32).toString("hex")}`);
      const hash = (await import("node:crypto")).createHash("sha256").update(legacy).digest("hex");
      // Recreate the pre-P05 state the NOT VALID constraint leaves behind (as the P05 pgTAP suite does).
      sql(
        `begin; alter table public.oauth_refresh_tokens drop constraint oauth_refresh_worker_grant_required; ` +
          `insert into public.oauth_refresh_tokens (token_hash, user_id, organization_id, client_id, scope, expires_at, revoked) values (${lit(hash)}, ${lit(ALPHA.id)}, ${lit(ORG_A)}, 'robynn-mcp-worker', 'brand:read', now() + interval '1 day', false); ` +
          `alter table public.oauth_refresh_tokens add constraint oauth_refresh_worker_grant_required check (client_id <> 'robynn-mcp-worker' or grant_id is not null or revoked) not valid; commit;`,
      );
      const refused = await appInternal("/api/oauth/token", { grant_type: "refresh_token", refresh_token: legacy, client_id: "robynn-mcp-worker" });
      expect(refused.status).toBe(400);
      expect(refused.json.error).toBe("invalid_grant");
      expect(sql(`select coalesce(used_at::text, 'unused') from public.oauth_refresh_tokens where token_hash=${lit(hash)}`)).toBe("unused");
      sql(`update public.oauth_refresh_tokens set revoked = true where token_hash=${lit(hash)}`);

      expect(await appBearer("/api/cli/context/summary", legacyAccessJwt(ALPHA.id, ORG_A))).toBe(401);
    });
  });

  describe("session binding, membership and credential version", () => {
    it("another user's valid token on an existing session id is refused (POST, GET, DELETE); the owner keeps working", async () => {
      const a = await connectHost({ clientId, user: ALPHA, organizationId: ORG_A, scope: "brand:read" });
      const betaClient = await registerHost("P16 Beta Host");
      const b = await connectHost({ clientId: betaClient, user: BETA, organizationId: ORG_B, scope: "brand:read" });
      const session = await openSession(a.access);

      const post = await callTool(b.access, session, "robynn_status");
      expect(post.status).toBe(404);
      expect(post.json?.error?.code).toBe(-32001);
      expect((await callTool(b.access, session, "robynn_vault_list")).status).toBe(404);
      expect((await mcp(b.access, {}, session, "GET")).status).toBe(404);
      expect((await mcp(b.access, {}, session, "DELETE")).status).toBe(404);
      expect((await mcp(a.access, {}, "never-initialized-session", "POST")).status).toBe(404);
      expect(toolOk(await callTool(a.access, session, "robynn_status"))).toBe(true);
    });

    it("a removed member's connection stops at the next call, the Worker grant is revoked, and refresh fails", async () => {
      const conn = await connectHost({ clientId, user: ALPHA, organizationId: ORG_B, scope: "brand:read" });
      const session = await openSession(conn.access);
      expect(toolOk(await callTool(conn.access, session, "robynn_status"))).toBe(true);
      setMembershipStatus(ALPHA.id, ORG_B, "removed");
      try {
        const gone = await callTool(conn.access, session, "robynn_status");
        expect(gone.status).toBe(401);
        expect((await ping(conn.access, session)).status).toBe(401);
        expect((await hostRefresh(clientId, conn.refresh)).body.error).toBe("invalid_grant");
        // ...and cannot reconnect to that workspace.
        const { browser, appUrl } = await atConsent(clientId, ALPHA, "brand:read");
        expect((await consentAtApp(browser, appUrl, { organizationId: ORG_B })).status).toBe(403);
      } finally {
        setMembershipStatus(ALPHA.id, ORG_B, "active");
      }
    });

    it("a credential-version bump makes the access token stale (401) without revoking; refresh renews it", async () => {
      const conn = await connectHost({ clientId, user: ALPHA, organizationId: ORG_A, scope: "brand:read" });
      const session = await openSession(conn.access);
      sql(`select public.oauth_bump_grant_credential_version(${lit(conn.appGrantId)})`);
      const stale = await callTool(conn.access, session, "robynn_status");
      expect(stale.status).toBe(401);
      expect(stale.www).toMatch(/invalid_token/);
      const renewed = await hostRefresh(clientId, conn.refresh);
      expect(renewed.status).toBe(200);
      expect(toolOk(await callTool(renewed.body.access_token, session, "robynn_status"))).toBe(true);
    });

    it("unsigned introspection is refused", async () => {
      const res = await appInternal(
        "/api/oauth/introspect",
        { grant_id: randomUUID(), user_id: ALPHA.id, organization_id: ORG_A, client_id: "robynn-mcp-worker", credential_version: 1 },
        { sign: false },
      );
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("invalid_client");
    });
  });

  describe("log canaries", () => {
    it("no code, state, cookie, token, password or local secret seen by this suite appears in the app or Worker logs", () => {
      expect(logsContainingSensitiveValues()).toEqual([]);
    });
  });
});
