import { Hono } from "hono";
import type { Env } from "./types";
import { REPORT_APP_SCRIPT } from "./ui/report-app-script";
import {
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
  shouldSignTrustedMcpTokenExchange,
  signTrustedMcpTokenExchange,
} from "./internal-mcp-auth";

type HonoEnv = { Bindings: Env };
const OAUTH_CLIENT_ID = "robynn-mcp-worker";

function getWorkerBaseUrl(c: { env: Env; req: { url: string } }) {
  const publicBaseUrl = c.env.MCP_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    return publicBaseUrl.replace(/\/+$/, "");
  }
  return new URL(c.req.url).origin;
}

/**
 * OAuth authorization handler.
 *
 * This Hono app handles the user-facing OAuth consent flow:
 * 1. /authorize — redirect user to robynn.ai login + consent page
 * 2. /callback  — exchange auth code for tokens, complete authorization
 * 3. /          — health check / landing page
 *
 * The OAuthProvider intercepts /token and /register automatically.
 */
const app = new Hono<HonoEnv>();

/**
 * Authorization endpoint — called by OAuthProvider when Claude initiates OAuth.
 * Redirects the user to robynn.ai's consent page.
 */
app.get("/authorize", async (c) => {
  const workerBaseUrl = getWorkerBaseUrl(c);
  const workerCallbackUrl = new URL("/callback", workerBaseUrl).href;
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

  // Generate a state token to link the callback back to this session
  const oauthState = crypto.randomUUID();

  // Store the original request URL so we can retrieve context in the callback
  await c.env.OAUTH_KEY.put(
    `oauth_state:${oauthState}`,
    JSON.stringify({
      workerCallbackUrl,
      oauthRequest,
      timestamp: Date.now(),
    }),
    { expirationTtl: 600 } // 10 minutes
  );

  // Redirect to Robynn's OAuth consent page
  const authorizeUrl = new URL("/oauth/authorize", c.env.ROBYNN_API_BASE_URL);
  authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", workerCallbackUrl);
  authorizeUrl.searchParams.set("state", oauthState);
  authorizeUrl.searchParams.set("scope", "brand:read tools:execute");
  authorizeUrl.searchParams.set("response_type", "code");

  return c.redirect(authorizeUrl.toString());
});

/**
 * OAuth callback — robynn.ai redirects here after user consents.
 * Exchanges the auth code for tokens and completes the OAuthProvider flow.
 */
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  // Handle denied access
  if (error) {
    return c.text(`Authorization denied: ${error}`, 403);
  }

  if (!code || !state) {
    return c.text("Missing code or state parameter", 400);
  }

  // Validate state
  const storedStateRaw = await c.env.OAUTH_KEY.get(`oauth_state:${state}`);
  if (!storedStateRaw) {
    return c.text("Invalid or expired state", 400);
  }
  // Clean up used state
  await c.env.OAUTH_KEY.delete(`oauth_state:${state}`);

  const storedState = JSON.parse(storedStateRaw) as {
    workerCallbackUrl: string;
    oauthRequest: import("./types").OAuthRequestInfo;
  };

  const internalAuthSecret =
    c.env.MCP_INTERNAL_AUTH_SECRET?.trim() ||
    c.env.CONNECTOR_STATE_SECRET?.trim();
  const tokenExchangeHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (
    shouldSignTrustedMcpTokenExchange(internalAuthSecret, OAUTH_CLIENT_ID)
  ) {
    const { signature, timestamp } = await signTrustedMcpTokenExchange(
      internalAuthSecret,
      {
        grantType: "authorization_code",
        code,
        clientId: OAUTH_CLIENT_ID,
        redirectUri: storedState.workerCallbackUrl,
      }
    );

    tokenExchangeHeaders[MCP_SIGNATURE_HEADER] = signature;
    tokenExchangeHeaders[MCP_TIMESTAMP_HEADER] = timestamp;
  }

  // Exchange authorization code for tokens with robynn.ai
  const tokenResponse = await fetch(
    `${c.env.ROBYNN_API_BASE_URL}/api/oauth/token`,
    {
      method: "POST",
      headers: tokenExchangeHeaders,
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: storedState.workerCallbackUrl,
      }),
    }
  );

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("[Auth] Token exchange failed:", errorText);
    return c.text("Token exchange failed", 500);
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  // Decode the JWT to extract user info (sub, org, scope)
  let userId = "unknown";
  let organizationId = "unknown";
  try {
    const parts = tokens.access_token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
      );
      userId = payload.sub || userId;
      organizationId = payload.org || organizationId;
    }
  } catch {
    console.error("[Auth] Failed to decode JWT payload");
  }

  // Complete the OAuthProvider authorization.
  // This stores the user's props, issues OAuthProvider's own token to Claude,
  // and redirects back to Claude's redirect_uri.
  const grantedScope =
    storedState.oauthRequest.scope?.length > 0
      ? storedState.oauthRequest.scope
      : ["brand:read", "tools:execute"];

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: storedState.oauthRequest,
    userId,
    metadata: {
      organizationId,
      upstreamClientId: OAUTH_CLIENT_ID,
    },
    scope: grantedScope,
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      userId,
      organizationId,
    },
  });

  return c.redirect(redirectTo);
});

/**
 * Health check / landing page
 */
app.get("/", (c) => {
  return c.json({
    name: "Robynn MCP Server",
    description: "Brand-aware AI marketing tools for Claude",
    version: c.env.MCP_SERVER_VERSION || "0.1.0",
    endpoints: {
      mcp: "/mcp",
      sse: "/sse",
      authorize: "/authorize",
      health: "/",
    },
  });
});

app.get("/app-assets/report-app.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(REPORT_APP_SCRIPT);
});

app.get("/.well-known/oauth-protected-resource/:transport", (c) => {
  const workerBaseUrl = getWorkerBaseUrl(c);
  const transport = c.req.param("transport");

  if (transport !== "mcp" && transport !== "sse") {
    return c.text("Not Found", 404);
  }

  return c.json({
    resource: `${workerBaseUrl}/${transport}`,
    authorization_servers: [workerBaseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["brand:read", "tools:execute"],
    resource_name: `Robynn ${transport.toUpperCase()} endpoint`,
  });
});

/**
 * Well-known MCP configuration
 */
app.get("/.well-known/mcp.json", (c) => {
  const workerBaseUrl = getWorkerBaseUrl(c);
  return c.json({
    name: "Robynn",
    description: "Brand-aware AI marketing tools for Claude",
    mcp_endpoint: `${workerBaseUrl}/mcp`,
    oauth: {
      authorization_endpoint: `${workerBaseUrl}/authorize`,
      token_endpoint: `${workerBaseUrl}/token`,
      registration_endpoint: `${workerBaseUrl}/register`,
    },
  });
});

export { app as robynnAuthHandler };
