import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectorActionTools } from "./connector-act";
import type { RobynnClient } from "../robynn-client";

describe("registerConnectorActionTools", () => {
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
      actOnConnectedApp: vi.fn().mockResolvedValue({
        ok: true,
        replayed: false,
        audit_id: "a-1",
        result: { id: "t_1" },
        dry_run: false,
      }),
    };
  });

  it("registers robynn_connected_app_action", () => {
    registerConnectorActionTools(server, client as RobynnClient);
    expect(Object.keys(registered)).toEqual(["robynn_connected_app_action"]);
  });

  it("forwards args to the client and returns structured content", async () => {
    registerConnectorActionTools(server, client as RobynnClient);
    const res = await registered["robynn_connected_app_action"]({
      service: "hubspot",
      action: "create_task",
      parameters: { subject: "follow up" },
      idempotency_key: "uuid-1",
      dry_run: true,
    });
    expect(client.actOnConnectedApp).toHaveBeenCalledWith({
      service: "hubspot",
      action: "create_task",
      parameters: { subject: "follow up" },
      idempotency_key: "uuid-1",
      dry_run: true,
    });
    expect(res.structuredContent).toMatchObject({ ok: true, audit_id: "a-1" });
  });

  it("returns isError on client failure", async () => {
    (client.actOnConnectedApp as any).mockRejectedValueOnce(new Error("boom"));
    registerConnectorActionTools(server, client as RobynnClient);
    const res = await registered["robynn_connected_app_action"]({
      service: "hubspot",
      action: "create_task",
      parameters: {},
      idempotency_key: "uuid-2",
    });
    expect(res.isError).toBe(true);
  });
});
