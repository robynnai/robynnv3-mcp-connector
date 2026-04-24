import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHermesBridgeTools } from "./hermes-bridge";
import type { RobynnClient } from "../robynn-client";

describe("registerHermesBridgeTools", () => {
  let server: McpServer;
  let client: Partial<RobynnClient>;
  let registered: Record<string, any>;

  beforeEach(() => {
    registered = {};
    server = {
      tool: (name: string, _desc: string, _schema: any, _anno: any, handler: any) => {
        registered[name] = handler;
      },
    } as unknown as McpServer;

    client = {
      upsertHermesThread: vi.fn().mockResolvedValue({ id: "t-1" }),
      appendHermesMessage: vi.fn().mockResolvedValue({ id: "m-1" }),
      writeHermesMemory: vi.fn().mockResolvedValue({ ok: true }),
      getHermesMemory: vi.fn().mockResolvedValue({ key: "k", value: "v" }),
      searchHermesMemory: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "m1",
            scope: "org",
            key: "theme",
            value: "distribution-led",
            updated_at: "2026-04-24T00:00:00Z",
            score: 0.81,
          },
        ],
      }),
    };
  });

  it("registers exactly the five hermes-bridge tools", () => {
    registerHermesBridgeTools(server, client as RobynnClient);
    expect(Object.keys(registered).sort()).toEqual([
      "robynn_memory_get",
      "robynn_memory_search",
      "robynn_memory_write",
      "robynn_thread_append",
      "robynn_thread_upsert",
    ]);
  });

  it("robynn_thread_upsert forwards args and returns structured content", async () => {
    registerHermesBridgeTools(server, client as RobynnClient);
    const result = await registered["robynn_thread_upsert"]({
      hermes_host_id: "roryclaw",
      hermes_session_id: "s-1",
      platform: "telegram",
    });
    expect(client.upsertHermesThread).toHaveBeenCalledWith({
      hermes_host_id: "roryclaw",
      hermes_session_id: "s-1",
      platform: "telegram",
    });
    expect(result.structuredContent).toEqual({ id: "t-1" });
  });

  it("robynn_thread_append strips thread_id from the body and passes as first arg", async () => {
    registerHermesBridgeTools(server, client as RobynnClient);
    const result = await registered["robynn_thread_append"]({
      thread_id: "t-1",
      role: "user",
      content: "hi",
    });
    expect(client.appendHermesMessage).toHaveBeenCalledWith("t-1", {
      role: "user",
      content: "hi",
    });
    expect(result.structuredContent).toEqual({ id: "m-1" });
  });

  it("robynn_memory_write forwards scope/key/value", async () => {
    registerHermesBridgeTools(server, client as RobynnClient);
    await registered["robynn_memory_write"]({
      scope: "org",
      key: "h2_theme",
      value: "distribution-led growth",
    });
    expect(client.writeHermesMemory).toHaveBeenCalledWith({
      scope: "org",
      key: "h2_theme",
      value: "distribution-led growth",
    });
  });

  it("robynn_memory_get returns null-shaped result on miss", async () => {
    (client.getHermesMemory as any).mockResolvedValueOnce(null);
    registerHermesBridgeTools(server, client as RobynnClient);
    const res = await registered["robynn_memory_get"]({ scope: "org", key: "missing" });
    expect(res.structuredContent).toEqual({ value: null });
  });

  it("robynn_memory_search forwards query + scope + limit", async () => {
    registerHermesBridgeTools(server, client as RobynnClient);
    const res = await registered["robynn_memory_search"]({
      query: "Q2 go-to-market",
      scope: "org",
      limit: 5,
    });
    expect(client.searchHermesMemory).toHaveBeenCalledWith({
      query: "Q2 go-to-market",
      scope: "org",
      limit: 5,
    });
    expect(res.structuredContent).toMatchObject({
      rows: [expect.objectContaining({ key: "theme", score: 0.81 })],
    });
  });

  it("robynn_memory_search returns isError on client failure", async () => {
    (client.searchHermesMemory as any).mockRejectedValueOnce(new Error("rpc down"));
    registerHermesBridgeTools(server, client as RobynnClient);
    const res = await registered["robynn_memory_search"]({ query: "x" });
    expect(res.isError).toBe(true);
  });

  it("robynn_thread_upsert returns isError on client failure", async () => {
    (client.upsertHermesThread as any).mockRejectedValueOnce(new Error("500"));
    registerHermesBridgeTools(server, client as RobynnClient);
    const res = await registered["robynn_thread_upsert"]({
      hermes_host_id: "h",
      hermes_session_id: "s",
      platform: "cli",
    });
    expect(res.isError).toBe(true);
  });
});
