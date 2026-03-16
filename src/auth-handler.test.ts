import { describe, expect, it } from "vitest";
import {
  getProtectedResourceMetadata,
  normalizeOAuthRequestResource,
  renderLaunchInterstitial,
} from "./auth-handler";

describe("renderLaunchInterstitial", () => {
  it("renders both the Claude launch URL and Brand Hub fallback", () => {
    const html = renderLaunchInterstitial({
      launchUrl: "claude://oauth/callback?code=abc123",
      fallbackUrl: "https://robynn.ai/brand-book/generate",
    });

    expect(html).toContain("Claude is opening");
    expect(html).toContain('href="claude://oauth/callback?code=abc123"');
    expect(html).toContain('href="https://robynn.ai/brand-book/generate"');
    expect(html).toContain(
      'const fallbackUrl = "https://robynn.ai/brand-book/generate";'
    );
    expect(html).toContain("window.location.replace(fallbackUrl);");
  });

  it("escapes launch and fallback links before inserting them into markup", () => {
    const html = renderLaunchInterstitial({
      launchUrl: 'claude://oauth/callback?x=<script>alert("x")</script>',
      fallbackUrl:
        'https://robynn.ai/brand-book/generate?next="onboarding"&safe=true',
    });

    expect(html).toContain(
      'href="claude://oauth/callback?x=&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"'
    );
    expect(html).toContain(
      'href="https://robynn.ai/brand-book/generate?next=&quot;onboarding&quot;&amp;safe=true"'
    );
  });
});

describe("normalizeOAuthRequestResource", () => {
  it("preserves requests without a resource parameter", () => {
    const oauthRequest = {
      responseType: "code",
      clientId: "client-id",
      redirectUri: "https://claude.ai/callback",
      state: "state-123",
      scope: ["brand:read"],
    };

    expect(
      normalizeOAuthRequestResource(oauthRequest, "https://mcp.robynn.ai"),
    ).toEqual(oauthRequest);
  });

  it("adds origin and transport aliases for protected resource requests", () => {
    const normalized = normalizeOAuthRequestResource(
      {
        responseType: "code",
        clientId: "client-id",
        redirectUri: "https://claude.ai/callback",
        state: "state-123",
        scope: ["brand:read", "tools:execute"],
        resource: "https://mcp.robynn.ai/mcp",
      },
      "https://mcp.robynn.ai",
    );

    expect(normalized.resource).toEqual([
      "https://mcp.robynn.ai/mcp",
      "https://mcp.robynn.ai",
      "https://mcp.robynn.ai/sse",
    ]);
  });
});

describe("getProtectedResourceMetadata", () => {
  it("returns canonical origin-based metadata", () => {
    expect(getProtectedResourceMetadata("https://mcp.robynn.ai/")).toEqual({
      resource: "https://mcp.robynn.ai",
      authorization_servers: ["https://mcp.robynn.ai"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["brand:read", "tools:execute"],
      resource_name: "Robynn MCP server",
    });
  });

  it("keeps transport routes aligned to the same canonical resource", () => {
    expect(
      getProtectedResourceMetadata("https://mcp.robynn.ai", "mcp"),
    ).toMatchObject({
      resource: "https://mcp.robynn.ai",
      resource_name: "Robynn MCP endpoint",
    });

    expect(
      getProtectedResourceMetadata("https://mcp.robynn.ai", "sse"),
    ).toMatchObject({
      resource: "https://mcp.robynn.ai",
      resource_name: "Robynn SSE endpoint",
    });
  });
});
