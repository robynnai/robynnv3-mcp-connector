/**
 * Vault authorization gate (COS-PLUGIN-001 P10; plan §5 "Direct Vault access
 * bypasses current membership/revocation checks"; contract §6.4 step 8).
 *
 * Vault tools read R2 directly, with no app route to enforce anything, so
 * they rely on the Worker preflight: a `tools/call` is forwarded to the
 * session only after app introspection confirmed the grant, membership and
 * scope for that request. The preflight then stamps the forwarded request
 * with `x-robynn-preflight: {"appGrantId", "tools", ...}` (clients cannot set
 * `x-robynn-*`: the Worker strips them). This gate refuses any R2 operation
 * unless that stamp is present for this tool and this session's grant and
 * the grant is a hardened (authVersion 2) one. Missing or malformed ⇒ deny:
 * the gate fails closed, and the default gate denies everything.
 */
import type { Props } from "../types";
import { readPreflightStamp } from "./preflight-stamp";
import { isUuid } from "./upstream-grant";

export type VaultGate = (tool: string, extra: unknown) => boolean;

/** Default for registrations without a gate (e.g. catalog listing). */
export const DENY_ALL_VAULT_CALLS: VaultGate = () => false;

export function createVaultGate(getProps: () => Partial<Props> | undefined): VaultGate {
  return (tool, extra) => {
    const props = getProps();
    if (!props || props.authVersion !== 2 || !isUuid(props.appGrantId)) return false;
    const stamp = readPreflightStamp(extra);
    return stamp !== null && stamp.appGrantId === props.appGrantId && stamp.tools.includes(tool);
  };
}

const VAULT_DENIED_MESSAGE =
  "Robynn could not confirm this connection's permissions for the vault. Nothing was read. Try again shortly.";

export function vaultDeniedResult() {
  return {
    content: [{ type: "text" as const, text: `authorization_unavailable: ${VAULT_DENIED_MESSAGE}` }],
    structuredContent: {
      error: { code: "authorization_unavailable", message: VAULT_DENIED_MESSAGE, retryable: true },
    } as Record<string, unknown>,
    isError: true,
  };
}
