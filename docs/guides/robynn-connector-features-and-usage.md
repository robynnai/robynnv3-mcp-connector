# Robynn Connector Features And Usage

## What It Is

Robynn is a Claude connector for brand-aware marketing work. Once connected, Claude can use your Robynn brand context, rules, and intelligence workflows directly inside a conversation.

It is best for:

- brand context lookup
- brand-book completeness and strategy
- competitive and market research
- GEO and SEO analysis
- website audit and website strategy
- competitive battlecards
- content generation in your brand voice

## How To Connect

### Claude Web or Claude Desktop

1. Open `Settings > Connectors`
2. Add the Robynn connector or use the custom connector URL:
   `https://mcp.robynn.ai/mcp`
3. Click `Connect`
4. Sign in to Robynn
5. Click `Allow`
6. Enable Robynn in the conversation where you want Claude to use it

## Available Features

### 1. Brand context

Use Robynn when you want Claude to answer from your actual brand setup instead of generic assumptions.

Available tools:

- `robynn_brand_context`
- `robynn_brand_rules`

Useful asks:

- "Show me our brand context summary from Robynn"
- "What are our brand voice guidelines?"
- "What positioning and competitor context do we have in Robynn?"

### 2. Status and usage

Use Robynn to confirm the connection and token availability.

Available tools:

- `robynn_status`
- `robynn_usage`

Useful asks:

- "Check my Robynn connection status"
- "How many Robynn tokens do we have left?"

### 3. GEO analysis

Use Robynn to measure brand visibility across AI answer engines and identify where competitors are showing up instead.

Available tool:

- `robynn_geo_analysis`

Useful asks:

- "Run a GEO analysis for Robynn in AI marketing platforms"
- "How visible are we for enterprise marketing AI queries?"
- "Compare our AI visibility with HubSpot and Salesforce"

Expected output:

- visibility scores
- citation breakdowns
- query gaps
- recommended actions

In compatible Claude clients, GEO also opens as an interactive report.

### 4. Competitive battlecards

Use Robynn to generate a current competitor battlecard grounded in your brand context.

Available tool:

- `robynn_competitive_battlecard`

Useful asks:

- "Build a competitive battlecard for Robynn vs Salesforce"
- "Compare us with HubSpot on positioning and objections"

Expected output:

- head-to-head comparison sections
- differentiators
- objections
- risks
- recommended actions

In compatible Claude clients, battlecards also render as an interactive report.

### 5. SEO opportunities

Use Robynn to find keyword gaps and competitive SEO opportunities.

Available tool:

- `robynn_seo_opportunities`

Useful asks:

- "What SEO opportunities are we missing versus HubSpot?"
- "Run SEO opportunity analysis for Robynn with AI marketing keywords"

Expected output:

- opportunity keywords
- keyword gaps
- competitor comparison
- recommended next actions

In compatible Claude clients, SEO results also render as an interactive report.

### 6. Brand book improvement

Use Robynn when you want to understand how complete your brand book is and what to fix next.

Available tools:

- `robynn_brand_book_status`
- `robynn_brand_book_gap_analysis`
- `robynn_brand_book_strategy`
- `robynn_brand_reflections`
- `robynn_publish_brand_book_html`

Useful asks:

- "Run brand book status for my brand"
- "What are the highest priority gaps in our brand book?"
- "Turn our current brand book into a strategy for improving positioning and voice"
- "Show me recent brand reflections"
- "Generate an HTML export of the current brand book"

Expected output:

- completeness score
- missing sections and items
- prioritized improvement actions
- recent reflection and changelog signals
- exportable HTML artifact data

In compatible Claude clients, brand-book status and strategy can also render as interactive reports.

### 7. Website audit and strategy

Use Robynn when you want a structured review of your current website and a prioritized plan for what to improve next.

Available tools:

- `robynn_website_audit`
- `robynn_website_strategy`

Useful asks:

- "Run a website audit for our homepage and core conversion path"
- "Audit our site against HubSpot and Salesforce"
- "Turn our current website findings into a strategy focused on demo conversion"

Expected output:

- messaging findings
- SEO findings
- GEO-oriented findings
- conversion issues
- competitor context
- prioritized next actions

In compatible Claude clients, both website tools also render as interactive reports.

### 8. Brand-aware content creation

Use Robynn when you want Claude to create content grounded in your Robynn brand context.

Available tool:

- `robynn_create_content`

Useful asks:

- "Create a LinkedIn post about AI visibility in our brand voice"
- "Write a landing page draft for our GEO product"
- "Draft an email in our brand style for a product launch"

### 9. General Robynn assist

Use Robynn when you want a catch-all CMO request that can preserve thread history and forward explicit assistant routing hints.

Available tool:

- `robynn_assist`

Useful asks:

- "Help me plan the launch using our current thread history"
- "Route this request to the best Robynn assistant and keep memory on"
- "Continue this thread with a deeper strategic response"

Expected output:

- thread and run metadata
- assistant routing preserved in the backend request
- completed output or a pending run reference

### 10. Research

Use Robynn for structured research workflows.

Available tool:

- `robynn_research`

Useful asks:

- "Research GrowthX.ai and summarize positioning gaps"
- "Research the AI visibility market"
- "Run competitor research on HubSpot"

### 11. Conversations

Use Robynn to list or create working threads tied to the Robynn CMO workflow.

Available tool:

- `robynn_conversations`

Useful asks:

- "List my Robynn conversations"
- "Create a new Robynn conversation for GEO strategy"


## Best Practices

- be explicit about the company, category, or competitor you want analyzed
- mention competitors when you want comparative output
- use Robynn when you want brand-aware answers, not generic advice
- use the interactive intelligence tools first when you want diagnostic insight
- use content creation after the intelligence step when you want Claude to act on the findings

## Example Workflow

1. Ask for a GEO analysis
2. Ask for a battlecard against the competitor that appears most often
3. Ask for SEO opportunities based on the same market
4. Ask Robynn to create content or messaging based on those findings

Example:

- "Run GEO analysis for Robynn in AI marketing platforms"
- "Now build a battlecard for Robynn vs HubSpot"
- "Now show me SEO opportunities we should prioritize"
- "Now draft a LinkedIn post based on those findings in our brand voice"

## Permissions In Claude

Robynn tools may appear under different permission groups in Claude:

- interactive tools
- read-only tools
- write/delete tools

If a tool is set to `Needs approval`, Claude will ask before using it.

## Tool Execution Notes

Not every Robynn tool uses the same backend path:

- brand context, status, usage, and the new brand-book tools are served directly from `robynnv3`
- content creation and research use the CMO thread/run workflow
- GEO, SEO, battlecards, and website reports use specialized intelligence paths
- interactive MCP Apps UI is rendered by the Worker, not by the backend agents

For the full execution matrix, see [robynn-mcp-tool-execution-matrix.md](/Users/madhukarkumar/Developer/robynnv3-standalone/robynn-mcp-server/docs/architecture/robynn-mcp-tool-execution-matrix.md).

## Troubleshooting

If Robynn is connected but not being used:

- confirm the connector is enabled for the current conversation
- confirm the tool permission mode is not blocking use
- start a new chat after connecting if Claude does not immediately pick it up

If reconnecting is needed:

1. remove the connector entry
2. add it again with `https://mcp.robynn.ai/mcp`
3. reconnect through the Robynn sign-in and consent flow
