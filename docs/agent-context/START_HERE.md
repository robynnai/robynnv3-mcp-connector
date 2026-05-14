# robynn-mcp-server Agent Context

Last updated: 2026-05-14

This repo owns the Robynn Cloudflare Workers MCP connector and the local `@robynn-ai/cli` bridge.

## Cold Start

1. Read `AGENTS.md`, then `CLAUDE.md`.
2. Run `scripts/context-check.sh`.
3. Use Beads for task state:

```bash
bd ready --json
```

If Beads is not ready, run:

```bash
bd bootstrap --yes
```

This repo did not previously have Beads history. After the first Beads issue is created, commit the exported `.beads/issues.jsonl` with the relevant code/docs change.

## Workspace Contract

Coordinate with:

- `robynnv3` for OAuth, Robynn API routes, CLI gateway endpoints, and user-facing auth flows.
- `robynnv3_agents` for LangGraph/agent behavior behind gateway calls.

MCP connector changes land in this repo. Frontend/API changes land in `robynnv3`. Agent-backend changes land in `robynnv3_agents`.
