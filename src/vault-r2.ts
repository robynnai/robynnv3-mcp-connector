/**
 * Native R2 binding wrapper for the vault.
 *
 * The materializer cron in robynnv3 writes to a single R2 bucket per env
 * (`robynn-materialized` in prod), with the layout:
 *
 *   <bucket>/orgs/<orgId>/brand/<doc-name>/<entry>.md
 *   <bucket>/orgs/<orgId>/facts/<doc-name>/<short-id>.md
 *   <bucket>/orgs/<orgId>/sources/<source-type>/<key>.md
 *   <bucket>/orgs/<orgId>/sources/<source-type>/<key>.embedding.json
 *   <bucket>/orgs/<orgId>/vault.lock
 *
 * This wrapper:
 *   1. Always scopes operations to one org via `orgs/<orgId>/<path>`
 *   2. Refuses path-traversal attempts (defense-in-depth — the OAuth-bound
 *      org id should never appear in a user-controlled path, but the
 *      `path` param is user-controlled)
 *   3. Returns small typed shapes the MCP tool layer can serialize directly
 *
 * No AWS SDK / IAM token: this uses Cloudflare Workers' native R2Bucket
 * binding (`env.VAULT`). The binding is per-Worker private; nothing in the
 * client request graph can leak credentials because there are none.
 */

import type { R2Bucket } from "@cloudflare/workers-types";

export interface VaultListEntry {
  /** Path relative to the org's root (e.g. `brand/voice-attribute/direct.md`). */
  path: string;
  /** Object size in bytes. */
  size: number;
  /** Last modification time as ISO-8601. */
  uploaded: string;
  /** R2 etag for cache validation. */
  etag: string | null;
}

export interface VaultListResult {
  entries: VaultListEntry[];
  /** Cursor for the next page; null/undefined when the list is exhausted. */
  cursor: string | null;
  /** True when more results exist beyond the returned cursor. */
  truncated: boolean;
}

export interface VaultReadResult {
  /** Path that was read (relative to the org root, echoed back). */
  path: string;
  /** Body decoded as UTF-8 text. Vault content is markdown / JSON only. */
  text: string;
  /** Content-Type stored at write time (passed through from R2). */
  contentType: string;
  /** Object size in bytes. */
  size: number;
  /** R2 etag. */
  etag: string | null;
  /** Last modification time as ISO-8601. */
  uploaded: string;
}

/** Largest vault object returned as text; larger objects are refused unread. */
export const MAX_VAULT_OBJECT_BYTES = 1024 * 1024;
/** Longest accepted vault path or prefix. */
export const MAX_VAULT_PATH_LENGTH = 1024;
/** Longest accepted list cursor. */
export const MAX_VAULT_CURSOR_LENGTH = 1024;

/**
 * Reject paths that try to escape the per-org prefix. Same rules as the
 * robynnv3-side LocalFilesystemStorage / R2Storage / R2Reader so a mistake
 * can't be made on either side of the read/write boundary.
 */
function assertSafePath(path: string): void {
  if (!path || path.length === 0) {
    throw new Error("Vault path is required");
  }
  if (path.length > MAX_VAULT_PATH_LENGTH) {
    throw new Error(`Vault path must be at most ${MAX_VAULT_PATH_LENGTH} characters`);
  }
  if (path.startsWith("/")) {
    throw new Error(`Vault path must not be absolute: ${path}`);
  }
  if (path.includes("\\")) {
    throw new Error(`Vault path must not contain backslashes: ${path}`);
  }
  for (const segment of path.split("/")) {
    if (segment === "..") {
      throw new Error(
        `Vault path must not contain parent-directory segments: ${path}`,
      );
    }
  }
}

/**
 * Defense in depth for COS-PLUGIN-001 P09b (plan §5 "Memory privacy differs
 * by backend"). The app's vault materializer no longer writes user-private or
 * session-scope agent memory into the org vault, and its reconcile deletes
 * objects leaked by earlier runs. Until every org's vault has been rebuilt or
 * purged, the Worker also refuses the paths those rows were written to:
 * `agent_memory` source keys `user:<owner>:<key>` / `user:<key>` and
 * `session:<id>:<key>` slugify to `sources/agent-memory/user-…` and
 * `sources/agent-memory/session-…`. Org-scope memory (`org:` ⇒ `org-…`) and
 * every other source stay readable. One-line flip.
 */
export const VAULT_HIDES_PRIVATE_MEMORY_PATHS = true;

const PRIVATE_MEMORY_FILE = /^(user|session)-/i;

/**
 * True for a vault-relative path that names user-private or session-scope
 * agent memory. Empty and `.` segments are ignored so `sources//agent-memory`
 * or `./sources/...` spellings cannot slip past; matching is
 * case-insensitive (fail closed: such a path is hidden, never served).
 */
export function isPrivateMemoryVaultPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return (
    segments.length >= 3 &&
    segments[0].toLowerCase() === "sources" &&
    segments[1].toLowerCase() === "agent-memory" &&
    PRIVATE_MEMORY_FILE.test(segments[2])
  );
}

function joinKey(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Per-org wrapper. Construct one per OAuth session (the org is fixed by
 * the access token); every method is scoped to the bound org.
 */
export class VaultR2 {
  private readonly bucket: R2Bucket;
  /** Bucket-relative root for this org, e.g. `orgs/<uuid>`. */
  readonly orgRoot: string;

  constructor(bucket: R2Bucket, organizationId: string) {
    if (!organizationId) {
      throw new Error("VaultR2: organizationId is required");
    }
    this.bucket = bucket;
    this.orgRoot = `orgs/${organizationId}`;
  }

  /**
   * List entries under a vault-relative prefix (e.g. `brand/voice-attribute/`).
   * Empty/absent prefix lists everything from the org root.
   *
   * @param opts.prefix    Path prefix relative to the org root.
   * @param opts.limit     Max entries to return (R2 hard cap is 1000).
   * @param opts.cursor    Continue a previous paginated list.
   */
  async list(opts: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<VaultListResult> {
    const prefix = opts.prefix ?? "";
    if (prefix) assertSafePath(prefix);
    if (opts.cursor !== undefined && opts.cursor.length > MAX_VAULT_CURSOR_LENGTH) {
      throw new Error("Vault cursor is invalid");
    }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);

    const fullPrefix = joinKey(this.orgRoot, prefix);
    const result = await this.bucket.list({
      prefix: fullPrefix.endsWith("/") ? fullPrefix : `${fullPrefix}/`,
      limit,
      cursor: opts.cursor,
    });

    const orgRootWithSlash = `${this.orgRoot}/`;
    const entries: VaultListEntry[] = result.objects
      .map((obj) => ({
        path: obj.key.startsWith(orgRootWithSlash)
          ? obj.key.slice(orgRootWithSlash.length)
          : obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
        etag: obj.etag ?? null,
      }))
      // A page may come back shorter than `limit`; the cursor still advances.
      .filter((entry) => !(VAULT_HIDES_PRIVATE_MEMORY_PATHS && isPrivateMemoryVaultPath(entry.path)));

    return {
      entries,
      cursor: result.truncated ? (result.cursor ?? null) : null,
      truncated: result.truncated,
    };
  }

  /**
   * Fetch a vault object as UTF-8 text. Returns `null` on missing key (and
   * for a private-memory path, see {@link isPrivateMemoryVaultPath}) so
   * callers can distinguish "not found" from real errors.
   */
  async read(path: string): Promise<VaultReadResult | null> {
    assertSafePath(path);
    // Reported exactly like a missing object, without an R2 call, so the
    // answer is no existence oracle.
    if (VAULT_HIDES_PRIVATE_MEMORY_PATHS && isPrivateMemoryVaultPath(path)) return null;
    const key = joinKey(this.orgRoot, path);
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    if (!(obj.size <= MAX_VAULT_OBJECT_BYTES)) {
      // Never buffer an oversized object: release the body unread.
      await obj.body?.cancel().catch(() => undefined);
      throw new Error(
        `Vault object is too large to read (${obj.size} bytes; limit ${MAX_VAULT_OBJECT_BYTES})`,
      );
    }
    const text = await obj.text();
    return {
      path,
      text,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
      etag: obj.etag ?? null,
      uploaded: obj.uploaded.toISOString(),
    };
  }
}

// Re-export the guard for tests + tool layer to use directly.
export { assertSafePath as assertSafeVaultPath };
