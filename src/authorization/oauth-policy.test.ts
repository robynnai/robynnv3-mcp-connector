import { describe, expect, it } from "vitest";
import {
  ADVERTISE_SSE,
  isCanonicalRequestPath,
  getApprovedResources,
  isScopeSubset,
  isUnservedApiPath,
  normalizeClientName,
  parseRequestedScopes,
  validateAuthorizeRequest,
  validateRequestedResource,
} from "./oauth-policy";
import type { OAuthRequestInfo } from "../types";

const BASE = "https://mcp.robynn.ai";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function request(overrides: Partial<OAuthRequestInfo> = {}): OAuthRequestInfo {
  return {
    responseType: "code",
    clientId: "client",
    redirectUri: "http://127.0.0.1:1234/callback",
    state: "s",
    scope: [],
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

describe("D-C flag", () => {
  it("defaults to not advertising SSE", () => {
    expect(ADVERTISE_SSE).toBe(false);
  });
});

describe("parseRequestedScopes", () => {
  it("normalizes an omitted or empty scope to brand:read", () => {
    expect(parseRequestedScopes(undefined)).toEqual({ ok: true, scopes: ["brand:read"] });
    expect(parseRequestedScopes([])).toEqual({ ok: true, scopes: ["brand:read"] });
  });

  it("never widens: brand:read stays brand:read", () => {
    expect(parseRequestedScopes(["brand:read"])).toEqual({ ok: true, scopes: ["brand:read"] });
    expect(parseRequestedScopes(["tools:execute"])).toEqual({ ok: true, scopes: ["tools:execute"] });
  });

  it("orders and deduplicates", () => {
    expect(parseRequestedScopes(["tools:execute", "brand:read", "tools:execute"])).toEqual({
      ok: true,
      scopes: ["brand:read", "tools:execute"],
    });
  });

  it.each([[["admin"]], [["brand:read", "x"]], [["cli:session"]], [["constructor"]], [["__proto__"]], [["BRAND:READ"]]])(
    "rejects unknown scopes %j",
    (scopes) => {
      expect(parseRequestedScopes(scopes)).toEqual({ ok: false });
    },
  );
});

describe("isScopeSubset", () => {
  it("works", () => {
    expect(isScopeSubset(["brand:read"], ["brand:read", "tools:execute"])).toBe(true);
    expect(isScopeSubset(["brand:read", "tools:execute"], ["brand:read"])).toBe(false);
    expect(isScopeSubset([], ["brand:read"])).toBe(true);
  });
});

describe("resources", () => {
  it("approves only the single-service aliases", () => {
    expect(getApprovedResources(`${BASE}/`)).toEqual([BASE, `${BASE}/`, `${BASE}/mcp`]);
    expect(getApprovedResources(BASE, true)).toContain(`${BASE}/sse`);
  });

  it.each([[undefined], [BASE], [`${BASE}/`], [`${BASE}/mcp`], [[BASE, `${BASE}/mcp`]]])("accepts %j", (resource) => {
    expect(validateRequestedResource(resource, BASE)).toBe(true);
  });

  it.each([
    [`${BASE}/sse`],
    [`${BASE}/mcp/openai`],
    [`${BASE}/mcp/lazy`],
    [`${BASE}/mcp/`],
    [`${BASE}/mcpx`],
    [`${BASE}/mcp?x`],
    [`${BASE}/mcp#f`],
    ["https://MCP.robynn.ai/mcp"],
    ["http://mcp.robynn.ai/mcp"],
    ["https://mcp.robynn.ai.evil.test/mcp"],
    [[`${BASE}/mcp`, "https://evil.test"]],
    [[]],
  ])("rejects %j", (resource) => {
    expect(validateRequestedResource(resource as never, BASE)).toBe(false);
  });

  it("accepts /sse only when SSE is advertised", () => {
    expect(validateRequestedResource(`${BASE}/sse`, BASE, true)).toBe(true);
  });
});

describe("validateAuthorizeRequest", () => {
  it("accepts a valid S256 code request", () => {
    expect(validateAuthorizeRequest(request({ scope: ["brand:read"] }), BASE)).toEqual({
      ok: true,
      scopes: ["brand:read"],
    });
  });

  it.each([
    ["token response type", { responseType: "token" }, "unsupported_response_type"],
    ["plain method", { codeChallengeMethod: "plain" }, "invalid_request"],
    ["missing method", { codeChallengeMethod: undefined }, "invalid_request"],
    ["missing challenge", { codeChallenge: undefined }, "invalid_request"],
    ["empty challenge", { codeChallenge: "" }, "invalid_request"],
    ["short challenge", { codeChallenge: CHALLENGE.slice(1) }, "invalid_request"],
    ["unknown scope", { scope: ["root"] }, "invalid_scope"],
    ["foreign resource", { resource: "https://evil.test/mcp" }, "invalid_target"],
  ])("rejects %s", (_label, overrides, error) => {
    const result = validateAuthorizeRequest(request(overrides as Partial<OAuthRequestInfo>), BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.error).toBe(error);
  });
});

describe("normalizeClientName", () => {
  it.each([
    ["Claude Code", "Claude Code"],
    ["  Codex\n\tCLI  ", "Codex CLI"],
    ["Evil‮edoC", "EviledoC"],
    ["Zero​width﻿", "Zerowidth"],
    ["\u0000\u0007", null],
    ["", null],
    [42, null],
    [undefined, null],
  ])("%j ⇒ %j", (input, expected) => {
    expect(normalizeClientName(input)).toBe(expected);
  });

  it("caps the display length at 64 code points", () => {
    expect(Array.from(normalizeClientName("é".repeat(100))!)).toHaveLength(64);
  });
});

describe("isUnservedApiPath", () => {
  it.each([["/mcpx"], ["/mcp/"], ["/mcp/openai"], ["/sse"], ["/sse/message"], ["/sse-anything"]])("%s is unserved", (p) => {
    expect(isUnservedApiPath(p)).toBe(true);
  });

  it.each([["/mcp"], ["/"], ["/authorize"], ["/callback"], ["/token"], ["/.well-known/oauth-protected-resource/mcp"]])(
    "%s is not an unserved API path",
    (p) => {
      expect(isUnservedApiPath(p)).toBe(false);
    },
  );
});

describe("isCanonicalRequestPath (P06 review B2)", () => {
  it.each([["/"], ["/mcp"], ["/token"], ["/.well-known/oauth-protected-resource/mcp"]])("%s is canonical", (p) => {
    expect(isCanonicalRequestPath(p)).toBe(true);
  });
  it.each([["//mcp.test/mcp"], ["///mcp"], ["/\\host/mcp"], ["/mcp\\x"], ["mcp"], [""]])("%j is not", (p) => {
    expect(isCanonicalRequestPath(p)).toBe(false);
  });
});
