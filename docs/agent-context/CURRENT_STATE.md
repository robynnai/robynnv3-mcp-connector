# robynn-mcp-server Current State

Last updated: 2026-10-09

This repo provides the hosted Robynn MCP connector at `mcp.robynn.ai` and the local CLI bridge for command-based agents.

## Agent Memory

- Beads is initialized for repo-local task memory.
- No prior Beads issue history existed in this repo. The first Beads issue update should commit the exported `.beads/issues.jsonl`.
- Fresh clones should run `bd bootstrap --yes` before using `bd ready`.
- Beads uses embedded Dolt metadata so agents do not depend on a machine-local Dolt server.

## Plugin v1 contracts (COS-PLUGIN-001)

- `docs/plugin-v1/AUTHORIZATION_CONTRACT.md` — grant record, introspection, Worker preflight, scope policy, error codes. Decision: stay on `@cloudflare/workers-oauth-provider` 0.3.0.
- `docs/plugin-v1/TOOL_CONTRACT.md` + `contracts/tool-route-map.json` — all 48 tools: scope, current vs proposed hints, app routes, side effects.
- `src/__tests__/provider-contract.test.ts` (35 cases, facts F1–F20) pins provider/agents behaviour; `src/__tests__/catalog-baseline.test.ts` recounts 48/46/40 via real `tools/list` and validates the map in both directions. Change the map and these tests together.
- Transport truth (F19): only streamable HTTP `/mcp` is served. `/sse` and `/sse/message` are auth-gated 404s that never reach a Durable Object, although `/sse` is still advertised in the resource aliases and landing JSON. v1 keeps SSE unserved (contract D10).
- P12 (tool metadata): every tool registers via `registerTool`/`registerAppTool` with `toolMetadata(title, hints)`. Hints, titles and input-schema digests are locked to the map. Five † tools stay `readOnlyHint:false` until P07 removes a hidden write from their read path: the four brand-book reads (`BRAND_BOOK_READS_PERSIST_COMPLETENESS` in `src/tools/brand-book.ts`) and `robynn_query_connected_app` (`CONNECTED_APP_READS_PERSIST_POLICY` in `src/tools/connectors.ts`). Flip the flag and the map entry (`hintsAfterP07` / `requiredScopeAfterP07`) together and regenerate the snapshot; `catalog-baseline.test.ts` derives its expectations from the flags.
- P13 (catalog contract, TOOL_CONTRACT §7): `src/__tests__/catalog-contract.test.ts` uses the real registration harness (`catalog-harness.ts`: real `RobynnMCP` DO activation and real `robynn mcp` CLI action, with stubbed app `fetch`).
  - It proves 48 / 46 (no `VAULT` or no `organizationId`) / 1 (unauthenticated) / 40 (CLI, intentional: no Vault, website family `core`).
  - It runs success, 422/503, 403, 401 and refused-input cases for every tool, with per-tool route attribution in both directions.
  - It pins the sanitized `tools/list` snapshot `contracts/mcp-tools.json`; regenerate with `UPDATE_MCP_TOOLS_SNAPSHOT=1`.
  - The old "exactly 41 tools" test in `all-tools.test.ts` is now named as a partial handler harness (48 − 5 Hermes − 2 Vault).

## Verification

Use `scripts/context-check.sh` for a lightweight readiness pass before making changes. Use `CLAUDE.md` and `README.md` for build, test, and deployment commands.

## Plugin v1 internal-auth signing (COS-PLUGIN-001 P03)

Updated 2026-10-09.

- **Secret:** `wrangler.toml` no longer commits `CONNECTOR_STATE_SECRET`. The Worker needs only `MCP_INTERNAL_AUTH_SECRET`, which must be set out of band and match the app. There is no fallback.
- **Signing:** every Worker → app `/api/oauth/token` request is v2-signed. That covers the `/callback` code exchange and both refresh call sites in `src/index.ts`. The signature uses HMAC over the timestamp, a single-use nonce, the method, the path and a body digest.
- **Docs:** contract, cross-repo test vector and deploy order are in `docs/plugin-v1/INTERNAL_AUTH_SIGNING.md`.
- **Tests:**
  - `src/internal-mcp-auth.test.ts`
  - `src/auth-handler.internal-auth.test.ts`
  - `src/index.refresh-signing.test.ts`
  - `src/wrangler-secrets.test.ts`
- **Closed by P10:** refresh no longer fails open when the upstream refresh fails (contract F12).

## Plugin v1 Worker OAuth front door (COS-PLUGIN-001 P06)

Updated 2026-10-09. Stacked on P03.

- **`/authorize`:**
  - Requires the code flow and an S256 challenge; a missing challenge is rejected too (F9).
  - Forwards exactly the requested scope (omitted ⇒ `brand:read`, unknown ⇒ `invalid_scope`).
  - Accepts only `{base}`, `{base}/` and `{base}/mcp` as `resource`.
  - Binds state to the browser with a per-transaction `HttpOnly` cookie.
- **`/callback`:**
  - Fails closed: state and cookie must match, and the state is single use.
  - The signed exchange's result is checked by app introspection; the JWT is only a hint and there is no `"unknown"` identity.
  - Requires granted ⊆ requested scopes, and the client name must still match.
  - **Until P05 (`gid`) and P10 (`/api/oauth/introspect`) land, every callback ends with an OAuth error to the host. This is intended.**
- **`/token`:** `redirect_uri` must equal the authorize-time value (F10). The binding is enforced in `tokenExchangeCallback` via grant props.
- **Transport:**
  - Only `/mcp` is served; other `/mcp*` and `/sse*` paths get 404 before the provider.
  - `ADVERTISE_SSE = false` is the single D-C switch.
- **Logging:** `src/safe-log.ts` only. Canary tests cover the OAuth paths.
- **Docs:** `docs/plugin-v1/WORKER_OAUTH_FRONT_DOOR.md`.

## Plugin v1 Worker session, Vault and refresh (COS-PLUGIN-001 P10)

Updated 2026-10-09. Stacked on P06, with P12 merged in.

- **Every `/mcp` request** passes `withMcpPreflight`: `unwrapToken`, legacy cutover (`authVersion !== 2` ⇒ revoke + 401), internal-header stripping, and the session binding read from the session DO's storage (mismatch ⇒ 404 `-32001`). Every `tools/call` also gets app introspection plus `TOOL_POLICY` (from `contracts/tool-route-map.json`). Inactive ⇒ revoke + 401; unavailable ⇒ `authorization_unavailable`, nothing forwarded.
- **`RobynnMCP`:** the binding is write-once; mismatching props are never adopted; foreign upgrades are refused; a newer upstream token is adopted on a warm session; there is no in-session refresh; P12's unauthenticated status tool is wired; there are server instructions.
- **Vault:** an R2-call-site gate needs the preflight stamp for the tool and grant; objects are capped at 1 MiB.
- **Refresh:** fail-closed typed errors (`invalid_grant` + revoke, or `temporarily_unavailable`, un-rotated), serialized per grant by the `RefreshCoordinator` DO. **`wrangler.toml` migration `v2`.**
- **Docs:** `docs/plugin-v1/WORKER_SESSION_AUTHORIZATION.md`.

