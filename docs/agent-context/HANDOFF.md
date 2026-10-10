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

