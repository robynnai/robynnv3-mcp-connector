import { describe, expect, it } from "vitest";
import {
  getAdvertisedTransports,
  getLandingDocument,
  getProtectedResourceMetadata,
  isSafeFallbackUrl,
  isSafeLaunchUrl,
  renderAuthErrorPage,
  renderLaunchInterstitial,
  serializeForInlineScript,
  type FrontDoorErrorCode,
} from "./auth-handler";

const FALLBACK = "https://robynn.ai/brand-book/generate";

/** Extract the inline script body and evaluate its two JSON literals. */
function scriptLiterals(html: string) {
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  const body = match![1];
  const launch = body.match(/const launchUrl = (.*);\n/)![1];
  const fallback = body.match(/const fallbackUrl = (.*);\n/)![1];
  return { body, launch: JSON.parse(launch), fallback: JSON.parse(fallback) };
}

describe("serializeForInlineScript", () => {
  it.each([
    ["</script><script>alert(1)</script>"],
    ["<!--"],
    ["a&b"],
    ["line\u2028sep\u2029para"],
    ['"quoted" \\ backslash'],
  ])("round-trips %j without any raw <, >, & or line separators", (value) => {
    const out = serializeForInlineScript(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toBe(value);
  });
});

describe("renderLaunchInterstitial", () => {
  it("renders host-neutral copy with the launch and Brand Hub links", () => {
    const html = renderLaunchInterstitial({
      launchUrl: "robynn-host://oauth/callback?code=abc123",
      fallbackUrl: FALLBACK,
      nonce: "n0nce",
    })!;

    expect(html).toContain("Returning to your app");
    expect(html).toContain("Open your app");
    expect(html).not.toMatch(/claude/i);
    expect(html).toContain('href="robynn-host://oauth/callback?code=abc123"');
    expect(html).toContain(`href="${FALLBACK}"`);
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    const { launch, fallback } = scriptLiterals(html);
    expect(launch).toBe("robynn-host://oauth/callback?code=abc123");
    expect(fallback).toBe(FALLBACK);
  });

  it("keeps a hostile query inert in both the markup and the script", () => {
    const hostile = 'robynn-host://cb?x=%3C/script%3E&y="</script><script>alert(1)</script>';
    // Raw `"`, `<` and `>` are not printable-URL safe here, so the URL is refused...
    expect(renderLaunchInterstitial({ launchUrl: hostile, fallbackUrl: FALLBACK })).toBeNull();

    // ...while a percent-encoded equivalent is rendered inert.
    const encoded = "robynn-host://cb?x=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&q='";
    const html = renderLaunchInterstitial({ launchUrl: encoded, fallbackUrl: FALLBACK })!;
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("q=&#39;");
    expect(scriptLiterals(html).launch).toBe(encoded);
  });

  it("escapes a fallback URL containing quotes and ampersands", () => {
    const fallback = 'https://robynn.ai/brand-book/generate?next="onboarding"&safe=true';
    // Raw quotes are refused outright.
    expect(renderLaunchInterstitial({ launchUrl: "robynn-host://cb", fallbackUrl: fallback })).toBeNull();
    const ok = "https://robynn.ai/brand-book/generate?next=onboarding&safe=true";
    const html = renderLaunchInterstitial({ launchUrl: "robynn-host://cb", fallbackUrl: ok })!;
    expect(html).toContain('href="https://robynn.ai/brand-book/generate?next=onboarding&amp;safe=true"');
    expect(html).toContain('"https://robynn.ai/brand-book/generate?next=onboarding\\u0026safe=true"');
    expect(scriptLiterals(html).fallback).toBe(ok);
  });

  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    [" javascript:alert(1)"],
    ["java\tscript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox"],
    ["file:///etc/passwd"],
    ["blob:https://evil.test/x"],
    ["about:blank"],
    ["https://evil.test/"],
    ["http://127.0.0.1:1/cb"],
    ["//evil.test/cb"],
    ["robynn-host://cb\u2028"],
    ["robynn-host://cb\nx"],
    ["robynn-hôst://cb"],
    [""],
    ["x".repeat(5000)],
  ])("refuses unsafe launch URL %j", (launchUrl) => {
    expect(isSafeLaunchUrl(launchUrl)).toBe(false);
    expect(renderLaunchInterstitial({ launchUrl, fallbackUrl: FALLBACK })).toBeNull();
  });

  it.each([["javascript:alert(1)"], ["data:text/html,x"], ["robynn-host://cb"], ["https://x/\u2028"], ["not a url"]])(
    "refuses unsafe fallback URL %j",
    (fallbackUrl) => {
      expect(isSafeFallbackUrl(fallbackUrl)).toBe(false);
      expect(renderLaunchInterstitial({ launchUrl: "robynn-host://cb", fallbackUrl })).toBeNull();
    },
  );

  it.each([["claude://oauth/callback?code=a"], ["cursor://anysphere/cb"], ["com.example.app:/oauth2redirect"]])(
    "accepts native redirect %s",
    (launchUrl) => {
      expect(isSafeLaunchUrl(launchUrl)).toBe(true);
    },
  );
});

describe("renderAuthErrorPage", () => {
  const codes: FrontDoorErrorCode[] = [
    "invalid_request",
    "unsupported_response_type",
    "invalid_scope",
    "invalid_target",
    "access_denied",
    "temporarily_unavailable",
    "server_error",
  ];

  it.each(codes)("%s renders static, host-neutral copy with no script", (code) => {
    const html = renderAuthErrorPage(code, "abc");
    expect(html).toContain(`Error code: ${code}`);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/claude/i);
  });

  it("falls back to server_error copy for an unknown code and never reflects it", () => {
    const html = renderAuthErrorPage("<img src=x onerror=alert(1)>" as FrontDoorErrorCode);
    expect(html).not.toContain("<img");
    expect(html).toContain("Robynn could not connect");
  });
});

describe("discovery documents (D-C: ADVERTISE_SSE=false)", () => {
  it("returns canonical origin-based metadata", () => {
    expect(getProtectedResourceMetadata("https://mcp.robynn.ai/")).toEqual({
      resource: "https://mcp.robynn.ai",
      authorization_servers: ["https://mcp.robynn.ai"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["brand:read", "tools:execute"],
      resource_name: "Robynn MCP server",
    });
    expect(getProtectedResourceMetadata("https://mcp.robynn.ai", "mcp")).toMatchObject({
      resource: "https://mcp.robynn.ai",
      resource_name: "Robynn MCP endpoint",
    });
  });

  it("advertises only /mcp by default and /sse only when the flag is flipped", () => {
    expect(getAdvertisedTransports()).toEqual(["mcp"]);
    expect(getAdvertisedTransports(true)).toEqual(["mcp", "sse"]);
    expect(getLandingDocument("1.0.0").endpoints).toEqual({ mcp: "/mcp", authorize: "/authorize", health: "/" });
    expect(getLandingDocument("1.0.0", true).endpoints).toHaveProperty("sse", "/sse");
  });

  it("uses host-neutral copy", () => {
    expect(JSON.stringify(getLandingDocument("1.0.0"))).not.toMatch(/claude/i);
  });
});
