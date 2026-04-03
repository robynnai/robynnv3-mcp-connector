# Robynn CLI & Local MCP Bridge Architecture

**Date:** April 3, 2026
**Status:** Approved for Implementation
**Target Repo:** `robynnv3-mcp-connector`

## 1. Overview & Objectives
**Goal:** Create a globally installable Node.js CLI (`@robynn-ai/cli`) that serves as the official terminal interface and local MCP bridge for Robynn.
**Primary Users:** Local AI Agents (Claude Code, Cursor, Codex), CI/CD pipelines, and Developers.
**Core Principles:**
1. **Thin Client:** The CLI contains no heavy LangGraph/Python logic. It uses the existing `RobynnClient` to hit `api.robynn.ai`.
2. **Code Reuse:** We share the exact same tool definitions (`src/tools/*.ts`) across the Cloudflare Worker (for remote SSE users) and the Node.js CLI (for local Stdio users).
3. **Local Stdio MCP:** Instead of proxying local agents to Cloudflare SSE, the CLI natively spins up a local Stdio MCP server, resulting in lower latency and higher stability for Cursor/Claude Code.
4. **Machine-Readable:** Bash commands will support strict `--json` flags for agentic parsing.

## 2. Authentication
We will use the existing Organization API Key infrastructure (`rbo_...` keys).
* **Command:** `robynn init <API_KEY>`
* **Storage:** Saves to `~/.robynn/config.json`.
* **Execution:** The CLI passes this token into `RobynnClient` to authenticate with the backend, automatically hydrating the correct brand context for the org.

## 3. Architecture Matrix
```text
src/tools/*.ts (The Shared MCP Tool Definitions)
       │
       ├─▶ Cloudflare Worker (mcp.robynn.ai) ─▶ Remote Claude users (SSE/OAuth)
       │
       └─▶ Node.js CLI (robynn-cli) ──────────▶ Local Agents (Stdio/API Key)
```

## 4. Implementation Phases

### Phase 1: CLI Scaffolding & Auth
* Add `commander` and `tsup` (or `esbuild`) to `robynnv3-mcp-connector` for building a Node CLI binary.
* Create `src/cli/index.ts` entrypoint.
* Implement config management (`~/.robynn/config.json`).
* Implement `robynn init <YOUR_KEY_HERE>` to securely store the API key.

### Phase 2: The Local MCP Server (`robynn mcp`)
* Implement the `robynn mcp` command.
* Instantiate `@modelcontextprotocol/sdk/server` with a `StdioServerTransport`.
* Initialize `RobynnClient` using the local API key from config.
* Call all existing `register*Tools(server, client)` functions to attach the tools.
* *Result:* Local agents can now use Robynn by adding `{"command": "robynn", "args": ["mcp"]}` to their configuration.

### Phase 3: Headless CLI Commands
* Wrap `RobynnClient` methods into standard terminal commands (e.g., `robynn analyze geo --query "..." --json`) for CI/CD pipelines, cron jobs, and bash-heavy agents.
* Implement strict standard output routing (logs to stderr, JSON payload to stdout).

## 5. Build Configuration
Add CLI targets to `package.json`:
```json
{
  "bin": {
    "robynn": "./dist/cli.js"
  },
  "scripts": {
    "build:cli": "tsup src/cli/index.ts --format cjs --outfile dist/cli.js"
  }
}
```