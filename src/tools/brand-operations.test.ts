import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBrandOperationTools } from "./brand-operations";
import type { RobynnClient } from "../robynn-client";

describe("registerBrandOperationTools", () => {
  let server: McpServer;
  let client: Partial<RobynnClient>;
  let registered: Record<string, any>;

  beforeEach(() => {
    registered = {};
    server = {
      tool: (
        name: string,
        _desc: string,
        _schema: any,
        _anno: any,
        handler: any,
      ) => {
        registered[name] = handler;
      },
    } as unknown as McpServer;
    client = {
      addBrandSource: vi.fn().mockResolvedValue({
        success: true,
        data: {
          source_type: "text",
          source_id: "source-1",
          status: "created",
          title: "Positioning notes",
        },
      }),
      rebuildBrandContext: vi.fn().mockResolvedValue({
        success: true,
        data: {
          status: "rebuilt",
          mode: "derive",
          organization_id: "org-1",
          derived_at: "2026-05-15T22:00:00.000Z",
          company_name: "Acme",
        },
      }),
    };
  });

  it("registers brand source and rebuild tools", () => {
    registerBrandOperationTools(server, client as RobynnClient);
    expect(Object.keys(registered)).toEqual([
      "robynn_brand_source_add",
      "robynn_brand_rebuild",
    ]);
  });

  it("adds text sources through the robynnv3 API client", async () => {
    registerBrandOperationTools(server, client as RobynnClient);

    const res = await registered["robynn_brand_source_add"]({
      source_type: "text",
      title: "Positioning notes",
      content: "# Notes",
      idempotency_key: "idem-1",
    });

    expect(client.addBrandSource).toHaveBeenCalledWith({
      source_type: "text",
      title: "Positioning notes",
      content: "# Notes",
      content_type: undefined,
      idempotency_key: "idem-1",
    });
    expect(res.structuredContent.source_id).toBe("source-1");
  });

  it("requires URL for website sources before calling the client", async () => {
    registerBrandOperationTools(server, client as RobynnClient);

    const res = await registered["robynn_brand_source_add"]({
      source_type: "website",
      idempotency_key: "idem-1",
    });

    expect(res.isError).toBe(true);
    expect(client.addBrandSource).not.toHaveBeenCalled();
  });

  it("rebuilds Brand Context with explicit confirmation", async () => {
    registerBrandOperationTools(server, client as RobynnClient);

    const res = await registered["robynn_brand_rebuild"]({
      write_confirmed: true,
    });

    expect(client.rebuildBrandContext).toHaveBeenCalledWith({
      mode: "derive",
      write_confirmed: true,
    });
    expect(res.structuredContent.status).toBe("rebuilt");
  });
});
