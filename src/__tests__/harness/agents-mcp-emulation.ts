/**
 * In-memory emulation of `agents/mcp`'s `McpAgent` for Worker integration
 * tests (extracted from P10's worker-session-authorization.test.ts for reuse
 * by the P16 suites). Use it as a module replacement:
 *
 *   vi.mock("agents/mcp", () => import("./harness/agents-mcp-emulation"));
 *
 * It reproduces only the facts P01 proved against the installed agents 0.7.5 /
 * partyserver 0.3.3 (provider-contract.test.ts F15–F18): the session DO is
 * addressed by `streamable-http:{mcp-session-id}` only, each request first
 * sends a set-name request carrying the caller's props, `onStart(props)` runs
 * once per activation with the latest props, and the request itself arrives
 * as a websocket-upgrade request carrying the client's headers.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every session-DO event, in order (tests reset it in beforeEach). */
export const doEvents = [] as Array<{
  session: string;
  kind: "set-name" | "start" | "upgrade" | "upgrade-refused";
  propsUserId?: unknown;
  accessToken?: unknown;
  headers?: Record<string, string>;
}>;

const SET_NAME = "/cdn-cgi/partyserver/set-name/";

/** Captures the server's JSON-RPC responses (stands in for the WS transport). */
class CaptureTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  private waiters = new Map<unknown, (message: unknown) => void>();
  async start() {}
  async close() {}
  async send(message: { id?: unknown }) {
    const waiter = this.waiters.get(message.id);
    if (waiter) {
      this.waiters.delete(message.id);
      waiter(message);
    }
  }
  request(message: { id: unknown }, extra: unknown) {
    const reply = new Promise((resolve) => this.waiters.set(message.id, resolve));
    this.onmessage?.(message, extra);
    return reply;
  }
}

class McpAgent {
  ctx: any;
  env: any;
  props: any;
  server: any;
  private status = "zero";
  private pendingProps: unknown;
  private transport: CaptureTransport | undefined;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  get sessionName(): string {
    return this.ctx.name;
  }

  async updateProps(props: unknown) {
    await this.ctx.storage.put("props", props ?? {});
    this.props = props;
  }

  // McpAgent.onStart (F18): persist given props, else reload; then init.
  async onStart(props?: unknown) {
    doEvents.push({ session: this.sessionName, kind: "start", propsUserId: (props as any)?.userId });
    if (props) await this.updateProps(props);
    this.props = await this.ctx.storage.get("props");
    await (this as any).init();
    this.transport = new CaptureTransport();
    await this.server.connect(this.transport);
  }

  async getInitializeRequest() {
    return this.ctx.storage.get("initializeRequest");
  }

  async setInitializeRequest(request: unknown) {
    await this.ctx.storage.put("initializeRequest", request);
  }

  async destroy() {
    await this.ctx.storage.deleteAll();
  }

  // partyserver Server.fetch (F17): the latest props win, onStart once.
  async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get("x-partykit-props");
    if (raw) this.pendingProps = JSON.parse(raw);
    if (this.status !== "started") {
      await this.onStart(this.pendingProps as never);
      this.status = "started";
    }
    if (new URL(request.url).pathname === SET_NAME) {
      doEvents.push({ session: this.sessionName, kind: "set-name", propsUserId: (this.pendingProps as any)?.userId });
      return Response.json({ ok: true });
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    doEvents.push({
      session: this.sessionName,
      kind: "upgrade",
      propsUserId: this.props?.userId,
      accessToken: this.props?.accessToken,
      headers,
    });
    const messages = JSON.parse(Buffer.from(request.headers.get("cf-mcp-message")!, "base64").toString("utf8"));
    const requestInfo = { headers: { ...headers } };
    delete (requestInfo.headers as Record<string, string>)["cf-mcp-message"];
    const replies: unknown[] = [];
    for (const message of messages) {
      if (message.id === undefined) {
        this.transport!.onmessage?.(message, { requestInfo });
      } else {
        replies.push(await this.transport!.request(message, { requestInfo }));
      }
    }
    return Response.json(replies, { status: 200 });
  }

  /** agents createStreamingHttpHandler, POST and DELETE paths (F15, F16). */
  static serve(path: string) {
    return {
      async fetch(request: Request, env: any, ctx: { props?: unknown }) {
        if (new URL(request.url).pathname !== path) {
          return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Not found" }, id: null }, { status: 404 });
        }
        const namespace = env.MCP_OBJECT;
        const sessionHeader = request.headers.get("mcp-session-id");
        const getAgent = async (sessionId: string) => {
          const name = `streamable-http:${sessionId}`;
          const stub = namespace.get(namespace.idFromName(name));
          const setName = new Request(`http://dummy-example.cloudflare.com${SET_NAME}`);
          setName.headers.set("x-partykit-room", name);
          if (ctx.props) setName.headers.set("x-partykit-props", JSON.stringify(ctx.props));
          await stub.fetch(setName);
          return stub;
        };
        if (request.method === "DELETE") {
          const agent = await getAgent(sessionHeader!);
          if (!(await agent.getInitializeRequest())) return new Response(null, { status: 404 });
          await agent.destroy();
          return new Response(null, { status: 204 });
        }
        const raw = await request.json();
        const messages = Array.isArray(raw) ? raw : [raw];
        const initialize = messages.find((m: any) => m.method === "initialize");
        if (initialize && sessionHeader) return new Response(null, { status: 400 });
        if (!initialize && !sessionHeader) return new Response(null, { status: 400 });
        const sessionId = sessionHeader ?? namespace.newUniqueId().toString();
        const agent = await getAgent(sessionId);
        const initialized = await agent.getInitializeRequest();
        if (initialize) await agent.setInitializeRequest(initialize);
        else if (!initialized) {
          return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
        }
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const upgrade = new Request(request.url, {
          headers: {
            ...headers,
            "cf-mcp-method": "POST",
            "cf-mcp-message": Buffer.from(JSON.stringify(messages)).toString("base64"),
            Upgrade: "websocket",
          },
        });
        const response = await agent.fetch(upgrade);
        if (response.status !== 200) {
          doEvents.push({ session: `streamable-http:${sessionId}`, kind: "upgrade-refused" });
          return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Failed to establish WebSocket connection" }, id: null }, { status: 500 });
        }
        const replies = (await response.json()) as unknown[];
        return Response.json(Array.isArray(raw) ? replies : replies[0] ?? null, {
          status: 200,
          headers: { "mcp-session-id": sessionId },
        });
      },
    };
  }
}

export { McpAgent };
