/**
 * MCP request preflight (COS-PLUGIN-001 P10; authorization contract §6.4,
 * §8.2, §8.3; plan §6 "Before a Worker tool executes").
 *
 * Runs as the provider's API handler, i.e. after the provider has validated
 * the host bearer (F3), and before anything reaches the session Durable
 * Object:
 *
 * 1. Only `/mcp` (the fetch wrapper already 404s other API-prefix paths).
 * 2. `unwrapToken(bearer)` gives the host grant id and host-token scopes (F4).
 * 3. Legacy grants (`props.authVersion !== 2`) are revoked: `401 invalid_token`.
 * 4. Client `x-robynn-*`, `x-partykit-*` and `cf-mcp-*` headers are dropped.
 *    A request naming an `mcp-session-id` must match the binding stored in
 *    that session DO's own storage, else `404 Session not found`.
 * 5. Every `tools/call` is re-authorized: app introspection (current grant,
 *    membership, role, credential version), then
 *    `hostScopes ∩ grantScopes ∩ props.scopes ∩ introspection.scopes` must
 *    contain the tool's required scope from TOOL_POLICY. Introspection
 *    inactive ⇒ the provider grant is revoked and the host gets `401`;
 *    unavailable ⇒ a tool error, nothing is forwarded. No positive cache.
 *
 * Only then is the request forwarded to `RobynnMCP.serve("/mcp")`, with the
 * host grant id added to the props and the binding/preflight headers set.
 */
import { getInternalAuthSecret } from "../internal-mcp-auth";
import { safeLog } from "../safe-log";
import type { Env, HostTokenSummary, Props } from "../types";
import { canonicalScopes, isOAuthScope, MCP_API_PATH, type OAuthScope } from "./oauth-policy";
import {
  isPlausibleSessionId,
  PREFLIGHT_HEADER,
  sameBinding,
  serializeBinding,
  SESSION_BINDING_HEADER,
  sessionObjectName,
  stripInternalHeaders,
  type SessionBinding,
} from "./session-binding";
import { decideToolCall, type ToolDenialCode } from "./tool-policy";
import { encodePreflightStamp } from "./preflight-stamp";
import { introspectUpstreamGrant, isUuid, type IntrospectionOutcome } from "./upstream-grant";

/** Same ceiling as agents 0.7.5's streamable-HTTP handler. */
const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024;

export interface ApiHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
}

export interface PreflightOptions {
  /** Injected in tests; defaults to the signed app introspection client. */
  introspect?: typeof introspectUpstreamGrant;
}

interface SessionObjectStub {
  getSessionBinding(): Promise<SessionBinding | null>;
}

type ToolErrorCode = ToolDenialCode | "authorization_unavailable";

const TOOL_ERROR_MESSAGES: Record<ToolErrorCode, string> = {
  insufficient_scope:
    "This connection is read-only. Reconnect Robynn and allow execution to use this tool.",
  tool_not_permitted: "This tool is not available on this Robynn connection.",
  unsupported_memory_scope:
    'Session-scoped memory is not supported on Robynn plugin connections. Use scope "user" or "org".',
  authorization_unavailable:
    "Robynn could not confirm this connection's permissions right now. Nothing was executed. Try again shortly.",
};

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function invalidToken(request: Request, description: string): Response {
  const resourceMetadataUrl = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return jsonResponse({ error: "invalid_token", error_description: description }, 401, {
    "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", error: { code, message }, id: null }, status);
}

function sessionNotFound(): Response {
  return jsonRpcError(404, -32001, "Session not found");
}

function toolErrorResult(code: ToolErrorCode, requiredScope?: OAuthScope) {
  let message = TOOL_ERROR_MESSAGES[code];
  if (code === "insufficient_scope" && requiredScope && requiredScope !== "tools:execute") {
    message = `This connection does not include the ${requiredScope} permission. Reconnect Robynn to use this tool.`;
  }
  const error = {
    code,
    message,
    retryable: code === "authorization_unavailable",
    ...(requiredScope ? { required_scope: requiredScope } : {}),
  };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error },
    isError: true,
  };
}

function scopeList(value: unknown): OAuthScope[] {
  if (!Array.isArray(value)) return [];
  return canonicalScopes(value.filter((s): s is OAuthScope => typeof s === "string" && isOAuthScope(s)));
}

function intersect(...sets: OAuthScope[][]): OAuthScope[] {
  const [first, ...rest] = sets;
  return canonicalScopes(first.filter((scope) => rest.every((set) => set.includes(scope))));
}

interface JsonRpcLike {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown } | unknown;
}

function isRequestWithId(message: JsonRpcLike): boolean {
  return typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number");
}

function isToolCall(message: unknown): message is JsonRpcLike {
  return Boolean(message && typeof message === "object" && (message as JsonRpcLike).method === "tools/call");
}

function toolCallParams(message: JsonRpcLike): { name: unknown; args: unknown } {
  const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
  return { name: params.name, args: params.arguments };
}

/**
 * Answer a request whose tool calls were (partly) denied, without forwarding
 * any of it: denied calls get an MCP tool error result, other requests in the
 * same batch a JSON-RPC error, notifications nothing.
 */
function deniedResponse(
  messages: JsonRpcLike[],
  isBatch: boolean,
  denials: Map<JsonRpcLike, { code: ToolErrorCode; requiredScope?: OAuthScope }>,
): Response {
  const replies: unknown[] = [];
  for (const message of messages) {
    if (!isRequestWithId(message)) continue;
    const denial = denials.get(message);
    if (denial) {
      replies.push({ jsonrpc: "2.0", id: message.id, result: toolErrorResult(denial.code, denial.requiredScope) });
    } else {
      replies.push({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Not processed: another request in this batch was refused." },
      });
    }
  }
  if (replies.length === 0) return new Response(null, { status: 202 });
  return jsonResponse(isBatch ? replies : replies[0], 200);
}

async function revokeHostGrant(env: Env, summary: HostTokenSummary, reason: string) {
  try {
    await env.OAUTH_PROVIDER.revokeGrant(summary.grantId, summary.userId);
    safeLog.warn("mcp.preflight.grant_revoked", { reason });
  } catch (err) {
    // The host still gets 401; the next request re-checks.
    safeLog.error("mcp.preflight.revoke_failed", { reason, errorKind: err instanceof Error ? err.name : "unknown" });
  }
}

function hasCompleteProps(props: Partial<Props> | undefined, summary: HostTokenSummary): props is Props {
  return Boolean(
    props &&
      props.authVersion === 2 &&
      typeof props.accessToken === "string" &&
      props.accessToken.length > 0 &&
      isUuid(props.userId) &&
      isUuid(props.organizationId) &&
      isUuid(props.appGrantId) &&
      Number.isSafeInteger(props.credentialVersion) &&
      (props.credentialVersion as number) > 0 &&
      props.userId === summary.userId,
  );
}

/** Wrap `RobynnMCP.serve("/mcp")` with the P10 preflight. */
export function withMcpPreflight(next: ApiHandler, options: PreflightOptions = {}): ApiHandler {
  const introspect = options.introspect ?? introspectUpstreamGrant;

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      if (new URL(request.url).pathname !== MCP_API_PATH) {
        return jsonResponse({ error: "not_found" }, 404);
      }

      // Step 2: the provider validated the bearer; learn its grant and scopes.
      const auth = request.headers.get("Authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const summary = bearer ? await env.OAUTH_PROVIDER.unwrapToken(bearer) : null;
      if (!summary) return invalidToken(request, "Invalid access token");

      // Step 3: legacy or incomplete grants never reach a session.
      const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
      if (!hasCompleteProps(props, summary)) {
        await revokeHostGrant(env, summary, "legacy_grant");
        return invalidToken(request, "This connection must be re-established");
      }

      const identity: SessionBinding = {
        hostGrantId: summary.grantId,
        userId: props.userId,
        organizationId: props.organizationId,
        appGrantId: props.appGrantId as string,
      };

      // Step 4: drop client-supplied internal headers; check the session binding.
      const headers = stripInternalHeaders(request.headers);
      headers.set(SESSION_BINDING_HEADER, serializeBinding(identity));

      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId !== null) {
        if (!isPlausibleSessionId(sessionId)) return sessionNotFound();
        let binding: SessionBinding | null;
        try {
          const id = env.MCP_OBJECT.idFromName(sessionObjectName(sessionId));
          const stub = env.MCP_OBJECT.get(id) as unknown as SessionObjectStub;
          binding = await stub.getSessionBinding();
        } catch (err) {
          safeLog.error("mcp.preflight.binding_unavailable", { errorKind: err instanceof Error ? err.name : "unknown" });
          return jsonRpcError(503, -32000, "Session temporarily unavailable");
        }
        if (!sameBinding(binding, identity)) {
          safeLog.warn("mcp.preflight.session_mismatch", { bound: Boolean(binding) });
          return sessionNotFound();
        }
      }

      let body: string | undefined;
      if (request.method === "POST") {
        if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > MAXIMUM_MESSAGE_SIZE_BYTES) {
          return jsonRpcError(413, -32000, "Request body too large");
        }
        body = await request.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
        }
        const isBatch = Array.isArray(parsed);
        const messages = (isBatch ? parsed : [parsed]) as JsonRpcLike[];
        const toolCalls = messages.filter(isToolCall);

        if (toolCalls.length > 0) {
          // Step 5: current authorization for every tools/call, no cache.
          const first = toolCallParams(toolCalls[0]);
          const firstDecision = decideToolCall(first.name, first.args, ["brand:read", "tools:execute"]);
          const secret = getInternalAuthSecret(env);
          const outcome: IntrospectionOutcome = secret
            ? await introspect({
                apiBaseUrl: env.ROBYNN_API_BASE_URL,
                secret,
                candidate: {
                  grantId: identity.appGrantId,
                  userId: identity.userId,
                  organizationId: identity.organizationId,
                  credentialVersion: props.credentialVersion as number,
                  scopes: scopeList(props.scopes),
                },
                hostGrantId: summary.grantId,
                ...(typeof first.name === "string" && firstDecision.allowed
                  ? { operation: { tool: first.name, requiredScope: firstDecision.requiredScope } }
                  : {}),
              })
            : { status: "unavailable", reason: "secret_unset" };

          if (outcome.status === "inactive") {
            // A bumped credential version is renewed by the host's refresh;
            // every other inactive reason ends the provider grant.
            if (outcome.reason !== "credential_version_stale") {
              await revokeHostGrant(env, summary, outcome.reason);
            }
            safeLog.warn("mcp.preflight.denied", { denial: "invalid_token", reason: outcome.reason });
            return invalidToken(request, "This connection is no longer active");
          }

          const denials = new Map<JsonRpcLike, { code: ToolErrorCode; requiredScope?: OAuthScope }>();
          let verified: { scopes: OAuthScope[]; organizationName: string | null } | null = null;
          if (outcome.status === "unavailable") {
            for (const call of toolCalls) denials.set(call, { code: "authorization_unavailable" });
            safeLog.warn("mcp.preflight.denied", { denial: "authorization_unavailable", reason: outcome.reason });
          } else {
            const effective = intersect(
              scopeList(summary.scope),
              scopeList(summary.grant.scope),
              scopeList(props.scopes),
              outcome.grant.scopes,
            );
            verified = { scopes: effective, organizationName: outcome.grant.organizationName };
            for (const call of toolCalls) {
              const { name, args } = toolCallParams(call);
              const decision = decideToolCall(name, args, effective);
              if (!decision.allowed) {
                denials.set(call, { code: decision.code, requiredScope: decision.requiredScope });
                safeLog.warn("mcp.preflight.denied", {
                  denial: decision.code,
                  tool: typeof name === "string" ? name.slice(0, 64) : "invalid",
                });
              }
            }
          }

          if (denials.size > 0) return deniedResponse(messages, isBatch, denials);

          headers.set(
            PREFLIGHT_HEADER,
            encodePreflightStamp({
              appGrantId: identity.appGrantId,
              tools: toolCalls.map((call) => toolCallParams(call).name).filter((n): n is string => typeof n === "string"),
              // What introspection verified for this call (robynn_status reports it; P17).
              organization: { id: identity.organizationId, name: verified?.organizationName ?? null },
              ...(verified ? { scopes: verified.scopes } : {}),
            }),
          );
        }
      }

      // Forward: same URL and method, sanitized headers, the body read above.
      const forwarded = new Request(request.url, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const boundProps: Props = { ...props, hostGrantId: summary.grantId };
      const forwardedCtx = {
        waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
        passThroughOnException: () => ctx.passThroughOnException(),
        props: boundProps,
      } as unknown as ExecutionContext;
      return next.fetch(forwarded, env, forwardedCtx);
    },
  };
}
