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
