# Robynn MCP Apps UI Design

## Goal

Add official MCP Apps support to `robynn-mcp-server` so compatible hosts can render
interactive Robynn-branded report experiences for the existing Phase 1 intelligence
tools:

- `robynn_geo_analysis`
- `robynn_seo_opportunities`
- `robynn_competitive_battlecard`

The implementation must preserve the current text and `structuredContent` fallback
for clients that do not support MCP Apps.

## Product Direction

Use a shared Robynn report shell rather than separate one-off app stacks.

Each intelligence tool points to a dedicated `ui://` app resource:

- `ui://reports/geo.html`
- `ui://reports/seo.html`
- `ui://reports/battlecard.html`

These resources share:

- a consistent Robynn visual system
- a small in-browser bridge for the MCP Apps handshake
- common report layout primitives
- tool-specific rendering and rerun behavior

## Protocol Strategy

Implement the server side using the official MCP Apps SDK helpers from
`@modelcontextprotocol/ext-apps/server`:

- `registerAppTool`
- `registerAppResource`
- `RESOURCE_MIME_TYPE`

Each UI-enabled tool will:

- declare `_meta.ui.resourceUri`
- remain visible to both the model and the app
- return `content` plus `structuredContent`

The app resource will:

- use the MCP Apps HTML MIME type
- render a Robynn report view
- accept tool inputs/results from the host
- call server tools through the host for follow-up reruns

## Runtime Architecture

Keep the UI layer entirely inside `robynn-mcp-server`.

Add:

1. `src/ui/`
   - HTML generator for report app resources
   - shared Robynn report runtime
   - report rendering helpers
2. Worker-served asset routes
   - JavaScript for the shared report runtime
3. App resource registration
   - one resource per report type
4. Tool registration updates
   - switch GEO, SEO, and battlecard tools to app-aware registration

`robynnv3` does not need changes for this phase because it already returns
normalized structured results for these tools.

## UX Scope

### GEO report

- visibility score cards
- citation breakdown
- query gap list
- recommended actions
- rerun form using the same tool

### SEO report

- opportunity leaderboard
- keyword gap table
- competitor comparison summary
- recommended actions
- rerun form using the same tool

### Battlecard report

- comparison sections
- objection handling
- differentiators and risks
- recommended actions
- rerun form using the same tool

## Compatibility

The UI enhancement must be additive.

If a host supports MCP Apps:

- the tool response should open the Robynn app resource

If a host does not support MCP Apps:

- the tool still works through `content` and `structuredContent`

## Testing

Add focused coverage for:

- app resource registration
- tool metadata pointing to the correct `ui://` resources
- HTML builder output
- existing tool success/error behavior

Manual verification:

- `pnpm run typecheck`
- focused `vitest` suite for UI helpers and updated tools

