import { describe, expect, it, vi } from "vitest";

import { registerStrapiTools } from "./strapi";

function createServerHarness() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        _config: Record<string, any>,
        handler: (args: any) => Promise<any>,
      ) => {
        handlers.set(name, handler);
      },
    ),
  };

  return { server, handlers };
}

describe("registerStrapiTools", () => {
  it("requires explicit write confirmation", async () => {
    const { server, handlers } = createServerHarness();
    const client = { publishStrapiDraft: vi.fn() };
    registerStrapiTools(server as never, client as never);

    const response = await handlers.get("robynn_publish_strapi_draft")?.({
      write_confirmed: false,
      content: "Draft",
    });

    expect(response?.isError).toBe(true);
    expect(client.publishStrapiDraft).not.toHaveBeenCalled();
  });

  it("publishes a draft and returns document metadata", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      publishStrapiDraft: vi.fn().mockResolvedValue({
        success: true,
        data: {
          success: true,
          is_draft: true,
          published_url: "https://cms.test/admin/content-manager",
          platform_post_id: "doc-123",
          publishing_metadata: {
            strapi_document_id: "doc-123",
            strapi_content_type_uid: "api::blog-post.blog-post",
          },
        },
      }),
    };
    registerStrapiTools(server as never, client as never);

    const response = await handlers.get("robynn_publish_strapi_draft")?.({
      write_confirmed: true,
      title: "Draft",
      content: "Body",
    });

    expect(client.publishStrapiDraft).toHaveBeenCalledWith({
      write_confirmed: true,
      title: "Draft",
      content: "Body",
    });
    expect(response?.structuredContent.platform_post_id).toBe("doc-123");
    expect(response?.content[0].text).toContain("documentId: doc-123");
  });

  it("returns upstream errors", async () => {
    const { server, handlers } = createServerHarness();
    const client = {
      publishStrapiDraft: vi.fn().mockResolvedValue({
        success: false,
        error: "No Strapi credential",
      }),
    };
    registerStrapiTools(server as never, client as never);

    const response = await handlers.get("robynn_publish_strapi_draft")?.({
      write_confirmed: true,
      artifact_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(response?.isError).toBe(true);
    expect(response?.content[0].text).toContain("No Strapi credential");
  });
});
