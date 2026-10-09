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
- `src/__tests__/provider-contract.test.ts` (35 cases, facts F1–F20) pins provider/agents behaviour; `src/__tests__/catalog-baseline.test.ts` (7 cases) recounts 48/46/40 via real `tools/list` and validates the map in both directions. Change the map and these tests together.
- Transport truth (F19): only streamable HTTP `/mcp` is served. `/sse` and `/sse/message` are auth-gated 404s that never reach a Durable Object, although `/sse` is still advertised in the resource aliases and landing JSON. v1 keeps SSE unserved (contract D10).

## Verification

Use `scripts/context-check.sh` for a lightweight readiness pass before making changes. Use `CLAUDE.md` and `README.md` for build, test, and deployment commands.
