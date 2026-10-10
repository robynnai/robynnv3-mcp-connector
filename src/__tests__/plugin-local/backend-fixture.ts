/**
 * COS-PLUGIN-001 P17 — deterministic stand-ins for the app's external
 * backends on the plugin-local stack (plan §7 step 7, §8: "external
 * destinations stubbed or test-only").
 *
 * One loopback HTTP server, started by the live suite itself, answers:
 *
 * - the LangGraph Platform API the app calls at LANGGRAPH_API_URL /
 *   LANGGRAPH_AGENT_URL (`http://localhost:8123`, P02's plugin-local
 *   default): threads, runs, run status, thread state and `runs/wait`;
 * - the Composio v3 tool-execution API the connector routes call at
 *   COMPOSIO_API_BASE_URL (same origin, `/api/v3/...`);
 * - a Strapi draft endpoint (`/strapi/...`), reached through a synthetic
 *   `publishing_credentials` row whose `metadata.base_url` is this origin.
 *
 * - the app's egress proxy (HTTP_PROXY/HTTPS_PROXY with NODE_USE_ENV_PROXY=1
 *   and a loopback NO_PROXY): every non-loopback request the app makes lands
 *   here. Plain-HTTP requests to {@link PUBLIC_SITE_HOST} get a synthetic
 *   homepage (the v3 website audit fetches the homepage before it starts);
 *   anything else is refused (HTTPS CONNECT ⇒ 403, other HTTP ⇒ 502) and
 *   recorded as egress, so a test can prove no unexpected call left the app.
 *
 * No real agent, LLM or third-party service is involved, and nothing leaves
 * the machine. Every request is recorded so a test can prove that a denied
 * call reached no backend at all. Graph outputs are synthetic and carry
 * {@link FIXTURE_MARKER} so success cases can prove the fixture's output
 * travelled app → Worker → MCP result.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const FIXTURE_PORT = Number(process.env.PLUGIN_LOCAL_FIXTURE_PORT ?? 8123);
export const FIXTURE_MARKER = "P17-FIXTURE-OUTPUT-5e3a";
/** The dummy key the app sends as `x-api-key` (configured, local-only, not a secret). */
export const FIXTURE_API_KEY = "p17-local-fixture-key";
/**
 * A guard-public IPv4 literal (no DNS) whose plain-HTTP homepage the egress
 * proxy serves. Requests never reach it: the proxy answers them.
 */
export const PUBLIC_SITE_HOST = "192.0.1.17";
export const PUBLIC_SITE_URL = `http://${PUBLIC_SITE_HOST}/`;

export interface FixtureRequest {
  method: string;
  path: string;
  /** Set for proxied (non-loopback) requests: the target host. */
  egress?: string;
  body: unknown;
  apiKey: string | null;
  at: number;
}

export interface FixtureRun {
  runId: string;
  threadId: string;
  assistantId: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  status: "pending" | "running" | "success" | "error";
  createdAt: string;
}

/** What a graph run "produces": the thread state `values` once it succeeds. */
export type GraphOutput = (run: FixtureRun) => Record<string, unknown>;

export interface GraphSpec {
  /** Thread state `values` (and the `runs/wait` / stream payload) once the run succeeds. */
  values: GraphOutput;
  /** Extra fields on `GET /threads/{t}/runs/{r}` once the run succeeds (e.g. `output`). */
  runFields?: (run: FixtureRun) => Record<string, unknown>;
  /** Side effect when a run is created (e.g. a graph that writes its own rows). */
  onRun?: (run: FixtureRun) => void;
}

/** How the next run of an assistant ends (default: success on first poll). */
export type RunOutcome = "success" | "error" | "pending";

const LONG_TEXT = `${FIXTURE_MARKER} ` + "Synthetic deterministic fixture output for the COS-PLUGIN-001 plugin-local stack. ".repeat(6);

/** Default Instant Agent / CMO output: text plus a manifest satisfying the run's expected artifacts. */
export const cmoOutput: GraphOutput = (run) => {
  const message = typeof run.input.message === "string" ? run.input.message : "";
  const expected = Array.isArray(run.input.expected_artifacts) ? (run.input.expected_artifacts as Array<Record<string, unknown>>) : [];
  const responseBlocks: unknown[] = [];
  if (message.includes("P17-DECISION")) {
    responseBlocks.push({
      id: "dc1",
      type: "decision_card",
      decisionId: "angle",
      question: "Which angle should the synthetic draft take?",
      options: [
        { id: "a", label: "Angle A" },
        { id: "b", label: "Angle B" },
      ],
    });
  }
  const result: Record<string, unknown> = { response: LONG_TEXT, response_blocks: responseBlocks };
  if (expected.length > 0) {
    result.artifact_manifest = {
      version: "instant_agent_artifact_manifest_v1",
      entries: expected.map((e) => ({
        task_id: e.task_id,
        artifact_kind: e.artifact_kind,
        source_marker: "persisted_agent_artifact",
        title: `Fixture ${String(e.artifact_kind)}`,
        content: e.render_contract === "premium_designed_html" ? { html: `<p>${LONG_TEXT}</p>` } : { text: LONG_TEXT },
        validation: { status: "valid", errors: [] },
      })),
    };
  }
  return {
    messages: [
      { type: "human", content: message },
      { type: "ai", content: LONG_TEXT },
    ],
    output: { status: "success", result },
  };
};

export class BackendFixture {
  readonly requests: FixtureRequest[] = [];
  readonly runs = new Map<string, FixtureRun>();
  private readonly threads = new Set<string>();
  private readonly graphs = new Map<string, GraphSpec>();
  private readonly outcomes = new Map<string, RunOutcome[]>();
  private composio: (slug: string, body: unknown) => { status: number; body: unknown } = (slug) => ({
    status: 200,
    body: { successful: true, data: { marker: FIXTURE_MARKER, slug, results: [{ id: "fixture-1", name: "Synthetic Contact" }] }, error: null },
  });
  private server: Server | null = null;
  /** Sockets CONNECT-tunnelled to the synthetic site: their requests are the site's. */
  private readonly tunnelled = new WeakSet<object>();

  /** Register a graph's synthetic behaviour (keyed by assistant/graph id; `*` = default). */
  graph(assistantId: string, spec: GraphOutput | GraphSpec) {
    this.graphs.set(assistantId, typeof spec === "function" ? { values: spec } : spec);
    return this;
  }

  /** Finish (or fail) a run the test left pending. */
  setRunStatus(runId: string, status: FixtureRun["status"]) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`fixture: unknown run ${runId}`);
    run.status = status;
  }

  runsFor(assistantId: string) {
    return [...this.runs.values()].filter((r) => r.assistantId === assistantId);
  }

  /** Queue how the next runs of an assistant end (FIFO; then success). */
  nextOutcomes(assistantId: string, ...outcomes: RunOutcome[]) {
    this.outcomes.set(assistantId, [...(this.outcomes.get(assistantId) ?? []), ...outcomes]);
    return this;
  }

  onComposio(handler: (slug: string, body: unknown) => { status: number; body: unknown }) {
    this.composio = handler;
    return this;
  }

  /** Non-loopback requests the app attempted, as `METHOD host` (proxied or CONNECT). */
  egress(since = 0) {
    return this.requests.slice(since).filter((r) => r.egress).map((r) => `${r.method} ${r.egress}`);
  }

  /** Requests recorded since `mark` (a value from {@link mark}). */
  since(mark: number) {
    return this.requests.slice(mark);
  }

  mark() {
    return this.requests.length;
  }

  async start(port = FIXTURE_PORT) {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture_failure" }));
      });
    });
    // undici's env proxy tunnels every target through CONNECT, even plain
    // HTTP. Only the synthetic site on port 80 is tunnelled, into this same
    // server; everything else (any HTTPS, any other host) is refused.
    this.server.on("connect", (req, socket, head) => {
      const target = req.url ?? "";
      const [host, port] = target.split(":");
      this.requests.push({ method: "CONNECT", path: target, egress: host, body: null, apiKey: null, at: Date.now() });
      if (host !== PUBLIC_SITE_HOST || port !== "80") {
        socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      this.tunnelled.add(socket);
      if (head.length > 0) socket.unshift(head);
      this.server!.emit("connection", socket);
    });
    // Dual-stack loopback: the app resolves `localhost` to ::1 or 127.0.0.1.
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen({ port, host: "::", ipv6Only: false }, () => resolve());
    });
    return this;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private specFor(run: FixtureRun): GraphSpec {
    return this.graphs.get(run.assistantId) ?? this.graphs.get("*") ?? { values: cmoOutput };
  }

  private outputFor(run: FixtureRun) {
    return this.specFor(run).values(run);
  }

  private createRun(threadId: string, body: Record<string, unknown>): FixtureRun {
    this.threads.add(threadId);
    const assistantId = typeof body.assistant_id === "string" ? body.assistant_id : "unknown";
    const queue = this.outcomes.get(assistantId) ?? [];
    const outcome = queue.shift() ?? "success";
    const run: FixtureRun = {
      runId: randomUUID(),
      threadId,
      assistantId,
      input: (body.input as Record<string, unknown>) ?? {},
      config: (body.config as Record<string, unknown>) ?? {},
      status: outcome === "pending" ? "running" : outcome,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.runId, run);
    if (run.status === "success") this.specFor(run).onRun?.(run);
    return run;
  }

  private latestRun(threadId: string) {
    return [...this.runs.values()].filter((r) => r.threadId === threadId).at(-1);
  }

  private state(threadId: string) {
    const run = this.latestRun(threadId);
    if (!run) return { values: {}, next: [], metadata: {} };
    if (run.status === "error") {
      return { values: { output: { status: "failed", error: "fixture_graph_failure" } }, next: [] };
    }
    if (run.status !== "success") return { values: {}, next: ["agent"] };
    return { values: this.outputFor(run), next: [], metadata: { run_id: run.runId } };
  }

  private runJson(run: FixtureRun) {
    return {
      run_id: run.runId,
      thread_id: run.threadId,
      assistant_id: run.assistantId,
      status: run.status,
      created_at: run.createdAt,
      updated_at: new Date().toISOString(),
      ...(run.status === "error" ? { error: "fixture_graph_failure" } : {}),
      ...(run.status === "success" ? (this.specFor(run).runFields?.(run) ?? {}) : {}),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if ((req.url ?? "").startsWith("http://")) return this.proxy(req, res, new URL(req.url!));
    if (this.tunnelled.has(req.socket)) {
      return this.proxy(req, res, new URL(req.url ?? "/", `http://${PUBLIC_SITE_HOST}`));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const apiKey = (req.headers["x-api-key"] as string | undefined) ?? null;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, body, apiKey, at: Date.now() });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const parts = url.pathname.split("/").filter(Boolean);

    // Composio v3: POST /api/v3/tools/execute/{SLUG}
    if (parts[0] === "api" && parts[1] === "v3") {
      if (req.method === "POST" && parts[2] === "tools" && parts[3] === "execute" && parts[4]) {
        const out = this.composio(parts[4], body);
        return send(out.status, out.body);
      }
      return send(404, { error: "fixture_unknown_composio_path" });
    }

    // Strapi draft API (synthetic credential base_url = this origin).
    if (parts[0] === "strapi") {
      if (req.method !== "POST") return send(405, { error: "fixture_method" });
      return send(200, { data: { documentId: `fixture-doc-${this.requests.length}`, id: this.requests.length } });
    }

    // LangGraph Platform API.
    if (req.method === "POST" && url.pathname === "/threads") {
      const threadId = typeof b.thread_id === "string" ? b.thread_id : randomUUID();
      this.threads.add(threadId);
      return send(200, { thread_id: threadId, created_at: new Date().toISOString(), metadata: b.metadata ?? {}, status: "idle" });
    }
    if (req.method === "POST" && (url.pathname === "/runs" || url.pathname === "/runs/wait")) {
      const run = this.createRun(randomUUID(), b);
      if (url.pathname === "/runs/wait") {
        if (run.status === "error") return send(500, { error: "fixture_graph_failure" });
        return send(200, this.outputFor(run));
      }
      return send(200, this.runJson(run));
    }
    if (parts[0] === "threads" && parts[1]) {
      const threadId = parts[1];
      if (req.method === "POST" && parts[2] === "runs" && parts.length === 3) {
        return send(200, this.runJson(this.createRun(threadId, b)));
      }
      if (req.method === "POST" && parts[2] === "runs" && parts[3] === "wait") {
        const run = this.createRun(threadId, b);
        if (run.status === "error") return send(500, { error: "fixture_graph_failure" });
        return send(200, this.outputFor(run));
      }
      if (req.method === "GET" && parts[2] === "runs" && parts[3] && parts[4] === "stream") {
        const run = this.runs.get(parts[3]);
        if (!run || run.threadId !== threadId) return send(404, { detail: "Run not found" });
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (run.status === "error") {
          res.end(`event: error\ndata: ${JSON.stringify({ error: "fixture_graph_failure" })}\n\n`);
        } else {
          if (run.status !== "success") run.status = "success";
          res.end(`event: metadata\ndata: ${JSON.stringify({ run_id: run.runId })}\n\nevent: values\ndata: ${JSON.stringify(this.outputFor(run))}\n\n`);
        }
        return;
      }
      if (req.method === "GET" && parts[2] === "runs" && parts[3]) {
        const run = this.runs.get(parts[3]);
        if (!run || run.threadId !== threadId) return send(404, { detail: "Run not found" });
        if (parts[4] === "join") return send(200, run.status === "success" ? this.outputFor(run) : {});
        return send(200, this.runJson(run));
      }
      if (req.method === "GET" && parts[2] === "runs" && parts.length === 3) {
        return send(200, [...this.runs.values()].filter((r) => r.threadId === threadId).map((r) => this.runJson(r)));
      }
      if (req.method === "GET" && parts[2] === "state") return send(200, this.state(threadId));
      if (req.method === "GET" && parts.length === 2) {
        return send(this.threads.has(threadId) ? 200 : 404, { thread_id: threadId, status: "idle", values: this.state(threadId).values });
      }
      if (req.method === "POST" && parts[2] === "runs" && parts[4] === "cancel") return send(200, {});
    }
    return send(404, { error: "fixture_unknown_path", path: url.pathname });
  }

  /** Absolute-form request from the app's env proxy: a non-loopback egress attempt. */
  private proxy(req: IncomingMessage, res: ServerResponse, target: URL) {
    req.resume();
    this.requests.push({ method: req.method ?? "GET", path: target.pathname, egress: target.host, body: null, apiKey: null, at: Date.now() });
    if (target.hostname === PUBLIC_SITE_HOST && req.method === "GET" && target.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>${FIXTURE_MARKER}</title><meta name="description" content="Synthetic site"></head><body><h1>Synthetic fixture site</h1><p>${FIXTURE_MARKER}</p></body></html>`);
      return;
    }
    if (target.hostname === PUBLIC_SITE_HOST) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("egress refused by the P17 fixture");
  }
}
