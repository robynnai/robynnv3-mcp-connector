# AGUI → MCP Parity Design

Date: 2026-08-05  
Status: approved for planning  
Repos: `robynnv3-mcp-connector`, `robynnv3` (contract + runner), `robynnv3_agents` (no required changes for v1)

## Problem

Instant Agent / CMO v3 now emits typed AGUI `response_blocks` (decision cards, charts, progress pipelines, tables, etc.). These are stashed on run metadata as `finalized_response_blocks` / `live_response_blocks` and rendered in the product chat via `ChatBlockRenderer`.

The MCP CMO path still returns legacy text only:

- `runCmoAgentForMcp` → `resolveLegacyRunOutput` reads `instant_agent_messages.content`
- MCP tools put that string in `content` / `structuredContent`
- Decision cards, charts, and clarify state are dropped

MCP clients therefore cannot see or act on the AGUI contract that product already uses.

## Goals

Phased delivery (approved):

| Phase | Goal |
| --- | --- |
| **A** | Structured passthrough: MCP tool results include `response_blocks` in `structuredContent` with a readable text fallback |
| **B** | MCP Apps report UI: render a high-value block subset in the existing report-app surface |
| **C** | Interactive clarify: decision-card choices can be submitted back through MCP to continue the same CMO thread |

## Non-goals (v1)

- Live mid-run SSE / streaming block updates (`artifact_draft_delta`, progressive live projectors)
- Full Instant Agent widget parity (`tone_picker`, `refine_inline`, `variation_picker`, `outline` editors, etc.)
- New writer-copilot MCP tool (separate track)
- Changes inside `robynnv3_agents` emit contract (reuse what CMO v3 already emits)
- Replacing existing guided intelligence tools (GEO, battlecard, SEO reports)

## Success criteria

1. A completed `robynn_cmo_agent` / `robynn_run_status` / `robynn_assist` response includes validated `response_blocks` when the underlying Instant Agent run has them.
2. Text content remains useful when the host ignores `structuredContent`.
3. Clarify runs surface `clarify_pending: true` plus decision-card blocks instead of looking like empty/failed text runs.
4. Phase B renders the approved block subset in MCP Apps without crashing on unknown types.
5. Phase C can continue a thread after a decision selection with one MCP tool call.
6. Default routing docs and tool descriptions point at CMO v3 (not stale `cmo_v2`).

## Approach

**Contract-first passthrough** across `robynnv3` + MCP connector.

Rejected alternatives:

- MCP-only scraping of run/messages (duplicates Instant Agent parsing, fragile)
- Separate GenUI status tool only (two-call UX; hosts often skip the second call)

## Architecture

```
MCP client
  → robynn_cmo_agent | robynn_run_status | robynn_assist [| robynn_cmo_decide]
  → robynnv3 MCP/CMO APIs
  → startInstantAgentRun / syncInstantAgentRun (default assistant_id = cmo_v3)
  → run.metadata.finalized_response_blocks | live_response_blocks
  → CmoAgentResult / run poll payload includes response_blocks + clarify flags
  → MCP structuredContent + text fallback
  → (Phase B) MCP Apps report resource renders block subset
```

Reuse existing helper in robynnv3:

- `extractResponseBlocksFromRunMetadata(run.metadata)` in `src/lib/server/instant-agent/runs.ts`

Do not invent a parallel block schema. Import / mirror the Instant Agent `ResponseBlock` catalog from `src/lib/types/response-blocks.ts` into MCP contracts carefully (zod on the API boundary; TypeScript types in the connector).

## Phase A — Structured passthrough

### API contract (`robynnv3`)

Extend `CmoAgentResultSchema` in `src/lib/server/mcp/contracts.ts`:

```ts
response_blocks: z.array(z.record(z.unknown())).default([])
has_decision_cards: z.boolean().default(false)
clarify_pending: z.boolean().default(false)
```

Rules:

- `response_blocks` are opaque-but-validated at the edge with `parseResponseBlocks` before serialization (invalid blocks dropped, never fail the whole run).
- Prefer `finalized_response_blocks`; fall back to `live_response_blocks` via `extractResponseBlocksFromRunMetadata`.
- `has_decision_cards` is true when any remaining block has `type === "decision_card"`.
- `clarify_pending` is true when the run completed/paused in a clarify-style state **or** decision cards are present and no final deliverable text is available. Exact predicate must reuse Instant Agent’s existing clarify/bare-ask semantics where possible; if no single flag exists, derive:
  - `clarify_pending = has_decision_cards && (output is empty/null OR output is a short clarification prompt)`
- Keep `output` as the human-readable text (current behavior). Do not strip prose when blocks exist.

Also expose the same fields on the MCP-facing run status path used by `robynn_run_status` (poll payload), so pending → completed transitions carry blocks.

### Runner (`robynnv3`)

Update `runCmoAgentForMcp` in `src/lib/server/mcp/cmo-agent-runner.ts`:

- After resolving legacy output, attach blocks from run metadata.
- Pending responses may include `live_response_blocks` when present (optional nicety; required once Phase B cares about progress pipelines).
- Failed/cancelled responses leave `response_blocks: []`.

### MCP connector

Update:

- `src/types.ts` — `CmoAgentResult` / run result types
- `src/robynn-client.ts` — pass-through parsing
- `src/tools/cmo-agent.ts`, `src/tools/runs.ts`, `src/tools/assist.ts` — include blocks in `structuredContent`
- Text fallback builder: summarize block counts + decision questions when present, e.g.

```
CMO agent completed.
Decision needed: Which channel should we prioritize first?
Options: LinkedIn | Email | Paid search
response_blocks: 3 (1 decision_card, 1 table, 1 chart)
```

Default / docs:

- Tool descriptions mention CMO v3 and optional `route_hint`.
- README + execution matrix stop claiming `cmo_v2` as the default (backend default is already `cmo_v3`).

### Tools in scope for Phase A

| Tool | Required |
| --- | --- |
| `robynn_cmo_agent` | Yes |
| `robynn_run_status` | Yes |
| `robynn_assist` | Yes |
| `robynn_create_content` / `robynn_research` | Best-effort if they share run poll shaping; otherwise follow-up |

## Phase B — MCP Apps report render

### Block subset (render)

Must render:

- `table`
- `chart`
- `metric_card`
- `priority_list`
- `progress_pipeline`
- `status_checklist`
- `decision_card` (read-only in Phase B: show question + options, no submit UI required)

### Unknown / deferred types

Skip silently and list skipped types in a footer count. Do not attempt interactive editors (`outline`, `variation_picker`, `tone_picker`, `refine_inline`) in v1.

### UI surface

Extend the existing MCP Apps report runtime (`src/ui/report-app.ts`, `src/ui/report-app-script.ts`) used by CMO/app tools. Prefer one shared “AGUI blocks” renderer section rather than per-tool forks.

`robynn_cmo_agent` should link an output resource when blocks are present (or always link a lightweight result report).

### No live streaming

Phase B renders the blocks returned by the completed/pending tool response only. Polling remains client-driven via `robynn_run_status`.

## Phase C — Interactive clarify

### New tool

`robynn_cmo_decide`

Inputs:

- `thread_id` (required)
- `run_id` (required; the run that produced the decision cards)
- `decision_id` (required; maps to `DecisionCardBlock.decisionId`)
- `option_id` (required; selected option id)
- optional `note` (free-text addendum)

Behavior:

1. Load the referenced run; verify org/thread access.
2. Confirm the decision card + option exist in that run’s `response_blocks`.
3. Build a continuation user message using the same semantic shape Instant Agent uses for checkpoint/decision replies (`checkpoint-reply.ts` pattern: decision question + selected option label).
4. Start a new Instant Agent run on the same thread with that message (default `cmo_v3`).
5. Return the same `CmoAgentResult` shape as `robynn_cmo_agent` (including new `response_blocks`).

### Report interactivity

After Phase C, decision cards in MCP Apps may include a host-capable hint (selected option echo) but Claude-driven hosts can simply call `robynn_cmo_decide`. Do not depend on browser postMessage for v1 correctness; the tool is the source of truth.

## Error handling

| Case | Behavior |
| --- | --- |
| No blocks on run | `response_blocks: []`, existing text output unchanged |
| Invalid block payloads | Drop invalid entries; never 500 the MCP tool |
| Clarify with no text | `clarify_pending: true`, text fallback lists decision questions |
| Unknown `decision_id` / `option_id` | Phase C tool returns `isError` with actionable message |
| Stale run / wrong thread | 404-style error from API; MCP maps to tool error |
| Pending run | Existing pending + `poll_after_seconds`; include live blocks if available |

## Testing

### robynnv3

- Contract tests: `CmoAgentResultSchema` accepts/rejects new fields
- Runner tests: finalized blocks attached; live fallback; empty on failure
- Clarify fixture: decision cards → `has_decision_cards` / `clarify_pending`
- Phase C: decide happy path + invalid option

### MCP connector

- Tool tests: `structuredContent.response_blocks` present
- Text fallback includes decision question when clarify pending
- Report renderer unit tests for each Phase B block type + unknown-type skip
- `robynn_cmo_decide` registration + client method tests

## Rollout / PR strategy

1. **PR1 (robynnv3):** Phase A contract + runner + run-status fields + tests
2. **PR2 (MCP connector):** Phase A types/client/tools/docs + tests
3. **PR3 (MCP connector):** Phase B report renderers
4. **PR4 (robynnv3 + MCP):** Phase C `robynn_cmo_decide` end-to-end

Each PR must be independently shippable. Phase B/C must not break Phase A consumers that ignore UI.

## Docs to update

- MCP `README.md` tool matrix / CMO default
- `docs/architecture/robynn-mcp-tool-execution-matrix.md`
- `CLAUDE.md` tool count + CMO notes (stale today)
- robynnv3 `capability-catalog.ts` note for decide tool when Phase C lands

## Open implementation details (non-blocking for this spec)

These are settled enough to plan; implementers should follow Instant Agent source of truth at coding time:

1. Exact `clarify_pending` predicate — derive from decision cards + output emptiness if no dedicated run flag exists.
2. Whether pending polls always include live blocks in Phase A or only once Phase B needs progress pipelines — default: include whenever present.
3. Whether `robynn_create_content` / `robynn_research` get full parity in PR2 or a fast follow — default: include if shared poll helper makes it cheap; otherwise follow-up issue.
`)
