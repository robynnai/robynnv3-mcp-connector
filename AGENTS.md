# AGENTS.md

Follow `/Users/madhukarkumar/AGENTS.md` as the global baseline for all work.

Read `CLAUDE.md` for this repository's architecture, commands, and MCP implementation details.

## Startup

Run this first:

```bash
scripts/context-check.sh
```

Then read:

1. `docs/agent-context/START_HERE.md`
2. `docs/agent-context/CURRENT_STATE.md`
3. `CLAUDE.md`

## Repo Boundary

This repo owns the Cloudflare Workers MCP connector and local `@robynn-ai/cli` bridge. Open PRs for MCP connector changes in this repo.

Coordinate cross-repo changes with:

- `robynnv3` for Robynn API, OAuth, and gateway endpoints.
- `robynnv3_agents` for LangGraph/agent execution behavior.

## Memory

Use Beads for repo-local task state. Fresh clones should run:

```bash
bd bootstrap --yes
bd ready --json
```

When Beads issues exist, the tracked source of truth is `.beads/issues.jsonl`. Local Dolt/runtime files must stay untracked.
