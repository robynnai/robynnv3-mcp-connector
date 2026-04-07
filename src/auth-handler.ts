import { Hono } from "hono";
import type { Env } from "./types";
import { REPORT_APP_SCRIPT } from "./ui/report-app-script";
import { getServerVersion } from "./version";
import {
  MCP_SIGNATURE_HEADER,
  MCP_TIMESTAMP_HEADER,
  shouldSignTrustedMcpTokenExchange,
  signTrustedMcpTokenExchange,
} from "./internal-mcp-auth";

type HonoEnv = { Bindings: Env };
const OAUTH_CLIENT_ID = "robynn-mcp-worker";
const BRAND_HUB_FALLBACK_PATH = "/brand-book/generate";
const CLAUDE_LAUNCH_REDIRECT_DELAY_MS = 1800;
const DEFAULT_OAUTH_SCOPES = ["brand:read", "tools:execute"] as const;
const DEFAULT_OAUTH_SCOPE_STRING = DEFAULT_OAUTH_SCOPES.join(" ");
const PROTECTED_RESOURCE_TRANSPORTS = ["mcp", "sse"] as const;

type ProtectedResourceTransport =
  (typeof PROTECTED_RESOURCE_TRANSPORTS)[number];

function getWorkerBaseUrl(c: { env: Env; req: { url: string } }) {
  const publicBaseUrl = c.env.MCP_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    return publicBaseUrl.replace(/\/+$/, "");
  }
  return new URL(c.req.url).origin;
}

function getBrandHubFallbackUrl(apiBaseUrl: string) {
  return new URL(BRAND_HUB_FALLBACK_PATH, apiBaseUrl).toString();
}

function getProtectedResourceAliases(workerBaseUrl: string) {
  const normalizedBaseUrl = workerBaseUrl.replace(/\/+$/, "");

  return [
    normalizedBaseUrl,
    ...PROTECTED_RESOURCE_TRANSPORTS.map(
      (transport) => `${normalizedBaseUrl}/${transport}`,
    ),
  ];
}

export function normalizeOAuthRequestResource(
  oauthRequest: import("./types").OAuthRequestInfo,
  workerBaseUrl: string,
): import("./types").OAuthRequestInfo {
  if (!oauthRequest.resource) {
    return oauthRequest;
  }

  const requestedResources = Array.isArray(oauthRequest.resource)
    ? oauthRequest.resource
    : [oauthRequest.resource];
  const mergedResources = Array.from(
    new Set([...requestedResources, ...getProtectedResourceAliases(workerBaseUrl)]),
  );

  return {
    ...oauthRequest,
    resource:
      mergedResources.length === 1 ? mergedResources[0] : mergedResources,
  };
}

export function getProtectedResourceMetadata(
  workerBaseUrl: string,
  transport?: ProtectedResourceTransport,
) {
  const normalizedBaseUrl = workerBaseUrl.replace(/\/+$/, "");

  return {
    resource: normalizedBaseUrl,
    authorization_servers: [normalizedBaseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: [...DEFAULT_OAUTH_SCOPES],
    resource_name: transport
      ? `Robynn ${transport.toUpperCase()} endpoint`
      : "Robynn MCP server",
  };
}

function shouldUseLaunchInterstitial(redirectTo: string) {
  return !/^https?:\/\//i.test(redirectTo);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderLaunchInterstitial(params: {
  launchUrl: string;
  fallbackUrl: string;
}) {
  const launchUrlJson = JSON.stringify(params.launchUrl);
  const fallbackUrlJson = JSON.stringify(params.fallbackUrl);
  const launchUrlHtml = escapeHtml(params.launchUrl);
  const fallbackUrlHtml = escapeHtml(params.fallbackUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening Claude</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f2ec;
        color: #111827;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(210, 96, 15, 0.08), transparent 40%),
          #f5f2ec;
      }
      main {
        width: min(100%, 520px);
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid rgba(17, 24, 39, 0.08);
        box-shadow: 0 28px 64px rgba(17, 24, 39, 0.12);
        padding: 32px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 2rem;
        line-height: 1.05;
      }
      p {
        margin: 0;
        color: #4b5563;
        line-height: 1.7;
      }
      .actions {
        margin-top: 24px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .primary,
      .secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        border-radius: 999px;
        padding: 0 18px;
        text-decoration: none;
        font-weight: 600;
      }
      .primary {
        background: #d2600f;
        color: #fff7ed;
      }
      .secondary {
        border: 1px solid rgba(17, 24, 39, 0.12);
        color: #111827;
        background: #fff;
      }
      .meta {
        margin-top: 18px;
        font-size: 0.92rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Claude is opening</h1>
      <p>
        If Claude does not take focus automatically, use the button below. This page will send you back to your Brand Hub in a moment.
      </p>
      <div class="actions">
        <a class="primary" href="${launchUrlHtml}">Open Claude</a>
        <a class="secondary" href="${fallbackUrlHtml}">Go to Brand Hub</a>
      </div>
      <p class="meta">You can close this tab any time after Claude opens.</p>
    </main>
    <script>
      const launchUrl = ${launchUrlJson};
      const fallbackUrl = ${fallbackUrlJson};
      window.setTimeout(() => {
        window.location.replace(fallbackUrl);
      }, ${CLAUDE_LAUNCH_REDIRECT_DELAY_MS});
      window.location.href = launchUrl;
    </script>
  </body>
</html>`;
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
  const oauthRequest = normalizeOAuthRequestResource(
    await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw),
    workerBaseUrl,
  );

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
  authorizeUrl.searchParams.set("scope", DEFAULT_OAUTH_SCOPE_STRING);
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
      : [...DEFAULT_OAUTH_SCOPES];

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
      _apiBaseUrl: c.env.ROBYNN_API_BASE_URL,
    },
  });

  if (shouldUseLaunchInterstitial(redirectTo)) {
    const fallbackUrl = getBrandHubFallbackUrl(c.env.ROBYNN_API_BASE_URL);
    return c.html(
      renderLaunchInterstitial({
        launchUrl: redirectTo,
        fallbackUrl,
      })
    );
  }

  return c.redirect(redirectTo);
});

/**
 * Health check / landing page
 */
app.get("/", (c) => {
  return c.json({
    name: "Robynn MCP Server",
    description: "Brand-aware AI marketing tools for Claude",
    version: getServerVersion(c.env.MCP_SERVER_VERSION),
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

  if (!PROTECTED_RESOURCE_TRANSPORTS.includes(transport as ProtectedResourceTransport)) {
    return c.text("Not Found", 404);
  }

  return c.json(
    getProtectedResourceMetadata(
      workerBaseUrl,
      transport as ProtectedResourceTransport,
    ),
  );
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
