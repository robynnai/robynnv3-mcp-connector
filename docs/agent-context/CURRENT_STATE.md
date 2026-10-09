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
- `src/__tests__/provider-contract.test.ts` pins provider/agents behaviour; `src/__tests__/catalog-baseline.test.ts` recounts 48/46/40 via real `tools/list` and validates the map. Change the map and these tests together.
- P12 (tool metadata): every tool registers via `registerTool`/`registerAppTool` with `toolMetadata(title, hints)`. Hints, titles and input-schema digests are locked to the map. The four † brand-book tools stay `readOnlyHint:false` until P07 removes the hidden completeness write; flip `BRAND_BOOK_READS_PERSIST_COMPLETENESS` in `src/tools/brand-book.ts` and the map together.

## Verification

Use `scripts/context-check.sh` for a lightweight readiness pass before making changes. Use `CLAUDE.md` and `README.md` for build, test, and deployment commands.
