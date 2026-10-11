import { Hono, type Context } from "hono";
import type { Env, OAuthRequestInfo, Props } from "./types";
import { REPORT_APP_SCRIPT } from "./ui/report-app-script";
import { getServerVersion } from "./version";
import {
  buildSignedTokenRequest,
  getInternalAuthSecret,
  TRUSTED_MCP_CLIENT_ID,
} from "./internal-mcp-auth";
import {
  ADVERTISE_SSE,
  canonicalScopes,
  isScopeSubset,
  normalizeClientName,
  SUPPORTED_OAUTH_SCOPES,
  validateAuthorizeRequest,
} from "./authorization/oauth-policy";
import {
  clearStateCookie,
  consumeAuthorizationTransaction,
  createAuthorizationTransaction,
} from "./authorization/state";
import {
  introspectUpstreamGrant,
  parseUpstreamTokenResponse,
  readUpstreamGrantCandidate,
} from "./authorization/upstream-grant";
import { AUTHORIZE_REDIRECT_PROP } from "./authorization/token-binding";
import {
  CONSENT_DESTINATION_PARAM,
  CONSENT_SIGNATURE_PARAM,
  redirectOrigin,
  signConsentDestination,
} from "./authorization/consent-destination";
import { errorKind, safeLog } from "./safe-log";

type HonoEnv = { Bindings: Env };
type AppContext = Context<HonoEnv>;

const BRAND_HUB_FALLBACK_PATH = "/brand-book/generate";
const LAUNCH_REDIRECT_DELAY_MS = 1800;
const MAX_APP_CODE_LENGTH = 2048;
const MAX_LAUNCH_URL_LENGTH = 4096;

type ProtectedResourceTransport = "mcp" | "sse";

/**
 * OAuth error codes the Worker returns to hosts or renders (contract §8.1).
 * Pages and redirects carry only these fixed codes — never request input or
 * upstream text.
 */
export type FrontDoorErrorCode =
  | "invalid_request"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "temporarily_unavailable"
  | "server_error";

const ERROR_PAGE_COPY: Record<FrontDoorErrorCode, { title: string; message: string }> = {
  invalid_request: {
    title: "This connection link is not valid",
    message:
      "The connection request is invalid, has expired, or was opened in a different browser. Start the connection again from your app.",
  },
  unsupported_response_type: {
    title: "This connection link is not valid",
    message: "Your app sent a connection request that Robynn does not support.",
  },
  invalid_scope: {
    title: "Permissions did not match",
    message:
      "The requested permissions are not supported, or the approved permissions did not match the request. Start the connection again from your app.",
  },
  invalid_target: {
    title: "This connection link is not valid",
    message: "Your app asked to connect to a Robynn address that is not supported.",
  },
  access_denied: {
    title: "Connection not approved",
    message: "Robynn was not connected. You can close this tab.",
  },
  temporarily_unavailable: {
    title: "Robynn is temporarily unavailable",
    message: "Robynn could not finish connecting right now. Try again in a few minutes.",
  },
  server_error: {
    title: "Robynn could not connect",
    message: "Something went wrong while connecting Robynn. Start the connection again from your app.",
  },
};

const ERROR_DESCRIPTIONS: Partial<Record<FrontDoorErrorCode, string>> = {
  unsupported_response_type: "Only the authorization code flow is supported",
  invalid_scope: "Requested or granted scope is not permitted",
  invalid_target: "The resource parameter is not an approved Robynn MCP resource",
};

const APP_ERROR_PASSTHROUGH = new Set<FrontDoorErrorCode>([
  "access_denied",
  "invalid_scope",
  "invalid_request",
  "temporarily_unavailable",
  "server_error",
]);

// Schemes that must never be navigated to from the launch page. http(s)
// redirects are plain 302s and never use the interstitial.
const BLOCKED_LAUNCH_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "mailto:",
  "filesystem:",
  "http:",
  "https:",
]);

function getWorkerBaseUrl(c: { env: Env; req: { url: string } }) {
  const publicBaseUrl = c.env.MCP_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    return publicBaseUrl.replace(/\/+$/, "");
  }
  return new URL(c.req.url).origin;
}

function isSecureBaseUrl(workerBaseUrl: string) {
  return workerBaseUrl.startsWith("https://");
}

function getBrandHubFallbackUrl(apiBaseUrl: string) {
  return new URL(BRAND_HUB_FALLBACK_PATH, apiBaseUrl).toString();
}

/** Transports advertised in discovery documents (D-C: `/sse` only if flagged). */
export function getAdvertisedTransports(
  advertiseSse = ADVERTISE_SSE,
): ProtectedResourceTransport[] {
  return advertiseSse ? ["mcp", "sse"] : ["mcp"];
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
    scopes_supported: [...SUPPORTED_OAUTH_SCOPES],
    resource_name: transport
      ? `Robynn ${transport.toUpperCase()} endpoint`
      : "Robynn MCP server",
  };
}

/** Landing JSON (health). `endpoints.sse` appears only when ADVERTISE_SSE. */
export function getLandingDocument(version: string, advertiseSse = ADVERTISE_SSE) {
  return {
    name: "Robynn MCP Server",
    description: "Brand-aware marketing tools from your Robynn workspace",
    version,
    endpoints: {
      mcp: "/mcp",
      ...(advertiseSse ? { sse: "/sse" } : {}),
      authorize: "/authorize",
      health: "/",
    },
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON that is safe inside an inline `<script>`: `<`, `>` and `&` cannot open
 * or close a tag or comment, and U+2028/U+2029 cannot end a string literal in
 * older engines.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * RFC 3986 URI characters only (unreserved, reserved and `%`). `URL#toString`
 * percent-encodes everything else, so raw quotes, angle brackets, backticks,
 * whitespace, controls and non-ASCII mean the value did not come from the
 * provider and is refused.
 */
function isUriCharset(value: string) {
  return /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(value);
}

/**
 * A launch URL is a registered native-app redirect (custom scheme) carrying
 * the authorization result. Pseudo-schemes, http(s) and anything with
 * whitespace, control or non-ASCII characters are refused.
 */
export function isSafeLaunchUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LAUNCH_URL_LENGTH) return false;
  if (!isUriCharset(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return !BLOCKED_LAUNCH_SCHEMES.has(protocol);
  } catch {
    return false;
  }
}

/** The fallback must be an http(s) URL (the app's Brand Hub). */
export function isSafeFallbackUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LAUNCH_URL_LENGTH) return false;
  if (!isUriCharset(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function generateCspNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PAGE_STYLE = `
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
      }`;

function pageContentSecurityPolicy(nonce: string, allowScript: boolean) {
  return [
    "default-src 'none'",
    allowScript ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Host-neutral page that opens a native app's custom-scheme redirect and then
 * falls back to the Brand Hub. Returns null when either URL fails validation;
 * callers must not render anything in that case.
 */
export function renderLaunchInterstitial(params: {
  launchUrl: string;
  fallbackUrl: string;
  nonce?: string;
}): string | null {
  if (!isSafeLaunchUrl(params.launchUrl) || !isSafeFallbackUrl(params.fallbackUrl)) {
    return null;
  }
  const nonce = escapeHtml(params.nonce ?? "");
  const nonceAttr = params.nonce ? ` nonce="${nonce}"` : "";
  const launchUrlJson = serializeForInlineScript(params.launchUrl);
  const fallbackUrlJson = serializeForInlineScript(params.fallbackUrl);
  const launchUrlHtml = escapeHtml(params.launchUrl);
  const fallbackUrlHtml = escapeHtml(params.fallbackUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Returning to your app</title>
    <style${nonceAttr}>${PAGE_STYLE}
    </style>
  </head>
  <body>
    <main>
      <h1>Returning to your app</h1>
      <p>
        Robynn is connected. If your app does not open automatically, use the button below. This page will then take you to your Brand Hub.
      </p>
      <div class="actions">
        <a class="primary" href="${launchUrlHtml}">Open your app</a>
        <a class="secondary" href="${fallbackUrlHtml}">Go to Brand Hub</a>
      </div>
      <p class="meta">You can close this tab after your app opens.</p>
    </main>
    <script${nonceAttr}>
      const launchUrl = ${launchUrlJson};
      const fallbackUrl = ${fallbackUrlJson};
      window.setTimeout(() => {
        window.location.replace(fallbackUrl);
      }, ${LAUNCH_REDIRECT_DELAY_MS});
      window.location.href = launchUrl;
    </script>
  </body>
</html>`;
}

/** Static, host-neutral error page. Only the fixed copy for `code` is shown. */
export function renderAuthErrorPage(code: FrontDoorErrorCode, nonce = ""): string {
  const copy = ERROR_PAGE_COPY[code] ?? ERROR_PAGE_COPY.server_error;
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(copy.title)}</title>
    <style${nonceAttr}>${PAGE_STYLE}
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(copy.title)}</h1>
      <p>${escapeHtml(copy.message)}</p>
      <p class="meta">Error code: ${escapeHtml(code)}</p>
    </main>
  </body>
</html>`;
}

function setNoStoreHeaders(c: AppContext) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
}

function errorPage(c: AppContext, status: 400 | 403 | 500 | 503, code: FrontDoorErrorCode) {
  const nonce = generateCspNonce();
  c.header("Content-Security-Policy", pageContentSecurityPolicy(nonce, false));
  return c.html(renderAuthErrorPage(code, nonce), status);
}

/**
 * Send the browser back to the host's validated redirect URI: a 302 for
 * http(s) (loopback hosts), the launch page for native custom schemes.
 */
function returnToHost(c: AppContext, redirectTo: string) {
  if (/^https?:\/\//i.test(redirectTo)) {
    return c.redirect(redirectTo, 302);
  }
  const nonce = generateCspNonce();
  const html = renderLaunchInterstitial({
    launchUrl: redirectTo,
    fallbackUrl: getBrandHubFallbackUrl(c.env.ROBYNN_API_BASE_URL),
    nonce,
  });
  if (!html) {
    safeLog.error("oauth.launch.refused", { reason: "launch_url_unsafe" });
    return errorPage(c, 400, "invalid_request");
  }
  c.header("Content-Security-Policy", pageContentSecurityPolicy(nonce, true));
  return c.html(html);
}

/** A host redirect the browser can actually be sent to (http(s) or a safe native scheme). */
export function isUsableHostRedirect(redirectUri: string): boolean {
  return /^https?:\/\//i.test(redirectUri) || isSafeLaunchUrl(redirectUri);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Whether OAuth *errors* may be redirected to this URI. With open DCR any
 * https URI can be registered, so error redirects to the open web would turn
 * the Worker into an open redirector (RFC 9700 §4.11.2; P06 review N3).
 * Errors therefore go only to loopback http(s) redirects (Claude Code, Codex)
 * and native custom schemes; any other host sees the static error page.
 */
export function mayRedirectErrorsTo(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return isLoopbackHost(url.hostname);
  return isSafeLaunchUrl(redirectUri);
}

/** RFC 6749 §4.1.2.1 error response to the host's (validated) redirect URI. */
function redirectHostError(c: AppContext, request: OAuthRequestInfo, error: FrontDoorErrorCode) {
  if (!mayRedirectErrorsTo(request.redirectUri)) {
    return errorPage(c, error === "temporarily_unavailable" ? 503 : 400, error);
  }
  let url: URL;
  try {
    url = new URL(request.redirectUri);
  } catch {
    return errorPage(c, 400, "invalid_request");
  }
  url.searchParams.set("error", error);
  const description = ERROR_DESCRIPTIONS[error];
  if (description) url.searchParams.set("error_description", description);
  if (request.state) url.searchParams.set("state", request.state);
  return returnToHost(c, url.toString());
}

function mapAppError(value: string): FrontDoorErrorCode {
  return APP_ERROR_PASSTHROUGH.has(value as FrontDoorErrorCode)
    ? (value as FrontDoorErrorCode)
    : "server_error";
}

/**
 * OAuth authorization handler.
 *
 * This Hono app handles the user-facing OAuth consent flow:
 * 1. /authorize — validate the host request, redirect to the Robynn consent page
 * 2. /callback  — validate the app grant, complete the host authorization
 * 3. /          — health check / landing page
 *
 * The OAuthProvider intercepts /token and /register automatically.
 */
const app = new Hono<HonoEnv>();

/**
 * Authorization endpoint (contract §6.1). Requires the authorization-code
 * flow with an S256 PKCE challenge, approved scopes and resources; forwards
 * exactly the requested scope to the app and binds the transaction to this
 * browser.
 */
app.get("/authorize", async (c) => {
  setNoStoreHeaders(c);
  const workerBaseUrl = getWorkerBaseUrl(c);

  let oauthRequest: OAuthRequestInfo;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    // Unknown client, unregistered redirect URI, malformed resource, plain
    // PKCE: never redirect to an unvalidated URI.
    safeLog.warn("oauth.authorize.rejected", { reason: "parse_failed", errorKind: errorKind(err) });
    return errorPage(c, 400, "invalid_request");
  }

  // parseAuthRequest skips the client/redirect checks when client_id is empty.
  if (!oauthRequest.clientId || !oauthRequest.redirectUri) {
    safeLog.warn("oauth.authorize.rejected", { reason: "client_or_redirect_missing" });
    return errorPage(c, 400, "invalid_request");
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    safeLog.warn("oauth.authorize.rejected", { reason: "client_unknown" });
    return errorPage(c, 400, "invalid_request");
  }
  // A redirect the browser cannot be safely sent to (e.g. `about:`,
  // `filesystem:`, non-ASCII, over-long) is refused here, before any app
  // grant is minted or `completeAuthorization` revokes existing grants
  // (P06 review N1).
  if (!isUsableHostRedirect(oauthRequest.redirectUri)) {
    safeLog.warn("oauth.authorize.rejected", { reason: "host_redirect_unsafe" });
    return errorPage(c, 400, "invalid_request");
  }

  const validation = validateAuthorizeRequest(oauthRequest, workerBaseUrl);
  if (!validation.ok) {
    safeLog.warn("oauth.authorize.rejected", { reason: validation.rejection.reason });
    return redirectHostError(c, oauthRequest, validation.rejection.error);
  }

  const clientName = normalizeClientName(client.clientName);
  const workerCallbackUrl = new URL("/callback", workerBaseUrl).href;
  const secureCookie = isSecureBaseUrl(workerBaseUrl);
  const { state, setCookie } = await createAuthorizationTransaction(
    c.env.OAUTH_KEY,
    {
      oauthRequest,
      requestedScopes: validation.scopes,
      clientName,
      workerCallbackUrl,
    },
    { secureCookie },
  );
  c.header("Set-Cookie", setCookie, { append: true });

  const authorizeUrl = new URL("/oauth/authorize", c.env.ROBYNN_API_BASE_URL);
  authorizeUrl.searchParams.set("client_id", TRUSTED_MCP_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", workerCallbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", validation.scopes.join(" "));
  authorizeUrl.searchParams.set("response_type", "code");
  if (clientName) authorizeUrl.searchParams.set("client_name", clientName);
  // Tell the consent page where the browser goes after approval (P19 RC
  // review R3: open DCR lets any https client call itself "Claude Code").
  // Signed and bound to this state; without the secret the app shows the
  // destination as unconfirmed, and the callback fails as before.
  const origin = redirectOrigin(oauthRequest.redirectUri);
  const internalAuthSecret = getInternalAuthSecret(c.env);
  if (origin && internalAuthSecret) {
    authorizeUrl.searchParams.set(CONSENT_DESTINATION_PARAM, origin);
    authorizeUrl.searchParams.set(
      CONSENT_SIGNATURE_PARAM,
      await signConsentDestination(internalAuthSecret, { state, origin }),
    );
  } else {
    safeLog.warn("oauth.authorize.destination_unsigned", {
      reason: origin ? "internal_auth_secret_missing" : "origin_unavailable",
    });
  }

  safeLog.info("oauth.authorize.forwarded", {
    scopeCount: validation.scopes.length,
    executeRequested: validation.scopes.includes("tools:execute"),
    hasResource: oauthRequest.resource !== undefined,
  });
  return c.redirect(authorizeUrl.toString(), 302);
});

/**
 * OAuth callback (contract §6.2) — the app redirects here after consent.
 * Fails closed: no `completeAuthorization` unless the state belongs to this
 * browser, the signed code exchange succeeds, the app confirms the grant via
 * introspection and the granted scopes are a subset of the host's request.
 */
app.get("/callback", async (c) => {
  setNoStoreHeaders(c);
  const workerBaseUrl = getWorkerBaseUrl(c);
  const secureCookie = isSecureBaseUrl(workerBaseUrl);
  const state = c.req.query("state");

  const consumed = await consumeAuthorizationTransaction(
    c.env.OAUTH_KEY,
    state,
    c.req.header("cookie"),
    { secureCookie },
  );
  if (!consumed.ok) {
    safeLog.warn("oauth.callback.rejected", { reason: consumed.reason });
    return errorPage(c, 400, "invalid_request");
  }
  c.header("Set-Cookie", clearStateCookie(state as string, secureCookie), { append: true });

  const transaction = consumed.transaction;
  const hostRequest = transaction.oauthRequest;
  const reject = (
    error: FrontDoorErrorCode,
    reason: string,
    extra: Record<string, number | boolean> = {},
  ) => {
    safeLog.warn("oauth.callback.rejected", { reason, error, ...extra });
    return redirectHostError(c, hostRequest, error);
  };

  const appError = c.req.query("error");
  if (appError !== undefined) {
    return reject(mapAppError(appError), "app_returned_error");
  }
  const code = c.req.query("code");
  if (!code || code.length > MAX_APP_CODE_LENGTH) {
    return reject("server_error", "app_code_missing");
  }

  // The client shown on the consent page must still be the one that started
  // this transaction (P04 residual: bind displayed identity to Worker state).
  const client = await c.env.OAUTH_PROVIDER.lookupClient(hostRequest.clientId);
  if (!client || normalizeClientName(client.clientName) !== transaction.clientName) {
    return reject("access_denied", "client_changed");
  }

  // Worker -> app token exchange is always signed with the dedicated
  // MCP_INTERNAL_AUTH_SECRET (no fallback); the app rejects unsigned requests.
  const internalAuthSecret = getInternalAuthSecret(c.env);
  if (!internalAuthSecret) {
    safeLog.error("oauth.callback.misconfigured", { reason: "internal_auth_secret_missing" });
    return reject("temporarily_unavailable", "internal_auth_secret_missing");
  }

  let tokenResponse: Response;
  try {
    const tokenRequest = await buildSignedTokenRequest(
      internalAuthSecret,
      c.env.ROBYNN_API_BASE_URL,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: transaction.workerCallbackUrl,
      },
    );
    tokenResponse = await fetch(tokenRequest.url, tokenRequest.init);
  } catch {
    return reject("temporarily_unavailable", "upstream_exchange_network");
  }

  if (!tokenResponse.ok) {
    // The body is never read or logged: it may echo the code.
    await tokenResponse.body?.cancel().catch(() => undefined);
    return reject(
      tokenResponse.status >= 500 || tokenResponse.status === 429
        ? "temporarily_unavailable"
        : "server_error",
      "upstream_exchange_rejected",
      { upstreamStatus: tokenResponse.status },
    );
  }

  let tokenBody: unknown;
  try {
    tokenBody = await tokenResponse.json();
  } catch {
    tokenBody = null;
  }
  const tokens = parseUpstreamTokenResponse(tokenBody);
  if (!tokens) return reject("server_error", "upstream_token_response_invalid");

  const candidate = readUpstreamGrantCandidate(tokens.accessToken);
  if (!candidate.ok) return reject("server_error", candidate.reason);

  const introspection = await introspectUpstreamGrant({
    apiBaseUrl: c.env.ROBYNN_API_BASE_URL,
    secret: internalAuthSecret,
    candidate: candidate.candidate,
  });
  if (introspection.status === "unavailable") {
    return reject("temporarily_unavailable", introspection.reason);
  }
  if (introspection.status === "inactive") {
    return reject("access_denied", `introspection_${introspection.reason}`);
  }

  const grant = introspection.grant;
  const requested = transaction.requestedScopes;
  if (
    !isScopeSubset(grant.scopes, requested) ||
    !isScopeSubset(candidate.candidate.scopes, requested)
  ) {
    // Consent can be tampered with in the browser (P04 residual); never
    // complete with more than the host asked for.
    return reject("invalid_scope", "granted_scope_exceeds_request");
  }
  const grantedScopes = canonicalScopes(
    grant.scopes.filter((scope) => candidate.candidate.scopes.includes(scope)),
  );
  if (grantedScopes.length === 0) {
    return reject("invalid_scope", "granted_scope_empty");
  }

  // Defense in depth: /authorize already refused unusable redirects.
  if (!isUsableHostRedirect(hostRequest.redirectUri)) {
    safeLog.error("oauth.callback.rejected", { reason: "host_redirect_unsafe" });
    return errorPage(c, 400, "invalid_request");
  }

  const props: Props = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userId: grant.userId,
    organizationId: grant.organizationId,
    appGrantId: grant.grantId,
    credentialVersion: grant.credentialVersion,
    scopes: grantedScopes,
    authVersion: 2,
    [AUTHORIZE_REDIRECT_PROP]: hostRequest.redirectUri,
    _apiBaseUrl: c.env.ROBYNN_API_BASE_URL,
  };

  let redirectTo: string;
  try {
    ({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: hostRequest,
      userId: grant.userId,
      metadata: {
        organizationId: grant.organizationId,
        appGrantId: grant.grantId,
        hostClientName: transaction.clientName,
        upstreamClientId: TRUSTED_MCP_CLIENT_ID,
        authVersion: 2,
      },
      scope: grantedScopes,
      props,
      revokeExistingGrants: true,
    }));
  } catch (err) {
    safeLog.error("oauth.callback.rejected", {
      reason: "complete_authorization_failed",
      errorKind: errorKind(err),
    });
    return errorPage(c, 500, "server_error");
  }

  safeLog.info("oauth.callback.completed", {
    scopeCount: grantedScopes.length,
    executeGranted: grantedScopes.includes("tools:execute"),
  });
  return returnToHost(c, redirectTo);
});

/**
 * Health check / landing page
 */
app.get("/", (c) => {
  return c.json(getLandingDocument(getServerVersion(c.env.MCP_SERVER_VERSION)));
});

app.get("/app-assets/report-app.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(REPORT_APP_SCRIPT);
});

app.get("/.well-known/oauth-protected-resource/:transport", (c) => {
  const workerBaseUrl = getWorkerBaseUrl(c);
  const transport = c.req.param("transport");

  if (!getAdvertisedTransports().includes(transport as ProtectedResourceTransport)) {
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
    description: "Brand-aware marketing tools from your Robynn workspace",
    mcp_endpoint: `${workerBaseUrl}/mcp`,
    oauth: {
      authorization_endpoint: `${workerBaseUrl}/authorize`,
      token_endpoint: `${workerBaseUrl}/token`,
      registration_endpoint: `${workerBaseUrl}/register`,
    },
  });
});

export { app as robynnAuthHandler };
