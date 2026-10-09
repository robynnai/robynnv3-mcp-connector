import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAssistTools } from "./assist";
import { registerContentTools } from "./content";
import { registerHermesBridgeTools } from "./hermes-bridge";
import { registerResearchTools } from "./research";
import { registerRunTools } from "./runs";
import {
  registerUnauthenticatedStatusTool,
  UNAUTHENTICATED_STATUS_MESSAGE,
} from "./status";
import { isSafePathId, toolMetadata } from "./util";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function createServerHarness() {
  const handlers = new Map<string, Handler>();
  const registerTool = vi.fn((name: string, _config: unknown, handler: Handler) => {
    handlers.set(name, handler);
  });
  return { server: { registerTool } as never, handlers };
}

function createClient() {
  return {
    createThread: vi.fn(),
    startRun: vi.fn(),
    pollRun: vi.fn(),
    getRun: vi.fn(),
    appendHermesMessage: vi.fn(),
  };
}

const UNSAFE_IDS = ["../usage", "abc/def", "run?x=1", "run%2F..", "a.b", "", "x".repeat(129)];

describe("toolMetadata", () => {
  it("returns the title at the top level and mirrored into annotations", () => {
    expect(
      toolMetadata("Check Run Status", {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
    ).toEqual({
      title: "Check Run Status",
      annotations: {
        title: "Check Run Status",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    });
  });

  it("omits idempotentHint when it is not supplied", () => {
    const { annotations } = toolMetadata("Plan Content", {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect("idempotentHint" in annotations).toBe(false);
  });
});

describe("isSafePathId", () => {
  it("accepts UUIDs and LangGraph-style ids", () => {
    expect(isSafePathId("3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")).toBe(true);
    expect(isSafePathId("run_abc-123")).toBe(true);
  });

  it.each(UNSAFE_IDS)("rejects %j", (id) => {
    expect(isSafePathId(id)).toBe(false);
  });
});

describe("path-id guards reject unsafe ids before any Robynn request", () => {
  it.each([
    ["robynn_create_content", registerContentTools, { type: "general", topic: "t", thread_id: "../usage" }],
    ["robynn_research", registerResearchTools, { query: "q", thread_id: "../usage" }],
    ["robynn_assist", registerAssistTools, { message: "m", thread_id: "../usage" }],
    ["robynn_run_status", registerRunTools, { run_id: "../../cli/usage" }],
    ["robynn_thread_append", registerHermesBridgeTools, { thread_id: "t/../../x", role: "user", content: "hi" }],
  ] as const)("%s", async (name, register, args) => {
    const { server, handlers } = createServerHarness();
    const client = createClient();
    register(server, client as never);

    const result = await handlers.get(name)!(args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid (thread|run)_id\.$/);
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });

  it("still forwards a valid thread_id", async () => {
    const { server, handlers } = createServerHarness();
    const client = createClient();
    client.startRun.mockResolvedValue({ success: false, error: "boom" });
    registerContentTools(server, client as never);

    await handlers.get("robynn_create_content")!({
      type: "general",
      topic: "t",
      thread_id: "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });

    expect(client.startRun).toHaveBeenCalledWith(
      "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      expect.any(Object),
    );
  });
});

describe("registerUnauthenticatedStatusTool", () => {
  it("lists robynn_status with the same title and hints and returns host-neutral copy", async () => {
    const server = new McpServer({ name: "unauthenticated", version: "0.0.0" });
    registerUnauthenticatedStatusTool(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "unauthenticated-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "robynn_status",
      title: "Check Robynn Connection",
      annotations: {
        title: "Check Robynn Connection",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    });

    const result = await client.callTool({ name: "robynn_status", arguments: {} });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: UNAUTHENTICATED_STATUS_MESSAGE }]);
    expect(UNAUTHENTICATED_STATUS_MESSAGE).not.toMatch(/claude/i);
  });
});
