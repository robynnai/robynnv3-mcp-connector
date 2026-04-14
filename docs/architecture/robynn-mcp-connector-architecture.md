# Robynn MCP Connector Architecture

## Overview

The Robynn MCP Connector is a remote Model Context Protocol server that lets Claude connect directly to Robynn over OAuth and use brand-aware marketing tools. It is deployed on Cloudflare Workers at `mcp.robynn.ai` and uses `robynn.ai` as the system of record for authentication, brand context, usage, and agent-backed execution.

The connector is designed to feel lightweight to the client and stateful on the server:

- Claude connects to a stable remote MCP endpoint
- OAuth happens through the Worker, with consent and token issuance handled by `robynn.ai`
- each authenticated user gets a Durable Object-backed MCP agent session
- tool calls are forwarded to Robynn APIs using that user's access token

## Product Goals

The connector is optimized for an intelligence-first marketing workflow inside Claude:

- retrieve trusted brand context and brand rules
- inspect and improve brand-book completeness
- run market intelligence workflows such as GEO analysis, SEO opportunity analysis, and competitive battlecards
- run website audit and website strategy workflows
- generate brand-aware content and research from Robynn's existing CMO workflows
- render interactive report UIs for the implemented report tools in hosts that support MCP Apps

## High-Level Architecture

```text
Claude / Claude Desktop / Claude Web
        |
        |  Remote MCP + OAuth 2.0
        v
Cloudflare Worker (mcp.robynn.ai)
  - OAuthProvider
  - Hono auth handler
  - Durable Object-hosted McpAgent
  - MCP Apps UI resources
        |
        |  Bearer token + trusted internal token exchange
        v
robynn.ai (robynnv3)
  - OAuth consent and token exchange
  - Brand context APIs
  - Usage and status APIs
  - CMO threads and runs
  - MCP-safe intelligence routes
```

## Core Components

### 1. Worker entrypoint

`src/index.ts` is the Worker entrypoint. It wraps the MCP server with Cloudflare's OAuth provider and routes requests to either the OAuth layer or the per-user MCP agent.

Responsibilities:

- expose `/mcp` and `/sse` transports
- expose `/authorize`, `/token`, and `/register`
- create one `RobynnMCP` Durable Object-backed agent per authenticated user
- register all tools and shared report UI resources
- emit request/response traces for key OAuth and MCP paths

### 2. OAuth handler

`src/auth-handler.ts` is the user-facing auth bridge.

Responsibilities:

- parse Claude's OAuth request
- create and persist Worker-side OAuth state in KV
- redirect the user to `robynn.ai/oauth/authorize`
- receive the callback from `robynn.ai`
- exchange the authorization code for Robynn-issued tokens
- finish the OAuthProvider flow so Claude receives its MCP token

The callback path now signs the backend token exchange with a trusted HMAC header so Robynn can distinguish internal MCP traffic from general public token traffic.

### 3. Durable Object MCP agent

`RobynnMCP` extends `McpAgent` and hosts the actual tool surface.

Responsibilities:

- receive authenticated tool calls from Claude
- construct a `RobynnClient` using the authenticated user's access token
- register all tools on initialization
- register shared MCP Apps resources for interactive report rendering

This keeps the transport and auth concerns separate from the business logic of the tools themselves.

### 4. Robynn API client

`src/robynn-client.ts` is the Worker-side HTTP client for `robynn.ai`.

Responsibilities:

- call read APIs like context, status, and usage
- call thread and run APIs for content generation and research
- call MCP-safe intelligence routes for GEO, SEO, battlecards, brand-book workflows, and website workflows
- normalize success and error envelopes for tool handlers
- poll long-running runs without exceeding Claude's tool timeout window

### 5. Tool modules

Tools are registered in isolated modules under `src/tools`.

Current tool groups:

- context: `robynn_brand_context`, `robynn_brand_rules`
- status: `robynn_status`, `robynn_usage`
- execution: `robynn_create_content`, `robynn_research`, `robynn_assist`, `robynn_conversations`
- intelligence: `robynn_geo_analysis`, `robynn_competitive_battlecard`, `robynn_seo_opportunities`
- brand book: `robynn_brand_book_status`, `robynn_brand_book_gap_analysis`, `robynn_brand_book_strategy`, `robynn_brand_reflections`, `robynn_publish_brand_book_html`
- website: `robynn_website_audit`, `robynn_website_strategy`

Every tool returns:

- `content` for model-readable fallback text
- `structuredContent` for machine-readable data
- MCP safety annotations

Several report-oriented tools are registered with MCP Apps metadata so compatible hosts can render interactive report UIs.

### 6. MCP Apps UI layer

The shared UI layer lives in:

- `src/ui/report-app.ts`
- `src/ui/report-app-script.ts`

Responsibilities:

- register `ui://reports/*.html` resources
- serve a Robynn-branded shared runtime
- render interactive GEO, SEO, battlecard, brand-book, and website report views
- support in-app reruns for the implemented report tools

This keeps the connector backward-compatible with plain MCP clients while unlocking richer embedded report experiences in compatible Claude clients.

## Authentication And Trust Model

### User auth

User identity comes from `robynn.ai`, not from the Worker itself.

Flow:

1. Claude dynamically registers a client with the Worker
2. Claude sends the user to the Worker's `/authorize`
3. the Worker redirects to `robynn.ai/oauth/authorize`
4. the user signs in and approves access
5. `robynn.ai` creates an authorization code and sends the user back to the Worker callback
6. the Worker exchanges that code for a Robynn access token and refresh token
7. the Worker completes the MCP OAuth flow and stores the Robynn token in authenticated session props

### Trusted internal token exchange

To avoid production rate-limit collisions for MCP callback traffic, the Worker signs the token exchange request to `robynn.ai/api/oauth/token` using a shared secret.

Design goals:

- keep the existing public OAuth token endpoint
- avoid a blanket token-endpoint bypass
- only relax MCP token limiting for requests that prove they came from the trusted Worker

Current implementation:

- the Worker signs the token exchange request body with HMAC
- the signature and timestamp are sent as internal headers
- `robynnv3` verifies the signature before bypassing the `/api/oauth/token` limiter
- untrusted callers still go through the normal rate limiting path

## Backend Dependencies

The Worker depends on `robynn.ai` for the following capabilities:

- `GET /oauth/authorize`
- `POST /api/oauth/token`
- `GET /api/cli/context/[scope]`
- `GET /api/cli/usage`
- thread and run endpoints under `/api/agents/cmo/*`
- MCP-safe intelligence, brand-book, and website routes used by the implemented tool surface

This repo is intentionally a thin remote connector layer. It does not implement the intelligence pipelines or CMO execution itself. It exposes those capabilities safely to Claude through remote MCP.

## Feature Surface

### Read-only tools

- `robynn_brand_context`
- `robynn_brand_rules`
- `robynn_status`
- `robynn_usage`

### Interactive intelligence tools

- `robynn_geo_analysis`
- `robynn_competitive_battlecard`
- `robynn_seo_opportunities`

### Brand-book tools

- `robynn_brand_book_status`
- `robynn_brand_book_gap_analysis`
- `robynn_brand_book_strategy`
- `robynn_brand_reflections`
- `robynn_publish_brand_book_html`

### Website tools

- `robynn_website_audit`
- `robynn_website_strategy`

### Write tools

- `robynn_create_content`
- `robynn_research`
- `robynn_assist`
- `robynn_conversations`

## Reliability Considerations

Important design choices that improve stability:

- stable production hostname at `mcp.robynn.ai`
- Durable Object isolation per authenticated user
- Worker KV state for short-lived OAuth handoff state
- absolute HTTPS OAuth and MCP metadata
- signed internal token exchange to avoid false-positive MCP token rate limiting
- interactive UI tools that still degrade gracefully to plain structured text

## Deployment Model

### Worker

The connector is deployed on Cloudflare Workers with:

- KV for OAuth state
- Durable Objects for authenticated MCP agent instances
- environment variables for public base URL and backend base URL
- shared secret for trusted token exchange signing

### Backend

`robynn.ai` must have:

- OAuth authorize and token routes live
- OAuth tables and migrations applied
- production secrets configured
- trusted MCP verification code deployed

## Future Extensions

The current connector architecture is set up to grow in two directions:

1. More intelligence-first tools
- market monitoring
- brand health
- landing page audit
- future persona and prospect workflows

2. More polished interactive experiences
- deeper report interactivity
- richer cross-tool pivots
- plugin and slash-command layering on top of the connector

## File Map

- `src/index.ts`: Worker entrypoint and MCP server bootstrap
- `src/auth-handler.ts`: OAuth bridge and callback flow
- `src/robynn-client.ts`: Worker-side API client for `robynn.ai`
- `src/tools/*`: tool registration modules
- `src/ui/*`: shared MCP Apps UI runtime and report resources
- `src/internal-mcp-auth.ts`: trusted Worker-side token exchange signing

For a tool-by-tool execution map, see [robynn-mcp-tool-execution-matrix.md](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/docs/architecture/robynn-mcp-tool-execution-matrix.md).
