# Intelligence-First MCP Implementation Plan

Date: 2026-03-09
Repo: `robynn-mcp-server`
Status: Ready for execution
Related design: `docs/plans/2026-03-09-intelligence-first-mcp-design.md`

## Objective

Ship an intelligence-first Robynn MCP surface that is meaningfully differentiated from native Claude usage.

The initial shipping target is a Phase 1 intelligence core:

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`

The plan also lays the foundation for:

- `robynn_market_monitor`
- `robynn_landing_page_audit`
- `robynn_abm_campaign`

## Success Criteria

### Product outcomes

- Claude users can authenticate once and run the three Phase 1 intelligence tools successfully
- Each tool returns structured data plus a readable summary and recommended next actions
- The tool surface reinforces the intelligence-first positioning instead of generic content creation

### Technical outcomes

- `robynn-mcp-server` remains a thin OAuth-authenticated MCP facade
- `robynnv3` exposes stable API-key and OAuth-safe routes for MCP consumption
- `robynnv3_agents` returns normalized, dependable payloads for the MCP-facing workflows
- Tests exist in all touched repos for contract, auth, and result-shaping behavior

## Scope

### In scope for this plan

- MCP tool contracts for GEO, battlecard, and SEO
- Dedicated or clearly-scoped CLI/MCP API routes in `robynnv3`
- Response normalization and adapter work in `robynnv3_agents` where needed
- MCP server tool registration, client methods, schemas, and tests
- End-to-end verification for auth, request flow, and result shape

### Out of scope for the first execution cycle

- Replacing the existing 7 MCP tools
- Full rollout of `robynn_market_monitor`, `robynn_landing_page_audit`, and `robynn_abm_campaign`
- UI work in Claude beyond tool descriptions and response shape
- New data pipelines unrelated to the selected tools

## Architecture Decisions

### 1. Keep the MCP server thin

`robynn-mcp-server` should continue to own:

- OAuth and connector-facing auth lifecycle
- MCP tool declarations and metadata
- parameter validation
- response shaping for Claude
- transport concerns

It should not own:

- long-running research orchestration
- agent-specific prompt logic
- competitive or SEO business logic
- brand-monitor persistence

### 2. Add explicit MCP-safe backend routes in `robynnv3`

The current app already has:

- direct execute proxies for GEO, SEO, ABM, and CMO
- CLI context and usage endpoints authenticated via `validateApiKey`
- brand-monitor routes for dashboard usage

However, the current surface is not yet a clean MCP contract. The implementation should add a dedicated API family under `src/routes/api/cli/mcp/` in `robynnv3` so the MCP server can call explicit, stable endpoints instead of session-only or playbook-internal routes.

Recommended Phase 1 endpoint family:

- `POST /api/cli/mcp/geo-analysis`
- `POST /api/cli/mcp/competitive-battlecard`
- `POST /api/cli/mcp/seo-opportunities`

Recommended Phase 2 endpoints:

- `GET /api/cli/mcp/market-monitor`
- `POST /api/cli/mcp/landing-page-audit`
- `POST /api/cli/mcp/abm-campaign`

### 3. Normalize agent outputs before MCP consumes them

The MCP should not depend on raw LangGraph response shapes. `robynnv3` route handlers or shared adapter modules should translate agent-specific output into stable MCP-oriented envelopes.

Each endpoint should return:

- `success`
- `data`
- `error`

Each `data` block should contain:

- `summary`
- `status`
- `artifacts`
- `recommended_actions`
- tool-specific structured fields

## Execution Strategy

The work should be executed in four batches with explicit checkpoints.

### Batch 1: Contracts and foundations

- Finalize parameter schemas and response envelopes
- Decide exact route names and payloads in `robynnv3`
- Add shared TypeScript interfaces in the MCP repo
- Add shared adapter or schema modules in `robynnv3` if needed

Checkpoint:

- No implementation should proceed past scaffolding until tool contracts are frozen

### Batch 2: Phase 1 backend enablement

- Implement GEO and SEO MCP-safe routes
- Implement battlecard MCP-safe route
- Add or refine backend result normalization for each route

Checkpoint:

- All three routes can be hit locally with authenticated test requests and return stable JSON

### Batch 3: MCP tool implementation

- Add client methods in `robynn-mcp-server`
- Add new tool registration modules
- Register the tools in `src/index.ts`
- Add unit tests for success, validation, and failure responses

Checkpoint:

- MCP repo passes typecheck and tests

### Batch 4: End-to-end verification and rollout prep

- Run route-level verification in `robynnv3`
- Run targeted agent verification in `robynnv3_agents`
- Validate OAuth-authenticated MCP flow locally
- Update README or connector docs only if needed after behavior stabilizes

Checkpoint:

- One full happy-path run per Phase 1 tool

## Parallel Workstreams

These workstreams are intentionally decomposed so multiple sub-agents or parallel sessions can implement them with minimal overlap.

## Workstream A: Contracts And Shared Schemas

Recommended owner: Subagent A

Primary repo:

- `robynn-mcp-server`

Supporting repo:

- `robynnv3`

Tasks:

1. Freeze the public MCP tool names and parameter schemas.
2. Define shared response envelopes for Phase 1 tools.
3. Add TypeScript interfaces in `robynn-mcp-server/src/types.ts` for:
   - GEO analysis result
   - competitive battlecard result
   - SEO opportunity result
   - shared status and error envelope
4. Decide which fields are guaranteed versus optional.
5. Document the route contract assumptions inside the implementation plan or inline code comments.

Deliverables:

- Updated shared types in `robynn-mcp-server`
- Contract notes for `robynnv3` route implementers

Tests:

- Type-only validation in the MCP repo
- If extracted into schema modules, add unit tests for parsing/validation

Verification:

- `cd robynn-mcp-server && pnpm run typecheck`

Dependencies:

- None

## Workstream B: `robynnv3` MCP-Safe API Routes

Recommended owner: Subagent B

Primary repo:

- `robynnv3`

Tasks:

1. Create route family under `src/routes/api/cli/mcp/`.
2. Reuse `validateApiKey` so routes work for API keys and OAuth JWTs.
3. Implement `POST /api/cli/mcp/geo-analysis` by delegating to existing GEO execution infrastructure and returning normalized output.
4. Implement `POST /api/cli/mcp/seo-opportunities` by delegating to the existing SEO execute flow and returning normalized output.
5. Implement `POST /api/cli/mcp/competitive-battlecard` with a new proxy path to the competitor agent or equivalent execution layer.
6. Ensure organization context is derived from validated auth, not trusted from raw caller input.
7. Add a shared helper for consistent endpoint response shaping.

Suggested files:

- `src/routes/api/cli/mcp/geo-analysis/+server.ts`
- `src/routes/api/cli/mcp/seo-opportunities/+server.ts`
- `src/routes/api/cli/mcp/competitive-battlecard/+server.ts`
- optional shared helper under `src/lib/server/mcp/`

Tests:

- Route handler tests mirroring existing `server.test.ts` style
- Auth failure test per route
- Validation failure test per route
- Success-path result normalization test per route
- Upstream error propagation test per route

Verification:

- `cd robynnv3 && pnpm run test_run -- src/routes/api/cli/mcp`
- `cd robynnv3 && pnpm run build`

Dependencies:

- Should start after Workstream A freezes route payloads

## Workstream C: `robynnv3_agents` Result Normalization And Gaps

Recommended owner: Subagent C

Primary repo:

- `robynnv3_agents`

Tasks:

1. Review Phase 1 agent output shapes for:
   - `geo_researcher_v1`
   - `competitor_intelligence_v1`
   - `seo_researcher_v5`
2. Identify whether `robynnv3` can safely adapt current outputs or whether agent-side normalization is needed.
3. Add normalization helpers or lightweight response builders if the raw outputs are inconsistent.
4. Ensure battlecard outputs contain stable sections for:
   - comparison summary
   - objections
   - differentiators
   - blind spots or risks
   - recommended actions
5. Ensure GEO and SEO outputs expose concise summary fields in addition to detailed artifacts.

Tests:

- Targeted unit tests for any new adapters or helper functions
- Existing agent tests should still pass
- Add at least one regression test per Phase 1 agent for the normalized fields consumed by MCP

Verification:

- `cd robynnv3_agents && uv run pytest tests/test_geo_e2e_suite.py -q`
- `cd robynnv3_agents && uv run pytest tests/test_seo_v5_integration.py -q`
- `cd robynnv3_agents && uv run pytest tests/unit/agents/test_competitor_intelligence_v1.py -q`

Dependencies:

- Can run in parallel with Workstream B after contracts are frozen

## Workstream D: MCP Server Tool Implementation

Recommended owner: Subagent D

Primary repo:

- `robynn-mcp-server`

Tasks:

1. Extend `src/robynn-client.ts` with methods for the new `robynnv3` MCP-safe routes.
2. Add tool modules:
   - `src/tools/geo.ts`
   - `src/tools/battlecard.ts`
   - `src/tools/seo.ts`
3. Register the new tools in `src/index.ts`.
4. Add new result types to `src/types.ts`.
5. Ensure all tools:
   - validate params with Zod
   - include safety annotations
   - return `content` and `structuredContent`
   - return clear `isError` responses
6. Decide whether to keep current legacy tools unchanged or mark them as secondary in docs only.

Tests:

- Add Vitest coverage for:
  - new client methods
  - tool happy paths
  - tool upstream error handling
  - malformed backend response handling

Suggested test files:

- `src/tools/geo.test.ts`
- `src/tools/battlecard.test.ts`
- `src/tools/seo.test.ts`
- `src/robynn-client.test.ts`

Verification:

- `cd robynn-mcp-server && pnpm run typecheck`
- `cd robynn-mcp-server && pnpm test`

Dependencies:

- Should begin once Workstream B route contracts are stable

## Workstream E: End-To-End Verification And Launch Readiness

Recommended owner: Subagent E

Primary repos:

- `robynn-mcp-server`
- `robynnv3`
- `robynnv3_agents`

Tasks:

1. Run one authenticated happy-path request for each Phase 1 endpoint in `robynnv3`.
2. Run one local MCP happy-path invocation per Phase 1 tool.
3. Verify OAuth login still completes and `/.well-known/mcp.json` remains valid.
4. Confirm tool responses stay under practical token limits and remain readable in Claude.
5. Validate failure scenarios:
   - unauthorized
   - missing brand context
   - invalid competitor inputs
   - upstream timeout or execution failure
6. Capture example requests and responses for future docs or connector review.

Verification commands:

- `cd robynnv3 && pnpm run build`
- `cd robynn-mcp-server && pnpm run typecheck && pnpm test`
- `cd robynnv3_agents && uv run pytest tests/test_agents.py -q`

Manual checks:

- `curl http://localhost:8787/.well-known/mcp.json`
- `curl http://localhost:8787/`
- local request to each `robynnv3` MCP-safe route with valid auth
- local MCP Inspector smoke test against `/mcp`

Dependencies:

- After Workstreams B, C, and D land

## Phase 1 Tool Contracts

These are the recommended contracts the implementation should lock.

### `robynn_geo_analysis`

Request:

- `company_name`
- `category` or `questions`
- optional `competitors`
- optional `analysis_depth`

Response minimum:

- `summary`
- `status`
- `visibility_scores`
- `citation_breakdown`
- `query_gaps`
- `recommended_actions`

### `robynn_competitive_battlecard`

Request:

- `competitor_name`
- optional `company_name`
- optional `focus_areas`
- optional `include_objections`

Response minimum:

- `summary`
- `status`
- `comparison`
- `objections`
- `differentiators`
- `risks`
- `recommended_actions`

### `robynn_seo_opportunities`

Request:

- `company_name`
- optional `company_url`
- optional `competitors`
- optional `keywords`
- optional `market_context`

Response minimum:

- `summary`
- `status`
- `opportunities`
- `keyword_gaps`
- `competitor_comparison`
- `recommended_actions`

## Proposed File Touch Map

This is the expected first-pass change map for execution.

### `robynn-mcp-server`

- `src/index.ts`
- `src/robynn-client.ts`
- `src/types.ts`
- `src/tools/geo.ts`
- `src/tools/battlecard.ts`
- `src/tools/seo.ts`
- new corresponding test files

### `robynnv3`

- `src/routes/api/cli/mcp/geo-analysis/+server.ts`
- `src/routes/api/cli/mcp/competitive-battlecard/+server.ts`
- `src/routes/api/cli/mcp/seo-opportunities/+server.ts`
- optional shared helper files under `src/lib/server/mcp/`
- new route test files

### `robynnv3_agents`

- possible normalization helpers in agent directories
- possible regression tests for Phase 1 result shapes

## Recommended Order For Multiple Sub-Agents

If executed by multiple sub-agents or parallel sessions, use this order:

1. Subagent A completes contracts and shared types.
2. Subagent B and Subagent C work in parallel on `robynnv3` routes and `robynnv3_agents` normalization.
3. Subagent D wires the MCP server once backend routes and payloads are stable.
4. Subagent E runs end-to-end verification and captures failures.

This keeps overlap low and preserves a clean handoff boundary.

## Review Gates

Before merging any execution branch, require:

- Contract review for all public tool names, params, and response shapes
- Route tests passing in `robynnv3`
- MCP tests and typecheck passing in `robynn-mcp-server`
- Targeted regression coverage in `robynnv3_agents`
- One human-reviewed sample response per Phase 1 tool

## Future Follow-On Plan

After Phase 1 is stable, repeat the same pattern for:

- `robynn_market_monitor`
- `robynn_landing_page_audit`
- `robynn_abm_campaign`

Then evaluate:

- `robynn_persona_finder`
- `robynn_prospect_finder`

Those future additions should reuse the same MCP-safe route pattern, shared response envelope, and verification gates established in this plan.
