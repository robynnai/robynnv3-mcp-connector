/**
 * COS-PLUGIN-001 P13 — real registration/transport harness for the tool catalog.
 *
 * Worker surface: constructs the real `RobynnMCP` Durable Object class from
 * src/index.ts and activates it through the real `McpAgent.onStart(props)`
 * (props persisted to DO storage, `init()` registers the tools, the server is
 * connected to its transport). Only the transport is swapped: an SDK
 * `InMemoryTransport` replaces the WebSocket bridge the Workers runtime uses,
 * and an SDK `Client` issues real `tools/list` / `tools/call` requests.
 *
 * CLI surface: runs the real `robynn mcp` commander action from
 * src/cli/index.ts with the stdio transport replaced by the same in-memory pair
 * (see `cliStdioTransportMock`).
 *
 * The app behind both surfaces is a stubbed global `fetch` (`FakeApp`): the
 * real `RobynnClient` builds every request, nothing leaves the process, and
 * unknown hosts or routes fail loudly. Vault uses an in-memory R2 bucket.
 *
 * Callers must `vi.mock("cloudflare:workers")` / `vi.mock("cloudflare:email")`
 * (and, for the CLI, the stdio transport and CLI config) before importing
 * src/index.ts or src/cli/index.ts — vi.mock is only hoisted in test files.
 * Not covered here (P16): the OAuth provider, the Worker fetch entry point and
 * the runtime WebSocket bridge between the stateless handler and the DO.
 */
import { createHash } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { vi } from "vitest";
import { PREFLIGHT_HEADER } from "../authorization/session-binding";

export const APP_BASE_URL = "http://app.robynn.test";
export const MCP_PUBLIC_BASE_URL = "http://mcp.robynn.test";
export const TEST_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
/** Synthetic bearer; never a real credential. */
export const TEST_ACCESS_TOKEN = "p13-synthetic-access-token";
/** Synthetic app grant (JWT `gid`) and provider grant ids for the P10 session binding. */
export const TEST_APP_GRANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const TEST_HOST_GRANT_ID = "p13-host-grant";

// ---------------------------------------------------------------------------
// Fake app (stubbed global fetch)
// ---------------------------------------------------------------------------

export interface AppRequest {
  method: string;
  /** Pathname only, e.g. `/api/cli/context/summary`. */
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

export interface AppReply {
  status?: number;
  body?: unknown;
}

export type AppResponder = (request: AppRequest) => AppReply | undefined;

/**
 * Every request is attributed to the bearer token that sent it, so concurrent
 * sessions (one synthetic token each) can share the one stubbed `fetch`.
 */
export class FakeApp {
  readonly requests: AppRequest[] = [];
  private readonly responders = new Map<string, AppResponder>();

  /** Route requests carrying `Bearer <token>`; `undefined` replies become a 599 "unrouted" failure. */
  respond(token: string, responder: AppResponder) {
    this.responders.set(`Bearer ${token}`, responder);
  }

  requestsFor(token: string) {
    return this.requests.filter((r) => r.authorization === `Bearer ${token}`);
  }

  install() {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.origin !== APP_BASE_URL) {
        throw new Error(`FakeApp: blocked network request to ${url.origin}`);
      }
      const text = init?.body !== undefined ? String(init.body) : await request.text();
      const appRequest: AppRequest = {
        method: (init?.method ?? request.method).toUpperCase(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
        authorization: new Headers(init?.headers).get("Authorization") ?? request.headers.get("Authorization"),
      };
      this.requests.push(appRequest);
      const reply = this.responders.get(appRequest.authorization ?? "")?.(appRequest);
      if (!reply) {
        return Response.json({ error: `unrouted ${appRequest.method} ${appRequest.path}` }, { status: 599 });
      }
      return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
    });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Fake R2 bucket (Vault)
// ---------------------------------------------------------------------------

export class MemoryR2Bucket {
  readonly objects = new Map<string, string>();
  readonly calls: Array<{ op: "list" | "get"; key: string }> = [];
  failWith: Error | null = null;

  async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
    this.calls.push({ op: "list", key: opts.prefix ?? "" });
    if (this.failWith) throw this.failWith;
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(opts.prefix ?? ""))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, text]) => ({ key, size: text.length, uploaded: new Date(0), etag: `etag-${key.length}` }));
    return { objects, truncated: false, cursor: undefined };
  }

  async get(key: string) {
    this.calls.push({ op: "get", key });
    if (this.failWith) throw this.failWith;
    const text = this.objects.get(key);
    if (text === undefined) return null;
    return {
      size: text.length,
      etag: `etag-${key.length}`,
      uploaded: new Date(0),
      httpMetadata: { contentType: "text/markdown" },
      text: async () => text,
    };
  }
}

// ---------------------------------------------------------------------------
// Worker surface: the real RobynnMCP Durable Object
// ---------------------------------------------------------------------------

/** Durable Object state with KV-style storage and a no-op SQL API (the Agent constructor creates tables). */
function fakeDurableObjectState() {
  const storage = new Map<string, unknown>();
  const emptyCursor = () => Object.assign([][Symbol.iterator](), { toArray: () => [], one: () => undefined });
  return {
    storage,
    ctx: {
      id: { toString: () => "p13-do-id", name: "streamable-http:p13-session" },
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => storage.delete(key),
        sql: { exec: () => emptyCursor() },
        setAlarm: async () => {},
        getAlarm: async () => null,
        deleteAlarm: async () => {},
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      getWebSockets: () => [],
      waitUntil: () => {},
    },
  };
}

export interface WorkerSessionOptions {
  /** Bind the VAULT R2 bucket (production binds it; local dev may not). Default true. */
  vault?: boolean;
  /** Props organizationId; Vault is skipped without it. Default TEST_ORG_ID. */
  organizationId?: string | null;
  /** Props accessToken; without it init() registers only the unauthenticated fallback. */
  accessToken?: string | null;
  bucket?: MemoryR2Bucket;
  /**
   * Stamp every incoming message with the Worker preflight's
   * `x-robynn-preflight` header for this grant (P10), as `withMcpPreflight`
   * does after a successful introspection. Default true. The real preflight
   * path (provider → preflight → DO) is proven in
   * `worker-session-authorization.test.ts` and P16's `oauth-chain` suites.
   */
  preflightStamp?: boolean;
}

/** Every tool name a stamp may authorize (the Vault gate checks membership). */
const STAMPED_TOOLS = ["robynn_vault_list", "robynn_vault_read"];

/**
 * Adds the preflight stamp to each message the server transport receives, the
 * way the stateless handler forwards `requestInfo.headers` to the session.
 */
function stampPreflight(transport: Transport) {
  let handler: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => handler,
    set: (next: Transport["onmessage"]) => {
      handler = next
        ? (message, extra) =>
            next(message, {
              ...extra,
              requestInfo: {
                headers: {
                  [PREFLIGHT_HEADER]: JSON.stringify({ appGrantId: TEST_APP_GRANT_ID, tools: STAMPED_TOOLS }),
                },
              },
            })
        : next;
    },
  });
}

export interface McpSession {
  client: Client;
  close(): Promise<void>;
}

export async function startWorkerSession(options: WorkerSessionOptions = {}) {
  const { RobynnMCP } = await import("../index");
  const { ctx, storage } = fakeDurableObjectState();
  const bucket = options.bucket ?? new MemoryR2Bucket();
  const env = {
    ROBYNN_API_BASE_URL: APP_BASE_URL,
    MCP_PUBLIC_BASE_URL,
    MCP_SERVER_NAME: "Robynn",
    MCP_SERVER_VERSION: "test",
    ...(options.vault === false ? {} : { VAULT: bucket }),
  };
  // Hardened (authVersion 2) props as the P06 /callback and P10 preflight
  // produce them; without them init() registers only the fallback tool.
  const props: Record<string, unknown> = {
    userId: TEST_USER_ID,
    appGrantId: TEST_APP_GRANT_ID,
    hostGrantId: TEST_HOST_GRANT_ID,
    credentialVersion: 1,
    scopes: ["brand:read", "tools:execute"],
    authVersion: 2,
  };
  if (options.organizationId !== null) props.organizationId = options.organizationId ?? TEST_ORG_ID;
  if (options.accessToken !== null) props.accessToken = options.accessToken ?? TEST_ACCESS_TOKEN;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (options.preflightStamp !== false) stampPreflight(serverTransport);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = new RobynnMCP(ctx as never, env as never) as any;
  // The only substitution: the runtime transport (WebSocket bridge) → in-memory pair.
  agent.initTransport = () => serverTransport;

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new Client({ name: "p13-catalog-contract", version: "0.0.0" });
  try {
    // Same activation request the stateless handler sends to the DO stub (partyserver set-name):
    // setName → onStart(props) → updateProps → init() → server.connect(initTransport()).
    const activation = await agent.fetch(
      new Request("http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/", {
        headers: { "x-partykit-room": "streamable-http:p13-session", "x-partykit-props": JSON.stringify(props) },
      }),
    );
    if (!activation.ok) throw new Error(`DO activation failed: ${activation.status}`);
    await client.connect(clientTransport);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
  return {
    client,
    agent,
    bucket,
    storage,
    serverInfo: client.getServerVersion(),
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------------------
// CLI surface: the real `robynn mcp` command action
// ---------------------------------------------------------------------------

/**
 * Server half of the next CLI session; the vi.mock'd StdioServerTransport hands it out.
 * Kept on globalThis because `vi.resetModules()` gives the mock factory a fresh module graph.
 */
const cliTransportSlot = ((globalThis as Record<string, unknown>).__p13CliTransportSlot ??= {
  next: null,
}) as { next: Transport | null };

/** Factory for `vi.mock("@modelcontextprotocol/sdk/server/stdio.js", cliStdioTransportMock)`. */
export function cliStdioTransportMock() {
  return {
    StdioServerTransport: function StdioServerTransport() {
      const transport = cliTransportSlot.next;
      if (!transport) throw new Error("cliTransportSlot.next is not set");
      cliTransportSlot.next = null;
      return transport;
    },
  };
}

/**
 * Imports src/cli/index.ts with argv `robynn mcp`, so commander runs the real action.
 * The test file must mock `../cli/config` (synthetic apiKey) and the stdio transport,
 * and set `process.env.ROBYNN_API_BASE_URL = APP_BASE_URL` before calling this.
 */
export async function startCliSession(): Promise<McpSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cliTransportSlot.next = serverTransport;
  const connected = new Promise<void>((resolve) => {
    const original = serverTransport.start.bind(serverTransport);
    serverTransport.start = async () => {
      await original();
      resolve();
    };
  });
  const argv = process.argv;
  process.argv = [argv[0], "robynn", "mcp"];
  vi.resetModules();
  try {
    await import("../cli/index");
    await connected;
  } finally {
    process.argv = argv;
  }
  const client = new Client({ name: "p13-catalog-contract-cli", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

// ---------------------------------------------------------------------------
// Input-schema digest (contracts/tool-route-map.json `inputSchemaDigest`)
// ---------------------------------------------------------------------------

/** Sorted-key compact JSON without string-valued `description` keys (see the map's $comment). */
function canonicalSchemaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSchemaJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => !(key === "description" && typeof record[key] === "string"))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSchemaJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const schemaDigest = (schema: unknown) =>
  `sha256:${createHash("sha256").update(canonicalSchemaJson(schema)).digest("hex")}`;
