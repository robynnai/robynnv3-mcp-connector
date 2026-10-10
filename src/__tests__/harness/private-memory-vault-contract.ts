/**
 * P09b's private-memory vault output contract, as the Worker tests consume it
 * (COS-PLUGIN-001 P16).
 *
 * `../fixtures/private-memory-vault.contract.json` is a byte-identical copy of
 * robynnv3 `src/lib/server/vault/contracts/private-memory-vault.contract.json`
 * (contract v2, branch `plugin-v1/p09b-vault-private-memory` @ dd56744b8). It
 * describes one synthetic org whose `org_knowledge_documents` mix org-shared,
 * user-private and session-scope rows. After the app's vault materializer
 * runs, the org vault's `sources/` subtree must be exactly
 * `expected_sources_keys`, contain none of `forbidden_paths`, and no object
 * may contain any `forbidden_substrings`.
 *
 * {@link findPrivateMemoryExposure} is a straight port of the app's helper
 * (`private-memory-vault-contract.ts`); an empty `exposures` list is the pass
 * condition. The two materialized-vault builders below reproduce the
 * materializer's path rule (`sources/<slug(source_type)>/<slug(source_key)>`,
 * collisions suffixed with the row's short id) so the tests can stand up the
 * post-P09b vault and a pre-P09b leaky one without the app.
 */
import contract from "../fixtures/private-memory-vault.contract.json";

export const PRIVATE_MEMORY_VAULT_CONTRACT = contract;
export type PrivateMemoryVaultContract = typeof contract;

export interface VaultExposure {
  path: string;
  kind: "unexpected_key" | "forbidden_path" | "forbidden_substring";
  /** For forbidden_substring: the matched marker. Never object contents. */
  detail?: string;
}

export interface VaultExposureReport {
  exposures: VaultExposure[];
  /** Expected org-shared keys that were not listed (completeness, not privacy). */
  missingExpectedKeys: string[];
}

/**
 * Check what a caller can list and read against the contract.
 *
 * @param keys  every key the caller can list (vault-relative, e.g. `sources/…`)
 * @param read  reads one vault-relative path; `null` when not found
 */
export async function findPrivateMemoryExposure(input: {
  keys: string[];
  read: (path: string) => Promise<string | null>;
  contract?: PrivateMemoryVaultContract;
}): Promise<VaultExposureReport> {
  const c = input.contract ?? PRIVATE_MEMORY_VAULT_CONTRACT;
  const listed = new Set(input.keys);
  const expected = new Set(c.expected_sources_keys);
  const exposures: VaultExposure[] = [];

  for (const key of listed) {
    if (key.startsWith("sources/") && !expected.has(key)) {
      exposures.push({ path: key, kind: "unexpected_key" });
    }
  }

  for (const path of c.forbidden_paths) {
    if (listed.has(path) || (await input.read(path)) !== null) {
      exposures.push({ path, kind: "forbidden_path" });
    }
  }

  for (const key of [...listed].sort()) {
    const text = await input.read(key);
    if (text === null) continue;
    for (const marker of c.forbidden_substrings) {
      if (text.includes(marker)) {
        exposures.push({ path: key, kind: "forbidden_substring", detail: marker });
      }
    }
  }

  return {
    exposures,
    missingExpectedKeys: c.expected_sources_keys.filter((k) => !listed.has(k)),
  };
}

type ContractDocument = PrivateMemoryVaultContract["documents"][number];

/** The materializer's `slugify` (robynnv3 `src/lib/server/vault/materializer.ts`). */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

function renderVault(c: PrivateMemoryVaultContract, documents: ContractDocument[]): Record<string, string> {
  const base = (doc: ContractDocument) => `sources/${slugify(doc.source_type)}/${slugify(doc.source_key)}`;
  const counts = new Map<string, number>();
  for (const doc of documents) counts.set(base(doc), (counts.get(base(doc)) ?? 0) + 1);

  const files: Record<string, string> = {};
  for (const doc of documents) {
    const stem = counts.get(base(doc))! > 1 ? `${base(doc)}-${doc.id.slice(0, 8)}` : base(doc);
    files[`${stem}.md`] = [
      "---",
      `id: ${doc.id}`,
      `source_type: ${doc.source_type}`,
      `source_key: ${JSON.stringify(doc.source_key)}`,
      "---",
      "",
      doc.content,
      "",
    ].join("\n");
    const chunks = c.chunks.filter((chunk) => chunk.document_id === doc.id);
    files[`${stem}.embedding.json`] = JSON.stringify({
      document_id: doc.id,
      chunks: chunks.map((chunk) => ({ id: chunk.id, index: chunk.chunk_index, content: chunk.content })),
    });
  }
  return files;
}

/** The org vault's `sources/` after a post-P09b run: excluded rows never written. */
export function materializedVault(c: PrivateMemoryVaultContract = PRIVATE_MEMORY_VAULT_CONTRACT) {
  const excluded = new Set(c.excluded_document_ids);
  return renderVault(
    c,
    c.documents.filter((doc) => !excluded.has(doc.id)),
  );
}

/** The same vault as a pre-P09b run left it: every row written, private ones included. */
export function preP09bLeakyVault(c: PrivateMemoryVaultContract = PRIVATE_MEMORY_VAULT_CONTRACT) {
  return renderVault(c, c.documents);
}
