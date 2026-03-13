# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Remote MCP server deployed on Cloudflare Workers at `mcp.robynn.ai`. Exposes 17 brand-aware marketing tools to Claude via the Connectors Directory, including MCP Apps UI for intelligence reports. Uses OAuth 2.0 for authentication, with the actual user data stored on `robynn.ai` (SvelteKit frontend).

## Quick Start

```bash
pnpm install              # Install dependencies
npx wrangler dev          # Local dev at http://localhost:8787
npx tsc --noEmit          # Type-check (also: pnpm typecheck)
pnpm test                 # Run tests (vitest, watch mode)
pnpm test -- --run        # Single test run
pnpm test -- src/tools/geo.test.ts  # Run a single test file
npx wrangler deploy       # Deploy to production (mcp.robynn.ai)
```

## Tech Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26.0 (pinned to match `agents` package)
- **MCP Apps**: `@modelcontextprotocol/ext-apps` v1.1.2 — `registerAppTool` for tools with UI report output
- **Agent**: `agents` v0.7.5 — provides `McpAgent` base class (Durable Object)
- **OAuth**: `@cloudflare/workers-oauth-provider` v0.3.0
- **HTTP**: Hono v4 (auth handler routes)
- **Validation**: Zod v3 (tool parameter schemas)
- **Testing**: Vitest v3
- **Language**: TypeScript, ES2022 target

## Architecture

### Entry Point (`src/index.ts`)

The default export is an `OAuthProvider` that wraps everything:

```
OAuthProvider
├── /mcp, /sse         → RobynnMCP.serve() (McpAgent Durable Object)
├── /authorize         → Handled by OAuthProvider, delegated to auth handler
├── /token, /register  → Handled by OAuthProvider automatically
└── /* (default)       → robynnAuthHandler (Hono app)
```

### McpAgent Class (`RobynnMCP`)

Extends `McpAgent<Env, Record<string, never>, Props>`:
- One Durable Object instance per authenticated user
- `this.props.accessToken` contains the user's robynn.ai JWT
- `init()` creates a `RobynnClient`, registers shared MCP App resources, and registers all tools via `registerXTools(server, client)` functions
- MCP transport (Streamable HTTP + SSE) handled automatically by the base class

### Auth Flow (`src/auth-handler.ts`)

Hono app handling the user-facing OAuth consent flow:

1. `GET /authorize` — Generates CSRF state, stores in KV, redirects to `robynn.ai/oauth/authorize`
2. `GET /callback` — Validates state from KV, exchanges auth code for JWT via `robynn.ai/api/oauth/token`, decodes JWT for user/org info, calls `completeAuthorization()`
3. `GET /` — Health check / landing JSON
4. `GET /app-assets/report-app.js` — shared JS runtime for Robynn MCP Apps reports
5. `GET /.well-known/mcp.json` — MCP discovery config

### API Client (`src/robynn-client.ts`)

HTTP client that calls robynn.ai with Bearer token auth:

| Method | Endpoint | Timeout |
|--------|----------|---------|
| `getBrandContext(scope)` | `GET /api/cli/context/{scope}` | 10s |
| `getUsage()` | `GET /api/cli/usage` | 10s |
| `getStatus()` | `GET /api/cli/context/summary` | 10s |
| `listThreads()` | `GET /api/agents/cmo/threads` | 10s |
| `createThread(title)` | `POST /api/agents/cmo/threads` | 10s |
| `startRun(threadId, payload)` | `POST /api/agents/cmo/threads/{id}/runs` | 280s |
| `pollRun(runId)` | `GET /api/agents/cmo/runs/{id}` (polls every 2s) | 280s |

Poll timeout is 280s to stay under Claude's 300s limit.

## Tool Implementation Patterns

### Standard tools (`server.tool`)

Used by read-only and CMO-based tools:

```typescript
server.tool(
  "tool_name",
  "Description for the LLM",
  { param: z.string().describe("...") },
  { readOnlyHint: true, destructiveHint: false },
  async ({ param }) => {
    const result = await client.someMethod(param);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data as Record<string, unknown>,
    };
  }
);
```

### App tools (`registerAppTool`) — Phase 1 intelligence + guided-workflow tools

Used by GEO, battlecard, SEO, brand-book, and website tools. Produces both structured data and a linked HTML report resource:

```typescript
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";

registerAppTool(server, {
  name: "tool_name",
  description: "Description for the LLM",
  inputSchema: { param: z.string().describe("...") },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  outputResource: { uri: REPORT_RESOURCE_URIS.reportName, ... },
  execute: async ({ param }) => { ... },
});
```

### Key patterns (both variants)
- **No `authContext` in handler args** — `RobynnClient` created in `init()` and passed via closure
- **Always return both `content` and `structuredContent`** — text fallback for LLM + structured data for UI
- **Cast `structuredContent`** to `Record<string, unknown>` (SDK type requirement)
- **Wrap in try/catch** — return `isError: true` on failure
- **Safety annotations required** — `readOnlyHint`, `destructiveHint`, `openWorldHint` on every tool
- **App tools link a report resource** — `outputResource.uri` points to a `ui://reports/*.html` resource registered in `report-app.ts`

## Tools Reference

### Read-Only Tools (4)

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_brand_context` | `scope`: summary, voice, positioning, competitors, audience, products, rules, full | `GET /api/cli/context/{scope}` |
| `robynn_brand_rules` | (none) | `GET /api/cli/context/rules` |
| `robynn_status` | (none) | `GET /api/cli/context/summary` |
| `robynn_usage` | (none) | `GET /api/cli/usage` |

### CMO / Write Tools (3)

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_create_content` | `type`, `topic`, `instructions?`, `thread_id?` | Creates thread → starts run → polls to completion |
| `robynn_research` | `query`, `type?`, `thread_id?` | Creates thread → starts run → polls to completion |
| `robynn_conversations` | `action` (list/create), `title?` | Lists or creates CMO threads |

### Intelligence Tools (3) — App tools with report UI

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_geo_analysis` | `company_name`, `category?`, `questions?`, `competitors?`, `analysis_depth?` | `POST /api/cli/mcp/geo-analysis` |
| `robynn_competitive_battlecard` | `competitor_name`, `company_name?`, `focus_areas?`, `include_objections?` | `POST /api/cli/mcp/competitive-battlecard` |
| `robynn_seo_opportunities` | `company_name`, `company_url?`, `competitors?`, `keywords?`, `market_context?` | `POST /api/cli/mcp/seo-opportunities` |

### Brand Book Tools (5) — Guided-workflow app tools

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_brand_book_status` | `include_recent_reflections?` | `GET /api/cli/mcp/brand-book/status` |
| `robynn_brand_book_gap_analysis` | `focus_areas?`, `include_competitive_context?`, `include_examples?` | `POST /api/cli/mcp/brand-book/gap-analysis` |
| `robynn_brand_book_strategy` | `goals?`, `focus_areas?`, `include_intelligence_signals?` | `POST /api/cli/mcp/brand-book/strategy` |
| `robynn_brand_reflections` | `status_filter?`, `limit?` | `GET /api/cli/mcp/brand-book/reflections` |
| `robynn_publish_brand_book_html` | `theme?`, `include_private_sections?` | `POST /api/cli/mcp/brand-book/publish-html` |

### Website Tools (2) — Guided-workflow app tools

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_website_audit` | `website_url?`, `goals?`, `competitors?`, `analysis_depth?` | `POST /api/cli/mcp/website/audit` |
| `robynn_website_strategy` | `website_url?`, `primary_goal?`, `constraints?`, `priority_pages?` | `POST /api/cli/mcp/website/strategy` |

## File Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | `RobynnMCP` McpAgent class + `OAuthProvider` default export |
| `src/auth-handler.ts` | Hono app: `/authorize` redirect, `/callback` token exchange, health, `.well-known` |
| `src/robynn-client.ts` | HTTP client for robynn.ai API with timeout/polling |
| `src/internal-mcp-auth.ts` | HMAC signing for trusted MCP→robynn.ai token exchanges |
| `src/types.ts` | `Env`, `Props`, all request/result types for intelligence + guided-workflow tools |
| `src/tools/context.ts` | `robynn_brand_context` + `robynn_brand_rules` |
| `src/tools/status.ts` | `robynn_status` + `robynn_usage` |
| `src/tools/content.ts` | `robynn_create_content` |
| `src/tools/research.ts` | `robynn_research` |
| `src/tools/conversations.ts` | `robynn_conversations` |
| `src/tools/geo.ts` | `robynn_geo_analysis` (app tool) |
| `src/tools/battlecard.ts` | `robynn_competitive_battlecard` (app tool) |
| `src/tools/seo.ts` | `robynn_seo_opportunities` (app tool) |
| `src/tools/brand-book.ts` | 5 brand book tools (app tools) |
| `src/tools/website.ts` | `robynn_website_audit` + `robynn_website_strategy` (app tools) |
| `src/ui/report-app.ts` | Registers MCP App report resources (`ui://reports/*.html`) + `REPORT_RESOURCE_URIS` |
| `src/ui/report-app-script.ts` | Shared browser runtime for the interactive report apps |
| `wrangler.toml` | Worker config, KV + DO bindings, env vars |

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `OAUTH_KEY` | KV Namespace | Stores OAuth state during auth redirect flow (10-min TTL) |
| `OAUTH_KV` | KV Namespace | Same KV namespace as `OAUTH_KEY` (aliased for OAuthProvider) |
| `MCP_OBJECT` | Durable Object (`RobynnMCP`) | One instance per authenticated user — hosts MCP server |
| `ROBYNN_API_BASE_URL` | Env var | `https://robynn.ai` |
| `MCP_PUBLIC_BASE_URL` | Env var | `https://mcp.robynn.ai` — used for URL rewriting and report resource URIs |
| `CONNECTOR_STATE_SECRET` | Env var | Secret for HMAC-signed OAuth state |
| `MCP_INTERNAL_AUTH_SECRET` | Env var (optional) | Secret for signing trusted token exchanges with robynn.ai |
| `MCP_SERVER_NAME` | Env var | `Robynn` |
| `MCP_SERVER_VERSION` | Env var | `0.1.0` |

## Dependencies on robynnv3

This Worker depends on several endpoints on robynn.ai (the SvelteKit frontend):

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /oauth/authorize` | OAuth consent page (Supabase login + consent) | Session |
| `POST /api/oauth/token` | Token exchange (auth code → JWT + refresh token) | HMAC signature (`internal-mcp-auth.ts`) |
| `GET /api/cli/context/[scope]` | Granular brand context (8 scopes) | Bearer (API key or JWT) |
| `GET /api/cli/usage` | Token balance | Bearer |
| `GET /api/agents/cmo/threads` | List CMO threads | Bearer |
| `POST /api/agents/cmo/threads` | Create CMO thread | Bearer |
| `POST /api/agents/cmo/threads/{id}/runs` | Start CMO run | Bearer |
| `GET /api/agents/cmo/runs/{id}` | Poll run status | Bearer |
| `GET /api/cli/mcp/brand-book/status` | Brand book completeness snapshot | Bearer |
| `POST /api/cli/mcp/brand-book/gap-analysis` | Priority gap analysis | Bearer |
| `POST /api/cli/mcp/brand-book/strategy` | Brand improvement strategy | Bearer |
| `GET /api/cli/mcp/brand-book/reflections` | Brand reflections/changelog | Bearer |
| `POST /api/cli/mcp/brand-book/publish-html` | Generate HTML brand book | Bearer |
| `POST /api/cli/mcp/website/audit` | Website audit | Bearer |
| `POST /api/cli/mcp/website/strategy` | Website strategy | Bearer |
| `POST /api/cli/mcp/geo-analysis` | GEO visibility analysis | Bearer |
| `POST /api/cli/mcp/competitive-battlecard` | Competitive battlecard | Bearer |
| `POST /api/cli/mcp/seo-opportunities` | SEO opportunity analysis | Bearer |

JWT tokens issued by robynn.ai contain `{ sub: userId, org: organizationId, scope }`.

## Common Tasks

### Add a new tool

1. Create or edit a file in `src/tools/`
2. Follow the tool pattern (see above) — params schema + annotations + handler
3. Import and call `registerXTools(this.server, client)` in `src/index.ts` `init()`
4. Type-check: `npx tsc --noEmit`
5. Deploy: `npx wrangler deploy`

### Debug auth issues

1. Check Worker logs: `npx wrangler tail`
2. Verify KV state: `npx wrangler kv key list --binding OAUTH_KEY`
3. Test health: `curl https://mcp.robynn.ai/`
4. Test auth redirect: `curl -v https://mcp.robynn.ai/authorize`

### Update SDK version

The `@modelcontextprotocol/sdk` version MUST match what the `agents` package uses. Check with:
```bash
npm view agents dependencies
```
Then pin the same version in `package.json`.

## Important Notes

- **SDK version pinned to 1.26.0** — must match `agents` package dependency. Don't upgrade independently.
- **`structuredContent` requires casting** — use `as Record<string, unknown>` or `as unknown as Record<string, unknown>` because SDK expects index signature.
- **Durable Objects use `new_sqlite_classes`** — required for Cloudflare free plan (not `new_classes`).
- **Both `OAUTH_KEY` and `OAUTH_KV`** KV bindings exist — they point to the same KV namespace.
- **Poll timeout 280s** — under Claude's 300s tool call timeout.
- **Tests use vitest** — test files live alongside source as `*.test.ts` (e.g., `src/tools/geo.test.ts`).
- **URL rewriting in index.ts** — `POST /` is rewritten to `/mcp` and all requests are rewritten to use `MCP_PUBLIC_BASE_URL` as origin.
