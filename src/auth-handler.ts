import { Hono } from "hono";
import type { Env } from "./types";

type HonoEnv = { Bindings: Env };

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
  // Generate a state token to link the callback back to this session
  const oauthState = crypto.randomUUID();

  // Store the original request URL so we can retrieve context in the callback
  await c.env.OAUTH_KEY.put(
    `oauth_state:${oauthState}`,
    JSON.stringify({
      workerCallbackUrl: new URL("/callback", c.req.url).href,
      timestamp: Date.now(),
    }),
    { expirationTtl: 600 } // 10 minutes
  );

  // Redirect to Robynn's OAuth consent page
  const authorizeUrl = new URL("/oauth/authorize", c.env.ROBYNN_API_BASE_URL);
  authorizeUrl.searchParams.set("client_id", "robynn-mcp-worker");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    new URL("/callback", c.req.url).href
  );
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
  };

  // Exchange authorization code for tokens with robynn.ai
  const tokenResponse = await fetch(
    `${c.env.ROBYNN_API_BASE_URL}/api/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: "robynn-mcp-worker",
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
  return c.env.OAUTH_PROVIDER.completeAuthorization({
    request: c.req.raw,
    userId,
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      userId,
      organizationId,
    },
    options: {
      scope: "brand:read tools:execute",
    },
  });
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

/**
 * Well-known MCP configuration
 */
app.get("/.well-known/mcp.json", (c) => {
  return c.json({
    name: "Robynn",
    description: "Brand-aware AI marketing tools for Claude",
    mcp_endpoint: "/mcp",
    oauth: {
      authorization_endpoint: "/authorize",
      token_endpoint: "/token",
      registration_endpoint: "/register",
    },
  });
});

export { app as robynnAuthHandler };
