import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthScope } from "../authorization/oauth-policy";
import type { PreflightStamp } from "../authorization/preflight-stamp";
import type { RobynnClient } from "../robynn-client";
import { toErrorResult, toSuccessResult, toolMetadata } from "./util";

/**
 * The connection `robynn_status` reports (plan §9 step 5): the organization
 * this OAuth connection is bound to and the permissions it has right now, as
 * the Worker preflight verified them for this call (P10 N7, P17).
 */
export interface StatusConnection {
  organization: { id: string; name: string | null };
  permissions: OAuthScope[];
  can_execute: boolean;
}

/** Null unless the stamp is complete and belongs to this session's grant. */
export function connectionFromStamp(
  stamp: PreflightStamp | null,
  appGrantId: string | undefined,
): StatusConnection | null {
  if (!stamp || !appGrantId || stamp.appGrantId !== appGrantId || !stamp.organization || !stamp.scopes) {
    return null;
  }
  return {
    organization: stamp.organization,
    permissions: stamp.scopes,
    can_execute: stamp.scopes.includes("tools:execute"),
  };
}

export interface StatusToolOptions {
  /** OAuth sessions: the verified connection for this call (absent on the CLI). */
  connection?: (extra: unknown) => StatusConnection | null;
}

const STATUS_TITLE = "Check Robynn Connection";

export const UNAUTHENTICATED_STATUS_MESSAGE =
  "Not authenticated. Disconnect and reconnect Robynn in your AI client, then try again.";

export function registerStatusTools(server: McpServer, client: RobynnClient, options: StatusToolOptions = {}) {
  server.registerTool(
    "robynn_status",
    {
      ...toolMetadata(STATUS_TITLE, {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the Robynn connection: the organization it is bound to, its permissions (brand:read; tools:execute only if granted at consent), company info and connection health. Read-only.",
    },
    async (extra) => {
      const connection = options.connection?.(extra) ?? null;
      try {
        const result = await client.getStatus();
        const statusData = {
          connected: result.success,
          ...(result.data || {}),
          ...(connection ? { connection } : {}),
        };

        return toSuccessResult(statusData as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error checking status: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "robynn_usage",
    {
      ...toolMetadata("Check Credit Balance", {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the connected organization's credit (token) balance, usage, and quota. Read-only; does not spend credits.",
    },
    async () => {
      try {
        const result = await client.getUsage();

        if (!result.success || !result.data) {
          return toErrorResult(result.error || "Failed to fetch usage");
        }

        return toSuccessResult(result.data as unknown as Record<string, unknown>);
      } catch (err) {
        return toErrorResult(
          `Error fetching usage: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
  );
}

/**
 * The `robynn_status` registration used when a session has no access token.
 * Same title and hints as the authenticated tool, host-neutral copy.
 * Not wired in yet: `RobynnMCP.init()` (src/index.ts, owned by P10) still
 * registers its own unannotated fallback and should call this instead.
 */
export function registerUnauthenticatedStatusTool(server: McpServer) {
  server.registerTool(
    "robynn_status",
    {
      ...toolMetadata(STATUS_TITLE, {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      }),
      description:
        "Check the Robynn connection. This session is not authenticated; reconnect Robynn to use its tools.",
    },
    async () => toErrorResult(UNAUTHENTICATED_STATUS_MESSAGE),
  );
}
