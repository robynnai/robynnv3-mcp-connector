/**
 * COS-PLUGIN-001 P17 — every MCP tool against the real backend on the
 * plugin-local stack (plan §10 P17; §8 "Every-tool contract coverage":
 * "Separately test app operations against local data and stubbed external
 * services").
 *
 * Real host OAuth (P16 chain) → real Worker (`wrangler dev --local`: preflight,
 * session DO, Vault R2) → real app (SvelteKit routes, P07 authorization,
 * billing, persistence) → real local Supabase with the synthetic seed. The
 * only stand-in is {@link BackendFixture} on loopback: LangGraph, Composio,
 * a Strapi endpoint and the app's egress proxy (deterministic outputs; no
 * real agent, LLM or provider; nothing leaves the machine).
 *
 * For each of the 48 tools:
 *   - success: a real call, its result checked, and selected persistence read
 *     back from Postgres;
 *   - error: a deterministic failure (bad input refused by the app or Worker,
 *     a backend/graph failure from the fixture, or an injected local DB
 *     fault) that comes back as a sanitized MCP error with nothing leaked;
 *   - permission denied: tools:execute tools under a read-only grant (refused
 *     by the Worker before any backend, and again by the app for a read-only
 *     upstream token), brand:read tools for a stale credential (Worker) and a
 *     removed member (app). Denials start no work and write nothing.
 *
 * Needs the stack from `plugin-dev-up.sh --reset-db` with the P17 fixture
 * environment (docs/plugin-v1/TOOL_BACKEND_INTEGRATION_TESTS.md). Run with
 * `pnpm test:plugin-local`; skipped unless PLUGIN_LOCAL_LIVE=1.
 */
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import toolRouteMap from "../../../contracts/tool-route-map.json";
import { TOOL_FIXTURES } from "../catalog-contract.fixtures";
import { BackendFixture, FIXTURE_API_KEY, FIXTURE_MARKER, PUBLIC_SITE_HOST, PUBLIC_SITE_URL } from "./backend-fixture";
import { registerFixtureGraphs } from "./fixture-graphs";
import {
  ALPHA,
  APP,
  BETA,
  LIVE,
  ORG_A,
  ORG_B,
  STATE_DIR,
  WORKER,
  appInternal,
  callTool,
  connectHost,
  generatedValue,
  lit,
  logsContainingSensitiveValues,
  openSession,
  registerHost,
  remember,
  setMembershipStatus,
  sql,
  toolErrorCode,
  toolOk,
  type HostConnection,
  type McpReply,
} from "./live-stack";

const LONG = 180_000;
const WORKER_CALLBACK = `${WORKER}/callback`;

type Outcome = "success" | "error" | "denied";
interface MapTool {
  name: string;
  requiredScope: "brand:read" | "tools:execute";
  scopeByArgument?: Record<string, Record<string, string>>;
  appRoutes: Array<{ method: string; path: string; file: string | null; hop?: string }>;
}
const MAP_TOOLS = (toolRouteMap as unknown as { tools: MapTool[] }).tools;
const ALL_TOOLS = MAP_TOOLS.map((t) => t.name);
const EXECUTE_TOOLS = MAP_TOOLS.filter((t) => t.requiredScope === "tools:execute").map((t) => t.name);
const READ_TOOLS = MAP_TOOLS.filter((t) => t.requiredScope === "brand:read").map((t) => t.name);

/** Which of the three contract cases each tool has proven live (checked at the end). */
const covered = new Map<string, Set<Outcome>>(ALL_TOOLS.map((n) => [n, new Set<Outcome>()]));
const cover = (tool: string, outcome: Outcome) => {
  if (!covered.has(tool)) throw new Error(`unknown tool ${tool}`);
  covered.get(tool)!.add(outcome);
};

// P17 synthetic rows (fixed ids in the plugin-local seed's 0c05a001 namespace).
const P17 = {
  website: "0c05a001-0000-4000-8000-0000000017a1",
  connection: "0c05a001-0000-4000-8000-0000000017a2",
  strapiCredential: "0c05a001-0000-4000-8000-0000000017a3",
  betaThread: "0c05a001-0000-4000-8000-0000000017a4",
};
/** Seeded prospect audit fixtures (P02 seed). */
const B_PENDING_AUDIT = "0c05a001-0000-4000-8000-0000000b0d01";
const HUBSPOT_PROVIDER = () => sql(`select id from public.connector_providers where key='hubspot'`);

/** SQL text literal for suite-owned constants only (refuses anything unexpected). */
function q(value: string): string {
  if (!/^[A-Za-z0-9:._\-/ ,@()#+=]*$/.test(value)) throw new Error("refusing to interpolate an unexpected SQL literal");
  return `'${value}'`;
}

const fixture = new BackendFixture();
let full: Conn; // alpha → Org A, brand:read + tools:execute
let ro: Conn; // alpha → Org A, brand:read only
let fullB: Conn; // alpha → Org B (collaborator), brand:read + tools:execute

interface Conn extends HostConnection {
  session: string;
}

/**
 * A new host connection. Each gets its own DCR client: the provider replaces
 * a user's earlier grants for the same client on reconnect (P16), exactly as
 * two installs of one host would.
 */
async function connect(organizationId: string, execute: boolean): Promise<Conn> {
  const clientId = await registerHost(`P17 Tool Host ${organizationId.slice(-2)} ${execute ? "exec" : "read"} ${randomBytes(2).toString("hex")}`);
  const conn = await connectHost({
    clientId,
    user: ALPHA,
    organizationId,
    scope: execute ? "brand:read tools:execute" : "brand:read",
    allowExecute: execute,
  });
  expect(conn.scope).toBe(execute ? "brand:read tools:execute" : "brand:read");
  return { ...conn, session: await openSession(conn.access) };
}

const call = (c: Conn, name: string, args: Record<string, unknown> = {}) => callTool(c.access, c.session, name, args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: McpReply): any => r.json?.result?.structuredContent ?? {};
const text = (r: McpReply) => JSON.stringify(r.json?.result ?? r.json ?? null);
const isToolError = (r: McpReply) => r.status === 200 && r.json?.result?.isError === true;
const isValidationError = (r: McpReply) =>
  r.status === 200 && (r.json?.error?.code === -32602 || (r.json?.result?.isError === true && /Input validation error|Invalid arguments/i.test(text(r))));

/** Every error the model sees must be sanitized (plan §5 error canaries). */
function expectSanitized(r: McpReply) {
  const body = text(r);
  expect(body).not.toMatch(/Bearer\s|eyJ[\w-]{8,}\.[\w-]{8,}/);
  expect(body).not.toMatch(/permission denied for|relation "|violates|syntax error|\/Users\/|node_modules|\n\s+at\s/);
  expect(body).not.toContain(FIXTURE_API_KEY);
  for (const value of [full?.access, full?.refresh, ro?.access, fullB?.access]) if (value) expect(body).not.toContain(value);
}

function expectOk(r: McpReply, label: string) {
  expect(toolOk(r), `${label}: ${text(r).slice(0, 600)}`).toBe(true);
}

function expectToolError(r: McpReply, label: string) {
  expect(isToolError(r) || isValidationError(r), `${label}: ${text(r).slice(0, 600)}`).toBe(true);
  expectSanitized(r);
}

// ---------------------------------------------------------------------------
// Side-effect accounting: business rows for the synthetic orgs
// ---------------------------------------------------------------------------

const WATCHED_TABLES = [
  "hermes_memories",
  "hermes_threads",
  "brand_hub_docs",
  "brand_hub_docs_changelog",
  "brand_hub_docs_changelog_trigger_rate_limits",
  "instant_agent_threads",
  "instant_agent_runs",
  "interactions_history",
  "connector_action_audit",
  "connector_action_logs",
  "prospect_audits",
  "mcp_campaign_runs",
  "design_studio_optimization_scans",
  "competitor_intel_profiles",
  "publishing_logs",
  "billing_events",
  "token_usage",
  "org_knowledge_documents",
];

/** The isolated DB's clock (rows written after this are this test's). */
const dbNow = () => sql(`select now()::text`);

/** Credits a reservation can draw on (reserve_tokens_for_execution); releases refund into subscription_tokens. */
const AVAILABLE_CREDITS = "(token_balance + subscription_tokens + purchased_tokens)";

/** Row counts per watched table for both synthetic orgs, plus token balances. */
function businessSnapshot(): Record<string, string> {
  const orgs = `(${lit(ORG_A)}, ${lit(ORG_B)})`;
  const snapshot: Record<string, string> = {};
  for (const table of WATCHED_TABLES) {
    snapshot[table] = sql(`select count(*) from public.${table} where organization_id in ${orgs}`);
  }
  snapshot.hermes_messages = sql(
    `select count(*) from public.hermes_messages m join public.hermes_threads t on t.id = m.thread_id where t.organization_id in ${orgs}`,
  );
  snapshot.balances = sql(`select string_agg(id || ':' || ${AVAILABLE_CREDITS}, ',' order by id) from public.organizations where id in ${orgs}`);
  return snapshot;
}

/**
 * Fault injection on the isolated DB: the app's service role temporarily
 * loses one privilege (functions: also PUBLIC's default EXECUTE).
 */
async function withoutPrivilege<T>(grant: string, on: string, run: () => Promise<T>): Promise<T> {
  const roles = on.startsWith("function ") ? "public, service_role" : "service_role";
  sql(`revoke ${grant} on ${on} from ${roles}`);
  try {
    return await run();
  } finally {
    sql(`grant ${grant} on ${on} to ${roles}`);
  }
}

// ---------------------------------------------------------------------------
// App-layer tokens (as the Worker would hold them), without browser sign-ins
// ---------------------------------------------------------------------------

/** Issue a grant + code in the local DB and exchange it through the signed token endpoint. */
async function appToken(organizationId: string, scope: string): Promise<{ access: string; grantId: string }> {
  // The RPC's code format: <uuid>-<32 hex>.
  const code = remember(`${randomUUID()}-${randomBytes(16).toString("hex")}`);
  sql(
    `select public.oauth_issue_authorization_code(${lit(code)}, ${lit(ALPHA.id)}, ${lit(organizationId)}, 'robynn-mcp-worker', ${q(WORKER_CALLBACK)}, ${q(scope)}, 600, 7776000, null, 'p17-live')`,
  );
  const exchange = await appInternal("/api/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: WORKER_CALLBACK,
    client_id: "robynn-mcp-worker",
  });
  expect(exchange.status).toBe(200);
  const grantId = sql(`select grant_id from public.oauth_authorization_codes where code=${lit(code)}`);
  return { access: exchange.json.access_token as string, grantId };
}

/** One app route as the Worker calls it (bearer only); concrete ids for path templates. */
async function appRoute(route: { method: string; path: string }, token: string) {
  const path = route.path
    .replace("{scope}", "summary")
    .replace(/\{[A-Za-z]+\}/g, () => randomUUID());
  const res = await fetch(`${APP}${path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, ...(route.method === "GET" ? {} : { "content-type": "application/json" }) },
    body: route.method === "GET" ? undefined : JSON.stringify({}),
    redirect: "manual",
  });
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON
  }
  return { status: res.status, code: (json.code ?? json.error_code ?? null) as string | null, raw };
}

const businessRoutes = (tool: string) =>
  MAP_TOOLS.find((t) => t.name === tool)!.appRoutes.filter((r) => r.file !== null && r.hop !== "internal");

// ---------------------------------------------------------------------------
// Vault: a synthetic object in the Worker's local R2 (never remote)
// ---------------------------------------------------------------------------

const MCP_DIR = process.cwd();
function putVaultObject(key: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "p17-vault-"));
  try {
    const file = join(dir, "object.md");
    writeFileSync(file, body);
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "r2", "object", "put", `robynn-materialized-plugin-local/${key}`, "--local", "--persist-to", ".wrangler/state/cos-plugin-001", "--config", "wrangler.local.toml", "--file", file],
      { cwd: MCP_DIR, stdio: "pipe" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** AES-256-GCM `iv:tag:ciphertext` (hex), the app's legacy credential format (robynnv3 src/lib/server/encryption.ts). */
function encryptForApp(plaintext: string) {
  const key = Buffer.from(generatedValue("robynnv3.env", "GRAPHLIT_ENCRYPTION_KEY"), "hex");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

/** A non-secret key from the generated app env (not registered as a log canary). */
function configValue(key: string): string {
  const line = readFileSync(join(STATE_DIR, "robynnv3.env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : "";
}

async function until<T>(probe: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000, intervalMs = 1_500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await probe();
  }
  return value;
}

describe.skipIf(!LIVE)("plugin-local: all 48 tools against the real app, DB and deterministic backends (P17)", () => {
  beforeAll(async () => {
    // The fixture env must be in the running app (else LangGraph/Composio calls would be keyless or leave the machine).
    // The dummy LangGraph key is remembered as a log canary; the rest is non-secret config.
    expect(generatedValue("robynnv3.env", "LANGGRAPH_API_KEY")).toBe(FIXTURE_API_KEY);
    // GEO authenticates to LangGraph with GEO_API_KEY only (agents/geo/execute), as production configures it.
    expect(configValue("GEO_API_KEY")).toBe(FIXTURE_API_KEY);
    expect(configValue("COMPOSIO_API_BASE_URL")).toBe("http://localhost:8123");
    expect(configValue("NODE_USE_ENV_PROXY")).toBe("1");
    expect(configValue("HTTP_PROXY")).toBe("http://localhost:8123");
    expect(configValue("HTTPS_PROXY")).toBe("http://localhost:8123");
    expect(configValue("NO_PROXY")).toBe("localhost,127.0.0.1");
    expect((await fetch(`${WORKER}/`)).status).toBe(200);

    await fixture.start();
    registerFixtureGraphs(fixture, {
      writeBattlecard: (competitorId) => {
        // A regeneration supersedes the current card (one is_current row per competitor).
        sql(
          `update public.competitor_battlecards set is_current = false where competitor_id=${lit(competitorId)} and is_current; ` +
          `insert into public.competitor_battlecards (competitor_id, version, positioning_analysis, strengths, weaknesses, what_to_counter, feature_comparison, model_used) values (${lit(competitorId)}, (select coalesce(max(version), 0) + 1 from public.competitor_battlecards where competitor_id=${lit(competitorId)}), ${q(`${FIXTURE_MARKER} positioning`)}, '["Synthetic strength"]', '["Synthetic weakness"]', '["Synthetic counter"]', '{"dimensions":[],"priorityMoves":[]}', 'p17-fixture')`,
        );
      },
    });

    // P17 synthetic additions on top of the P02 seed (local DB only).
    sql(`update public.organizations set purchased_tokens = 100000, subscription_tokens = 0, token_balance = 0 where id in (${lit(ORG_A)}, ${lit(ORG_B)})`);
    // Re-runnable: a previous run's 5-minute reflections cooldown would refuse the first trigger.
    sql(`delete from public.brand_hub_docs_changelog_trigger_rate_limits where organization_id in (${lit(ORG_A)}, ${lit(ORG_B)})`);
    sql(
      `insert into public.organization_websites (id, organization_id, label, base_url, hostname, is_primary, created_by) values (${lit(P17.website)}, ${lit(ORG_A)}, 'P17 synthetic site', ${q(PUBLIC_SITE_URL)}, ${q(PUBLIC_SITE_HOST)}, true, ${lit(ALPHA.id)}) on conflict (id) do nothing`,
    );
    sql(
      `insert into public.connector_connections (id, organization_id, provider_id, ownership_mode, composio_user_id, composio_connected_account_id, status, is_default, health_status, connected_by, display_name) values (${lit(P17.connection)}, ${lit(ORG_A)}, ${lit(HUBSPOT_PROVIDER())}, 'org_shared', 'p17-fixture-user', 'p17-fixture-account', 'active', true, 'healthy', ${lit(ALPHA.id)}, 'P17 HubSpot (fixture)') on conflict (id) do nothing`,
    );
    const strapiToken = remember(`p17-strapi-${randomBytes(16).toString("hex")}`);
    sql(
      `insert into public.publishing_credentials (id, organization_id, platform, credential_type, access_token_encrypted, metadata, status, connected_by) values (${lit(P17.strapiCredential)}, ${lit(ORG_A)}, 'strapi', 'api_key', ${lit(encryptForApp(strapiToken))}, jsonb_build_object('base_url', 'http://localhost:8123', 'route_path', '/strapi/drafts'), 'active', ${lit(ALPHA.id)}) on conflict (id) do nothing`,
    );

    full = await connect(ORG_A, true);
    ro = await connect(ORG_A, false);
    fullB = await connect(ORG_B, true);
  }, LONG);

  afterAll(async () => {
    setMembershipStatus(ALPHA.id, ORG_B, "active");
    await fixture.stop();
  });

  // =========================================================================
  // Permission denied
  // =========================================================================

  describe("permission denied", () => {
    it(
      "read-only grant: all tools:execute tools are refused by the Worker before any backend; nothing is written or charged",
      async () => {
        const before = businessSnapshot();
        const mark = fixture.mark();
        for (const tool of EXECUTE_TOOLS) {
          const args = tool === "robynn_conversations" ? { action: "create", title: "p17 denied" } : TOOL_FIXTURES[tool].args;
          const reply = await call(ro, tool, args);
          expect(toolErrorCode(reply), `${tool}: ${text(reply).slice(0, 300)}`).toBe("insufficient_scope");
          expect(data(reply).error.required_scope, tool).toBe("tools:execute");
          expectSanitized(reply);
          cover(tool, "denied");
        }
        expect(fixture.since(mark)).toEqual([]);
        expect(businessSnapshot()).toEqual(before);
      },
      LONG,
    );

    it(
      "read-only upstream token at the app (defense in depth): every tools:execute route answers 403 insufficient_scope; nothing is written",
      async () => {
        const token = await appToken(ORG_A, "brand:read");
        const before = businessSnapshot();
        const mark = fixture.mark();
        for (const tool of EXECUTE_TOOLS) {
          const routes = businessRoutes(tool).filter(
            // robynn_conversations: only its create route is tools:execute.
            (r) => !(tool === "robynn_conversations" && r.method === "GET"),
          );
          expect(routes.length, tool).toBeGreaterThan(0);
          for (const route of routes) {
            const res = await appRoute(route, token.access);
            expect(res.status, `${tool} ${route.method} ${route.path}`).toBe(403);
            expect(res.code, `${tool} ${route.method} ${route.path}`).toBe("insufficient_scope");
          }
        }
        expect(fixture.since(mark)).toEqual([]);
        expect(businessSnapshot()).toEqual(before);
      },
      LONG,
    );

    it(
      "stale credential: every brand:read tool (including Vault) is refused at introspection with 401 invalid_token, without revoking",
      async () => {
        const stale = await connect(ORG_A, false);
        sql(`select public.oauth_bump_grant_credential_version(${lit(stale.appGrantId)})`);
        const before = businessSnapshot();
        const mark = fixture.mark();
        for (const tool of READ_TOOLS) {
          const reply = await call(stale, tool, TOOL_FIXTURES[tool].args);
          expect(reply.status, tool).toBe(401);
          expect(reply.www ?? "", tool).toMatch(/invalid_token/);
          cover(tool, "denied");
        }
        expect(sql(`select status from public.oauth_grants where id=${lit(stale.appGrantId)}`)).toBe("active");
        expect(fixture.since(mark)).toEqual([]);
        expect(businessSnapshot()).toEqual(before);
      },
      LONG,
    );

    it(
      "removed member at the app: every brand:read route answers 403 membership_inactive; nothing is read or written",
      async () => {
        const token = await appToken(ORG_B, "brand:read");
        const before = businessSnapshot();
        setMembershipStatus(ALPHA.id, ORG_B, "removed");
        try {
          for (const tool of READ_TOOLS.filter((t) => !t.startsWith("robynn_vault_"))) {
            for (const route of businessRoutes(tool)) {
              const res = await appRoute(route, token.access);
              expect(res.status, `${tool} ${route.method} ${route.path}`).toBe(403);
              expect(res.code, `${tool} ${route.method} ${route.path}`).toBe("membership_inactive");
              expect(res.raw).not.toContain("COSPLUGIN-MARKER-ORG-B");
            }
          }
        } finally {
          setMembershipStatus(ALPHA.id, ORG_B, "active");
        }
        expect(businessSnapshot()).toEqual(before);
      },
      LONG,
    );
  });

  // =========================================================================
  // Brand context, status, usage, capabilities
  // =========================================================================

  describe("brand context, status, usage and capabilities", () => {
    it("robynn_brand_context: the bound org's seeded summary only; an unknown scope is refused", async () => {
      const reply = await call(ro, "robynn_brand_context", { scope: "summary" });
      expectOk(reply, "brand_context");
      expect(text(reply)).toContain("COSPLUGIN-MARKER-ORG-A");
      expect(text(reply)).not.toContain("COSPLUGIN-MARKER-ORG-B");
      cover("robynn_brand_context", "success");

      const bad = await call(ro, "robynn_brand_context", { scope: "p17-not-a-scope" });
      expectToolError(bad, "brand_context bad scope");
      cover("robynn_brand_context", "error");
    });

    it("robynn_brand_context_search: finds the org A fixture phrase, never org B's; a blank query is refused", async () => {
      const reply = await call(ro, "robynn_brand_context_search", { query: "heliotrope packet routing" });
      expectOk(reply, "search");
      expect(text(reply)).toMatch(/heliotrope packet routing/i);
      expect(text(reply)).not.toMatch(/cobalt orchard telemetry|COSPLUGIN-MARKER-ORG-B/i);
      cover("robynn_brand_context_search", "success");

      const blank = await call(ro, "robynn_brand_context_search", { query: "   " });
      expectToolError(blank, "search blank");
      cover("robynn_brand_context_search", "error");
    });

    it("robynn_status: reports the bound organization and the granted permissions (P10 N7, plan §9 step 5)", async () => {
      const read = await call(ro, "robynn_status");
      expectOk(read, "status ro");
      expect(data(read).connection).toEqual({
        organization: { id: ORG_A, name: "Synthetic Org A (COS-PLUGIN-001)" },
        permissions: ["brand:read"],
        can_execute: false,
      });
      const exec = await call(fullB, "robynn_status");
      expect(data(exec).connection).toEqual({
        organization: { id: ORG_B, name: "Synthetic Org B (COS-PLUGIN-001)" },
        permissions: ["brand:read", "tools:execute"],
        can_execute: true,
      });
      expect(data(exec).organization_id).toBe(ORG_B);
      cover("robynn_status", "success");
    });

    it("robynn_status error: a local DB fault in the brand-context read surfaces as a sanitized error", async () => {
      const reply = await withoutPrivilege("select", "public.brand_hub_docs", () => call(ro, "robynn_status"));
      expect(isToolError(reply) || data(reply).connected === false, text(reply).slice(0, 400)).toBe(true);
      expectSanitized(reply);
      cover("robynn_status", "error");
    });

    it("robynn_usage: reads the seeded credit balance; a DB fault is a sanitized error", async () => {
      const reply = await call(ro, "robynn_usage");
      expectOk(reply, "usage");
      expect(text(reply)).toMatch(/100000|100,000/);
      cover("robynn_usage", "success");

      const fault = await withoutPrivilege("execute", "function public.get_token_breakdown", () => call(ro, "robynn_usage"));
      expectToolError(fault, "usage fault");
      cover("robynn_usage", "error");
    });

    it("robynn_capabilities: bridge capabilities plus the org's one active connector; a DB fault is a sanitized error", async () => {
      const reply = await call(ro, "robynn_capabilities");
      expectOk(reply, "capabilities");
      expect(data(reply).organization_id).toBe(ORG_A);
      expect(data(reply).connectors.active_connection_count).toBe(1);
      cover("robynn_capabilities", "success");

      const fault = await withoutPrivilege("select", "public.connector_connections", () => call(ro, "robynn_capabilities"));
      expectToolError(fault, "capabilities fault");
      cover("robynn_capabilities", "error");
    });
  });

  // =========================================================================
  // Brand book (read-only since the P17 † flip) and reflections
  // =========================================================================

  describe("brand book and reflections", () => {
    const READS: Array<[string, Record<string, unknown>]> = [
      ["robynn_brand_book_status", {}],
      ["robynn_brand_book_gap_analysis", { focus_areas: ["positioning"] }],
      ["robynn_brand_book_strategy", { goals: ["p17 synthetic goal"] }],
      ["robynn_publish_brand_book_html", {}],
      ["robynn_brand_reflections", { status_filter: "all" }],
    ];

    it("read-only grant: status, gap analysis, strategy, HTML export and reflections succeed and write nothing (no 'Brand Completeness' doc)", async () => {
      const before = businessSnapshot();
      for (const [tool, args] of READS) {
        const reply = await call(ro, tool, args);
        expectOk(reply, tool);
        cover(tool, "success");
      }
      const html = await call(ro, "robynn_publish_brand_book_html", {});
      expect(text(html)).toMatch(/<html|<!doctype/i);
      expect(sql(`select count(*) from public.brand_hub_docs where organization_id=${lit(ORG_A)} and document_name='Brand Completeness'`)).toBe("0");
      expect(businessSnapshot()).toEqual(before);
    });

    it("a local DB fault on brand docs and the changelog is a sanitized error for each", async () => {
      await withoutPrivilege("select", "public.brand_hub_docs", () =>
        withoutPrivilege("select", "public.brand_hub_docs_changelog", async () => {
          for (const [tool, args] of READS) {
            const reply = await call(ro, tool, args);
            expectToolError(reply, `${tool} fault`);
            cover(tool, "error");
          }
        }),
      );
    });

    it("robynn_trigger_brand_reflections: runs once (cooldown armed in the DB); an immediate second run is refused (429)", async () => {
      const first = await call(full, "robynn_trigger_brand_reflections", { dry_run: false, lookback_hours: 24 });
      expectOk(first, "trigger reflections");
      expect(Number(sql(`select count(*) from public.brand_hub_docs_changelog_trigger_rate_limits where organization_id=${lit(ORG_A)}`))).toBeGreaterThan(0);
      cover("robynn_trigger_brand_reflections", "success");

      const second = await call(full, "robynn_trigger_brand_reflections", { dry_run: false, lookback_hours: 24 });
      expectToolError(second, "trigger reflections cooldown");
      expect(text(second)).toMatch(/429|cooldown|recently|wait/i);
      cover("robynn_trigger_brand_reflections", "error");
    });
  });

  // =========================================================================
  // CMO / Instant Agent
  // =========================================================================

  describe("CMO and Instant Agent (fixture LangGraph)", () => {
    let contentRun: { run_id: string; thread_id: string };

    it("robynn_conversations: create persists a thread for the caller in the bound org; list returns it (also under brand:read)", async () => {
      const title = `P17 thread ${randomBytes(4).toString("hex")}`;
      const created = await call(full, "robynn_conversations", { action: "create", title });
      expectOk(created, "conversations create");
      expect(sql(`select count(*) from public.instant_agent_threads where organization_id=${lit(ORG_A)} and user_id=${lit(ALPHA.id)} and title=${q(title)}`)).toBe("1");
      // P19: a thread created over a plugin connection is private (P09 rule).
      expect(sql(`select visibility from public.instant_agent_threads where organization_id=${lit(ORG_A)} and title=${q(title)}`)).toBe("private");
      const listed = await call(ro, "robynn_conversations", { action: "list" });
      expectOk(listed, "conversations list");
      expect(text(listed)).toContain(title);
      cover("robynn_conversations", "success");

      const bad = await call(full, "robynn_conversations", { action: "p17-unknown" });
      expectToolError(bad, "conversations bad action");
      cover("robynn_conversations", "error");
    });

    it(
      "robynn_create_content: thread → run → fixture graph → completed content; the run row and its billing are persisted",
      async () => {
        const mark = fixture.mark();
        const since = dbNow();
        const reply = await call(full, "robynn_create_content", { type: "blog_post", topic: "P17 synthetic topic" });
        expectOk(reply, "create_content");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        contentRun = { run_id: data(reply).run_id, thread_id: data(reply).thread_id };
        expect(contentRun.run_id).toBeTruthy();
        expect(sql(`select visibility from public.instant_agent_threads where id=${lit(contentRun.thread_id)}`)).toBe("private");
        const calls = fixture.since(mark);
        expect(calls.some((c) => c.method === "POST" && /\/threads\/[^/]+\/runs$/.test(c.path))).toBe(true);
        expect(calls.every((c) => c.apiKey === FIXTURE_API_KEY)).toBe(true);
        expect(sql(`select status from public.instant_agent_runs where id=${lit(contentRun.run_id)}`)).toMatch(/completed|succeeded|success/);
        // One Instant Agent turn reserved and finalized (5 credits) and recorded in token_usage.
        const after = `created_at > ${q(since)}::timestamptz`;
        expect(sql(`select string_agg(event_status || ':' || charged_credits, ',' order by created_at) from public.billing_events where organization_id=${lit(ORG_A)} and action_key='instant-agent-chat' and ${after}`)).toBe("reserved:5,finalized:5");
        expect(sql(`select string_agg(tokens_used::text, ',') from public.token_usage where organization_id=${lit(ORG_A)} and agent_name='Instant Agent Chat' and ${after}`)).toBe("5");
        cover("robynn_create_content", "success");
      },
      LONG,
    );

    it(
      "robynn_create_content error: a failed graph run comes back as a sanitized run failure",
      async () => {
        fixture.nextOutcomes("cmo_v3", "error");
        const reply = await call(full, "robynn_create_content", { type: "email", topic: "P17 failing topic" });
        expectToolError(reply, "create_content failure");
        cover("robynn_create_content", "error");
      },
      LONG,
    );

    it(
      "robynn_run_status: the completed run's output; an unknown run is not found",
      async () => {
        const reply = await call(full, "robynn_run_status", { run_id: contentRun.run_id });
        expectOk(reply, "run_status");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        cover("robynn_run_status", "success");

        const unknown = await call(full, "robynn_run_status", { run_id: randomUUID() });
        expectToolError(unknown, "run_status unknown");
        expect(text(unknown)).toMatch(/not.?found|404/i);
        cover("robynn_run_status", "error");
      },
      LONG,
    );

    it(
      "robynn_research and robynn_assist: completed fixture output; an unknown thread_id is refused",
      async () => {
        for (const [tool, args] of [
          ["robynn_research", { query: "P17 synthetic research question" }],
          ["robynn_assist", { message: "P17 synthetic assist request" }],
        ] as const) {
          const reply = await call(full, tool, args);
          expectOk(reply, tool);
          expect(text(reply)).toContain(FIXTURE_MARKER);
          cover(tool, "success");

          const foreign = await call(full, tool, { ...args, thread_id: randomUUID() });
          expectToolError(foreign, `${tool} unknown thread`);
          cover(tool, "error");
        }
      },
      LONG,
    );

    it(
      "robynn_cmo_agent → robynn_cmo_decide: a decision card opens the clarify gate; the decision continues the run",
      async () => {
        const reply = await call(full, "robynn_cmo_agent", { message: "P17-DECISION draft a synthetic one pager" });
        expectOk(reply, "cmo_agent");
        cover("robynn_cmo_agent", "success");
        let state = data(reply);
        // P19: cli/mcp/cmo/run now follows the private plugin thread rule too.
        expect(sql(`select visibility from public.instant_agent_threads where id=${lit(String(state.thread_id))}`)).toBe("private");
        if (state.status === "pending") {
          const polled = await until(
            () => call(full, "robynn_run_status", { run_id: state.run_id }),
            (r) => data(r).status !== "pending",
          );
          state = data(polled);
        }
        expect(state.has_decision_cards, text(reply).slice(0, 400)).toBe(true);

        const decided = await call(full, "robynn_cmo_decide", {
          thread_id: state.thread_id,
          run_id: state.run_id,
          decision_id: "angle",
          option_id: "a",
        });
        expectOk(decided, "cmo_decide");
        cover("robynn_cmo_decide", "success");

        const wrong = await call(full, "robynn_cmo_decide", {
          thread_id: state.thread_id,
          run_id: state.run_id,
          decision_id: "p17-no-such-decision",
          option_id: "z",
        });
        expectToolError(wrong, "cmo_decide unknown decision");
        cover("robynn_cmo_decide", "error");
      },
      LONG,
    );

    it(
      "robynn_cmo_agent error: a failed graph run is a sanitized failure",
      async () => {
        fixture.nextOutcomes("cmo_v3", "error");
        const reply = await call(full, "robynn_cmo_agent", { message: "P17 failing request" });
        const failed = isToolError(reply) || data(reply).status === "failed" || data(reply).status === "error";
        expect(failed, text(reply).slice(0, 400)).toBe(true);
        expectSanitized(reply);
        cover("robynn_cmo_agent", "error");
      },
      LONG,
    );
  });

  // =========================================================================
  // Intelligence: GEO, battlecard, SEO, content plan, weekly visibility
  // =========================================================================

  describe("intelligence tools (fixture LangGraph)", () => {
    it(
      "robynn_geo_analysis: threads → runs → state through the app's internal hop; a failed run is a sanitized error",
      async () => {
        const reply = await call(full, "robynn_geo_analysis", { company_name: "Synthetic Org A", category: "synthetic analytics" });
        expectOk(reply, "geo");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        expect(fixture.runsFor("geo_researcher").length).toBeGreaterThan(0);
        cover("robynn_geo_analysis", "success");

        fixture.nextOutcomes("geo_researcher", "error");
        const failed = await call(full, "robynn_geo_analysis", { company_name: "Synthetic Org A failing", category: "synthetic analytics" });
        expectToolError(failed, "geo failure");
        cover("robynn_geo_analysis", "error");
      },
      LONG,
    );

    it(
      "robynn_competitive_battlecard: the graph's battlecard row is read back; a failed graph is a sanitized error",
      async () => {
        const reply = await call(full, "robynn_competitive_battlecard", { competitor_name: "P17 Rival" });
        expectOk(reply, "battlecard");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        expect(sql(`select count(*) from public.competitor_intel_profiles where organization_id=${lit(ORG_A)} and name='P17 Rival'`)).toBe("1");
        cover("robynn_competitive_battlecard", "success");

        fixture.nextOutcomes("competitor_intelligence_v1", "error");
        const failed = await call(full, "robynn_competitive_battlecard", { competitor_name: "P17 Failing Rival" });
        expectToolError(failed, "battlecard failure");
        cover("robynn_competitive_battlecard", "error");
      },
      LONG,
    );

    it(
      "robynn_seo_opportunities: runs/wait report through the app's internal hop; a failed graph is a sanitized error",
      async () => {
        const reply = await call(full, "robynn_seo_opportunities", { company_name: "Synthetic Org A" });
        expectOk(reply, "seo");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        cover("robynn_seo_opportunities", "success");

        fixture.nextOutcomes("seo_researcher", "error");
        const failed = await call(full, "robynn_seo_opportunities", { company_name: "Synthetic Org A failing" });
        expectToolError(failed, "seo failure");
        cover("robynn_seo_opportunities", "error");
      },
      LONG,
    );

    it(
      "robynn_content_plan: planner rows from a research packet; a failed planner is a sanitized error",
      async () => {
        const research_packet = { topic: "P17 synthetic topic", findings: ["Synthetic finding"], keywords: ["synthetic keyword"] };
        const reply = await call(full, "robynn_content_plan", { research_packet, planning_goal: "P17" });
        expectOk(reply, "content_plan");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        cover("robynn_content_plan", "success");

        fixture.nextOutcomes("content_planner_v2", "error");
        const failed = await call(full, "robynn_content_plan", { research_packet, planning_goal: "P17 failing" });
        expectToolError(failed, "content_plan failure");
        cover("robynn_content_plan", "error");
      },
      LONG,
    );

    it("robynn_weekly_visibility_report: the org's website report (read-only grant); an unknown website is not found", async () => {
      const reply = await call(ro, "robynn_weekly_visibility_report", { website_id: P17.website });
      expectOk(reply, "weekly");
      expect(text(reply)).toContain(P17.website);
      cover("robynn_weekly_visibility_report", "success");

      const unknown = await call(ro, "robynn_weekly_visibility_report", { website_id: randomUUID() });
      expectToolError(unknown, "weekly unknown");
      expect(text(unknown)).toMatch(/not.?found|404/i);
      cover("robynn_weekly_visibility_report", "error");
    });
  });

  // =========================================================================
  // Website family and campaigns
  // =========================================================================

  describe("website audits, strategy and campaigns (fixture LangGraph + egress proxy)", () => {
    it(
      "robynn_website_strategy: runs/wait report; a failed graph is a sanitized error",
      async () => {
        const reply = await call(full, "robynn_website_strategy", { primary_goal: "P17 synthetic goal", website_url: PUBLIC_SITE_URL });
        expectOk(reply, "website_strategy");
        expect(text(reply)).toContain(FIXTURE_MARKER);
        cover("robynn_website_strategy", "success");

        fixture.nextOutcomes("website_report_v1", "error");
        const failed = await call(full, "robynn_website_strategy", { primary_goal: "P17 failing", website_url: PUBLIC_SITE_URL });
        expectToolError(failed, "website_strategy failure");
        cover("robynn_website_strategy", "error");
      },
      LONG,
    );

    it(
      "robynn_website_audit → robynn_website_audit_status: reserve → dispatch → settle (P11 N7), then the poller persists the report once",
      async () => {
        const credits = () => Number(sql(`select ${AVAILABLE_CREDITS} from public.organizations where id=${lit(ORG_A)}`));
        const creditsBefore = credits();
        const since = dbNow();
        const started = await call(full, "robynn_website_audit", { website_url: PUBLIC_SITE_URL, company_name: "P17 Prospect" });
        expectOk(started, "website_audit");
        const auditId = data(started).prospect_audit_id as string;
        expect(auditId).toBeTruthy();
        expect(data(started).status).toBe("pending");
        expect(fixture.runsFor("cmo_audit_v1").map((r) => String(r.input.website_url).replace(/\/$/, ""))).toContain(PUBLIC_SITE_URL.replace(/\/$/, ""));
        // P11 N7: the real reserve → settle_billing_session path for the catalog row 'website-audit-report'.
        const session = sql(`select session_id from public.billing_events where organization_id=${lit(ORG_A)} and action_key='website-audit-report' and created_at > ${q(since)}::timestamptz limit 1`);
        expect(sql(`select string_agg(event_status || ':' || charged_credits, ',' order by created_at) from public.billing_events where session_id=${lit(session)}`)).toBe("reserved:50,finalized:50");
        expect(sql(`select string_agg(tokens_used::text, ',') from public.token_usage where organization_id=${lit(ORG_A)} and session_id::text=${lit(session)}`)).toBe("50");
        expect(credits()).toBe(creditsBefore - 50);
        cover("robynn_website_audit", "success");

        const done = await until(
          () => call(full, "robynn_website_audit_status", { prospect_audit_id: auditId }),
          (r) => data(r).status !== "pending",
        );
        expectOk(done, "website_audit_status");
        expect(data(done).status).toBe("success");
        expect(sql(`select status || '|' || (report_data->>'headline') from public.prospect_audits where id=${lit(auditId)}`)).toBe(`draft|${FIXTURE_MARKER}`);
        // Polling again is idempotent: no second write.
        const updatedAt = sql(`select updated_at from public.prospect_audits where id=${lit(auditId)}`);
        expectOk(await call(full, "robynn_website_audit_status", { prospect_audit_id: auditId }), "status again");
        expect(sql(`select updated_at from public.prospect_audits where id=${lit(auditId)}`)).toBe(updatedAt);
        cover("robynn_website_audit_status", "success");
      },
      LONG,
    );

    it("website audit errors: a non robynn-ai org is refused before any charge; another org's audit id is not found", async () => {
      const before = businessSnapshot();
      const gated = await call(fullB, "robynn_website_audit", { website_url: PUBLIC_SITE_URL, company_name: "P17 Gated" });
      expectToolError(gated, "website_audit gate");
      cover("robynn_website_audit", "error");

      const foreign = await call(full, "robynn_website_audit_status", { prospect_audit_id: B_PENDING_AUDIT });
      expectToolError(foreign, "audit_status foreign");
      expect(text(foreign)).toMatch(/not.?found|404/i);
      expect(text(foreign)).not.toContain("cos-plugin-b-pending");
      cover("robynn_website_audit_status", "error");
      expect(businessSnapshot()).toEqual(before);
    });

    it(
      "robynn_website_audit_v2 → _status: scan dispatched to the fixture graph completes; a loopback URL is refused before any charge",
      async () => {
        const started = await call(full, "robynn_website_audit_v2", { website_url: PUBLIC_SITE_URL, mode: "external", manual_pages: [PUBLIC_SITE_URL] });
        expectOk(started, "audit_v2");
        const scanId = (data(started).scan_id ?? data(started).id) as string;
        expect(scanId, text(started).slice(0, 400)).toBeTruthy();
        cover("robynn_website_audit_v2", "success");

        const done = await until(
          () => call(ro, "robynn_website_audit_v2_status", { scan_id: scanId }),
          (r) => !["pending", "running", "queued"].includes(String(data(r).status)),
        );
        expectOk(done, "audit_v2_status");
        expect(data(done).status).toBe("completed");
        expect(sql(`select status from public.design_studio_optimization_scans where id=${lit(scanId)}`)).toBe("completed");
        cover("robynn_website_audit_v2_status", "success");

        // The route reserves before its URL guard runs; a refused URL must release the reservation (no net charge, no scan).
        const balance = () => sql(`select ${AVAILABLE_CREDITS} from public.organizations where id=${lit(ORG_A)}`);
        const scans = () => sql(`select count(*) from public.design_studio_optimization_scans where organization_id=${lit(ORG_A)}`);
        const [balanceBefore, scansBefore] = [balance(), scans()];
        const refused = await call(full, "robynn_website_audit_v2", { website_url: "http://127.0.0.1/", mode: "external" });
        expectToolError(refused, "audit_v2 loopback");
        expect(await until(async () => balance(), (b) => b === balanceBefore, 10_000, 500)).toBe(balanceBefore);
        expect(scans()).toBe(scansBefore);
        cover("robynn_website_audit_v2", "error");

        const unknown = await call(ro, "robynn_website_audit_v2_status", { scan_id: randomUUID() });
        expectToolError(unknown, "audit_v2_status unknown");
        expect(text(unknown)).toContain("(not_found)"); // P19: contract §8.3, not a 500
        cover("robynn_website_audit_v2_status", "error");
      },
      LONG,
    );

    it(
      "robynn_website_optimization_audit → _status: homepage via the egress proxy, v3 run over SSE, settled; a loopback URL is refused",
      async () => {
        const started = await call(full, "robynn_website_optimization_audit", { website_url: PUBLIC_SITE_URL, audit_depth: "top_level" });
        expectOk(started, "optimization_audit");
        const runId = (data(started).run_id ?? data(started).scan_id) as string;
        expect(runId, text(started).slice(0, 400)).toBeTruthy();
        expect(fixture.egress().some((e) => e === `GET ${PUBLIC_SITE_HOST}`)).toBe(true);
        cover("robynn_website_optimization_audit", "success");

        const done = await until(
          () => call(ro, "robynn_website_optimization_audit_status", { run_id: runId }),
          (r) => !["pending", "running", "queued"].includes(String(data(r).status)),
        );
        expectOk(done, "optimization_audit_status");
        expect(data(done).status).toBe("completed");
        cover("robynn_website_optimization_audit_status", "success");

        const before = businessSnapshot();
        const refused = await call(full, "robynn_website_optimization_audit", { website_url: "http://127.0.0.1/", audit_depth: "top_level" });
        expectToolError(refused, "optimization loopback");
        expect(businessSnapshot()).toEqual(before);
        cover("robynn_website_optimization_audit", "error");

        const unknown = await call(ro, "robynn_website_optimization_audit_status", { run_id: randomUUID() });
        expectToolError(unknown, "optimization_status unknown");
        expect(text(unknown)).toContain("(not_found)"); // P19: contract §8.3, not a 500
        cover("robynn_website_optimization_audit_status", "error");
      },
      LONG,
    );

    it(
      "robynn_website_audit_orchestrator → _status: manual top-level page, orchestrator graph, completed; a loopback URL is refused",
      async () => {
        const started = await call(full, "robynn_website_audit_orchestrator", { audit_depth: "top_level", website_url: PUBLIC_SITE_URL, manual_pages: ["/"] });
        expectOk(started, "orchestrator");
        const runId = (data(started).run_id ?? data(started).scan_id) as string;
        expect(runId, text(started).slice(0, 400)).toBeTruthy();
        cover("robynn_website_audit_orchestrator", "success");

        const done = await until(
          () => call(ro, "robynn_website_audit_orchestrator_status", { run_id: runId }),
          (r) => !["pending", "running", "queued"].includes(String(data(r).status)),
        );
        expectOk(done, "orchestrator_status");
        expect(data(done).status).toBe("completed");
        cover("robynn_website_audit_orchestrator_status", "success");

        const refused = await call(full, "robynn_website_audit_orchestrator", { audit_depth: "top_level", website_url: "http://127.0.0.1/", manual_pages: ["/"] });
        expectToolError(refused, "orchestrator loopback");
        cover("robynn_website_audit_orchestrator", "error");

        const unknown = await call(ro, "robynn_website_audit_orchestrator_status", { run_id: randomUUID() });
        expectToolError(unknown, "orchestrator_status unknown");
        expect(text(unknown)).toContain("(not_found)"); // P19: contract §8.3, not a 500
        cover("robynn_website_audit_orchestrator_status", "error");
      },
      LONG,
    );

    it(
      "robynn_campaign_creator → robynn_campaign_status: graph markdown saved once as an artifact; gated and unknown runs are refused",
      async () => {
        const created = await call(full, "robynn_campaign_creator", { company_name: "P17 Campaign Co", company_url: PUBLIC_SITE_URL });
        expectOk(created, "campaign_creator");
        const lt = data(created).langgraph_thread_id as string;
        const lr = data(created).langgraph_run_id as string;
        expect(lt && lr, text(created).slice(0, 400)).toBeTruthy();
        cover("robynn_campaign_creator", "success");

        const status = await until(
          () => call(full, "robynn_campaign_status", { langgraph_thread_id: lt, langgraph_run_id: lr }),
          (r) => data(r).status !== "pending",
        );
        expectOk(status, "campaign_status");
        expect(text(status)).toContain(FIXTURE_MARKER);
        expect(sql(`select count(*) from public.mcp_campaign_runs where organization_id=${lit(ORG_A)} and artifact_id is not null and langgraph_run_id=${lit(lr)}`)).toBe("1");
        cover("robynn_campaign_status", "success");

        const gated = await call(fullB, "robynn_campaign_creator", { company_name: "P17 Gated Co" });
        expectToolError(gated, "campaign gate");
        cover("robynn_campaign_creator", "error");

        const unknown = await call(full, "robynn_campaign_status", { langgraph_thread_id: randomUUID(), langgraph_run_id: randomUUID() });
        expectToolError(unknown, "campaign_status unknown");
        cover("robynn_campaign_status", "error");
      },
      LONG,
    );
  });

  // =========================================================================
  // Brand operations, connectors, Strapi
  // =========================================================================

  describe("brand operations, connected apps and Strapi", () => {
    it("robynn_brand_source_add: a text source is stored for the org; a website source without a URL is refused", async () => {
      const key = `p17-${randomBytes(4).toString("hex")}`;
      const reply = await call(full, "robynn_brand_source_add", { source_type: "text", idempotency_key: key, title: `P17 source ${key}`, content: "Synthetic brand note." });
      expectOk(reply, "brand_source_add");
      expect(sql(`select count(*) from public.brand_hub_docs where organization_id=${lit(ORG_A)} and document_name='Ingested Text' and document_label=${q(`P17 source ${key}`)}`)).toBe("1");
      cover("robynn_brand_source_add", "success");

      const bad = await call(full, "robynn_brand_source_add", { source_type: "website", idempotency_key: `${key}-w` });
      expectToolError(bad, "brand_source_add no url");
      cover("robynn_brand_source_add", "error");
    });

    it("robynn_brand_rebuild: an admin rebuild upserts the derived Brand Context doc; a collaborator is refused (role policy)", async () => {
      const reply = await call(full, "robynn_brand_rebuild", { write_confirmed: true });
      expectOk(reply, "brand_rebuild");
      expect(sql(`select count(*) from public.brand_hub_docs where organization_id=${lit(ORG_A)} and document_name='Brand Context'`)).toBe("1");
      cover("robynn_brand_rebuild", "success");

      const before = businessSnapshot();
      const collaborator = await call(fullB, "robynn_brand_rebuild", { write_confirmed: true });
      expectToolError(collaborator, "brand_rebuild collaborator");
      expect(text(collaborator)).toMatch(/role_forbidden|403/);
      expect(businessSnapshot()).toEqual(before);
      cover("robynn_brand_rebuild", "error");
    });

    it("robynn_connected_apps / _capabilities: the org's active HubSpot connection; an unconnected provider is an error", async () => {
      const apps = await call(ro, "robynn_connected_apps");
      expectOk(apps, "connected_apps");
      expect(text(apps)).toContain("hubspot");
      cover("robynn_connected_apps", "success");

      const caps = await call(ro, "robynn_connected_app_capabilities", { provider_key: "hubspot" });
      expectOk(caps, "capabilities hubspot");
      expect(text(caps)).toContain("hubspot.list_contacts");
      cover("robynn_connected_app_capabilities", "success");

      const none = await call(ro, "robynn_connected_app_capabilities", { provider_key: "salesforce" });
      expectToolError(none, "capabilities salesforce");
      cover("robynn_connected_app_capabilities", "error");

      const fault = await withoutPrivilege("select", "public.connector_connections", () => call(ro, "robynn_connected_apps"));
      expectToolError(fault, "connected_apps fault");
      cover("robynn_connected_apps", "error");
    });

    it("robynn_query_connected_app: a read through the fixture Composio; a provider failure is a sanitized error", async () => {
      const mark = fixture.mark();
      const reply = await call(full, "robynn_query_connected_app", { provider_key: "hubspot", action_key: "hubspot.list_contacts", payload: {} });
      expectOk(reply, "query_connected_app");
      expect(text(reply)).toContain(FIXTURE_MARKER);
      const composio = fixture.since(mark).filter((r) => r.path.startsWith("/api/v3/tools/execute/"));
      expect(composio).toHaveLength(1);
      cover("robynn_query_connected_app", "success");

      fixture.onComposio(() => ({ status: 500, body: { error: "p17 provider failure canary" } }));
      try {
        const failed = await call(full, "robynn_query_connected_app", { provider_key: "hubspot", action_key: "hubspot.list_contacts", payload: {} });
        expectToolError(failed, "query_connected_app provider failure");
        cover("robynn_query_connected_app", "error");
      } finally {
        fixture.onComposio((slug) => ({ status: 200, body: { successful: true, data: { marker: FIXTURE_MARKER, slug, results: [] }, error: null } }));
      }
    });

    it("robynn_connected_app_action: dry run and a confirmed write are audited once; a replay is served from the audit; a changed payload is refused", async () => {
      const dryKey = `p17-dry-${randomBytes(4).toString("hex")}`;
      const dry = await call(full, "robynn_connected_app_action", { service: "hubspot", action: "hubspot.create_marketing_email", parameters: { name: "P17" }, idempotency_key: dryKey, dry_run: true, write_confirmed: true });
      expectOk(dry, "action dry run");
      expect(sql(`select status || '|' || dry_run from public.connector_action_audit where organization_id=${lit(ORG_A)} and idempotency_key=${q(dryKey)}`)).toBe("ok|true");

      const key = `p17-act-${randomBytes(4).toString("hex")}`;
      const args = { service: "hubspot", action: "hubspot.create_marketing_email", parameters: { name: "P17 synthetic email" }, idempotency_key: key, write_confirmed: true };
      const mark = fixture.mark();
      const first = await call(full, "robynn_connected_app_action", args);
      expectOk(first, "action write");
      const replay = await call(full, "robynn_connected_app_action", args);
      expectOk(replay, "action replay");
      expect(data(replay).replayed).toBe(true);
      expect(fixture.since(mark).filter((r) => r.path.startsWith("/api/v3/tools/execute/"))).toHaveLength(1);
      expect(sql(`select count(*) from public.connector_action_audit where organization_id=${lit(ORG_A)} and idempotency_key=${q(key)}`)).toBe("1");
      cover("robynn_connected_app_action", "success");

      const changed = await call(full, "robynn_connected_app_action", { ...args, parameters: { name: "P17 changed" } });
      expectToolError(changed, "action payload mismatch");
      expect(text(changed)).toMatch(/idempotency_key_reused|409/);
      cover("robynn_connected_app_action", "error");
    });

    it("robynn_publish_strapi_draft: a draft through the org's Strapi credential (fixture endpoint) is logged; an org without one is refused", async () => {
      const mark = fixture.mark();
      const since = dbNow();
      const reply = await call(full, "robynn_publish_strapi_draft", { write_confirmed: true, title: "P17 synthetic draft", content: "Synthetic draft body." });
      expectOk(reply, "strapi");
      const strapiCalls = fixture.since(mark).filter((r) => r.path.startsWith("/strapi/"));
      expect(strapiCalls).toHaveLength(1);
      // Exactly one audit row for this publish (P17 app fix: cmo_agent publishes were silently unlogged).
      expect(
        sql(`select string_agg(source_type || '|' || platform || '|' || status, ',') from public.publishing_logs where organization_id=${lit(ORG_A)} and created_at > ${q(since)}::timestamptz`),
      ).toBe("cmo_agent|strapi|success");
      cover("robynn_publish_strapi_draft", "success");

      const none = await call(fullB, "robynn_publish_strapi_draft", { write_confirmed: true, title: "P17", content: "Synthetic." });
      expectToolError(none, "strapi no credential");
      expect(text(none)).toMatch(/no_credential/);
      cover("robynn_publish_strapi_draft", "error");
    });
  });

  // =========================================================================
  // Hermes bridge: threads and memory
  // =========================================================================

  describe("Hermes threads and memory (legacy backend)", () => {
    let threadId: string;

    it("robynn_thread_upsert: creates the caller's thread; another user's identical host/session key is a conflict", async () => {
      const host = `p17-host-${randomBytes(3).toString("hex")}`;
      const reply = await call(full, "robynn_thread_upsert", { hermes_host_id: host, hermes_session_id: "p17-session", platform: "cli", title: "P17 thread" });
      expectOk(reply, "thread_upsert");
      threadId = data(reply).id;
      expect(sql(`select organization_id || '|' || user_id from public.hermes_threads where id=${lit(threadId)}`)).toBe(`${ORG_A}|${ALPHA.id}`);
      cover("robynn_thread_upsert", "success");

      sql(
        `insert into public.hermes_threads (id, organization_id, user_id, hermes_host_id, hermes_session_id, platform, title) values (${lit(P17.betaThread)}, ${lit(ORG_A)}, ${lit(BETA.id)}, 'p17-beta-host', 'p17-beta-session', 'cli', 'P17 beta thread') on conflict (id) do nothing`,
      );
      const conflict = await call(full, "robynn_thread_upsert", { hermes_host_id: "p17-beta-host", hermes_session_id: "p17-beta-session", platform: "cli" });
      expectToolError(conflict, "thread_upsert conflict");
      expect(text(conflict)).toMatch(/thread_key_conflict|409/);
      expect(sql(`select user_id from public.hermes_threads where id=${lit(P17.betaThread)}`)).toBe(BETA.id);
      cover("robynn_thread_upsert", "error");
    });

    it("robynn_thread_append: appends to the caller's thread; a system message over OAuth is refused", async () => {
      const reply = await call(full, "robynn_thread_append", { thread_id: threadId, role: "user", content: "P17 synthetic message" });
      expectOk(reply, "thread_append");
      expect(sql(`select count(*) from public.hermes_messages where thread_id=${lit(threadId)} and content='P17 synthetic message'`)).toBe("1");
      cover("robynn_thread_append", "success");

      const system = await call(full, "robynn_thread_append", { thread_id: threadId, role: "system", content: "P17 system" });
      expectToolError(system, "thread_append system");
      expect(text(system)).toMatch(/unsupported_message_role|400/);
      cover("robynn_thread_append", "error");
    });

    it("robynn_memory_write / _get / _search: an org memory written, stored, read back and found; session scope is refused", async () => {
      const key = `p17-${randomBytes(4).toString("hex")}`;
      const value = `P17-MEMORY-${key}`;
      const write = await call(full, "robynn_memory_write", { scope: "org", key, value });
      expectOk(write, "memory_write");
      expect(sql(`select value from public.hermes_memories where organization_id=${lit(ORG_A)} and scope='org' and key=${q(key)}`)).toBe(value);
      cover("robynn_memory_write", "success");

      const get = await call(ro, "robynn_memory_get", { scope: "org", key });
      expectOk(get, "memory_get");
      expect(text(get)).toContain(value);
      cover("robynn_memory_get", "success");

      const search = await call(ro, "robynn_memory_search", { query: "COSPLUGIN" });
      expectOk(search, "memory_search");
      expect(text(search)).toContain("COSPLUGIN-MEMORY-ORG-A");
      expect(text(search)).not.toContain("COSPLUGIN-MEMORY-ORG-B");
      cover("robynn_memory_search", "success");

      for (const [tool, args] of [
        ["robynn_memory_write", { scope: "session", key, value }],
        ["robynn_memory_get", { scope: "session", key }],
        ["robynn_memory_search", { query: "COSPLUGIN", scope: "session" }],
      ] as const) {
        const reply = await call(full, tool, args);
        expect(toolErrorCode(reply), tool).toBe("unsupported_memory_scope");
        cover(tool, "error");
      }
    });
  });

  // =========================================================================
  // Vault (local R2)
  // =========================================================================

  describe("Vault over local R2", () => {
    it(
      "robynn_vault_list / _read: a synthetic org A object is listed and read; traversal is refused",
      async () => {
        putVaultObject(`orgs/${ORG_A}/brand/p17-voice.md`, `# ${FIXTURE_MARKER} voice`);
        putVaultObject(`orgs/${ORG_B}/brand/p17-voice.md`, "# Org B private voice p17-foreign");

        const list = await call(ro, "robynn_vault_list", { prefix: "brand/" });
        expectOk(list, "vault_list");
        expect(text(list)).toContain("brand/p17-voice.md");
        cover("robynn_vault_list", "success");

        const read = await call(ro, "robynn_vault_read", { path: "brand/p17-voice.md" });
        expectOk(read, "vault_read");
        expect(text(read)).toContain(FIXTURE_MARKER);
        expect(text(read)).not.toContain("p17-foreign");
        cover("robynn_vault_read", "success");

        const traversal = await call(ro, "robynn_vault_read", { path: `../${ORG_B}/brand/p17-voice.md` });
        expectToolError(traversal, "vault_read traversal");
        expect(text(traversal)).not.toContain("p17-foreign");
        cover("robynn_vault_read", "error");

        const badPrefix = await call(ro, "robynn_vault_list", { prefix: `../${ORG_B}/` });
        expectToolError(badPrefix, "vault_list traversal");
        cover("robynn_vault_list", "error");
      },
      LONG,
    );
  });

  // =========================================================================
  // Whole-run invariants
  // =========================================================================

  describe("whole run", () => {
    it("every one of the 48 tools proved success, error and permission-denied live", () => {
      expect(ALL_TOOLS).toHaveLength(48);
      const missing = ALL_TOOLS.flatMap((tool) =>
        (["success", "error", "denied"] as const).filter((o) => !covered.get(tool)!.has(o)).map((o) => `${tool}:${o}`),
      );
      expect(missing).toEqual([]);
    });

    it("no request left the machine: the only egress the app attempted was the synthetic homepage, answered by the fixture", () => {
      const egress = new Set(fixture.egress());
      const site = PUBLIC_SITE_HOST.replaceAll(".", "\\.");
      for (const entry of egress) expect(entry, entry).toMatch(new RegExp(`^(GET ${site}|CONNECT ${site})$`));
    });

    it("every LangGraph call carried the fixture key and named a known graph", () => {
      const graphCalls = fixture.requests.filter((r) => !r.egress && !r.path.startsWith("/api/v3/") && !r.path.startsWith("/strapi/"));
      expect(graphCalls.length).toBeGreaterThan(0);
      for (const r of graphCalls) expect(r.apiKey, `${r.method} ${r.path}`).toBe(FIXTURE_API_KEY);
      const unknown = [...fixture.runs.values()].filter((r) => r.assistantId === "unknown");
      expect(unknown.map((r) => r.runId)).toEqual([]);
    });

    it("no code, state, cookie, token, password, signature or local secret seen by this suite appears in the app or Worker logs", () => {
      expect(STATE_DIR).not.toBe("");
      expect(logsContainingSensitiveValues()).toEqual([]);
    });
  });
});
