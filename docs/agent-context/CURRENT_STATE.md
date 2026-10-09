# robynn-mcp-server Current State

Last updated: 2026-05-14

This repo provides the hosted Robynn MCP connector at `mcp.robynn.ai` and the local CLI bridge for command-based agents.

## Agent Memory

- Beads is initialized for repo-local task memory.
- No prior Beads issue history existed in this repo. The first Beads issue update should commit the exported `.beads/issues.jsonl`.
- Fresh clones should run `bd bootstrap --yes` before using `bd ready`.
- Beads uses embedded Dolt metadata so agents do not depend on a machine-local Dolt server.

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
- **Still open (P10):** refresh fails open when the upstream refresh fails (contract F12).

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
