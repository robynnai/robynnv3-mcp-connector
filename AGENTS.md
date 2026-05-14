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

## Beads PR Workflow

Every PR must account for Beads before it is opened or updated.

- Run `bd bootstrap --yes` and `bd ready --json` before starting tracked work.
- If the work maps to an existing Beads issue, claim it with `bd update <issue-id> --claim --json`.
- Before committing, close or update the issue. Completed work should use `bd close <issue-id> --reason "Completed in this PR" --json`.
- Commit `.beads/issues.jsonl` with the code/docs changes whenever Beads state changes.
- Include a `Beads: <issue-id|none>` line in the PR body. Use `Beads: none` only for mechanical changes that do not represent durable task state, and explain why.
- If follow-up work is discovered, create a linked issue with `bd create "Follow-up title" --description "Context..." -t task -p 2 --deps discovered-from:<issue-id> --json`.
