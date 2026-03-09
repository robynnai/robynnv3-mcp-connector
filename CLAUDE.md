# CLAUDE.md — Robynn MCP Server

This file provides guidance to Claude Code when working in this repository.

## Overview

Remote MCP server deployed on Cloudflare Workers at `mcp.robynn.ai`. Exposes 10 brand-aware marketing tools to Claude via the Connectors Directory, including MCP Apps UI for the Phase 1 intelligence reports. Uses OAuth 2.0 for authentication, with the actual user data stored on `robynn.ai` (SvelteKit frontend).

## Quick Start

```bash
pnpm install              # Install dependencies
npx wrangler dev          # Local dev at http://localhost:8787
npx tsc --noEmit          # Type-check
npx wrangler deploy       # Deploy to production (mcp.robynn.ai)
```

## Tech Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26.0 (pinned to match `agents` package)
- **Agent**: `agents` v0.7.5 — provides `McpAgent` base class (Durable Object)
- **OAuth**: `@cloudflare/workers-oauth-provider` v0.3.0
- **HTTP**: Hono v4 (auth handler routes)
- **Validation**: Zod v3 (tool parameter schemas)
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
- `init()` creates a `RobynnClient`, registers shared MCP App resources, and registers all 10 tools
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

## Tool Implementation Pattern

All tools follow the same pattern:

```typescript
server.tool(
  "tool_name",                                    // Name
  "Description for the LLM",                      // Description
  { param: z.string().describe("...") },          // Zod params schema
  { readOnlyHint: true, destructiveHint: false },  // Safety annotations
  async ({ param }) => {                           // Handler (no auth context — client via closure)
    const result = await client.someMethod(param);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data as Record<string, unknown>,
    };
  }
);
```

Key patterns:
- **No `authContext` in handler args** — the `RobynnClient` is created in `init()` from `this.props.accessToken` and passed to tool registration functions via closure
- **Always return both `content` and `structuredContent`** — text fallback for LLM + structured data for UI rendering
- **Cast `structuredContent`** to `Record<string, unknown>` (SDK type requirement)
- **Wrap in try/catch** — return `isError: true` on failure
- **Safety annotations required** — `readOnlyHint`, `destructiveHint`, `openWorldHint` on every tool

## Tools Reference

### Read-Only Tools (4)

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_brand_context` | `scope`: summary, voice, positioning, competitors, audience, products, rules, full | `GET /api/cli/context/{scope}` |
| `robynn_brand_rules` | (none) | `GET /api/cli/context/rules` |
| `robynn_status` | (none) | `GET /api/cli/context/summary` |
| `robynn_usage` | (none) | `GET /api/cli/usage` |

### Write Tools (3)

| Tool | Params | Calls |
|------|--------|-------|
| `robynn_create_content` | `type`, `topic`, `instructions?`, `thread_id?` | Creates thread → starts run → polls to completion |
| `robynn_research` | `query`, `type?`, `thread_id?` | Creates thread → starts run → polls to completion |
| `robynn_conversations` | `action` (list/create), `title?` | Lists or creates CMO threads |

## File Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | `RobynnMCP` McpAgent class + `OAuthProvider` default export |
| `src/auth-handler.ts` | Hono app: `/authorize` redirect, `/callback` token exchange, health, `.well-known` |
| `src/robynn-client.ts` | HTTP client for robynn.ai API with timeout/polling |
| `src/types.ts` | `Env`, `Props`, `RobynnApiResponse`, `BrandContextData`, `UsageData`, `Thread`, `RunResult` |
| `src/tools/context.ts` | `robynn_brand_context` + `robynn_brand_rules` |
| `src/tools/status.ts` | `robynn_status` + `robynn_usage` |
| `src/tools/content.ts` | `robynn_create_content` |
| `src/tools/research.ts` | `robynn_research` |
| `src/tools/conversations.ts` | `robynn_conversations` |
| `src/tools/geo.ts` | `robynn_geo_analysis` |
| `src/tools/battlecard.ts` | `robynn_competitive_battlecard` |
| `src/tools/seo.ts` | `robynn_seo_opportunities` |
| `src/ui/report-app.ts` | Registers Robynn MCP App report resources (`ui://reports/*.html`) |
| `src/ui/report-app-script.ts` | Shared browser runtime for the interactive report apps |
| `wrangler.toml` | Worker config, KV + DO bindings, env vars |
| `package.json` | Dependencies + scripts |
| `tsconfig.json` | TypeScript config (ES2022, bundler resolution, Cloudflare types) |

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `OAUTH_KEY` | KV Namespace | Stores OAuth state during auth redirect flow (10-min TTL) |
| `MCP_OBJECT` | Durable Object (`RobynnMCP`) | One instance per authenticated user — hosts MCP server |
| `ROBYNN_API_BASE_URL` | Env var | `https://robynn.ai` |
| `MCP_SERVER_NAME` | Env var | `Robynn` |
| `MCP_SERVER_VERSION` | Env var | `0.1.0` |

## Dependencies on robynnv3

This Worker depends on several endpoints on robynn.ai (the SvelteKit frontend):

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /oauth/authorize` | OAuth consent page (Supabase login + consent) | Session |
| `POST /api/oauth/token` | Token exchange (auth code → JWT + refresh token) | None |
| `GET /api/cli/context/[scope]` | Granular brand context (8 scopes) | Bearer (API key or JWT) |
| `GET /api/cli/usage` | Token balance | Bearer |
| `GET /api/agents/cmo/threads` | List CMO threads | Bearer |
| `POST /api/agents/cmo/threads` | Create CMO thread | Bearer |
| `POST /api/agents/cmo/threads/{id}/runs` | Start CMO run | Bearer |
| `GET /api/agents/cmo/runs/{id}` | Poll run status | Bearer |

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
- **KV binding is `OAUTH_KEY`** (not `OAUTH_KV`) — matches the namespace created on Cloudflare.
- **Poll timeout 280s** — under Claude's 300s tool call timeout.
- **No tests yet** — `vitest.config.ts` is set up but test files need to be written.
