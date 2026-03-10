# Brand Book Improvement MCP Implementation Plan

Date: 2026-03-10
Repo: `robynn-mcp-server`
Status: Ready for execution
Related docs:
- `docs/plans/2026-03-09-intelligence-first-mcp-design.md`
- `docs/plans/2026-03-09-intelligence-first-mcp-implementation-plan.md`
- `docs/plans/2026-03-09-mcp-apps-ui-design.md`

## Objective

Extend the Robynn connector from an intelligence-first reporting surface into a guided marketer workflow that:

1. helps a newly connected user understand how complete their brand book is,
2. shows what is missing or weak,
3. turns intelligence into concrete brand-book improvement strategy,
4. then expands into website audit and website improvement planning.

The immediate next phase should center on brand book completion and improvement.

The follow-on phase should center on website audit and website improvement.

## Current Baseline

The connector already ships:

- OAuth-authenticated remote MCP on Cloudflare Workers
- Phase 1 intelligence tools:
  - `robynn_geo_analysis`
  - `robynn_competitive_battlecard`
  - `robynn_seo_opportunities`
- MCP Apps UI for those three intelligence reports
- read/write support for generic brand context, brand rules, content, research, and conversations

The broader platform already has the main primitives needed for the next phase:

### In `robynnv3`

- `brand_hub_docs` as the source of truth for structured brand data
- `BrandBookV2Service` with `calculateBrandCompleteness()`
- dashboard save APIs for company info, positioning, competitors, voice attributes, vocabulary, proof points, and other brand-book sections
- brand changelog and reflection pipeline under `brand_hub_docs_changelog`
- share/export services for brand book HTML/PDF aggregation
- existing CLI auth pattern through `validateApiKey`

### In `robynnv3_agents`

- `website_report_v1` for deep website intelligence and artifact generation
- `cmo_audit_v1` for broader strategy-style website/marketing audit output
- existing `landing_page_roast` skill focus in CMO agents for faster page critique flows

## Product Goals

- Make the first post-connect experience feel guided instead of exposing a flat tool list
- Turn Robynn into the brand system behind Claude, not just a set of marketing prompts
- Create a strong onboarding loop:
  - connect
  - inspect brand-book completeness
  - improve weak areas
  - audit the website
  - execute daily work from the improved brand context
- Preserve the current thin-MCP architecture and avoid pushing business logic into the Worker

## Non-Goals

- Replacing the current intelligence tools
- Supporting unrestricted free-form brand-book writes from Claude on day one
- Mirroring the entire dashboard editing surface inside MCP immediately
- Shipping website editing or CMS publishing in this phase

## Recommended Approach

Three implementation approaches are possible.

### Approach A: Read-first orchestration with selective follow-up writes

Add MCP-safe routes and tools that read the current brand-book state, compute gaps, generate an improvement strategy, expose pending reflections, and publish shareable exports. Defer direct mutation tools until the read and recommendation loop is stable.

Why this is the recommended approach:

- safest for source-of-truth integrity
- fastest path to marketer-visible value
- easiest to make deterministic and testable
- gives us room to observe how users want Claude to propose edits before allowing writes

### Approach B: Full write-through brand-book editing from the connector

Expose structured update tools immediately for most brand-book sections.

Why not first:

- higher risk of bad writes and audit complexity
- larger permission and UX surface
- more fragile because the dashboard APIs are section-specific and not yet MCP-shaped

### Approach C: Route everything through the generic CMO/research tools

Rely on existing content and research tools instead of introducing dedicated brand-book tools.

Why not first:

- weak onboarding clarity
- harder to market and document
- does not create a crisp post-connect workflow

Recommendation: ship Approach A first, then add narrow write tools once the read/recommend/export loop is proven.

## Proposed Product Surface

### Phase 1: Brand Book Completion And Improvement

Ship these tools first:

- `robynn_brand_book_status`
  - returns completeness score, section health, missing items, and readiness summary
- `robynn_brand_book_gap_analysis`
  - explains what is missing, what is weak, and what inputs would most improve downstream content quality
- `robynn_brand_book_strategy`
  - combines current brand context with available intelligence signals to recommend how to improve positioning, voice, differentiation, and proof
- `robynn_brand_reflections`
  - surfaces pending or recent brand reflections/changelog items for review
- `robynn_publish_brand_book_html`
  - returns a shareable/exportable brand book artifact or link using the existing export pipeline

Deliberately defer:

- `robynn_update_brand_book`
- `robynn_accept_brand_reflection`
- `robynn_edit_brand_reflection`

Those can follow as a Phase 1.5 once we freeze the approval model.

### Phase 2: Website Audit And Improvement

Ship after Phase 1 stabilizes:

- `robynn_website_audit`
  - structured website audit across SEO, GEO, messaging, conversion, and competitor context
- `robynn_website_strategy`
  - prioritized website improvement plan tied to the user’s goals and current brand book

Optional later extension:

- `robynn_website_improvement_brief`
  - converts strategy into page-level rewrite briefs, experiments, or sprint plans

## Architecture Decisions

### 1. Keep the MCP server thin

`robynn-mcp-server` should continue to own:

- OAuth and connector auth lifecycle
- tool declarations and metadata
- parameter validation
- response shaping for Claude
- MCP Apps resource registration

It should not own:

- brand-book scoring logic
- brand context mutation logic
- website analysis logic
- report generation business logic

### 2. Add explicit MCP-safe route families in `robynnv3`

Like the Phase 1 intelligence rollout, the Worker should call dedicated, stable app routes instead of reaching into dashboard-only endpoints.

Recommended Phase 1 route family:

- `GET /api/cli/mcp/brand-book/status`
- `POST /api/cli/mcp/brand-book/gap-analysis`
- `POST /api/cli/mcp/brand-book/strategy`
- `GET /api/cli/mcp/brand-book/reflections`
- `POST /api/cli/mcp/brand-book/publish-html`

Recommended Phase 2 route family:

- `POST /api/cli/mcp/website/audit`
- `POST /api/cli/mcp/website/strategy`

### 3. Separate read/report tools from write tools

All initial tools in this plan should be read/report oriented, even if they aggregate or transform data from internal systems.

If later write tools are added, they should use:

- explicit destructive/write safety annotations
- narrower schemas per document type
- auditable update records
- clear permission boundaries

### 4. Normalize results into stable MCP envelopes

Each route should return:

- `success`
- `data`
- `error`

Each `data` block should include:

- `summary`
- `status`
- `artifacts`
- `recommended_actions`
- `next_steps`
- tool-specific structured fields

### 5. Reuse MCP Apps UI for the new guided surfaces

The current shared report app shell should be extended rather than creating unrelated UI stacks.

Recommended new resources:

- `ui://reports/brand-book-status.html`
- `ui://reports/brand-book-strategy.html`
- `ui://reports/website-audit.html`

`robynn_brand_reflections` can start as structured/text output first if the review UX is still evolving.

## Route Contracts

### `robynn_brand_book_status`

Request:

- no required params
- optional `include_recent_reflections`

Response minimum:

- `summary`
- `status`
- `completeness_score`
- `sections`
- `missing_items`
- `recommended_actions`
- `artifacts`

Primary source:

- `BrandBookV2Service.calculateBrandCompleteness()`

### `robynn_brand_book_gap_analysis`

Request:

- optional `focus_areas`
- optional `include_competitive_context`
- optional `include_examples`

Response minimum:

- `summary`
- `status`
- `highest_priority_gaps`
- `section_findings`
- `content_readiness_impact`
- `recommended_actions`

Primary sources:

- brand-book completeness
- brand context
- brand rules
- competitors and proof points where available

### `robynn_brand_book_strategy`

Request:

- optional `goals`
- optional `focus_areas`
- optional `include_intelligence_signals`

Response minimum:

- `summary`
- `status`
- `strategic_priorities`
- `positioning_recommendations`
- `voice_recommendations`
- `competitive_recommendations`
- `proof_recommendations`
- `recommended_actions`

Primary sources:

- current brand context
- existing brand-book data
- optional GEO/SEO/battlecard-derived signals where available

### `robynn_brand_reflections`

Request:

- optional `status_filter`
- optional `limit`

Response minimum:

- `summary`
- `status`
- `pending_reflections`
- `recent_reflections`
- `recommended_actions`

Primary sources:

- `brand_hub_docs_changelog`
- changelog analysis services

### `robynn_publish_brand_book_html`

Request:

- optional `theme`
- optional `include_private_sections`

Response minimum:

- `summary`
- `status`
- `artifacts`
  - `html`
  - `pdf` when available
  - shareable URL if generated
- `recommended_actions`

Primary sources:

- `BrandBookExportService`
- existing brand book HTML template/export pipeline

### `robynn_website_audit`

Request:

- optional `website_url` if absent, default from organization website
- optional `goals`
- optional `competitors`
- optional `analysis_depth`

Response minimum:

- `summary`
- `status`
- `messaging_findings`
- `seo_findings`
- `geo_findings`
- `conversion_findings`
- `competitor_findings`
- `artifacts`
- `recommended_actions`

Primary backend:

- `website_report_v1`

### `robynn_website_strategy`

Request:

- optional `website_url`
- optional `primary_goal`
- optional `constraints`
- optional `priority_pages`

Response minimum:

- `summary`
- `status`
- `priority_plan`
- `page_level_recommendations`
- `messaging_changes`
- `seo_geo_changes`
- `measurement_plan`
- `recommended_actions`

Primary backend:

- `website_report_v1` plus a strategy summarization layer
- optional selective use of `cmo_audit_v1` for deeper planning paths

## Execution Strategy

### Batch 1: Contracts And Baseline Read APIs

- freeze tool names and route contracts
- add shared types in `robynn-mcp-server`
- implement `brand-book/status`
- define shared response envelopes and adapter helpers in `robynnv3`

Checkpoint:

- completeness and section health can be fetched through one MCP-safe route

### Batch 2: Brand Book Analysis And Strategy

- implement `brand-book/gap-analysis`
- implement `brand-book/strategy`
- normalize brand context, completeness, and competitor data into stable response objects

Checkpoint:

- new user with partial brand data gets a coherent improvement plan

### Batch 3: Reflections And Publishable Brand Book Output

- implement `brand-book/reflections`
- implement `brand-book/publish-html`
- expand MCP Apps UI for brand-book report screens

Checkpoint:

- Claude can show both the current state and a shareable artifact of the brand book

### Batch 4: Website Audit

- implement `website/audit` route and tool
- normalize `website_report_v1` output into MCP-safe sections
- add report UI for audit results

Checkpoint:

- Claude can audit the organization website with structured findings and a readable report

### Batch 5: Website Improvement Strategy

- implement `website/strategy`
- connect audit findings to brand-book context and business goals
- add follow-up recommended actions and page-level priorities

Checkpoint:

- Claude can move from website diagnosis to a real prioritized improvement plan

## Workstreams

## Workstream A: Contracts, Types, And Tool Taxonomy

Primary repo:

- `robynn-mcp-server`

Tasks:

1. Freeze the new public tool names.
2. Define request and response types for all new brand-book and website tools.
3. Decide guaranteed vs optional fields.
4. Extend `src/types.ts` and test fixtures.

Deliverables:

- stable TypeScript contracts for Phase 1 and Phase 2 tools

## Workstream B: `robynnv3` MCP-Safe Brand Book Routes

Primary repo:

- `robynnv3`

Tasks:

1. Add route family under `src/routes/api/cli/mcp/brand-book/`.
2. Reuse `validateApiKey` so routes work for API keys and OAuth JWTs.
3. Build a shared adapter module that translates:
   - company info
   - completeness
   - brand context
   - competitors
   - voice attributes
   - reflections
   into stable MCP envelopes.
4. Reuse existing export services for `publish-html`.

Suggested files:

- `src/routes/api/cli/mcp/brand-book/status/+server.ts`
- `src/routes/api/cli/mcp/brand-book/gap-analysis/+server.ts`
- `src/routes/api/cli/mcp/brand-book/strategy/+server.ts`
- `src/routes/api/cli/mcp/brand-book/reflections/+server.ts`
- `src/routes/api/cli/mcp/brand-book/publish-html/+server.ts`
- `src/lib/server/mcp/brand-book-adapters.ts`

## Workstream C: `robynnv3_agents` Website Result Normalization

Primary repo:

- `robynnv3_agents`

Tasks:

1. Review `website_report_v1` output shape for MCP consumption.
2. Add a lightweight normalization layer if the raw output is too artifact-heavy or inconsistent.
3. Define the minimum stable sections needed for:
   - website audit
   - website strategy
4. Decide whether `cmo_audit_v1` is needed in Phase 2 or should remain a deeper follow-on path.

Deliverables:

- deterministic website audit/strategy output contract

## Workstream D: MCP Server Tooling And App UI

Primary repo:

- `robynn-mcp-server`

Tasks:

1. Extend `src/robynn-client.ts` with brand-book and website client methods.
2. Add tool modules for the new surfaces.
3. Register new tools in `src/index.ts`.
4. Extend the shared report app shell for brand-book and website results.
5. Add focused tests for metadata, routing, and error handling.

Suggested tool files:

- `src/tools/brand-book-status.ts`
- `src/tools/brand-book-gap.ts`
- `src/tools/brand-book-strategy.ts`
- `src/tools/brand-reflections.ts`
- `src/tools/brand-book-publish.ts`
- `src/tools/website-audit.ts`
- `src/tools/website-strategy.ts`

## Workstream E: Verification And Launch Readiness

Primary repos:

- `robynn-mcp-server`
- `robynnv3`
- `robynnv3_agents`

Tasks:

1. Verify auth and happy paths for all new routes.
2. Verify report payload size stays practical for Claude.
3. Validate fallbacks when:
   - brand book is sparse
   - no reflections exist
   - company website is missing
   - website audit providers are partially unavailable
4. Capture sample requests and outputs for internal review.

## File Touch Map

### `robynn-mcp-server`

- `src/index.ts`
- `src/robynn-client.ts`
- `src/types.ts`
- new `src/tools/*` files for brand-book and website tools
- `src/ui/report-app.ts`
- `src/ui/report-app-script.ts`
- new test files

### `robynnv3`

- `src/routes/api/cli/mcp/brand-book/*`
- `src/routes/api/cli/mcp/website/*`
- optional shared helpers under `src/lib/server/mcp/`

### `robynnv3_agents`

- `website_report_v1` normalization helpers or wrapper output formatting
- optional website strategy summarizer helper
- new tests for normalized MCP-facing payloads

## Testing And Verification

### `robynn-mcp-server`

- `pnpm test`
- `npx tsc --noEmit`

### `robynnv3`

- route tests for each new MCP-safe endpoint
- `pnpm run build`

### `robynnv3_agents`

- targeted tests around `website_report_v1`
- targeted tests for any new normalization helpers

### Manual checks

- authenticate through the connector
- run `robynn_brand_book_status` on a sparse org and a mature org
- run `robynn_brand_book_strategy` after GEO/SEO/battlecard data exists
- publish a brand book HTML artifact
- run `robynn_website_audit` using the org website default

## Risks And Mitigations

### Risk: brand-book write complexity leaks into Phase 1

Mitigation:

- keep initial tools read/report oriented
- defer mutation tools until approval semantics are clear

### Risk: platform data is fragmented across v1 and v2 brand-book documents

Mitigation:

- centralize MCP adapters in `robynnv3`
- never let the Worker stitch raw documents directly

### Risk: website audit outputs are too large or too slow

Mitigation:

- normalize into compact sections
- cap returned artifacts
- keep deeper raw outputs as optional artifacts rather than inline text

### Risk: reflections are not yet ready for direct approval from Claude

Mitigation:

- start with read-only reflections listing
- add accept/edit actions only after audit trail and UX review

## Success Criteria

- A new connector user can ask, "How complete is my brand book?" and get a structured answer with next steps.
- A user can ask, "How should I improve my brand book?" and get a prioritized strategy rooted in current Robynn data.
- A user can ask for a shareable brand book and receive a branded export artifact.
- A user can ask for a website audit and get a structured report tied back to their brand context.
- All new tools work through the same OAuth-authenticated remote connector flow and preserve thin-server architecture.

## Recommended Sequencing

1. Ship `robynn_brand_book_status` first.
2. Ship `robynn_brand_book_gap_analysis` and `robynn_brand_book_strategy`.
3. Ship `robynn_publish_brand_book_html`.
4. Ship `robynn_brand_reflections`.
5. Move to `robynn_website_audit`.
6. Finish with `robynn_website_strategy`.

This order creates the clearest user journey:

connect -> inspect brand health -> improve the brand system -> publish the brand system -> audit the website -> improve the website
