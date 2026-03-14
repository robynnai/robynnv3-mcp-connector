---
name: mcp-tool-reviewer
description: Review MCP tool implementations for consistency and correctness
---

Review all MCP tool implementations in `src/tools/` for adherence to project conventions:

## Checklist

- [ ] Every tool has safety annotations: `readOnlyHint`, `destructiveHint`, `openWorldHint`
- [ ] Every tool returns both `content` (text array) and `structuredContent`
- [ ] `structuredContent` is cast to `Record<string, unknown>` (SDK type requirement)
- [ ] Every tool handler is wrapped in try/catch with `isError: true` on failure
- [ ] All Zod schema parameters have `.describe("...")` for LLM context
- [ ] App tools (`registerAppTool`) have an `outputResource` with a valid `ui://reports/*.html` URI
- [ ] Standard tools use `server.tool()` — not `registerAppTool`
- [ ] All tools are registered in `src/index.ts` `init()`
- [ ] Each tool file has a corresponding `.test.ts` file

Report any inconsistencies found, grouped by file.
