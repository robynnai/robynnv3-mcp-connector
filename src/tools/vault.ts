/**
 * Vault MCP tools.
 *
 * Exposes the materializer's R2 vault to Claude as two tools:
 *
 *   robynn_vault_list — paginated list of objects under a prefix
 *   robynn_vault_read — fetch one object by path (UTF-8 text)
 *
 * Both are scoped to the OAuth session's organization (`props.organizationId`)
 * — there is no `orgId` parameter; the session id is the trust boundary.
 *
 * Why tools instead of MCP `resources/list` + `resources/read`?
 * The vault has thousands of files per org; static resource registration
 * doesn't fit. Resource templates would work but offer the agent less
 * control over pagination + prefix filtering than explicit tool params.
 * If a future consumer prefers the resources protocol, these can be
 * promoted; the underlying R2 calls don't change.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { VaultR2 } from "../vault-r2";
import { toErrorResult, toSuccessResult } from "./util";

export function registerVaultTools(server: McpServer, vault: VaultR2): void {
  server.tool(
    "robynn_vault_list",
    [
      "List materialized vault objects for the current organization.",
      "",
      "Layout:",
      "  brand/<doc-name>/<entry>.md           — brand_hub_docs (filtered)",
      "  facts/<doc-name>/<short-id>.md        — org_facts (live only)",
      "  sources/<source-type>/<key>.md        — org_knowledge_documents (live only)",
      "  sources/<source-type>/<key>.embedding.json  — chunk embeddings sidecar",
      "  vault.lock                            — last-materialized timestamp",
      "",
      "Pass an empty/absent `prefix` to enumerate everything; pass e.g.",
      "`brand/voice-attribute/` to drill in. Returns at most `limit` entries",
      "(default 100, max 1000) and a `cursor` you can pass back to continue.",
    ].join("\n"),
    {
      prefix: z
        .string()
        .optional()
        .describe(
          "Path prefix relative to the org root. Examples: 'brand/', 'sources/website/'. Omit to list everything.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max entries to return (default 100, max 1000)."),
      cursor: z
        .string()
        .optional()
        .describe("Continuation cursor returned by a previous list call."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ prefix, limit, cursor }) => {
      try {
        const result = await vault.list({ prefix, limit, cursor });
        return toSuccessResult(
          result as unknown as Record<string, unknown>,
          [
            `Vault list (prefix=${JSON.stringify(prefix ?? "")}, ` +
              `count=${result.entries.length}, truncated=${result.truncated})`,
            ...result.entries
              .slice(0, 50)
              .map((e) => `  ${e.path}  (${e.size} B)`),
            result.entries.length > 50
              ? `  ...and ${result.entries.length - 50} more`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (err) {
        return toErrorResult(
          `Vault list failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "robynn_vault_read",
    [
      "Read one materialized vault object by its path (relative to the",
      "current org's root). The body is returned as UTF-8 text — vault",
      "objects are markdown (with YAML frontmatter) or JSON sidecars.",
      "",
      "Use robynn_vault_list first if you need to discover available paths.",
      "Returns null/error if the path doesn't exist; check `not_found` in",
      "the response.",
    ].join("\n"),
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Vault-relative path. Examples: 'brand/voice-attribute/direct.md', 'sources/website/about.embedding.json', 'vault.lock'.",
        ),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ path }) => {
      try {
        const obj = await vault.read(path);
        if (!obj) {
          return toSuccessResult(
            { not_found: true, path } as Record<string, unknown>,
            `Vault path not found: ${path}`,
          );
        }
        return toSuccessResult(
          obj as unknown as Record<string, unknown>,
          obj.text,
        );
      } catch (err) {
        return toErrorResult(
          `Vault read failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
