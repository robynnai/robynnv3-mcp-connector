---
name: new-tool
description: Create a new MCP tool following project conventions
disable-model-invocation: true
---

When the user provides a tool name and description, create it following these steps:

1. **Create/edit file** in `src/tools/` — one file per tool or group of related tools
2. **Zod param schemas** — every parameter uses `z.string().describe("...")` (or appropriate type)
3. **Safety annotations** — every tool must have `readOnlyHint`, `destructiveHint`, and `openWorldHint`
4. **Return format** — always return both `content` (text for LLM) and `structuredContent` (cast to `Record<string, unknown>`)
5. **Error handling** — wrap handler in try/catch, return `isError: true` on failure
6. **Choose tool type**:
   - Read-only / CMO tools: use `server.tool()`
   - Intelligence tools with HTML reports: use `registerAppTool()` from `@modelcontextprotocol/ext-apps/server`
7. **Register** — import and call `registerXTools(server, client)` in `src/index.ts` `init()`
8. **Create test** — add a matching `.test.ts` file next to the tool file
9. **Type-check** — run `npx tsc --noEmit` to verify

Refer to existing tools in `src/tools/` for concrete examples of both patterns.
