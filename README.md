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
│  │  /register → DCR     │  │  17 tools + MCP Apps UI           │ │
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

| Tool | Category | Execution backend | Inline MCP App UI |
|---|---|---|---|
| `robynn_brand_context` | Brand context | Direct `robynnv3` context API | No |
| `robynn_brand_rules` | Brand context | Direct `robynnv3` context API | No |
| `robynn_status` | Status | Direct `robynnv3` status API | No |
| `robynn_usage` | Status | Direct `robynnv3` usage API | No |
| `robynn_conversations` | Thread management | `robynnv3` CMO thread list/create endpoints | No |
| `robynn_create_content` | CMO execution | `robynnv3` CMO thread/run pipeline, defaulting to `cmo_v2` unless env overrides it | No |
| `robynn_research` | CMO execution | `robynnv3` CMO thread/run pipeline, defaulting to `cmo_v2` unless env overrides it | No |
| `robynn_geo_analysis` | Intelligence | GEO proxy in `robynnv3` -> LangGraph `geo_researcher` by default | Yes |
| `robynn_seo_opportunities` | Intelligence | SEO proxy in `robynnv3` -> LangGraph `seo_researcher` -> `seo_researcher_v5` | Yes |
| `robynn_competitive_battlecard` | Intelligence | Direct LangGraph `competitor_intelligence_v1` plus Supabase battlecard readback | Yes |
| `robynn_brand_book_status` | Brand book | Direct `robynnv3` brand-book export and changelog services | Yes |
| `robynn_brand_book_gap_analysis` | Brand book | Direct `robynnv3` brand-book adapter logic | No |
| `robynn_brand_book_strategy` | Brand book | Direct `robynnv3` brand-book adapter logic | Yes |
| `robynn_brand_reflections` | Brand book | Direct `robynnv3` changelog/reflection query logic | No |
| `robynn_publish_brand_book_html` | Brand book | Direct `robynnv3` export aggregation and HTML generation | No |
| `robynn_website_audit` | Website intelligence | `robynnv3` website adapter -> LangGraph `website_report_v1` | Yes |
| `robynn_website_strategy` | Website intelligence | `robynnv3` website adapter -> LangGraph `website_report_v1` | Yes |

All tools return both `content` (text for LLM) and `structuredContent` (machine-readable JSON). Tools with inline app support expose MCP Apps resources from the Worker, while the backend agent or service only returns data.

Detailed execution mapping for every tool lives in [docs/architecture/robynn-mcp-tool-execution-matrix.md](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/docs/architecture/robynn-mcp-tool-execution-matrix.md).

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
├── ui/                   # Shared Robynn MCP Apps report resources and runtime
└── tools/
    ├── context.ts        # robynn_brand_context + robynn_brand_rules
    ├── status.ts         # robynn_status + robynn_usage
    ├── content.ts        # robynn_create_content
    ├── research.ts       # robynn_research
    ├── conversations.ts  # robynn_conversations
    ├── geo.ts            # robynn_geo_analysis
    ├── battlecard.ts     # robynn_competitive_battlecard
    ├── seo.ts            # robynn_seo_opportunities
    ├── brand-book.ts     # brand-book status, strategy, reflections, export tools
    └── website.ts        # website audit + website strategy tools
```

## Development

```bash
pnpm install              # Install dependencies
npx wrangler dev          # Local dev server at http://localhost:8787
npx tsc --noEmit          # Type-check
npx wrangler deploy       # Deploy to Cloudflare
```

### Local Testing

Detailed runbook: [docs/local-testing.md](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/docs/local-testing.md)

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

## @robynn-ai/cli (Local Usage)

In addition to the Cloudflare-hosted remote server for Claude Web, this repository builds the official `@robynn-ai/cli` which provides a local Stdio MCP bridge (for Claude Code, Cursor) and standalone headless commands.

### Installation

```bash
# Install globally
npm install -g @robynn-ai/cli

# Verify installation
robynn -h
```

### Authentication

The CLI uses the exact same `rbo_...` organization keys from your Robynn dashboard.

```bash
robynn init rbo_YOUR_KEY_HERE
robynn auth status
```

### Viewing and Using Commands

The CLI runs the exact same execution paths as the Cloudflare tools, but locally:

```bash
# List all available commands
robynn --help

# Generate a GEO Analysis (outputs rich terminal text)
robynn analyze geo -q "Lucid Software" -c "software"

# Generate an SEO Report (outputs JSON for agent parsing)
robynn analyze seo -u "https://lucid.co" --json

# Read current brand context
robynn brand context --json
```

### Local MCP Server (Cursor / Claude Code)

You can plug the exact same tool suite into your local agents without setting up the remote Cloudflare worker:

**For Claude Code:**
```bash
claude mcp add robynn-local -- robynn mcp
```

**For Cursor:**
1. Open Cursor Settings > MCP
2. Add new MCP server
3. Name: `Robynn Local`
4. Type: `command`
5. Command: `robynn mcp`

### OpenClaw Install

For remote Linux hosts running OpenClaw, the CLI can patch the local OpenClaw MCP config for you:

**If `@robynn-ai/cli` is published:**

```bash
npm install -g @robynn-ai/cli
robynn install openclaw
robynn init rbo_YOUR_KEY_HERE
```

**If you are installing from this repository before package publish:**

```bash
git clone https://github.com/robynnai/robynnv3-mcp-connector.git
cd robynnv3-mcp-connector
pnpm install
pnpm build:cli
node dist/cli.cjs install openclaw
node dist/cli.cjs init rbo_YOUR_KEY_HERE
```

What this does:

- `robynn install openclaw` looks for OpenClaw config in:
  - `/home/$USER/.openclaw/openclaw.json`
  - `~/.openclaw/openclaw.json`
- If it finds a config file, it adds or updates:

```json
{
  "mcp": {
    "servers": {
      "robynn": {
        "command": "robynn",
        "args": ["mcp"]
      }
    }
  }
}
```

- If it cannot find or safely patch the config, it prints exact manual instructions instead.
- `robynn init rbo_...` stores the org key in `~/.robynn/config.json`, which is then used by `robynn mcp`.
- OpenClaw stores the saved local server entry under `mcp.servers.robynn`.

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
