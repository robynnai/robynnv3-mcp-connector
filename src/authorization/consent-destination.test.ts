import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  consentDestinationPayload,
  redirectOrigin,
  signConsentDestination,
} from "./consent-destination";

// COS-PLUGIN-001 P19b (P19 RC review R3). The same vector is asserted by the
// app's src/lib/server/oauth/consent-destination.test.ts, so the two sides
// cannot drift apart.
const VECTOR = {
  secret: "p19b-test-vector-secret-not-a-real-secret",
  state: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd0",
  origin: "https://evil.example",
  nowMs: 1760200000000,
  signature: "v1.1760200600.E3B_PAGLdf6oCfrSjedEYXMcEDl16M6D7ng1zof-Iyo",
};

describe("redirectOrigin", () => {
  it.each([
    ["http://127.0.0.1:43123/callback?x=1#f", "http://127.0.0.1:43123"],
    ["http://localhost:33418/callback", "http://localhost:33418"],
    ["https://claude.ai/api/mcp/auth_callback", "https://claude.ai"],
    ["https://Evil.Example:443/cb", "https://evil.example"],
    // The userinfo part is not the destination: the browser goes to evil.example.
    ["https://claude.ai@evil.example/cb", "https://evil.example"],
    ["https://bücher.example/cb", "https://xn--bcher-kva.example"],
    ["http://[::1]:8080/cb", "http://[::1]:8080"],
    ["cursor://anysphere.cursor-retrieval/oauth/callback", "cursor:"],
  ])("%s ⇒ %s", (uri, expected) => {
    expect(redirectOrigin(uri)).toBe(expected);
  });

  it.each([["not a url"], [""], ["https://"]])("%j ⇒ null", (uri) => {
    expect(redirectOrigin(uri)).toBeNull();
  });
});

describe("signConsentDestination", () => {
  it("matches the shared test vector", async () => {
    expect(
      await signConsentDestination(VECTOR.secret, { state: VECTOR.state, origin: VECTOR.origin }, VECTOR.nowMs),
    ).toBe(VECTOR.signature);
  });

  it("is HMAC-SHA256 over the labelled payload, expiring with the transaction (600 s)", async () => {
    const signature = await signConsentDestination("s", { state: "st", origin: "https://a.example" }, 1_000_000);
    const [version, exp, mac] = signature.split(".");
    expect(version).toBe("v1");
    expect(Number(exp)).toBe(1000 + 600);
    expect(mac).toBe(
      createHmac("sha256", "s")
        .update(JSON.stringify(["robynn-consent-destination", "v1", 1600, "st", "https://a.example"]))
        .digest("base64url"),
    );
    expect(consentDestinationPayload(1600, "st", "https://a.example")).toBe(
      '["robynn-consent-destination","v1",1600,"st","https://a.example"]',
    );
  });

  it("binds the state and the origin", async () => {
    const base = await signConsentDestination("s", { state: "st", origin: "https://a.example" }, 0);
    expect(await signConsentDestination("s", { state: "st2", origin: "https://a.example" }, 0)).not.toBe(base);
    expect(await signConsentDestination("s", { state: "st", origin: "https://b.example" }, 0)).not.toBe(base);
    expect(await signConsentDestination("t", { state: "st", origin: "https://a.example" }, 0)).not.toBe(base);
  });
});
