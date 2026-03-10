import { describe, expect, it } from "vitest";
import {
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
  signTrustedMcpTokenExchange,
  shouldSignTrustedMcpTokenExchange,
} from "./internal-mcp-auth";

describe("internal MCP auth helpers", () => {
  it("signs trusted MCP token exchanges with a versioned signature", async () => {
    const result = await signTrustedMcpTokenExchange("shared-secret", {
      grantType: "authorization_code",
      clientId: "robynn-mcp-worker",
      redirectUri: "https://mcp.robynn.ai/callback",
      code: "code-123",
      timestamp: "1700000000000",
    });

    expect(result.timestamp).toBe("1700000000000");
    expect(result.signature.startsWith("v1.")).toBe(true);
  });

  it("only opts into signing when the trusted client id and secret are present", () => {
    expect(
      shouldSignTrustedMcpTokenExchange("shared-secret", "robynn-mcp-worker"),
    ).toBe(true);
    expect(
      shouldSignTrustedMcpTokenExchange(undefined, "robynn-mcp-worker"),
    ).toBe(false);
    expect(
      shouldSignTrustedMcpTokenExchange("shared-secret", "other-client"),
    ).toBe(false);
  });

  it("exports stable header names for downstream usage", () => {
    expect(MCP_SIGNATURE_HEADER).toBe("x-robynn-mcp-signature");
    expect(MCP_TIMESTAMP_HEADER).toBe("x-robynn-mcp-timestamp");
  });
});
