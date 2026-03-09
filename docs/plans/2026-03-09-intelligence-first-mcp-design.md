# Intelligence-First MCP Design

Date: 2026-03-09
Repo: `robynn-mcp-server`
Status: Approved for planning

## Summary

Robynn's MCP should be positioned as an intelligence-first marketing workspace for Claude, not as a generic content generator. The primary value is giving B2B enterprise marketers access to proprietary market intelligence, brand context, competitive analysis, and downstream actions that Claude cannot perform by itself.

The product wedge should be:

> Monitor brand visibility, competitor pressure, and market opportunities across AI, search, and messaging surfaces, then turn that into action.

This positioning supports both product marketing and demand generation while preserving strong repeat usage.

## Product Goals

### Primary goals

- Differentiate Robynn from native Claude capabilities
- Create strong weekly repeat usage, not just one-time novelty
- Preserve a high-wow first session through one or two standout tools
- Make intelligence outputs naturally lead into diagnostic or execution workflows

### Non-goals

- Competing with Claude on generic writing alone
- Exposing every backend agent as a top-level MCP tool
- Requiring users to understand Robynn internal agent names or routing mechanics

## Recommended Product Shape

The MCP should be organized conceptually into three layers.

### Layer 1: Market Intelligence Core

These tools define the connector and should anchor the product messaging:

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`
- `robynn_market_monitor`

These tools answer the repeat-use questions:

- How visible are we?
- Where are competitors beating us?
- What search opportunities are we missing?
- What changed since last week?

### Layer 2: Diagnostic Action Tools

These tools convert intelligence into optimization work:

- `robynn_landing_page_audit`
- `robynn_brand_health`

They should feel like natural follow-through from Layer 1 rather than standalone products.

### Layer 3: Execution And Expansion Tools

These tools help users act on what they learn:

- `robynn_abm_campaign`
- Future: `robynn_persona_finder`
- Future: `robynn_prospect_finder`
- Future: `robynn_ad_briefs`

Execution should support the intelligence layer, not define the connector.

## Recommended Initial Tool Set

The recommended v1 surface is:

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`
- `robynn_market_monitor`
- `robynn_landing_page_audit`
- `robynn_abm_campaign`

`robynn_brand_health` is a strong near-term follow-up if its scoring and prioritization outputs are crisp and repeatable.

## Tool Definitions

### `robynn_geo_analysis`

Purpose: Measure brand visibility across major AI answer engines for a category, query set, or competitor set.

Why it is differentiated:

- Claude cannot benchmark presence across multiple AI engines in one run
- Robynn can combine multi-LLM querying with brand-aware interpretation

Expected output:

- Visibility scores by model
- Citation breakdown by brand, competitor, and neutral source
- Query-level opportunity gaps
- Recommended messaging and content actions

Backend candidate:

- `geo_researcher_v1`

### `robynn_competitive_battlecard`

Purpose: Generate current battlecards against named competitors using live data and Robynn brand context.

Why it is differentiated:

- The value is not generic competitor summarization
- The value comes from combining internal positioning context with live evidence and objection handling

Expected output:

- Head-to-head comparison
- Likely buyer objections
- Differentiators to emphasize
- Risk areas and blind spots
- Suggested sales talk track

Backend candidate:

- `competitor_intelligence_v1`
- Optional enhancement from CMO competitive blindspots skill

### `robynn_seo_opportunities`

Purpose: Find keyword and topic gaps relative to competitors using real search and SEO data.

Why it is differentiated:

- Claude can ideate keywords but cannot independently perform trusted gap analysis from proprietary SEO tools

Expected output:

- High-opportunity keywords and topics
- Search volume, difficulty, and ranking context
- Competitor overlap and whitespace
- Suggested content or landing page plays

Backend candidate:

- `seo_researcher_v5`

### `robynn_market_monitor`

Purpose: Provide ongoing market and brand signal awareness rather than a narrow mention tracker.

Why rename from `robynn_brand_monitor`:

- "Market monitor" better communicates strategic repeat usage
- The tool should feel like a weekly intelligence workflow, not just passive monitoring

Expected output:

- New competitor moves
- Brand mention and sentiment changes
- Share-of-voice shifts
- "What changed since last run?" summary
- Recommended follow-up actions

Backend candidate:

- `org_intelligence_v1`
- CMO `brand_monitor` capability where useful

### `robynn_landing_page_audit`

Purpose: Evaluate a URL against conversion, clarity, positioning, and brand fit.

Why it is differentiated only if done well:

- Claude can already perform a generic page critique
- Robynn wins only if the audit is brand-aware, competitor-aware, and grounded in actual page extraction

Expected output:

- Friction points
- Messaging clarity issues
- CTA and conversion recommendations
- Suggested rewritten sections
- Priority-ranked fixes

Backend candidate:

- CMO `landing_page_roast`

### `robynn_abm_campaign`

Purpose: Generate a personalized campaign package for a target account.

Why it belongs in the product:

- Strong action-oriented follow-through from intelligence findings
- Good demo value after the core intelligence story is established

Expected output:

- Account summary
- Persona-specific hooks
- Landing page outline or copy
- LinkedIn ads
- Email sequence
- Suggested sequencing

Backend candidate:

- `abm_campaign_v1`

## Critique Of Candidate Tools

### Highest priority

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`
- `robynn_market_monitor`

These are the strongest combination of differentiation, repeat usage, and strategic value for enterprise marketers.

### Strong but secondary

- `robynn_landing_page_audit`
- `robynn_abm_campaign`
- `robynn_brand_health`

These are useful and compelling, but they should support the intelligence core rather than define the connector.

### Lower priority as standalone connector tools

- `robynn_content_ideas`
- `robynn_ad_briefs`
- `robynn_gtm_sprint`

These may still be valuable backend capabilities, but they are weaker top-level MCP hooks because they are either less differentiated or less likely to drive frequent in-Claude usage.

## Session Model

The connector should behave like a market intelligence system inside Claude, not like a bag of disconnected RPC calls.

### First-session wow

Users should be able to start with a high-impact question such as:

- "How visible are we in AI for enterprise CDP?"
- "Build a battlecard for us vs Salesforce."

### Repeat-use loop

The weekly usage pattern should revolve around:

- What changed?
- Where are we slipping?
- What should we fix next?
- Turn that into a concrete asset or campaign

### Recommended conversational flow

1. `robynn_geo_analysis` identifies visibility gaps
2. `robynn_competitive_battlecard` explains competitor pressure
3. `robynn_landing_page_audit` or `robynn_seo_opportunities` identifies remediation opportunities
4. `robynn_abm_campaign` helps the team act on those findings

Each major intelligence tool should answer:

- What is happening?
- Why does it matter?
- What should we do next?

## Architecture Recommendations

`robynn-mcp-server` should remain a thin OAuth-authenticated facade. It should not absorb backend orchestration complexity.

Responsibilities of the MCP server:

- OAuth and session/auth lifecycle
- MCP tool registration
- Parameter validation and tool metadata
- Response shaping and structured outputs
- Stable public contracts for Claude

Responsibilities of backend services:

- Running agent workflows
- Tooling integrations and research pipelines
- Long-running orchestration
- Persistence, history, and monitoring state

### Backend integration preference

Preferred:

- Direct endpoints for stable first-class agents such as `geo_researcher_v1`, `competitor_intelligence_v1`, `seo_researcher_v5`, `abm_campaign_v1`, and `cmo_audit_v1`

Acceptable for early iterations:

- Calls routed through `cmo_v2` or `cmo_v3` skill focuses like `landing_page_roast`, `competitive_blindspots`, `gtm_sprint`, and `brand_monitor`

Long term, high-value MCP tools should map to explicit backend contracts rather than generalized prompt-routing inside a universal CMO agent.

## Error Handling And Trust

Trust is critical for enterprise users. Tool responses should expose clear, structured outcomes.

Each tool should return:

- Structured status
- Short human-readable summary
- Useful machine-readable payload
- Specific failure mode where possible

Important failure cases to distinguish:

- Auth failure
- Missing brand context
- Insufficient competitive data
- URL scrape failure
- Long-running task timeout
- Backend execution failure

Even when the underlying system uses polling, the output should feel deliberate rather than opaque.

## Rollout Plan

### Phase 1

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`

### Phase 2

- `robynn_market_monitor`
- `robynn_landing_page_audit`

### Phase 3

- `robynn_abm_campaign`
- Future persona and prospect tools

This ordering maximizes differentiation first, then establishes repeat usage, then adds execution depth.

## Open Product Notes

- Keep generic content generation in the product, but do not lead with it
- Avoid exposing too many adjacent "analysis" tools that feel interchangeable
- Favor outcome-oriented names over backend or internal agent terminology
- Product marketing and demand generation are both served best by the same intelligence-first wedge

## Proposed Next Step

Create an implementation plan for:

1. New MCP tool contracts and parameter schemas
2. Required backend endpoints in `robynnv3` or `robynnv3_agents`
3. Response schemas and common status/error envelope
4. Launch sequencing for the first 3 tools
