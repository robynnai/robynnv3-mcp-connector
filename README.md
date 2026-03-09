# Robynn MCP Server

Remote MCP (Model Context Protocol) server for the [Claude Connectors Directory](https://claude.ai/directory). Deployed on Cloudflare Workers at `mcp.robynn.ai`.

Users connect by clicking "Robynn" in Claude's directory, authenticating via OAuth, and immediately getting brand-aware marketing tools — zero install, works on web, desktop, and mobile.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude (Web / Desktop / Mobile / Code)                          │
│  User clicks "Robynn" in Connectors Directory                    │
└──────────────┬──────────────────────────────────────┬────────────┘
               │ 1. OAuth 2.0 flow                    │ 3. Tool calls
               ▼                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker — mcp.robynn.ai                               │
│                                                                  │
│  ┌─────────────────────┐  ┌────────────────────────────────────┐ │
│  │  OAuthProvider       │  │  McpAgent (Durable Object)        │ │
│  │  /authorize → login  │  │  /mcp — Streamable HTTP           │ │
│  │  /token    → tokens  │  │  /sse — SSE transport             │ │
│  │  /register → DCR     │  │  7 tools, safety annotations      │ │
│  └─────────┬───────────┘  └──────────────┬─────────────────────┘ │
│            │                              │                      │
│            │  KV Store (OAuth state)      │                      │
│            └──────────────────────────────┘                      │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ 2. API calls (Bearer token)
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  robynnv3 (SvelteKit) — robynn.ai                                │
│  /api/cli/context/[scope]  — Granular brand context              │
│  /api/cli/usage            — Token balance                       │
│  /api/agents/cmo/*         — CMO threads/runs                    │
│  /oauth/authorize          — OAuth consent page                  │
│  /api/oauth/token          — Token exchange                      │
└──────────────────────────────────────────────────────────────────┘
```

## Tools

| # | Tool | Type | Description |
|---|------|------|-------------|
| 1 | `robynn_brand_context` | Read | Get brand context by scope (voice, positioning, competitors, audience, products, rules, summary, full) |
| 2 | `robynn_brand_rules` | Read | Get brand rules, terminology, style constraints |
| 3 | `robynn_status` | Read | Check connection and org info |
| 4 | `robynn_usage` | Read | Check token balance and quota |
| 5 | `robynn_create_content` | Write | Create marketing content (blog, LinkedIn, email, ad copy, etc.) using brand voice |
| 6 | `robynn_research` | Write | Research companies, competitors, markets |
| 7 | `robynn_conversations` | Write | List/create conversation threads |

All tools return both `content` (text for LLM) and `structuredContent` (machine-readable JSON).

## OAuth Flow

1. Claude calls `/register` (Dynamic Client Registration) — gets a client_id
2. Claude redirects user to `/authorize` on the Worker
3. Worker redirects to `robynn.ai/oauth/authorize` (consent page)
4. User logs in via Supabase Auth, clicks "Allow"
5. Robynn generates auth code, redirects to Worker's `/callback`
6. Worker exchanges code for JWT access token via `robynn.ai/api/oauth/token`
7. Worker calls `completeAuthorization()` — OAuthProvider issues its own token to Claude
8. Claude makes tool calls to `/mcp` with Bearer token
9. McpAgent resolves token to user's props (robynn.ai access token)
10. Tools call robynn.ai API with the access token

## Tech Stack

- **Runtime**: Cloudflare Workers (Durable Objects)
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.26
- **Agent Framework**: `agents` (Cloudflare McpAgent)
- **OAuth**: `@cloudflare/workers-oauth-provider`
- **Routing**: Hono (for the auth handler)
- **Language**: TypeScript

## Project Structure

```
src/
├── index.ts              # Worker entry: RobynnMCP (McpAgent DO) + OAuthProvider
├── auth-handler.ts       # Hono app: /authorize redirect, /callback token exchange
├── robynn-client.ts      # HTTP client for robynn.ai API (10s read, 280s poll timeout)
├── types.ts              # Env, Props, API response types
└── tools/
    ├── context.ts        # robynn_brand_context + robynn_brand_rules
    ├── status.ts         # robynn_status + robynn_usage
    ├── content.ts        # robynn_create_content
    ├── research.ts       # robynn_research
    └── conversations.ts  # robynn_conversations
```

## Development

```bash
pnpm install              # Install dependencies
npx wrangler dev          # Local dev server at http://localhost:8787
npx tsc --noEmit          # Type-check
npx wrangler deploy       # Deploy to Cloudflare
```

### Local Testing

```bash
# Health check
curl http://localhost:8787/

# MCP config
curl http://localhost:8787/.well-known/mcp.json

# Test with MCP Inspector
npx @modelcontextprotocol/inspector
# Enter URL: http://localhost:8787/mcp
```

### Connecting Claude Desktop (for testing)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "robynn": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.robynn.ai/sse"]
    }
  }
}
```

### Connecting on claude.ai

Settings → Connectors → Add Custom Connector → `https://mcp.robynn.ai`

## Deployment

```bash
# Type-check + deploy (2 commands)
npx tsc --noEmit
npx wrangler deploy
```

Changes are live at `mcp.robynn.ai` within seconds.

### Environment

| Variable | Value | Set via |
|----------|-------|---------|
| `ROBYNN_API_BASE_URL` | `https://robynn.ai` | wrangler.toml `[vars]` |
| `MCP_SERVER_NAME` | `Robynn` | wrangler.toml `[vars]` |
| `MCP_SERVER_VERSION` | `0.1.0` | wrangler.toml `[vars]` |
| `OAUTH_KEY` | KV namespace | wrangler.toml binding |
| `MCP_OBJECT` | Durable Object | wrangler.toml binding |

### Required Cloudflare Resources

- **KV Namespace**: `OAUTH_KEY` — stores OAuth state during auth flow
- **Durable Object**: `RobynnMCP` — hosts MCP server instances per authenticated user

## Related Projects

- **robynnv3** — SvelteKit frontend + API (robynn.ai)
- **robynnv3_agents** — Python LangGraph agent backend
- **robynn-claude-cmo** — Rory CLI (local MCP server for Claude Code)

## Connectors Directory Submission

Submit at [anthropic.com/partners/mcp](https://www.anthropic.com/partners/mcp). Requirements:

- [x] OAuth 2.0 with Dynamic Client Registration
- [x] Safety annotations on all tools
- [x] Structured JSON responses
- [x] HTTPS/TLS (Cloudflare automatic)
- [x] `.well-known/mcp.json` discovery endpoint
- [x] Responses under 25,000 tokens
- [ ] Test account with sample brand data
- [ ] Privacy policy link
- [ ] Rate limiting on robynn.ai API
