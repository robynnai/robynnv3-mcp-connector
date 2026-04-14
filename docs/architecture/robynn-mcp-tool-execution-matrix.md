# Robynn MCP Tool Execution Matrix

## Why This Exists

This document answers two recurring questions:

1. Which MCP tools actually use a LangGraph agent in `robynnv3_agents`?
2. Which layer is responsible for the interactive MCP Apps UI?

Short answer:

- some tools are thin reads over `robynnv3` APIs or services
- some tools proxy into specialized LangGraph assistants in `robynnv3_agents`
- the interactive UI is always emitted by the Cloudflare Worker in `robynn-mcp-server`, not by the backend agent

## UI Ownership

Interactive report rendering lives in the Worker:

- report resources are registered in [src/ui/report-app.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/ui/report-app.ts)
- the browser runtime and rerun behavior live in [src/ui/report-app-script.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/ui/report-app-script.ts)
- app-capable tools attach a `ui://reports/*.html` resource via `_meta.ui.resourceUri`

Backend routes and agents only return data. The Worker turns that data into:

- `content` for model fallback
- `structuredContent` for machine-readable results
- optional MCP Apps UI for compatible hosts

## Tool Matrix

| Tool | Category | Worker registration | robynnv3 entrypoint | Actual execution backend | Uses `robynnv3_agents`? | Inline MCP App UI |
|---|---|---|---|---|---|---|
| `robynn_brand_context` | Brand context | `server.tool` | `GET /api/cli/context/{scope}` | Direct `robynnv3` context API | No | No |
| `robynn_brand_rules` | Brand context | `server.tool` | `GET /api/cli/context/rules` | Direct `robynnv3` context API | No | No |
| `robynn_status` | Status | `server.tool` | `GET /api/cli/context/summary` | Direct `robynnv3` status API | No | No |
| `robynn_usage` | Status | `server.tool` | `GET /api/cli/usage` | Direct `robynnv3` usage API | No | No |
| `robynn_conversations` | Thread management | `server.tool` | `GET/POST /api/agents/cmo/threads` | `robynnv3` thread persistence around the CMO workflow | No agent run for `list` or `create` | No |
| `robynn_create_content` | CMO execution | `server.tool` | `POST /api/agents/cmo/threads`, `POST /api/agents/cmo/threads/{id}/runs`, `GET /api/agents/cmo/runs/{id}` | `robynnv3` instant-agent thread/run pipeline | Yes, via the configured CMO assistant. Current default is `env.INSTANT_AGENT_ASSISTANT_ID || "cmo_v2"` | No |
| `robynn_research` | CMO execution | `server.tool` | `POST /api/agents/cmo/threads`, `POST /api/agents/cmo/threads/{id}/runs`, `GET /api/agents/cmo/runs/{id}` | `robynnv3` instant-agent thread/run pipeline | Yes, via the configured CMO assistant. Current default is `env.INSTANT_AGENT_ASSISTANT_ID || "cmo_v2"` | No |
| `robynn_assist` | CMO execution | `server.tool` | `POST /api/agents/cmo/threads`, `POST /api/agents/cmo/threads/{id}/runs`, `GET /api/agents/cmo/runs/{id}` | `robynnv3` instant-agent thread/run pipeline with caller-provided routing hints | Yes, via explicit `assistant_id`, `route_hint`, `requested_capability`, and optional history/memory hints | No |
| `robynn_geo_analysis` | Intelligence | `registerAppTool` | `POST /api/cli/mcp/geo-analysis` -> `/api/agents/geo/execute` | GEO proxy in `robynnv3`, then LangGraph `geo_researcher` by default | Yes | Yes |
| `robynn_seo_opportunities` | Intelligence | `registerAppTool` | `POST /api/cli/mcp/seo-opportunities` -> `/api/agents/seo/execute` | SEO proxy in `robynnv3`, then LangGraph `env.SEO_ASSISTANT_ID || "seo_researcher"` | Yes. In `robynnv3_agents`, `seo_researcher` maps to `seo_researcher_v5` | Yes |
| `robynn_competitive_battlecard` | Intelligence | `registerAppTool` | `POST /api/cli/mcp/competitive-battlecard` | Direct LangGraph `competitor_intelligence_v1`, then read latest row from `competitor_battlecards` | Yes | Yes |
| `robynn_brand_book_status` | Brand book | `registerAppTool` | `GET /api/cli/mcp/brand-book/status` | Direct `robynnv3` brand-book export + completeness + changelog services | No | Yes |
| `robynn_brand_book_gap_analysis` | Brand book | `registerAppTool` | `POST /api/cli/mcp/brand-book/gap-analysis` | Direct `robynnv3` brand-book adapter logic over exported brand data | No | No |
| `robynn_brand_book_strategy` | Brand book | `registerAppTool` | `POST /api/cli/mcp/brand-book/strategy` | Direct `robynnv3` brand-book adapter logic over exported brand data | No | Yes |
| `robynn_brand_reflections` | Brand book | `registerAppTool` | `GET /api/cli/mcp/brand-book/reflections` | Direct `robynnv3` changelog/reflection query logic | No | No |
| `robynn_publish_brand_book_html` | Brand book | `registerAppTool` | `POST /api/cli/mcp/brand-book/publish-html` | Direct `robynnv3` export aggregation + HTML generation | No | No |
| `robynn_website_audit` | Website intelligence | `registerAppTool` | `POST /api/cli/mcp/website/audit` | `robynnv3` adapter calls LangGraph `website_report_v1`, then normalizes the report into MCP-safe sections | Yes | Yes |
| `robynn_website_strategy` | Website intelligence | `registerAppTool` | `POST /api/cli/mcp/website/strategy` | `robynnv3` adapter calls LangGraph `website_report_v1`, then normalizes the report into a strategy view | Yes | Yes |

## Tool Families

### 1. Direct `robynnv3` API and service tools

These do not call `robynnv3_agents`:

- `robynn_brand_context`
- `robynn_brand_rules`
- `robynn_status`
- `robynn_usage`
- `robynn_brand_book_status`
- `robynn_brand_book_gap_analysis`
- `robynn_brand_book_strategy`
- `robynn_brand_reflections`
- `robynn_publish_brand_book_html`

These are fulfilled by `robynnv3` routes and service-layer logic, mainly:

- brand context APIs
- usage/status APIs
- brand-book export aggregation
- brand hub changelog/reflection queries
- HTML export generation

### 2. CMO thread/run tools

These use the CMO thread/run system exposed by `robynnv3`:

- `robynn_create_content`
- `robynn_research`
- `robynn_assist`

They do not call a specialized MCP-safe report route. Instead they:

- create or reuse a thread
- start a run
- poll the run until completion

The catch-all `robynn_assist` tool forwards caller hints directly into the existing thread/run path, while the legacy content and research tools continue using the CMO assistant selected by `robynnv3`.

### 3. Specialized intelligence agents

These use purpose-built agent paths rather than the general CMO thread runner:

- `robynn_geo_analysis` -> `geo_researcher`
- `robynn_seo_opportunities` -> `seo_researcher` -> `seo_researcher_v5`
- `robynn_competitive_battlecard` -> `competitor_intelligence_v1`
- `robynn_website_audit` -> `website_report_v1`
- `robynn_website_strategy` -> `website_report_v1`

These are the best tools to test when you want to validate specialized LangGraph behavior instead of the general CMO flow.

## Source Pointers

### Worker registration

- [src/index.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/index.ts)
- [src/tools/context.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/context.ts)
- [src/tools/status.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/status.ts)
- [src/tools/content.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/content.ts)
- [src/tools/research.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/research.ts)
- [src/tools/conversations.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/conversations.ts)
- [src/tools/geo.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/geo.ts)
- [src/tools/seo.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/seo.ts)
- [src/tools/battlecard.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/battlecard.ts)
- [src/tools/brand-book.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/brand-book.ts)
- [src/tools/website.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/src/tools/website.ts)

### `robynnv3` MCP-safe adapters and routes

- [src/lib/server/mcp/brand-book-adapters.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/lib/server/mcp/brand-book-adapters.ts)
- [src/lib/server/mcp/website-adapters.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/lib/server/mcp/website-adapters.ts)
- [src/routes/api/cli/mcp/geo-analysis/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/geo-analysis/+server.ts)
- [src/routes/api/cli/mcp/seo-opportunities/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/seo-opportunities/+server.ts)
- [src/routes/api/cli/mcp/competitive-battlecard/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/competitive-battlecard/+server.ts)
- [src/routes/api/cli/mcp/brand-book/status/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/brand-book/status/+server.ts)
- [src/routes/api/cli/mcp/brand-book/gap-analysis/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/brand-book/gap-analysis/+server.ts)
- [src/routes/api/cli/mcp/brand-book/strategy/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/brand-book/strategy/+server.ts)
- [src/routes/api/cli/mcp/brand-book/reflections/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/brand-book/reflections/+server.ts)
- [src/routes/api/cli/mcp/brand-book/publish-html/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/brand-book/publish-html/+server.ts)
- [src/routes/api/cli/mcp/website/audit/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/website/audit/+server.ts)
- [src/routes/api/cli/mcp/website/strategy/+server.ts](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3/src/routes/api/cli/mcp/website/strategy/+server.ts)

### `robynnv3_agents` assistant registry

- [langgraph.json](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3_agents/langgraph.json)
