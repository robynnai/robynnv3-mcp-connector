/**
 * The Worker preflight's per-request stamp (COS-PLUGIN-001 P10, extended in
 * P17). After app introspection authorizes a `tools/call`, the preflight sets
 * `x-robynn-preflight` on the request it forwards to the session DO. Clients
 * cannot set `x-robynn-*` headers (the preflight strips them), so tools can
 * trust it:
 *
 * - `appGrantId`, `tools`: the Vault gate refuses R2 access without them.
 * - `organization`, `scopes` (P17): what introspection verified for this very
 *   call (bound organization and effective permissions), which
 *   `robynn_status` reports (plan §9 step 5).
 */
import { isOAuthScope, type OAuthScope } from "./oauth-policy";
import { PREFLIGHT_HEADER } from "./session-binding";

export interface PreflightStamp {
  appGrantId: string;
  tools: string[];
  organization?: { id: string; name: string | null };
  /** Effective scopes for this call (host ∩ grant ∩ props ∩ introspection). */
  scopes?: OAuthScope[];
}

const MAX_ORGANIZATION_NAME = 200;

/**
 * Header-safe JSON: header values must be ByteStrings, so every non-ASCII
 * character (an organization name in any script) is `\uXXXX`-escaped.
 * `JSON.parse` restores it exactly.
 */
export function encodePreflightStamp(stamp: PreflightStamp): string {
  const value: PreflightStamp = {
    appGrantId: stamp.appGrantId,
    tools: stamp.tools,
    ...(stamp.organization
      ? {
          organization: {
            id: stamp.organization.id,
            name: stamp.organization.name === null ? null : stamp.organization.name.slice(0, MAX_ORGANIZATION_NAME),
          },
        }
      : {}),
    ...(stamp.scopes ? { scopes: stamp.scopes } : {}),
  };
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The stamp on the current `tools/call`, or null if absent or malformed. */
export function readPreflightStamp(extra: unknown): PreflightStamp | null {
  const headers = (extra as { requestInfo?: { headers?: Record<string, unknown> } } | undefined)?.requestInfo
    ?.headers;
  const raw = headers?.[PREFLIGHT_HEADER];
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { appGrantId, tools, organization, scopes } = parsed as Record<string, unknown>;
  if (typeof appGrantId !== "string" || !Array.isArray(tools) || !tools.every((t) => typeof t === "string")) {
    return null;
  }
  const stamp: PreflightStamp = { appGrantId, tools: tools as string[] };
  if (
    organization &&
    typeof organization === "object" &&
    typeof (organization as { id?: unknown }).id === "string" &&
    ["string", "object"].includes(typeof (organization as { name?: unknown }).name)
  ) {
    const { id, name } = organization as { id: string; name: string | null };
    stamp.organization = { id, name: typeof name === "string" ? name : null };
  }
  if (Array.isArray(scopes) && scopes.every(isOAuthScope)) stamp.scopes = scopes as OAuthScope[];
  return stamp;
}
