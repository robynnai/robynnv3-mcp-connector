# robynn-mcp-server Handoff

Last updated: 2026-05-14

For future agents:

1. Start with `docs/agent-context/START_HERE.md`.
2. Run `scripts/context-check.sh`.
3. Inspect Beads with `bd ready --json` after bootstrap.
4. Keep PRs scoped to this repo unless the user asks for coordinated cross-repo work.

When a change affects `robynnv3` or `robynnv3_agents`, update the relevant repo in its own branch/PR and only update the root workspace submodule pointer after those PRs land.

## COS-PLUGIN-001 P03: Worker internal-auth signing (2026-10-09)

- **Branch and PR:** `plugin-v1/p03-worker-internal-auth`, draft PR #55. P06 stacks on it.
- **Paired with:** robynnv3 `plugin-v1/p03-signing-token-auth`. The two must ship together. Deploy order: secrets → app migration → Worker → app (see `docs/plugin-v1/INTERNAL_AUTH_SIGNING.md` §5).
- **For P10:** reuse `internalMcpRequestHeaders` for introspection. Do not add a second signing scheme.
- **Full handoff:** `cos-share/reports/plugin/P03-handoff.md`.
