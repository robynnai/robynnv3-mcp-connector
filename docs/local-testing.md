# Local Testing Guide

This guide covers the fastest way to validate the `robynn-mcp-server` locally,
including the new MCP Apps UI for GEO, SEO, and competitive battlecard reports.

## What to test

There are two separate testing layers:

1. Worker and tool contract checks
   - health endpoint
   - MCP discovery
   - typecheck and focused Vitest coverage
   - tool responses and `structuredContent`
2. MCP Apps host rendering
   - embedded report UI opens in a compliant host
   - report rerun works from inside the app
   - fullscreen request works when supported by the host

The fastest path is to run the Worker locally while using the existing production
backend at `https://robynn.ai`.

## Recommended setup

### 1. Start the Worker locally

From [robynn-mcp-server](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server):

```bash
cd /Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server
pnpm install
```

Create a local override file at
[.dev.vars](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/.dev.vars):

```env
ROBYNN_API_BASE_URL=https://robynn.ai
MCP_PUBLIC_BASE_URL=https://<your-worker-tunnel>.trycloudflare.com
MCP_SERVER_NAME=Robynn
MCP_SERVER_VERSION=0.1.0
```

Notes:
- `ROBYNN_API_BASE_URL=https://robynn.ai` keeps the backend fixed and avoids
  local OAuth/backend debugging.
- `MCP_PUBLIC_BASE_URL` must be the public URL that the host can reach. It is
  used by the embedded app resources to load
  `/app-assets/report-app.js`.

Start the Worker:

```bash
pnpm run typecheck
pnpm test -- --run src/robynn-client.test.ts src/tools/geo.test.ts src/tools/seo.test.ts src/tools/battlecard.test.ts src/ui/report-app.test.ts
pnpm dev
```

### 2. Expose the Worker with a tunnel

In a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Copy the generated public URL and put it into
[.dev.vars](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/.dev.vars)
as `MCP_PUBLIC_BASE_URL`, then restart `pnpm dev`.

## Smoke checks

With the Worker running locally:

```bash
curl http://127.0.0.1:8787/
curl http://127.0.0.1:8787/.well-known/mcp.json
curl http://127.0.0.1:8787/app-assets/report-app.js
```

Expected:
- `/` returns the Worker metadata JSON
- `/.well-known/mcp.json` returns MCP discovery config
- `/app-assets/report-app.js` returns JavaScript, not HTML or a 404

## Host-level MCP Apps test

Use an MCP Apps-capable host such as Claude custom connectors.

### Claude custom connector

1. Open Claude settings.
2. Add a custom connector using the Worker tunnel base URL.
3. Authenticate through the Robynn OAuth flow.
4. Run one prompt per report type:

```text
Run robynn_geo_analysis for Acme in enterprise CRM
Run robynn_seo_opportunities for Acme against HubSpot and Salesforce
Run robynn_competitive_battlecard for Acme vs Salesforce
```

Verify:
- the tool returns normally in chat
- the embedded Robynn report UI appears inline
- GEO view shows visibility cards and query gaps
- SEO view shows opportunity sorting and competitor comparison
- battlecard view shows tabs and sections
- “Run updated report” triggers a new tool run from inside the app
- “Expand” requests fullscreen if the host supports display mode changes

## Optional: local `robynnv3` backend

Use this only if you want to test the Worker against local backend routes too.

From [robynnv3](/Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3):

```bash
cd /Users/madhukarkumar/Developer/robynnv3-standalone/robynnv3
pnpm install
pnpm dev
```

If you want a real host to hit the local backend, expose it too:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Then update
[.dev.vars](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/.dev.vars)
to:

```env
ROBYNN_API_BASE_URL=https://<your-robynnv3-tunnel>.trycloudflare.com
MCP_PUBLIC_BASE_URL=https://<your-worker-tunnel>.trycloudflare.com
MCP_SERVER_NAME=Robynn
MCP_SERVER_VERSION=0.1.0
```

Restart the Worker and repeat the same host-level test steps.

## Important notes

- MCP Inspector is useful for plain MCP tool checks, but it is not the right
  place to validate embedded MCP Apps UI.
- If `MCP_PUBLIC_BASE_URL` points to `localhost`, the embedded report app will
  fail to load in remote hosts.
- The fastest end-to-end validation path is:
  local Worker + production `robynn.ai` backend + one public tunnel for the Worker.
