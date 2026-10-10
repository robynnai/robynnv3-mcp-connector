/**
 * Vault authorization gate (COS-PLUGIN-001 P10; plan §5 "Direct Vault access
 * bypasses current membership/revocation checks"; contract §6.4 step 8).
 *
 * Vault tools read R2 directly, with no app route to enforce anything, so
 * they rely on the Worker preflight: a `tools/call` is forwarded to the
 * session only after app introspection confirmed the grant, membership and
 * scope for that request. The preflight then stamps the forwarded request
 * with `x-robynn-preflight: {"appGrantId", "tools"}` (clients cannot set
 * `x-robynn-*`: the Worker strips them). This gate refuses any R2 operation
 * unless that stamp is present for this tool and this session's grant and
 * the grant is a hardened (authVersion 2) one. Missing or malformed ⇒ deny:
 * the gate fails closed, and the default gate denies everything.
 */
import type { Props } from "../types";
import { PREFLIGHT_HEADER } from "./session-binding";
import { isUuid } from "./upstream-grant";

export type VaultGate = (tool: string, extra: unknown) => boolean;

/** Default for registrations without a gate (e.g. catalog listing). */
export const DENY_ALL_VAULT_CALLS: VaultGate = () => false;

function preflightHeader(extra: unknown): string | null {
  const headers = (extra as { requestInfo?: { headers?: Record<string, unknown> } } | undefined)?.requestInfo
    ?.headers;
  const value = headers?.[PREFLIGHT_HEADER];
  return typeof value === "string" ? value : null;
}

export function createVaultGate(getProps: () => Partial<Props> | undefined): VaultGate {
  return (tool, extra) => {
    const props = getProps();
    if (!props || props.authVersion !== 2 || !isUuid(props.appGrantId)) return false;
    const raw = preflightHeader(extra);
    if (!raw) return false;
    try {
      const stamp = JSON.parse(raw) as { appGrantId?: unknown; tools?: unknown };
      return (
        stamp.appGrantId === props.appGrantId &&
        Array.isArray(stamp.tools) &&
        stamp.tools.includes(tool)
      );
    } catch {
      return false;
    }
  };
}

const VAULT_DENIED_MESSAGE =
  "Robynn could not confirm this connection's permissions for the vault. Nothing was read. Try again shortly.";

export function vaultDeniedResult() {
  return {
    content: [{ type: "text" as const, text: VAULT_DENIED_MESSAGE }],
    structuredContent: {
      error: { code: "authorization_unavailable", message: VAULT_DENIED_MESSAGE, retryable: true },
    } as Record<string, unknown>,
    isError: true,
  };
}
