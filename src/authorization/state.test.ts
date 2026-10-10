import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_STATE_TTL_SECONDS,
  clearStateCookie,
  consumeAuthorizationTransaction,
  createAuthorizationTransaction,
  stateCookieName,
  STATE_PATTERN,
} from "./state";

function memoryKv() {
  const store = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  return {
    store,
    ttl,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      ttl.set(key, options?.expirationTtl);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const input = {
  oauthRequest: {
    responseType: "code",
    clientId: "client",
    redirectUri: "http://127.0.0.1:1/cb",
    state: "host-state",
    scope: ["brand:read"],
  },
  requestedScopes: ["brand:read" as const],
  clientName: "Host",
  workerCallbackUrl: "https://mcp.test/callback",
};

async function start(secureCookie = true) {
  const kv = memoryKv();
  const created = await createAuthorizationTransaction(kv, input, { secureCookie });
  const pair = created.setCookie.split(";")[0];
  return { kv, ...created, pair, nonce: pair.slice(pair.indexOf("=") + 1) };
}

describe("createAuthorizationTransaction", () => {
  it("stores the transaction with a 10-minute TTL and only a hash of the browser nonce", async () => {
    const { kv, state, nonce, setCookie } = await start();
    expect(state).toMatch(STATE_PATTERN);
    const record = kv.store.get(`oauth_state:${state}`)!;
    expect(kv.ttl.get(`oauth_state:${state}`)).toBe(AUTHORIZATION_STATE_TTL_SECONDS);
    expect(record).not.toContain(nonce);
    expect(JSON.parse(record)).toMatchObject({ v: 2, requestedScopes: ["brand:read"], clientName: "Host" });
    expect(setCookie).toBe(
      `${stateCookieName(state, true)}=${nonce}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it("generates distinct states and nonces", async () => {
    const a = await start();
    const b = await start();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("consumeAuthorizationTransaction", () => {
  it("returns and deletes the transaction for the owning browser", async () => {
    const { kv, state, pair } = await start();
    const result = await consumeAuthorizationTransaction(kv, state, `other=1; ${pair}`, { secureCookie: true });
    expect(result.ok).toBe(true);
    expect(kv.store.size).toBe(0);
    expect(await consumeAuthorizationTransaction(kv, state, pair, { secureCookie: true })).toEqual({
      ok: false,
      reason: "state_unknown",
    });
  });

  it.each([
    ["no cookie", undefined, "browser_binding_missing"],
    ["another flow's cookie", "robynn_oauth_x=abc", "browser_binding_missing"],
  ])("rejects %s and keeps the record", async (_label, cookie, reason) => {
    const { kv, state } = await start();
    expect(await consumeAuthorizationTransaction(kv, state, cookie, { secureCookie: true })).toEqual({ ok: false, reason });
    expect(kv.store.size).toBe(1);
  });

  it("rejects a wrong nonce and keeps the record", async () => {
    const { kv, state } = await start();
    const cookie = `${stateCookieName(state, true)}=${"A".repeat(43)}`;
    expect(await consumeAuthorizationTransaction(kv, state, cookie, { secureCookie: true })).toEqual({
      ok: false,
      reason: "browser_binding_mismatch",
    });
    expect(kv.store.size).toBe(1);
  });

  it("refuses an ambiguous duplicated cookie", async () => {
    const { kv, state, pair } = await start();
    const dup = `${pair}; ${stateCookieName(state, true)}=evil`;
    expect((await consumeAuthorizationTransaction(kv, state, dup, { secureCookie: true })).ok).toBe(false);
  });

  it("does not accept the non-__Host- cookie name on https", async () => {
    const { kv, state, nonce } = await start(true);
    const downgraded = `${stateCookieName(state, false)}=${nonce}`;
    expect((await consumeAuthorizationTransaction(kv, state, downgraded, { secureCookie: true })).ok).toBe(false);
  });

  it.each([[undefined], [""], ["short"], ["a".repeat(44)], ["a/".repeat(22)]])("rejects malformed state %j", async (state) => {
    const { kv } = await start();
    expect(await consumeAuthorizationTransaction(kv, state, "", { secureCookie: true })).toEqual({
      ok: false,
      reason: "state_malformed",
    });
  });

  it("rejects and deletes a corrupt or legacy record", async () => {
    const { kv, state, pair } = await start();
    kv.store.set(`oauth_state:${state}`, JSON.stringify({ workerCallbackUrl: "x", oauthRequest: {} }));
    expect(await consumeAuthorizationTransaction(kv, state, pair, { secureCookie: true })).toEqual({
      ok: false,
      reason: "state_corrupt",
    });
    expect(kv.store.size).toBe(0);
  });

  it("rejects an expired record", async () => {
    const { kv, state, pair } = await start();
    const key = `oauth_state:${state}`;
    const record = JSON.parse(kv.store.get(key)!);
    record.createdAt = Date.now() - (AUTHORIZATION_STATE_TTL_SECONDS + 1) * 1000;
    kv.store.set(key, JSON.stringify(record));
    expect(await consumeAuthorizationTransaction(kv, state, pair, { secureCookie: true })).toEqual({
      ok: false,
      reason: "state_expired",
    });
  });
});

describe("clearStateCookie", () => {
  it("expires the cookie with matching attributes", () => {
    expect(clearStateCookie("s".repeat(43), false)).toBe(
      `robynn_oauth_${"s".repeat(43)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });
});
