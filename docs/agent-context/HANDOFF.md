# robynn-mcp-server Handoff

Last updated: 2026-10-09

For future agents:

1. Start with `docs/agent-context/START_HERE.md`.
2. Run `scripts/context-check.sh`.
3. Inspect Beads with `bd ready --json` after bootstrap.
4. Keep PRs scoped to this repo unless the user asks for coordinated cross-repo work.

When a change affects `robynnv3` or `robynnv3_agents`, update the relevant repo in its own branch/PR and only update the root workspace submodule pointer after those PRs land.

## Plugin v1 (COS-PLUGIN-001)

P01 (Beads `robynn_mcp_server-1fs`, branch `plugin-v1/p01-baseline-contracts`, draft PR #52) locked the contracts that P06, P10, P12 and P13 implement in this repo:

- Start from `docs/plugin-v1/AUTHORIZATION_CONTRACT.md` (Worker pipeline §6, facts F1–F20) and `docs/plugin-v1/TOOL_CONTRACT.md` / `contracts/tool-route-map.json` (per-tool scope and hints).
- Ship `proposedHints`, never `hintsAfterP07`, until the app-side P07 fix lands.
- Do not enable SSE (`McpAgent.serveSSE`) without the `?sessionId=` binding described in contract §6.4 step 4.
- Full cross-repo handoff: `~/Developer/cos-share/reports/plugin/P01-handoff.md`.

## COS-PLUGIN-001 P03: Worker internal-auth signing (2026-10-09)

- **Branch and PR:** `plugin-v1/p03-worker-internal-auth`, draft PR #55. P06 stacks on it.
- **Paired with:** robynnv3 `plugin-v1/p03-signing-token-auth`. The two must ship together. Deploy order: secrets → app migration → Worker → app (see `docs/plugin-v1/INTERNAL_AUTH_SIGNING.md` §5).
- **For P10:** reuse `internalMcpRequestHeaders` for introspection. Do not add a second signing scheme.
- **Full handoff:** `cos-share/reports/plugin/P03-handoff.md`.

## COS-PLUGIN-001 P06: Worker OAuth front door (2026-10-09)

- **Branch:** `plugin-v1/p06-worker-auth`, stacked on `plugin-v1/p03-worker-internal-auth`.
- **What changed:** strict `/authorize` (S256, scope, resource, browser-bound state), fail-closed `/callback` (introspection, scope subset, client binding), `/token` `redirect_uri` binding, `/mcp`-only path allow-list, `ADVERTISE_SSE=false`, host-neutral pages and the redacting logger. Details are in `docs/plugin-v1/WORKER_OAUTH_FRONT_DOOR.md`.
- **For P10:**
  - Reuse `introspectUpstreamGrant` (`src/authorization/upstream-grant.ts`) for per-call checks.
  - `props.authVersion === 2` marks hardened grants.
  - `props.appGrantId` and `props.credentialVersion` are set at `/callback`.
- **Full handoff:** `cos-share/reports/plugin/P06-handoff.md`.

## COS-PLUGIN-001 P10: Worker session binding, per-call reauthorization, Vault, refresh (2026-10-09)

- **Branch:** `plugin-v1/p10-worker-session-vault`, stacked on `plugin-v1/p06-worker-auth`, with `plugin-v1/p12-tool-metadata` merged in. It pairs with robynnv3 `plugin-v1/p10-introspect`. Deploy the app first.
- **What changed:** see `docs/plugin-v1/WORKER_SESSION_AUTHORIZATION.md`.
- **For P16/P18:** host OAuth now completes end to end on plugin-local (P05 + P10 app). `cos-share/reports/plugin/P10-evidence/live.mjs` is a template. `wrangler.local.toml` needs the `REFRESH_COORDINATOR` binding and migration `v2`.
- **For P11:** `robynn-client.ts` changes are minimal: `setAccessToken` and a typed `authorization_expired` on an upstream 401 with no refresh hook. The retry and replay work is unchanged.
- **Full handoff:** `cos-share/reports/plugin/P10-handoff.md`.

P12 (Beads `robynn_mcp_server-qp3`, branch `plugin-v1/p12-tool-metadata`, draft PR #54, stacked on P01) shipped tool metadata:

- Every tool registers via `registerTool` / `registerAppTool` with `toolMetadata(title, hints)`. Titles, hints and input-schema digests are locked to `contracts/tool-route-map.json`.
- Five † tools stay `readOnlyHint:false` until P07 removes a hidden write: the four brand-book reads (`BRAND_BOOK_READS_PERSIST_COMPLETENESS`) and `robynn_query_connected_app` (`CONNECTED_APP_READS_PERSIST_POLICY`).
  - The P07 recipe: flip the flag; in the map set `currentHints` / `proposedHints` to `hintsAfterP07` and `requiredScope` to `requiredScopeAfterP07`; regenerate `contracts/mcp-tools.json`.
- Left to P10: wiring `registerUnauthenticatedStatusTool` and server instructions (`src/index.ts`). Left to P11: `encodeURIComponent` of path ids in `src/robynn-client.ts`.
- Handoff: `~/Developer/cos-share/reports/plugin/P12-handoff.md`; re-review: `P12-review.md` (APPROVE).

P13 (Beads `robynn_mcp_server-b1o`, branch `plugin-v1/p13-catalog-contract`, stacked on P12) added the full catalog contract suite (TOOL_CONTRACT §7):

- `src/__tests__/catalog-harness.ts` runs the real `RobynnMCP` DO activation (`onStart` → `init()`) and the real `robynn mcp` CLI action behind an SDK `Client`, with a stubbed app `fetch` and in-memory R2.
- `contracts/mcp-tools.json` is the sanitized real `tools/list` + `resources/list`. Drift fails `catalog-contract.test.ts`; regenerate deliberately with `UPDATE_MCP_TOOLS_SNAPSHOT=1 pnpm exec vitest run src/__tests__/catalog-contract.test.ts`.
- Any tool change touches four things together: code, map entry, fixture (`catalog-contract.fixtures.ts`), snapshot.
- D-A flip point: the query tool's `requiredScopeAfterP07` (a downgrade needs P07 first).
- P10 should add a Worker-side "denied before any request" case per tool to the matrix.
- Handoff: `~/Developer/cos-share/reports/plugin/P13-handoff.md`.

## COS-PLUGIN-001 P16: OAuth integration and revocation tests (2026-10-10)

- **Branch:** `plugin-v1/p16-oauth-integration`, stacked on `plugin-v1/p10-worker-session-vault`, with `plugin-v1/p11-retry-safety` and `plugin-v1/p13-catalog-contract` merged in. Pairs with robynnv3 `plugin-v1/p16-oauth-integration`. Beads `robynn_mcp_server-5zt`.
- **What changed:** see `docs/plugin-v1/OAUTH_INTEGRATION_TESTS.md`.
  - The in-process Worker harness now lives in `src/__tests__/harness/` and is shared by P10's suite.
  - The new suites are the full front-door chain (`oauth-chain.test.ts`) and the Vault P09b contract (`vault-private-memory.test.ts`).
  - The live plugin-local suites are in `src/__tests__/plugin-local/` (`pnpm test:plugin-local`).
- **Behaviour change:** `VaultR2` hides and refuses `sources/agent-memory/user-…` and `session-…` paths (`VAULT_HIDES_PRIVATE_MEMORY_PATHS`, a one-line flip).
- **Merge note:** P13's catalog harness now activates the DO with P10-shaped (authVersion 2) props and a preflight stamp. Props without `organizationId` are refused by the session binding; `contracts/mcp-tools.json` was regenerated (P10 instructions and the fallback tool).
- **Full handoff:** `cos-share/reports/plugin/P16-handoff.md`.

## COS-PLUGIN-001 P17: tool and backend integration (2026-10-10)

- **Branch:** `plugin-v1/p17-tool-integration`, stacked on `plugin-v1/p16-oauth-integration`. Pairs with robynnv3 `plugin-v1/p17-tool-integration`. Beads `robynn_mcp_server-af8`.
- **Live suite:** `src/__tests__/plugin-local/tool-backend.live.test.ts` runs all 48 tools through real OAuth, the real Worker, the real app and local Supabase, for success, error and permission denied. The only stand-in is `backend-fixture.ts` (fake LangGraph, Composio, Strapi and an egress proxy, all on loopback). How to run and the per-tool matrix: `docs/plugin-v1/TOOL_BACKEND_INTEGRATION_TESTS.md`.
- **Behaviour changes:**
  - The four brand-book † tools are now `brand:read` and read-only (`BRAND_BOOK_READS_PERSIST_COMPLETENESS = false`, map flipped). P07 had already removed the write app-side.
  - `robynn_status` adds `connection: { organization, permissions, can_execute }` from the preflight stamp (`src/authorization/preflight-stamp.ts`, which also feeds the Vault gate).
- **Test hardening:** `PLUGIN_LOCAL_LIVE=1` never skips silently (`PLUGIN_LOCAL_SKIP=vault` to opt out); per-tool error canaries; `catalog-baseline` denies all network.
- **Full handoff:** `cos-share/reports/plugin/P17-handoff.md`.
