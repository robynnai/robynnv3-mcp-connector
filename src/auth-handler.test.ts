import { describe, expect, it } from "vitest";
import { renderLaunchInterstitial } from "./auth-handler";

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
