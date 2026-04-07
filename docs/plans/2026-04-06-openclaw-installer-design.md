# OpenClaw Installer Design

**Date:** April 6, 2026
**Status:** Approved
**Target Repo:** `robynnv3-mcp-connector`

## Goal

Add a Robynn-owned OpenClaw bootstrap command so a user on a remote Linux host can run:

```bash
robynn install openclaw
robynn init rbo_...
```

The first command wires OpenClaw to launch the local Robynn stdio MCP bridge. The second command stores the Robynn org key used by `robynn mcp`.

## Constraints

- OpenClaw config should be patched automatically when possible.
- The installer should look for config in this order:
  1. `/home/$USER/.openclaw/openclaw.json`
  2. `~/.openclaw/openclaw.json`
- If no config file is found, or if the file cannot be parsed or written safely, the CLI should print exact manual instructions.
- The OpenClaw config must not store the Robynn API key.
- The saved MCP entry must point to the local command bridge:

```json
{
  "command": "robynn",
  "args": ["mcp"]
}
```

## OpenClaw Config Shape

OpenClaw stores saved MCP definitions under:

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

## Installer Behavior

### `robynn install openclaw`

- Detect the first existing OpenClaw config path.
- Parse the JSON config.
- Create `mcp` and `mcp.servers` objects if they are missing.
- Add or update the `robynn` server definition.
- Preserve all unrelated config.
- Write atomically via temp file + rename.
- If no config exists or patching fails, print:
  - checked paths
  - exact JSON snippet to add
  - next auth step: `robynn init rbo_...`

### `robynn init <key>`

- Continue storing the key in `~/.robynn/config.json`.
- The same stored key is used for headless CLI commands and `robynn mcp`.

## User Experience

### Success

```text
OpenClaw config updated: /home/alice/.openclaw/openclaw.json
Installed MCP server: robynn -> robynn mcp
Next step: run `robynn init rbo_...` to save your org key.
```

### Manual Fallback

```text
OpenClaw config not found.
Checked:
- /home/alice/.openclaw/openclaw.json
- /home/alice/.openclaw/openclaw.json

Add this under mcp.servers in your OpenClaw config:
{
  "robynn": {
    "command": "robynn",
    "args": ["mcp"]
  }
}

Then run:
robynn init rbo_...
```

## Verification

- Unit tests for path detection order and deduping.
- Unit tests for config patching:
  - create new `mcp.servers`
  - update existing `robynn`
  - preserve unrelated config
- Unit tests for failure cases:
  - missing config
  - invalid JSON
  - write failure
- Manual Linux verification:
  1. create `~/.openclaw/openclaw.json`
  2. run `robynn install openclaw`
  3. verify `mcp.servers.robynn`
  4. run `robynn init rbo_...`
  5. confirm `robynn mcp` starts cleanly
