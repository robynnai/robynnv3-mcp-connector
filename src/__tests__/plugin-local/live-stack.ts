/**
 * Helpers for the COS-PLUGIN-001 P16 live suites against the plugin-local
 * stack (workspace `scripts/plugin-dev-up.sh`; docs/plugin-v1/OAUTH_INTEGRATION_TESTS.md).
 *
 * Everything here talks to loopback only: the real app (SvelteKit, local
 * Supabase), the real Worker (`wrangler dev --local`) and the isolated
 * Postgres container. Synthetic data only. Values read from the generated
 * plugin-local files (the synthetic password, the local internal-auth
 * secret) and every credential the flows produce are kept in memory, never
 * printed, and registered with {@link sensitive} so the suite can prove none
 * of them reached the app or Worker logs.
 *
 * The suites are skipped unless PLUGIN_LOCAL_LIVE=1. With PLUGIN_LOCAL_LIVE=1
 * the run fails (never skips) unless PLUGIN_LOCAL_STATE_DIR names the
 * workspace's `.workspace-dev/plugin-local` (P16 review N1: no vacuous pass).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { internalMcpRequestHeaders } from "../../internal-mcp-auth";

export const STATE_DIR = process.env.PLUGIN_LOCAL_STATE_DIR ?? "";
/** Live suites were requested (`pnpm test:plugin-local`). */
export const LIVE_REQUESTED = process.env.PLUGIN_LOCAL_LIVE === "1";
if (LIVE_REQUESTED && (STATE_DIR === "" || !existsSync(join(STATE_DIR, "secrets.env")))) {
  throw new Error(
    "PLUGIN_LOCAL_LIVE=1 needs PLUGIN_LOCAL_STATE_DIR set to the workspace's .workspace-dev/plugin-local (with secrets.env); refusing to skip",
  );
}
export const LIVE = LIVE_REQUESTED;

/**
 * Suites a run explicitly opts out of (`PLUGIN_LOCAL_SKIP=vault,...`). An
 * explicit opt-out is the only way a requested live suite may skip.
 */
export const explicitlySkipped = (suite: string) =>
  (process.env.PLUGIN_LOCAL_SKIP ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(suite);

export const APP = process.env.PLUGIN_LOCAL_APP_URL ?? "http://localhost:5173";
export const WORKER = process.env.PLUGIN_LOCAL_WORKER_URL ?? "http://localhost:8787";
export const DB_CONTAINER = process.env.PLUGIN_LOCAL_DB_CONTAINER ?? "supabase_db_robynn_cos_plugin_001";
/** The host's loopback callback (Claude Code and Codex use one like it). */
export const HOST_CALLBACK = "http://127.0.0.1:33916/callback";

// Synthetic seed (workspace scripts/plugin-local/synthetic-seed.sql).
export const ORG_A = "0c05a001-0000-4000-8000-00000000000a";
export const ORG_B = "0c05a001-0000-4000-8000-00000000000b";
/** Admin of A, active collaborator of B. */
export const ALPHA = { id: "0c05a001-0000-4000-8000-0000000000a1", email: "plugin-local-alpha@robynn.test" };
/** Admin of B, removed collaborator of A. */
export const BETA = { id: "0c05a001-0000-4000-8000-0000000000b1", email: "plugin-local-beta@robynn.test" };
/** An org neither user belongs to (created by the suites when needed). */
export const STRANGER_ORG = "0c05a001-0000-4000-8000-0000000016ff";

function assertLoopback(raw: string) {
  const host = new URL(raw).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error(`plugin-local live suites only talk to loopback (refused ${host})`);
  }
}

if (LIVE) {
  for (const url of [APP, WORKER, HOST_CALLBACK]) assertLoopback(url);
  if (!/^supabase_db_[a-z0-9_]*cos_plugin[a-z0-9_]*$/.test(DB_CONTAINER)) {
    throw new Error("PLUGIN_LOCAL_DB_CONTAINER must be the isolated plugin-local database container");
  }
}

// ---------------------------------------------------------------------------
// Secrets and canaries
// ---------------------------------------------------------------------------

/** Every credential or one-time value the suites see; scanned against logs. */
export const sensitive = new Set<string>();

export function remember<T extends string | null | undefined>(value: T): T {
  if (typeof value === "string" && value.length >= 8) sensitive.add(value);
  return value;
}

/** Reads one KEY=VALUE line from a generated plugin-local file (never printed). */
export function generatedValue(file: string, key: string): string {
  const line = readFileSync(join(STATE_DIR, file), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from ${file}`);
  return remember(line.slice(key.length + 1).replace(/^"|"$/g, ""));
}

/** Names of log files under the plugin-local state dir whose text contains a remembered value. */
export function logsContainingSensitiveValues(): { file: string; hits: number }[] {
  const dir = join(STATE_DIR, "logs");
  if (!existsSync(dir)) return [];
  const findings: { file: string; hits: number }[] = [];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    let hits = 0;
    for (const value of sensitive) if (text.includes(value)) hits++;
    if (hits) findings.push({ file: name, hits });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Database (isolated container, local only)
// ---------------------------------------------------------------------------

export function sql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-X", "-At", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", query],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

/** Literal for a value the suite itself generated (uuids, hex); refuses anything else. */
export function lit(value: string): string {
  if (!/^[A-Za-z0-9:._\-]+$/.test(value)) throw new Error("refusing to interpolate an unexpected SQL literal");
  return `'${value}'`;
}

/** Flip a seeded membership on the local synthetic DB (bypasses the membership trigger, as P07/P10 did). */
export function setMembershipStatus(userId: string, organizationId: string, status: "active" | "removed") {
  sql(
    `set session_replication_role = replica; update public.organization_memberships set status=${lit(status)} where user_id=${lit(userId)} and organization_id=${lit(organizationId)}`,
  );
}

// ---------------------------------------------------------------------------
// A browser: one cookie jar for localhost (cookies are not port-scoped)
// ---------------------------------------------------------------------------

/**
 * A browser's plain form POST. `accept: text/html` matters: with Node's
 * default (any type), SvelteKit answers form actions with its JSON envelope
 * instead of the redirect a browser gets.
 */
const FORM_POST_HEADERS = { origin: APP, accept: "text/html", "content-type": "application/x-www-form-urlencoded" };

export class Browser {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response) {
    // Node's Headers (undici); the Workers type definitions omit getSetCookie.
    const setCookies = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
    for (const raw of setCookies) {
      const [pair, ...attributes] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a: string) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, remember(value));
    }
  }

  /** Same cookies (e.g. the app session), independent jar from here on. */
  clone() {
    const copy = new Browser();
    for (const [name, value] of this.cookies) copy.cookies.set(name, value);
    return copy;
  }

  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader);
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.absorb(res);
    return res;
  }

  /** The real sign-in form action (`/login/sign_in`). */
  async signIn(email: string, password: string) {
    const res = await this.fetch(`${APP}/login/sign_in`, {
      method: "POST",
      // One browser per synthetic user (the sign-in limiter counts per IP + user agent).
      headers: { ...FORM_POST_HEADERS, "user-agent": `p16-live-browser/${email.split("@")[0]}` },
      body: new URLSearchParams({ email, password }).toString(),
    });
    await res.body?.cancel();
    return res.status;
  }
}

/** The synthetic users' shared password from the generated secrets file. */
export const syntheticPassword = () => generatedValue("secrets.env", "PLUGIN_LOCAL_USER_PASSWORD");

const signedIn = new Map<string, Browser>();

/**
 * A browser already signed in as `user`. Each user signs in once per run
 * through the real form action (the app allows 10 sign-ins an hour per IP);
 * every flow then gets its own copy of that session, like tabs of one
 * browser.
 */
export async function browserFor(user: { email: string }): Promise<Browser> {
  let session = signedIn.get(user.email);
  if (!session) {
    session = new Browser();
    const status = await session.signIn(user.email, syntheticPassword());
    if (status !== 303) throw new Error(`sign-in answered ${status}`);
    signedIn.set(user.email, session);
  }
  return session.clone();
}

// ---------------------------------------------------------------------------
// Host (MCP client): DCR, /authorize, consent, /callback, /token
// ---------------------------------------------------------------------------

export function pkce() {
  const verifier = remember(randomBytes(32).toString("base64url"));
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function registerHost(name = "P16 Live Host", redirectUris = [HOST_CALLBACK]) {
  const res = await fetch(`${WORKER}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

export interface AuthorizeOptions {
  clientId: string;
  scope?: string;
  redirectUri?: string;
  challenge?: string | null;
  method?: string | null;
  resource?: string;
}

/** Host's GET /authorize in the browser; returns the hand-off to the app. */
export async function authorizeAtWorker(browser: Browser, opts: AuthorizeOptions) {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri ?? HOST_CALLBACK,
    state: "p16-host-state",
    resource: opts.resource ?? `${WORKER}/mcp`,
  });
  if (opts.scope !== undefined) params.set("scope", opts.scope);
  if (opts.challenge !== null) params.set("code_challenge", opts.challenge ?? challenge);
  if (opts.method !== null) params.set("code_challenge_method", opts.method ?? "S256");
  const res = await browser.fetch(`${WORKER}/authorize?${params}`);
  await res.body?.cancel();
  const location = res.headers.get("location");
  const appUrl = location ? new URL(location) : null;
  if (appUrl?.searchParams.get("state")) remember(appUrl.searchParams.get("state"));
  return { status: res.status, appUrl, verifier };
}

/** Posts the real consent form action (`/oauth/authorize?/authorize`). */
export async function consentAtApp(
  browser: Browser,
  appUrl: URL,
  choice: { organizationId: string; allowExecute?: boolean; tamper?: (form: URLSearchParams) => void },
) {
  const p = appUrl.searchParams;
  const form = new URLSearchParams({
    client_id: p.get("client_id") ?? "",
    redirect_uri: p.get("redirect_uri") ?? "",
    state: p.get("state") ?? "",
    scope: p.get("scope") ?? "",
  });
  if (p.get("client_name")) form.set("client_name", p.get("client_name")!);
  form.set("organization_id", choice.organizationId);
  if (choice.allowExecute) form.set("grant_scope", "tools:execute");
  choice.tamper?.(form);
  const res = await browser.fetch(`${APP}/oauth/authorize?/authorize`, {
    method: "POST",
    headers: FORM_POST_HEADERS,
    body: form.toString(),
  });
  const text = await res.text();
  const location = res.headers.get("location");
  const callback = location ? new URL(location, APP) : null;
  remember(callback?.searchParams.get("code"));
  return { status: res.status, callback, text };
}

/** The browser follows the app's redirect back to the Worker's /callback. */
export async function followToWorkerCallback(browser: Browser, callback: URL) {
  const res = await browser.fetch(callback.href);
  await res.body?.cancel();
  const location = res.headers.get("location");
  const hostUrl = location ? new URL(location) : null;
  remember(hostUrl?.searchParams.get("code"));
  return { status: res.status, hostUrl };
}

export async function hostToken(params: Record<string, string>) {
  const res = await fetch(`${WORKER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  remember(body.access_token);
  remember(body.refresh_token);
  return { status: res.status, body };
}

export interface HostConnection {
  clientId: string;
  access: string;
  refresh: string;
  scope: string;
  appGrantId: string;
}

/**
 * The full chain a host and its user go through: /authorize, real sign-in,
 * real consent, the Worker's /callback (signed exchange + introspection) and
 * the host's PKCE code exchange.
 */
export async function connectHost(opts: {
  clientId: string;
  user: { id: string; email: string };
  organizationId: string;
  scope: string;
  allowExecute?: boolean;
}): Promise<HostConnection> {
  const browser = await browserFor(opts.user);
  const auth = await authorizeAtWorker(browser, { clientId: opts.clientId, scope: opts.scope });
  if (auth.status !== 302 || !auth.appUrl) throw new Error(`/authorize answered ${auth.status}`);
  const consent = await consentAtApp(browser, auth.appUrl, { organizationId: opts.organizationId, allowExecute: opts.allowExecute });
  if (!consent.callback) throw new Error(`consent answered ${consent.status}`);
  const back = await followToWorkerCallback(browser, consent.callback);
  const code = back.hostUrl?.searchParams.get("code");
  if (!code) throw new Error(`/callback returned ${back.hostUrl?.searchParams.get("error") ?? back.status}`);
  const token = await hostToken({
    grant_type: "authorization_code",
    code,
    client_id: opts.clientId,
    redirect_uri: HOST_CALLBACK,
    code_verifier: auth.verifier,
    resource: `${WORKER}/mcp`,
  });
  if (token.status !== 200) throw new Error(`/token answered ${token.status}`);
  const appGrantId = sql(
    `select id from public.oauth_grants where user_id=${lit(opts.user.id)} and organization_id=${lit(opts.organizationId)} and status='active' order by created_at desc limit 1`,
  );
  return { clientId: opts.clientId, access: token.body.access_token, refresh: token.body.refresh_token, scope: token.body.scope, appGrantId };
}

export function hostRefresh(clientId: string, refreshToken: string, extra: Record<string, string> = {}) {
  return hostToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...extra });
}

// ---------------------------------------------------------------------------
// MCP over streamable HTTP
// ---------------------------------------------------------------------------

let rpcId = 1;

export interface McpReply {
  status: number;
  json: { result?: Record<string, any>; error?: { code: number; message: string } } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  session: string | null;
  www: string | null;
}

export async function mcp(access: string, message: Record<string, unknown>, sessionId?: string | null, method = "POST"): Promise<McpReply> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${access}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${WORKER}/mcp`, { method, headers, body: method === "POST" ? JSON.stringify(message) : undefined });
  const text = await res.text();
  let json: McpReply["json"] = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    json = events.at(-1) ?? null;
  } else if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, session: res.headers.get("mcp-session-id"), www: res.headers.get("www-authenticate") };
}

export async function openSession(access: string) {
  const init = await mcp(access, {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p16-live", version: "1" } },
  });
  if (init.status !== 200 || !init.session) throw new Error(`initialize answered ${init.status}`);
  await mcp(access, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
  return init.session;
}

export const callTool = (access: string, sessionId: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(access, { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }, sessionId);

export const listTools = (access: string, sessionId: string) =>
  mcp(access, { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }, sessionId);

export const ping = (access: string, sessionId?: string) => mcp(access, { jsonrpc: "2.0", id: rpcId++, method: "ping" }, sessionId);

export const toolErrorCode = (reply: McpReply): string | null =>
  (reply.json?.result?.structuredContent?.error?.code as string | undefined) ?? null;

export const toolOk = (reply: McpReply) => reply.status === 200 && reply.json?.result !== undefined && !reply.json.result.isError;

// ---------------------------------------------------------------------------
// Acting as the Worker against the app (app-layer negatives only)
// ---------------------------------------------------------------------------

/** The local, generated MCP_INTERNAL_AUTH_SECRET shared by the local Worker and app. */
export const internalSecret = () => generatedValue("secrets.env", "MCP_INTERNAL_AUTH_SECRET");

/** POST a JSON body to an internal app route, signed (or not) exactly as the Worker signs. */
export async function appInternal(path: string, body: Record<string, unknown>, opts: { sign?: boolean } = {}) {
  const url = `${APP}${path}`;
  const raw = JSON.stringify(body);
  const signed = opts.sign === false ? {} : await internalMcpRequestHeaders(internalSecret(), { method: "POST", url, body: raw });
  // P16 review N3: the signature and nonce this suite generates are canaries too.
  // (Not the timestamp: a bare epoch-milliseconds value is not a secret.)
  for (const [name, value] of Object.entries(signed)) if (!/timestamp/i.test(name)) remember(value);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body: raw,
    redirect: "manual",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  remember(json.access_token);
  remember(json.refresh_token);
  return { status: res.status, json };
}

/** App bearer call (as the Worker's tool calls make them). */
export async function appBearer(path: string, accessToken: string) {
  const res = await fetch(`${APP}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "manual" });
  await res.body?.cancel();
  return res.status;
}
