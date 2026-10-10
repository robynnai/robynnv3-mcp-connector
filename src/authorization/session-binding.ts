/**
 * Immutable MCP session binding (COS-PLUGIN-001 P10; authorization contract
 * D7, §6.4 step 4; facts F15–F18).
 *
 * agents 0.7.5 addresses the session Durable Object by the client-supplied
 * `mcp-session-id` alone, forwards the current caller's props on every
 * request, and (via partyserver) adopts the latest caller's props after an
 * eviction. The binding below closes that gap:
 *
 * - The first props a session DO ever receives (the `initialize` caller)
 *   are written to the DO's own storage as the binding, once, and never
 *   overwritten. DO storage is strongly consistent; KV is not.
 * - The Worker reads the binding through a DO RPC before `RobynnMCP.serve`
 *   addresses the session, and answers a mismatch with `404 Session not
 *   found` (the host re-initializes).
 * - The DO refuses mismatching props on cold start and refuses the
 *   transport upgrade unless the Worker's binding header matches.
 */
import type { Props } from "../types";

/** DO storage key holding the binding. */
export const SESSION_BINDING_STORAGE_KEY = "robynn:session-binding";

/**
 * Header the Worker sets (after stripping every client `x-robynn-*`
 * header) on requests it forwards to a session, so the DO can check the
 * transport upgrade against its binding.
 */
export const SESSION_BINDING_HEADER = "x-robynn-session-binding";

/**
 * Header naming the tools the Worker preflight authorized for this HTTP
 * request (JSON `{ appGrantId, tools }`). Vault tools refuse to touch R2
 * without it (defense in depth behind the Worker preflight).
 */
export const PREFLIGHT_HEADER = "x-robynn-preflight";

/** Client-supplied headers that must never reach the session DO. */
const STRIPPED_HEADER_PREFIXES = ["x-robynn-", "x-partykit-", "cf-mcp-"];

const MAX_SESSION_ID_LENGTH = 256;

export interface SessionBinding {
  hostGrantId: string;
  userId: string;
  organizationId: string;
  appGrantId: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** The binding identity carried by a request's props, or null if incomplete. */
export function bindingFromProps(props: Partial<Props> | null | undefined): SessionBinding | null {
  if (!props) return null;
  const { hostGrantId, userId, organizationId, appGrantId } = props as Record<string, unknown>;
  if (!nonEmpty(hostGrantId) || !nonEmpty(userId) || !nonEmpty(organizationId) || !nonEmpty(appGrantId)) {
    return null;
  }
  return { hostGrantId, userId, organizationId, appGrantId };
}

export function sameBinding(a: SessionBinding | null | undefined, b: SessionBinding | null | undefined): boolean {
  return Boolean(
    a &&
      b &&
      a.hostGrantId === b.hostGrantId &&
      a.userId === b.userId &&
      a.organizationId === b.organizationId &&
      a.appGrantId === b.appGrantId,
  );
}

export function serializeBinding(binding: SessionBinding): string {
  return JSON.stringify({
    hostGrantId: binding.hostGrantId,
    userId: binding.userId,
    organizationId: binding.organizationId,
    appGrantId: binding.appGrantId,
  });
}

export function parseBindingHeader(value: string | null): SessionBinding | null {
  if (!value) return null;
  try {
    return bindingFromProps(JSON.parse(value) as Partial<Props>);
  } catch {
    return null;
  }
}

/** Session ids the Worker will look up; anything else is an unknown session. */
export function isPlausibleSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID_LENGTH && /^[\x21-\x7e]+$/.test(sessionId);
}

/** The DO name agents 0.7.5 uses for a streamable-HTTP session (F15). */
export function sessionObjectName(sessionId: string): string {
  return `streamable-http:${sessionId}`;
}

/** Copy of `headers` without any client-supplied internal header. */
export function stripInternalHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return;
    out.append(key, value);
  });
  return out;
}

/** Decode the unverified `exp` of the upstream JWT (ordering only, never trust). */
export function upstreamTokenExpiry(accessToken: unknown): number | null {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * Whether a warm session should adopt `incoming` props over `current`. Same
 * binding is required by the caller; this only orders upstream tokens so an
 * older host access token (still valid until expiry, F13) cannot roll the
 * session back to an older upstream token.
 */
export function shouldAdoptProps(current: Partial<Props> | undefined, incoming: Partial<Props>): boolean {
  if (!current?.accessToken) return true;
  if (incoming.accessToken === current.accessToken) return false;
  const incomingExp = upstreamTokenExpiry(incoming.accessToken);
  const currentExp = upstreamTokenExpiry(current.accessToken);
  if (incomingExp === null || currentExp === null) return true;
  return incomingExp >= currentExp;
}

/** The subset of `DurableObjectStorage` the session guard uses. */
export interface BindingStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export async function readSessionBinding(storage: BindingStorage): Promise<SessionBinding | null> {
  return bindingFromProps((await storage.get(SESSION_BINDING_STORAGE_KEY)) as Partial<Props> | undefined);
}

export type StartOutcome = "bound" | "matched" | "kept_newer" | "refused" | "no_props";

/** McpAgent's storage key for the session's props (agents 0.7.5, F18). */
export const SESSION_PROPS_STORAGE_KEY = "props";

/**
 * Cold start (`onStart(props)`, F17): decide which props the session may
 * adopt. The first complete props bind the session; later props are adopted
 * only for the same binding. Refused props are never written to storage, so
 * the session keeps (only) its bound user's state. For the same binding, the
 * stored props are kept when they hold a newer upstream token (review N4:
 * after an eviction an older, still-valid host token must not roll the
 * session back, exactly as on a warm session).
 */
export async function admitStartProps(
  storage: BindingStorage,
  props: Partial<Props> | undefined,
): Promise<{ adopt: Props | undefined; outcome: StartOutcome }> {
  if (!props) return { adopt: undefined, outcome: "no_props" };
  const incoming = bindingFromProps(props);
  const binding = await readSessionBinding(storage);
  if (!incoming) return { adopt: undefined, outcome: "refused" };
  if (!binding) {
    await storage.put(SESSION_BINDING_STORAGE_KEY, JSON.parse(serializeBinding(incoming)));
    return { adopt: props as Props, outcome: "bound" };
  }
  if (!sameBinding(binding, incoming)) return { adopt: undefined, outcome: "refused" };
  const stored = (await storage.get(SESSION_PROPS_STORAGE_KEY)) as Partial<Props> | undefined;
  if (stored?.accessToken && !shouldAdoptProps(stored, props)) {
    return { adopt: undefined, outcome: "kept_newer" };
  }
  return { adopt: props as Props, outcome: "matched" };
}

/** Transport upgrade: only the Worker, for the bound identity, may open one. */
export async function admitUpgrade(storage: BindingStorage, headerValue: string | null): Promise<boolean> {
  const presented = parseBindingHeader(headerValue);
  return sameBinding(await readSessionBinding(storage), presented);
}
