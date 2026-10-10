/**
 * Per-tool authorization policy for the Worker preflight (COS-PLUGIN-001
 * P10; authorization contract §6.4 step 5, §7).
 *
 * TOOL_POLICY is built from `contracts/tool-route-map.json` at module load,
 * so the map stays the single source of truth: a scope flip there (P07 †
 * tools, D-A) changes enforcement here with no code edit. Unknown tools are
 * denied (`tool_not_permitted`).
 */
import toolRouteMap from "../../contracts/tool-route-map.json";
import { isOAuthScope, type OAuthScope } from "./oauth-policy";

export interface ToolPolicy {
  name: string;
  requiredScope: OAuthScope;
  /** `{ argument: { value: scope } }`; a missing/unknown value uses `requiredScope`. */
  scopeByArgument: Record<string, Record<string, OAuthScope>>;
  /** `{ argument: [rejected values] }`, each rejected with `unsupported_memory_scope`. */
  rejectedArgumentValues: Record<string, string[]>;
}

export type ToolDenialCode =
  | "tool_not_permitted"
  | "insufficient_scope"
  | "unsupported_memory_scope";

export type ToolDecision =
  | { allowed: true; requiredScope: OAuthScope }
  | { allowed: false; code: ToolDenialCode; requiredScope?: OAuthScope };

interface MapTool {
  name: string;
  requiredScope: string;
  scopeByArgument?: Record<string, Record<string, string>>;
  argumentPolicy?: Record<string, Record<string, string>>;
}

function toScope(value: string, where: string): OAuthScope {
  if (!isOAuthScope(value)) {
    throw new Error(`tool-route-map: unknown scope ${JSON.stringify(value)} at ${where}`);
  }
  return value;
}

/** Exported for tests; the Worker uses TOOL_POLICY. */
export function buildToolPolicy(tools: readonly MapTool[]): ReadonlyMap<string, ToolPolicy> {
  const policy = new Map<string, ToolPolicy>();
  for (const tool of tools) {
    if (policy.has(tool.name)) throw new Error(`tool-route-map: duplicate tool ${tool.name}`);
    const scopeByArgument: ToolPolicy["scopeByArgument"] = {};
    for (const [argument, values] of Object.entries(tool.scopeByArgument ?? {})) {
      scopeByArgument[argument] = {};
      for (const [value, scope] of Object.entries(values)) {
        scopeByArgument[argument][value] = toScope(scope, `${tool.name}.${argument}=${value}`);
      }
    }
    const rejectedArgumentValues: ToolPolicy["rejectedArgumentValues"] = {};
    for (const [argument, values] of Object.entries(tool.argumentPolicy ?? {})) {
      const rejected = Object.entries(values)
        .filter(([, rule]) => rule.startsWith("reject"))
        .map(([value]) => value);
      if (rejected.length > 0) rejectedArgumentValues[argument] = rejected;
    }
    policy.set(tool.name, {
      name: tool.name,
      requiredScope: toScope(tool.requiredScope, tool.name),
      scopeByArgument,
      rejectedArgumentValues,
    });
  }
  return policy;
}

export const TOOL_POLICY = buildToolPolicy((toolRouteMap as { tools: MapTool[] }).tools);

/**
 * Decide one `tools/call` against the effective scopes. A listed argument
 * value selects its scope (`robynn_conversations` `action=list` is
 * `brand:read`); any other value, or none, uses the tool's `requiredScope`.
 */
export function decideToolCall(
  name: unknown,
  args: unknown,
  effectiveScopes: readonly OAuthScope[],
  policyMap: ReadonlyMap<string, ToolPolicy> = TOOL_POLICY,
): ToolDecision {
  const policy = typeof name === "string" ? policyMap.get(name) : undefined;
  if (!policy) return { allowed: false, code: "tool_not_permitted" };

  const argRecord =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

  for (const [argument, rejected] of Object.entries(policy.rejectedArgumentValues)) {
    const value = argRecord[argument];
    if (typeof value === "string" && rejected.includes(value)) {
      return { allowed: false, code: "unsupported_memory_scope" };
    }
  }

  let requiredScope = policy.requiredScope;
  for (const [argument, byValue] of Object.entries(policy.scopeByArgument)) {
    const value = argRecord[argument];
    if (typeof value === "string" && Object.hasOwn(byValue, value)) {
      requiredScope = byValue[value];
    }
  }

  if (!effectiveScopes.includes(requiredScope)) {
    return { allowed: false, code: "insufficient_scope", requiredScope };
  }
  return { allowed: true, requiredScope };
}
