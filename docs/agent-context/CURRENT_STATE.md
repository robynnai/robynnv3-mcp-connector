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

## Local Plugin Testing (COS-PLUGIN-001)

`wrangler.local.toml` runs this Worker for the workspace's non-production
`plugin-local` stack: `wrangler dev --local` on `http://localhost:8787`,
pointing at the app on `http://localhost:5173`, with Miniflare-emulated KV,
Durable Object and R2 storage under `.wrangler/state/cos-plugin-001`. It has
no routes, account IDs or remote bindings, and it carries no secrets. Secret
names are listed in `.dev.vars.example`; the workspace scripts generate local
values and pass them with `--env-file`. Never deploy with this config.
`src/wrangler-local-config.test.ts` keeps it aligned with `wrangler.toml`.
Start it through the workspace's `./scripts/plugin-dev-up.sh` (see the
workspace `docs/agent-context/PLUGIN_LOCAL_TESTING.md`).
