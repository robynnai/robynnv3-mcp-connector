import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCapabilityTools } from "./capabilities";
import type { RobynnClient } from "../robynn-client";

describe("registerCapabilityTools", () => {
  let server: McpServer;
  let client: Partial<RobynnClient>;
  let registered: Record<string, any>;

  beforeEach(() => {
    registered = {};
    server = {
      tool: (name: string, _desc: string, _anno: any, handler: any) => {
        registered[name] = handler;
      },
    } as unknown as McpServer;
    client = {
      getBridgeCapabilities: vi.fn().mockResolvedValue({
        success: true,
        data: {
          version: 1,
          organization_id: "org-1",
          capabilities: [
            {
              id: "agents.cmo.run",
              status: "available",
              mcp_tools: ["robynn_cmo_agent"],
            },
          ],
          connectors: {
            active_connection_count: 0,
            active_provider_keys: [],
            write_execution: {
              route: "/api/cli/connectors/act",
              credential_mode: "server_side",
              accepts_provider_access_token: false,
            },
          },
        },
      }),
    };
  });

  it("registers robynn_capabilities and returns structured manifest data", async () => {
    registerCapabilityTools(server, client as RobynnClient);

    const res = await registered["robynn_capabilities"]({});

    expect(client.getBridgeCapabilities).toHaveBeenCalledWith();
    expect(res.structuredContent.capabilities[0]).toMatchObject({
      id: "agents.cmo.run",
      status: "available",
    });
    expect(res.structuredContent.connectors.write_execution).toMatchObject({
      accepts_provider_access_token: false,
    });
    expect(res.content[0].text).toContain('"agents.cmo.run"');
    expect(res.content[0].text).toContain('"accepts_provider_access_token": false');
  });
});
