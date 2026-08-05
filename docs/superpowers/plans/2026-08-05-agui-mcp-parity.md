# AGUI → MCP Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Instant Agent AGUI `response_blocks` through MCP CMO tools (structured passthrough → MCP Apps render → decision continuation).

**Architecture:** Contract-first. `robynnv3` attaches validated blocks from Instant Agent run metadata onto CMO MCP / run-status payloads; the MCP connector forwards them in `structuredContent`, renders a block subset in MCP Apps, then adds `robynn_cmo_decide` for clarify loops. No live SSE in v1.

**Tech Stack:** SvelteKit + Zod (`robynnv3`), Cloudflare Workers MCP + Vitest (`robynnv3-mcp-connector`), Instant Agent `ResponseBlock` catalog, MCP Apps report resources.

**Spec:** `docs/superpowers/specs/2026-08-05-agui-mcp-parity-design.md`

## Global Constraints

- Reuse Instant Agent block parsing via `parseResponseBlocks` / `extractResponseBlocksFromRunMetadata` — do not invent a second schema.
- Prefer `finalized_response_blocks`, fall back to `live_response_blocks`.
- Invalid blocks are dropped; never fail a successful run because of bad block payloads.
- Keep legacy `output` text behavior; blocks are additive.
- Default assistant remains backend `cmo_v3`; docs must stop claiming `cmo_v2` as default.
- Ship as four independently mergeable PRs (Tasks 1–2 = PR1 robynnv3; Tasks 3–5 = PR2 MCP; Tasks 6–7 = PR3 MCP; Tasks 8–10 = PR4 cross-repo).
- No live streaming / `artifact_draft_delta` in this plan.
- Phase B renders only: `table`, `chart`, `metric_card`, `priority_list`, `progress_pipeline`, `status_checklist`, `decision_card` (read-only until Phase C).

## File Structure

| File | Responsibility |
| --- | --- |
| `robynnv3/src/lib/server/mcp/contracts.ts` | Zod fields for AGUI on CMO results + decide request |
| `robynnv3/src/lib/server/mcp/cmo-agui.ts` **(new)** | Shared helpers: extract blocks, flags, text fallback inputs, decide reply text |
| `robynnv3/src/lib/server/mcp/cmo-agent-runner.ts` | Attach AGUI fields on success/pending/failed MCP CMO runs |
| `robynnv3/src/routes/api/agents/cmo/runs/[runId]/+server.ts` | Include AGUI fields on run poll |
| `robynnv3/src/routes/api/cli/mcp/cmo/decide/+server.ts` **(new)** | Phase C decide API |
| `robynnv3/src/lib/server/mcp/cmo-decide-runner.ts` **(new)** | Phase C orchestration |
| `robynnv3-mcp-connector/src/types.ts` | Client types for blocks + decide |
| `robynnv3-mcp-connector/src/tools/cmo-text.ts` **(new)** | Shared text fallback builder |
| `robynnv3-mcp-connector/src/tools/cmo-agent.ts` | Pass through blocks; improve description |
| `robynnv3-mcp-connector/src/tools/runs.ts` | Pass through blocks on run status |
| `robynnv3-mcp-connector/src/tools/assist.ts` | Pass through blocks when present on poll |
| `robynnv3-mcp-connector/src/tools/cmo-decide.ts` **(new)** | `robynn_cmo_decide` tool |
| `robynnv3-mcp-connector/src/ui/report-app.ts` | Register `cmoAgui` report resource |
| `robynnv3-mcp-connector/src/ui/cmo-agui-render.ts` **(new)** | Pure HTML render helpers for Phase B block subset (unit-tested) |
| `robynnv3-mcp-connector/src/ui/report-app-script.ts` | Call into CMO AGUI helpers from the browser bundle |
| Docs in MCP repo | README / execution matrix / CLAUDE defaults |

---

### Task 1: robynnv3 — AGUI helper + contract fields

**Repo:** `robynnv3`  
**Files:**
- Create: `src/lib/server/mcp/cmo-agui.ts`
- Create: `src/lib/server/mcp/cmo-agui.test.ts`
- Modify: `src/lib/server/mcp/contracts.ts`
- Modify: `src/lib/server/mcp/contracts.test.ts`

**Interfaces:**
- Consumes: `extractResponseBlocksFromRunMetadata`, `parseResponseBlocks`, `ResponseBlock` from Instant Agent types
- Produces: `buildCmoAguiFields(run, output)`, `CmoAgentResultSchema` fields `response_blocks`, `has_decision_cards`, `clarify_pending`

- [ ] **Step 1: Write the failing helper tests**

```ts
// src/lib/server/mcp/cmo-agui.test.ts
import { describe, expect, it } from "vitest"
import { buildCmoAguiFields } from "./cmo-agui"

describe("buildCmoAguiFields", () => {
  it("prefers finalized_response_blocks and sets decision flags", () => {
    const fields = buildCmoAguiFields({
      metadata: {
        finalized_response_blocks: [
          {
            id: "d1",
            type: "decision_card",
            decisionId: "d1",
            question: "Which channel first?",
            options: [
              { id: "linkedin", label: "LinkedIn" },
              { id: "email", label: "Email" },
            ],
          },
        ],
        live_response_blocks: [{ id: "x", type: "table", columns: [], rows: [] }],
      },
      output: "Quick clarification needed.",
    })

    expect(fields.response_blocks).toHaveLength(1)
    expect(fields.has_decision_cards).toBe(true)
    expect(fields.clarify_pending).toBe(true)
  })

  it("returns empty blocks when metadata missing", () => {
    expect(buildCmoAguiFields({ metadata: null, output: "Done" })).toEqual({
      response_blocks: [],
      has_decision_cards: false,
      clarify_pending: false,
    })
  })

  it("does not mark clarify_pending when decisions absent and output is substantial", () => {
    const fields = buildCmoAguiFields({
      metadata: {
        finalized_response_blocks: [
          {
            id: "t1",
            type: "table",
            columns: [{ key: "a", label: "A" }],
            rows: [{ a: "1" }],
          },
        ],
      },
      output: "Here is a full launch plan with three workstreams...",
    })
    expect(fields.has_decision_cards).toBe(false)
    expect(fields.clarify_pending).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/server/mcp/cmo-agui.test.ts`  
Expected: FAIL — module `./cmo-agui` not found

- [ ] **Step 3: Implement helper + contract fields**

```ts
// src/lib/server/mcp/cmo-agui.ts
import { extractResponseBlocksFromRunMetadata } from "$lib/server/instant-agent/runs"
import type { ResponseBlock } from "$lib/types/response-blocks"

export type CmoAguiFields = {
  response_blocks: ResponseBlock[]
  has_decision_cards: boolean
  clarify_pending: boolean
}

function isClarifyLikeOutput(output: string | null | undefined): boolean {
  const text = (output || "").trim()
  if (!text) return true
  if (text.length > 280) return false
  return / wh(ich|at)|choose|pick|prefer|option|clarif/i.test(text)
}

export function buildCmoAguiFields(params: {
  metadata: Record<string, unknown> | null | undefined
  output: string | null | undefined
}): CmoAguiFields {
  const response_blocks = extractResponseBlocksFromRunMetadata(params.metadata)
  const has_decision_cards = response_blocks.some(
    (block) => block.type === "decision_card",
  )
  const clarify_pending =
    has_decision_cards && isClarifyLikeOutput(params.output)

  return { response_blocks, has_decision_cards, clarify_pending }
}
```

In `contracts.ts`, extend `CmoAgentResultSchema`:

```ts
response_blocks: z.array(z.record(z.unknown())).default([]),
has_decision_cards: z.boolean().default(false),
clarify_pending: z.boolean().default(false),
```

Add a contracts test asserting defaults and explicit values parse.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm exec vitest run src/lib/server/mcp/cmo-agui.test.ts src/lib/server/mcp/contracts.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit (robynnv3 branch)**

```bash
git checkout -b cursor/agui-mcp-phase-a-contract-e5df
git add src/lib/server/mcp/cmo-agui.ts src/lib/server/mcp/cmo-agui.test.ts src/lib/server/mcp/contracts.ts src/lib/server/mcp/contracts.test.ts
git commit -m "feat(mcp): add CMO AGUI response_blocks contract fields"
```

---

### Task 2: robynnv3 — Attach AGUI fields in CMO runner + run poll

**Repo:** `robynnv3`  
**Files:**
- Modify: `src/lib/server/mcp/cmo-agent-runner.ts`
- Modify: `src/lib/server/mcp/cmo-agent-runner.test.ts`
- Modify: `src/routes/api/agents/cmo/runs/[runId]/+server.ts`
- Modify: `src/routes/api/agents/cmo/runs/[runId]/server.test.ts`

**Interfaces:**
- Consumes: `buildCmoAguiFields`
- Produces: `CmoAgentResult` and `GET /api/agents/cmo/runs/:id` include AGUI fields

- [ ] **Step 1: Write failing runner + poll-route tests**

```ts
it("attaches finalized response_blocks on success", async () => {
  const startInstantAgentRun = vi.fn().mockResolvedValue(
    createRun({
      metadata: {
        finalized_response_blocks: [
          {
            id: "d1",
            type: "decision_card",
            decisionId: "d1",
            question: "Which channel first?",
            options: [
              { id: "linkedin", label: "LinkedIn" },
              { id: "email", label: "Email" },
            ],
          },
        ],
      },
    }),
  )

  const result = await runCmoAgentForMcp({
    request: { message: "Plan a campaign" },
    supabase: createSupabaseMock() as never,
    organizationId: "org-1",
    userId: "user-1",
    deps: {
      startInstantAgentRun,
      resolveLegacyRunOutput: vi.fn().mockResolvedValue("Which channel first?"),
    },
  })

  expect(result.has_decision_cards).toBe(true)
  expect(result.clarify_pending).toBe(true)
  expect(result.response_blocks?.[0]).toMatchObject({ type: "decision_card" })
})
```

Also add:
1. Pending-run test that includes `live_response_blocks` when present
2. Failed-run test that returns `response_blocks: []`
3. Poll-route test in `src/routes/api/agents/cmo/runs/[runId]/server.test.ts` asserting `GET` JSON `data.response_blocks` / `has_decision_cards` / `clarify_pending` (follow existing auth/supabase mocks in that file)

- [ ] **Step 2: Run to verify fail**

Run:
```bash
pnpm exec vitest run src/lib/server/mcp/cmo-agent-runner.test.ts src/routes/api/agents/cmo/runs/\[runId\]/server.test.ts
```
Expected: FAIL — `has_decision_cards` / `response_blocks` undefined on runner and/or poll payload

- [ ] **Step 3: Implement runner + poll route**

In `cmo-agent-runner.ts`, after each return path:

```ts
import { buildCmoAguiFields } from "$lib/server/mcp/cmo-agui"

function withAgui(
  run: InstantAgentRunRecord,
  base: Omit<CmoAgentResult, "response_blocks" | "has_decision_cards" | "clarify_pending">,
): CmoAgentResult {
  const agui = buildCmoAguiFields({
    metadata: run.metadata,
    output: base.output,
  })
  if (base.status === "failed") {
    return {
      ...base,
      response_blocks: [],
      has_decision_cards: false,
      clarify_pending: false,
    }
  }
  return { ...base, ...agui }
}
```

Wrap success / pending / failed returns with `withAgui(run, ...)`.

In `runs/[runId]/+server.ts`:

```ts
import { buildCmoAguiFields } from "$lib/server/mcp/cmo-agui"

const output = await resolveLegacyRunOutput(supabase, latestRun)
const agui = buildCmoAguiFields({
  metadata: latestRun.metadata,
  output,
})

return json({
  success: true,
  data: {
    id: latestRun.id,
    status: latestRun.status,
    thread_id: latestRun.thread_id,
    output: output || undefined,
    tokens_used: null,
    ...agui,
  },
})
```

- [ ] **Step 4: Run tests**

```bash
pnpm exec vitest run \
  src/lib/server/mcp/cmo-agent-runner.test.ts \
  src/routes/api/agents/cmo/runs/\[runId\]/server.test.ts \
  src/routes/api/cli/mcp/cmo/run/server.test.ts
```
Expected: PASS (update any snapshot/objectContaining asserts that require the new defaults)

- [ ] **Step 5: Commit + open PR1**

```bash
git add src/lib/server/mcp/cmo-agent-runner.ts src/lib/server/mcp/cmo-agent-runner.test.ts \
  src/routes/api/agents/cmo/runs/[runId]/+server.ts \
  src/routes/api/agents/cmo/runs/[runId]/server.test.ts
git commit -m "feat(mcp): return response_blocks on CMO MCP runs and poll"
git push -u origin cursor/agui-mcp-phase-a-contract-e5df
```

Open robynnv3 PR against `main`. Body must include `Beads: <id|none>`.

---

### Task 3: MCP connector — types + text fallback helper

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Create: `src/tools/cmo-text.ts`
- Create: `src/tools/cmo-text.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: Phase A API fields
- Produces: `buildCmoAguiTextFallback(...)`, extended `CmoAgentResult` / `RunResult`

- [ ] **Step 1: Write failing text-fallback tests**

```ts
import { describe, expect, it } from "vitest"
import { buildCmoAguiTextFallback } from "./cmo-text"

describe("buildCmoAguiTextFallback", () => {
  it("lists decision questions when clarify_pending", () => {
    const text = buildCmoAguiTextFallback({
      output: "Need a quick choice.",
      clarify_pending: true,
      has_decision_cards: true,
      response_blocks: [
        {
          id: "d1",
          type: "decision_card",
          decisionId: "d1",
          question: "Which channel first?",
          options: [
            { id: "linkedin", label: "LinkedIn" },
            { id: "email", label: "Email" },
          ],
        },
      ],
    })
    expect(text).toContain("Which channel first?")
    expect(text).toContain("LinkedIn")
    expect(text).toContain("decision_card")
  })

  it("falls back to output when no blocks", () => {
    expect(
      buildCmoAguiTextFallback({
        output: "Launch plan ready.",
        clarify_pending: false,
        has_decision_cards: false,
        response_blocks: [],
      }),
    ).toBe("Launch plan ready.")
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/tools/cmo-text.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement types + helper**

```ts
// types.ts additions
export type ResponseBlock = {
  id: string
  type: string
  title?: string
  [key: string]: unknown
}

export interface CmoAgentResult extends IntelligenceToolResultBase {
  output?: string | null
  thread_id: string
  run_id: string
  tokens_used?: number | null
  poll_after_seconds?: number
  response_blocks?: ResponseBlock[]
  has_decision_cards?: boolean
  clarify_pending?: boolean
}

export interface CmoDecideRequest {
  thread_id: string
  run_id: string
  decision_id: string
  option_id: string
  note?: string
}

export interface RunResult {
  id: string
  status: string
  output?: string
  thread_id?: string
  tokens_used?: number
  response_blocks?: ResponseBlock[]
  has_decision_cards?: boolean
  clarify_pending?: boolean
}
```

```ts
// src/tools/cmo-text.ts
import type { ResponseBlock } from "../types"

function countByType(blocks: ResponseBlock[]): string {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    counts.set(block.type, (counts.get(block.type) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => `${count} ${type}`)
    .join(", ")
}

export function buildCmoAguiTextFallback(params: {
  output?: string | null
  clarify_pending?: boolean
  has_decision_cards?: boolean
  response_blocks?: ResponseBlock[]
  defaultSummary?: string
}): string {
  const blocks = params.response_blocks || []
  const output = (params.output || "").trim()
  if (blocks.length === 0) {
    return output || params.defaultSummary || "CMO agent completed."
  }

  const lines: string[] = []
  if (output) lines.push(output)

  if (params.clarify_pending || params.has_decision_cards) {
    for (const block of blocks) {
      if (block.type !== "decision_card") continue
      const question = String(block.question || block.title || "").trim()
      const options = Array.isArray(block.options)
        ? block.options
            .map((option) => {
              const row = option as { label?: unknown; id?: unknown }
              return String(row.label || row.id || "").trim()
            })
            .filter(Boolean)
        : []
      if (question) {
        lines.push(`Decision needed: ${question}`)
        if (options.length) lines.push(`Options: ${options.join(" | ")}`)
      }
    }
  }

  lines.push(`response_blocks: ${blocks.length} (${countByType(blocks)})`)
  return lines.join("\n")
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/tools/cmo-text.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git checkout -b cursor/agui-mcp-phase-a-connector-e5df
git add src/types.ts src/tools/cmo-text.ts src/tools/cmo-text.test.ts
git commit -m "feat: add CMO AGUI types and text fallback helper"
```

---

### Task 4: MCP connector — wire blocks into cmo_agent / run_status / assist

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Modify: `src/tools/cmo-agent.ts`
- Modify: `src/tools/cmo-agent.test.ts`
- Modify: `src/tools/runs.ts`
- Modify: `src/tools/runs.test.ts` (create if absent)
- Modify: `src/tools/assist.ts`
- Modify: `src/tools/assist.test.ts` (extend if present)
- Modify: `src/tools/all-tools.test.ts` as needed

**Interfaces:**
- Consumes: `buildCmoAguiTextFallback`, API AGUI fields
- Produces: tool `structuredContent` with `response_blocks`, `has_decision_cards`, `clarify_pending`

- [ ] **Step 1: Write failing tool tests**

In `cmo-agent.test.ts`, assert that when `client.cmoAgent` returns blocks, the tool result `structuredContent` includes them and text mentions the decision question.

In `runs` tests, mock `getRun` returning blocks on completed status and assert passthrough.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/tools/cmo-agent.test.ts`  
Expected: FAIL on missing structured fields / text

- [ ] **Step 3: Implement tool wiring**

`cmo-agent.ts` success/pending path:

```ts
import { buildCmoAguiTextFallback } from "./cmo-text"

const responseBlocks = Array.isArray(data.response_blocks)
  ? data.response_blocks
  : []
const payload = {
  ...data,
  response_blocks: responseBlocks,
  has_decision_cards: Boolean(data.has_decision_cards),
  clarify_pending: Boolean(data.clarify_pending),
}
const summary = buildCmoAguiTextFallback({
  output: typeof data.output === "string" ? data.output : typeof data.summary === "string" ? data.summary : null,
  clarify_pending: payload.clarify_pending,
  has_decision_cards: payload.has_decision_cards,
  response_blocks: responseBlocks as never,
  defaultSummary: data.status === "pending" ? undefined : "CMO agent completed.",
})
```

Update tool description to mention CMO v3 + `route_hint` + that clarify may return `decision_card` blocks.

For pending responses, keep existing `buildPendingText` / `poll_after_seconds` guidance and **also** attach any live `response_blocks` fields so progress/decision previews are available without dropping the poll instruction.

`runs.ts` completed branch must include the same three AGUI fields and use `buildCmoAguiTextFallback`.

`assist.ts`: after `pollRun`, if `result.data` has blocks, include them; otherwise leave behavior unchanged. Prefer reading AGUI fields from `getRun`/`pollRun` once Task 2 lands.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run src/tools/cmo-agent.test.ts src/tools/runs.test.ts src/tools/assist.test.ts src/tools/all-tools.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/cmo-agent.ts src/tools/cmo-agent.test.ts src/tools/runs.ts src/tools/assist.ts src/tools/all-tools.test.ts
git commit -m "feat: pass CMO response_blocks through MCP tools"
```

---

### Task 5: MCP connector — Phase A docs + PR2

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Modify: `README.md` (CMO default `cmo_v2` → backend default `cmo_v3`)
- Modify: `docs/architecture/robynn-mcp-tool-execution-matrix.md`
- Modify: `CLAUDE.md` CMO notes / tool inventory if still stale

- [ ] **Step 1: Update docs**

Replace claims that content/research default to `cmo_v2` with: omit `assistant_id` to use Instant Agent default (`cmo_v3`); optional override `cmo_v2|cmo_v3|auto`. Document that CMO tools may return `response_blocks`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` or `npx tsc --noEmit`  
Expected: PASS

- [ ] **Step 3: Commit + open PR2**

```bash
git add README.md docs/architecture/robynn-mcp-tool-execution-matrix.md CLAUDE.md
git commit -m "docs: document CMO v3 default and response_blocks passthrough"
git push -u origin cursor/agui-mcp-phase-a-connector-e5df
```

PR depends on robynnv3 PR1 being available in the target API environment.

---

### Task 6: MCP connector — CMO AGUI report resource

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Modify: `src/ui/report-app.ts`
- Modify: `src/ui/report-app.test.ts`
- Modify: `src/tools/cmo-agent.ts` (link `outputResource` when useful)

**Interfaces:**
- Produces: `REPORT_RESOURCE_URIS.cmoAgui = "ui://reports/cmo-agui.html"`

- [ ] **Step 1: Write failing resource registration test**

```ts
expect(resources.has(REPORT_RESOURCE_URIS.cmoAgui)).toBe(true)
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/ui/report-app.test.ts`  
Expected: FAIL — `cmoAgui` missing

- [ ] **Step 3: Register report type**

Extend `ReportType` union + `REPORT_RESOURCE_URIS` + `REPORT_DEFINITIONS` with:

```ts
cmoAgui: "ui://reports/cmo-agui.html"
// title: "Robynn CMO Result", description: "AGUI response blocks for CMO runs"
```

Link from `robynn_cmo_agent` using the same MCP Apps meta pattern as `geo.ts`:

```ts
_meta: {
  ui: {
    resourceUri: REPORT_RESOURCE_URIS.cmoAgui,
    visibility: ["model", "app"],
  },
},
```

(Do not invent an `outputResource` field — that is not how hosted tools bind reports today.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/ui/report-app.test.ts src/tools/cmo-agent.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git checkout -b cursor/agui-mcp-phase-b-report-e5df
git add src/ui/report-app.ts src/ui/report-app.test.ts src/tools/cmo-agent.ts
git commit -m "feat: register CMO AGUI MCP Apps report resource"
```

---

### Task 7: MCP connector — Phase B block renderers

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Create: `src/ui/cmo-agui-render.ts`
- Create: `src/ui/cmo-agui-render.test.ts`
- Modify: `src/ui/report-app-script.ts` (invoke helper; keep browser bundle thin)

**Interfaces:**
- Consumes: `structuredContent.response_blocks`
- Produces: `renderCmoAguiBlocks(blocks): { html: string; skippedTypes: string[] }`
- Spec coverage: unit tests for **each** Phase B type: `table`, `chart`, `metric_card`, `priority_list`, `progress_pipeline`, `status_checklist`, `decision_card`, plus unknown-type skip

Because `report-app-script.ts` is a `String.raw` browser bundle (hard to unit-test), implement pure renderers in `cmo-agui-render.ts` and either:
1. import/call them from a small Node-side HTML builder used when registering the resource, **or**
2. embed the helper output by generating the section server-side into the report HTML template.

Do **not** rely on eval of the `String.raw` script for tests.

- [ ] **Step 1: Write failing renderer tests for every Phase B type**

```ts
// src/ui/cmo-agui-render.test.ts
import { describe, expect, it } from "vitest"
import { renderCmoAguiBlocks } from "./cmo-agui-render"

describe("renderCmoAguiBlocks", () => {
  it("renders table headers and rows", () => {
    const { html } = renderCmoAguiBlocks([
      {
        id: "t1",
        type: "table",
        columns: [{ key: "channel", label: "Channel" }],
        rows: [{ channel: "LinkedIn" }],
      },
    ])
    expect(html).toContain("Channel")
    expect(html).toContain("LinkedIn")
  })

  it("renders chart, metric_card, priority_list, progress_pipeline, status_checklist", () => {
    const { html } = renderCmoAguiBlocks([
      { id: "c1", type: "chart", title: "Share", series: [{ label: "A", value: 10 }] },
      { id: "m1", type: "metric_card", label: "Score", value: 82 },
      { id: "p1", type: "priority_list", items: [{ id: "i1", label: "Fix CTA", priority: "high" }] },
      {
        id: "g1",
        type: "progress_pipeline",
        stages: [{ id: "s1", label: "Research", status: "active" }],
      },
      {
        id: "k1",
        type: "status_checklist",
        items: [{ id: "x1", label: "Brand voice loaded", checked: true }],
      },
    ])
    expect(html).toContain("Share")
    expect(html).toContain("Score")
    expect(html).toContain("Fix CTA")
    expect(html).toContain("Research")
    expect(html).toContain("Brand voice loaded")
  })

  it("renders decision_card read-only and skips unknown types with footer count", () => {
    const { html, skippedTypes } = renderCmoAguiBlocks([
      {
        id: "d1",
        type: "decision_card",
        decisionId: "d1",
        question: "Which channel first?",
        options: [
          { id: "linkedin", label: "LinkedIn" },
          { id: "email", label: "Email" },
        ],
      },
      { id: "u1", type: "tone_picker", options: [] },
    ])
    expect(html).toContain("Which channel first?")
    expect(html).toContain("LinkedIn")
    expect(skippedTypes).toContain("tone_picker")
    expect(html).toMatch(/skipped:\s*1/i)
  })
})
```

Adapt fixture field names to match Instant Agent `ResponseBlock` shapes in `robynnv3/src/lib/types/response-blocks.ts` if the sketch fields above differ (read that file before coding).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/ui/cmo-agui-render.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement `renderCmoAguiBlocks` + wire into report**

```ts
// src/ui/cmo-agui-render.ts
export function renderCmoAguiBlocks(blocks: Array<Record<string, unknown>>): {
  html: string
  skippedTypes: string[]
} {
  const parts: string[] = []
  const skippedTypes: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "table":
        parts.push(renderTable(block))
        break
      case "chart":
        parts.push(renderChart(block))
        break
      case "metric_card":
        parts.push(renderMetric(block))
        break
      case "priority_list":
        parts.push(renderPriorityList(block))
        break
      case "progress_pipeline":
        parts.push(renderProgress(block))
        break
      case "status_checklist":
        parts.push(renderChecklist(block))
        break
      case "decision_card":
        parts.push(renderDecisionCard(block)) // read-only
        break
      default:
        skippedTypes.push(String(block.type || "unknown"))
    }
  }
  if (skippedTypes.length) {
    parts.push(`<p class="muted">Skipped: ${skippedTypes.length} unsupported block(s)</p>`)
  }
  return { html: parts.join("\n"), skippedTypes }
}
```

Implement each `render*` with `escapeHtml`. Wire the HTML into the `cmoAgui` report template / script path so MCP Apps shows it.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm vitest run src/ui/cmo-agui-render.test.ts src/ui/report-app.test.ts
pnpm typecheck
```
Expected: PASS

- [ ] **Step 5: Commit + open PR3**

```bash
git add src/ui/cmo-agui-render.ts src/ui/cmo-agui-render.test.ts src/ui/report-app-script.ts
git commit -m "feat: render CMO AGUI response_blocks in MCP Apps reports"
git push -u origin cursor/agui-mcp-phase-b-report-e5df
```

---

### Task 8: robynnv3 — `POST /api/cli/mcp/cmo/decide` runner

**Repo:** `robynnv3`  
**Files:**
- Create: `src/lib/server/mcp/cmo-decide-runner.ts`
- Create: `src/lib/server/mcp/cmo-decide-runner.test.ts`
- Modify: `src/lib/server/mcp/contracts.ts` (add `CmoDecideRequestSchema`)
- Create: `src/routes/api/cli/mcp/cmo/decide/+server.ts`
- Create: `src/routes/api/cli/mcp/cmo/decide/server.test.ts`
- Modify: `src/lib/server/mcp/capability-catalog.ts` (add decide note/tools)

**Interfaces:**
- Consumes: prior run blocks via `buildCmoAguiFields` / `getRunById`
- Produces: same `CmoAgentResult` as `runCmoAgentForMcp`
- Reply text **must reuse** Instant Agent `buildCheckpointReply` from `src/lib/components/instant-agent/checkpoint-reply.ts` (or extract that helper to a shared `$lib` module if component-path import is awkward for server code). Do not hardcode a divergent string that can drift.

- [ ] **Step 1: Write failing decide-runner tests**

Cases:
1. Happy path: valid decision/option → starts new run on same thread with checkpoint-style message → returns AGUI fields
2. Unknown `decision_id` → throws actionable error
3. Option not in card → throws
4. Run/thread org mismatch → not found

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run src/lib/server/mcp/cmo-decide-runner.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement contract + runner + route**

```ts
// contracts.ts
export const CmoDecideRequestSchema = z.object({
  thread_id: z.string().trim().uuid(),
  run_id: z.string().trim().min(1),
  decision_id: z.string().trim().min(1),
  option_id: z.string().trim().min(1),
  note: z.string().trim().max(1000).optional(),
})
```

Runner sketch:

```ts
import { buildCheckpointReply } from "$lib/components/instant-agent/checkpoint-reply"
// If server import from components is blocked, move buildCheckpointReply to
// $lib/server/instant-agent/checkpoint-reply.ts (or similar) in this same task.

export async function runCmoDecideForMcp(params: { ... }) {
  const run = await getRunById(...)
  // verify thread/org
  const { response_blocks } = buildCmoAguiFields({ metadata: run.metadata, output: null })
  const card = response_blocks.find(
    (b) => b.type === "decision_card" && b.decisionId === request.decision_id,
  )
  if (!card || card.type !== "decision_card") {
    throw new Error(`Unknown decision_id: ${request.decision_id}`)
  }
  const option = card.options.find((o) => o.id === request.option_id)
  if (!option) throw new Error(`Unknown option_id: ${request.option_id}`)

  let message = buildCheckpointReply({
    decisions: [{ decision: {
      id: card.decisionId,
      question: card.question,
      options: card.options,
    }, selectedOptionId: request.option_id }],
  })
  if (request.note) message += `\n\nAdditional note: ${request.note}`

  return runCmoAgentForMcp({
    request: {
      message,
      thread_id: request.thread_id,
      assistant_id: "cmo_v3",
    },
    ...params,
  })
}
```

Adapt the `DecisionCard` shape expected by `buildCheckpointReply` if it differs from `DecisionCardBlock` — map fields explicitly rather than casting blindly.

Wire `+server.ts` like existing `cmo/run/+server.ts` (auth, parse, success/error envelope).

Update capability catalog notes to mention `robynn_cmo_decide`.

- [ ] **Step 4: Run tests**

```bash
pnpm exec vitest run src/lib/server/mcp/cmo-decide-runner.test.ts src/routes/api/cli/mcp/cmo/decide/server.test.ts src/lib/server/mcp/capability-catalog.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git checkout -b cursor/agui-mcp-phase-c-decide-e5df
git add src/lib/server/mcp/cmo-decide-runner.ts src/lib/server/mcp/cmo-decide-runner.test.ts \
  src/lib/server/mcp/contracts.ts src/routes/api/cli/mcp/cmo/decide \
  src/lib/server/mcp/capability-catalog.ts
git commit -m "feat(mcp): add CMO decide endpoint for AGUI decision cards"
```

---

### Task 9: MCP connector — `robynn_cmo_decide` tool

**Repo:** `robynnv3-mcp-connector`  
**Files:**
- Create: `src/tools/cmo-decide.ts`
- Create: `src/tools/cmo-decide.test.ts`
- Modify: `src/robynn-client.ts`
- Modify: `src/robynn-client.test.ts`
- Modify: `src/index.ts` (register tool)
- Modify: `src/tools/all-tools.test.ts` (count + name)
- Modify: `src/cli/index.ts` only if CLI parity is required in this PR (default: hosted first; CLI optional follow-up)

**Interfaces:**
- Consumes: `POST /api/cli/mcp/cmo/decide`
- Produces: MCP tool `robynn_cmo_decide`

- [ ] **Step 1: Write failing client + tool tests**

Client test asserts POST body shape. Tool test asserts success structuredContent includes new run id + blocks passthrough; error path for API failure.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm vitest run src/tools/cmo-decide.test.ts src/robynn-client.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement client method + tool + registration**

```ts
// robynn-client.ts
async cmoDecide(payload: CmoDecideRequest): Promise<RobynnApiResponse<CmoAgentResult>> {
  return this.fetch("/api/cli/mcp/cmo/decide", {
    method: "POST",
    body: JSON.stringify(payload),
  }, POLL_TIMEOUT_MS)
}
```

```ts
// tools/cmo-decide.ts
server.tool(
  "robynn_cmo_decide",
  "Continue a CMO clarify turn by selecting an option from a decision_card returned by robynn_cmo_agent or robynn_run_status.",
  {
    thread_id: z.string(),
    run_id: z.string(),
    decision_id: z.string(),
    option_id: z.string(),
    note: z.string().optional(),
  },
  { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async (args) => { /* call client.cmoDecide + buildCmoAguiTextFallback */ },
)
```

Register in `index.ts` next to `registerCmoAgentTools`.

Update `all-tools.test.ts` expected tool list/count.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run src/tools/cmo-decide.test.ts src/robynn-client.test.ts src/tools/all-tools.test.ts
pnpm typecheck
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git checkout -b cursor/agui-mcp-phase-c-tool-e5df
git add src/tools/cmo-decide.ts src/tools/cmo-decide.test.ts src/robynn-client.ts src/index.ts src/types.ts src/tools/all-tools.test.ts
git commit -m "feat: add robynn_cmo_decide MCP tool"
```

---

### Task 10: Docs + PR4 closeout

**Repos:** both  
**Files:**
- MCP: `README.md`, `docs/architecture/robynn-mcp-tool-execution-matrix.md`, `CLAUDE.md`
- robynnv3: capability catalog already updated in Task 8
- Optional: mark open implementation details in the design spec as resolved

- [ ] **Step 1: Document Phase C tool + clarify loop**

Add matrix row:

| Tool | Entrypoint | Notes |
| --- | --- | --- |
| `robynn_cmo_decide` | `POST /api/cli/mcp/cmo/decide` | Continues thread after `decision_card` selection |

Document the loop: `robynn_cmo_agent` → (optional) `robynn_run_status` → `robynn_cmo_decide`.

- [ ] **Step 2: Run the full Testing Plan below (Phases A–C + closeout)**

Complete every checkbox in **Testing Plan → Automated gates** and **Manual smoke**. Do not open/merge PR4 until those gates pass.

- [ ] **Step 3: Commit + open PR4**

```bash
git commit -m "docs: document robynn_cmo_decide clarify loop"
git push -u origin <phase-c-branches>
```

Land robynnv3 decide API before or with MCP tool PR.

---

## Testing Plan

Use this section as the merge gate for each PR. Per-task TDD steps above write the tests; this section is what you re-run before declaring a phase done.

### Test matrix (what must exist)

| Phase | Repo | Test file(s) | Must prove |
| --- | --- | --- | --- |
| A | `robynnv3` | `src/lib/server/mcp/cmo-agui.test.ts` | finalized > live; empty metadata; clarify flags |
| A | `robynnv3` | `src/lib/server/mcp/contracts.test.ts` | `response_blocks` / flags parse + default |
| A | `robynnv3` | `src/lib/server/mcp/cmo-agent-runner.test.ts` | success/pending/failed AGUI attachment |
| A | `robynnv3` | `src/routes/api/agents/cmo/runs/[runId]/server.test.ts` | poll JSON includes AGUI fields |
| A | `robynnv3` | `src/routes/api/cli/mcp/cmo/run/server.test.ts` | route still returns success envelope with new fields |
| A | MCP | `src/tools/cmo-text.test.ts` | decision text fallback + no-block fallback |
| A | MCP | `src/tools/cmo-agent.test.ts` | `structuredContent.response_blocks` + clarify text |
| A | MCP | `src/tools/runs.test.ts` | completed poll passthrough of AGUI fields |
| A | MCP | `src/tools/assist.test.ts` (if touched) | blocks forwarded when present |
| B | MCP | `src/ui/report-app.test.ts` | `cmoAgui` resource registered |
| B | MCP | `src/ui/cmo-agui-render.test.ts` | **each** Phase B block type + unknown skip |
| C | `robynnv3` | `src/lib/server/mcp/cmo-decide-runner.test.ts` | happy path + bad decision/option + auth/not-found |
| C | `robynnv3` | `src/routes/api/cli/mcp/cmo/decide/server.test.ts` | HTTP envelope + validation errors |
| C | `robynnv3` | `src/lib/server/mcp/capability-catalog.test.ts` | decide tool listed/noted |
| C | MCP | `src/tools/cmo-decide.test.ts` | tool success/error + structuredContent |
| C | MCP | `src/robynn-client.test.ts` | `POST /api/cli/mcp/cmo/decide` body |
| C | MCP | `src/tools/all-tools.test.ts` | `robynn_cmo_decide` registered; count updated |

### Automated gates (run before each PR)

#### PR1 gate — robynnv3 Phase A

- [ ] **Run**
```bash
cd /agent/repos/robynnv3
pnpm exec vitest run \
  src/lib/server/mcp/cmo-agui.test.ts \
  src/lib/server/mcp/contracts.test.ts \
  src/lib/server/mcp/cmo-agent-runner.test.ts \
  src/routes/api/agents/cmo/runs/\[runId\]/server.test.ts \
  src/routes/api/cli/mcp/cmo/run/server.test.ts
```
- [ ] **Expected:** all PASS
- [ ] **Assert in failing fixtures (manual code review of test output):**
  - success path includes `response_blocks.length >= 1` when metadata has finalized blocks
  - failed path forces `response_blocks: []`, `has_decision_cards: false`, `clarify_pending: false`
  - pending path may include live blocks without dropping `poll_after_seconds`

#### PR2 gate — MCP Phase A

- [ ] **Run**
```bash
cd /agent/repos/robynnv3-mcp-connector
pnpm vitest run \
  src/tools/cmo-text.test.ts \
  src/tools/cmo-agent.test.ts \
  src/tools/runs.test.ts \
  src/tools/assist.test.ts \
  src/tools/all-tools.test.ts
pnpm typecheck
```
- [ ] **Expected:** all PASS; `tsc --noEmit` clean for changed files
- [ ] **Assert:** tool text for clarify fixtures contains the decision question and `Options:`

#### PR3 gate — MCP Phase B

- [ ] **Run**
```bash
cd /agent/repos/robynnv3-mcp-connector
pnpm vitest run \
  src/ui/report-app.test.ts \
  src/ui/cmo-agui-render.test.ts \
  src/tools/cmo-agent.test.ts
pnpm typecheck
```
- [ ] **Expected:** all PASS
- [ ] **Assert `cmo-agui-render` covers all seven Phase B types** (`table`, `chart`, `metric_card`, `priority_list`, `progress_pipeline`, `status_checklist`, `decision_card`) **plus** unknown-type skip footer

#### PR4 gate — Phase C end-to-end unit surface

- [ ] **Run robynnv3**
```bash
cd /agent/repos/robynnv3
pnpm exec vitest run \
  src/lib/server/mcp/cmo-decide-runner.test.ts \
  src/routes/api/cli/mcp/cmo/decide/server.test.ts \
  src/lib/server/mcp/capability-catalog.test.ts \
  src/lib/server/mcp/cmo-agent-runner.test.ts
```
- [ ] **Run MCP**
```bash
cd /agent/repos/robynnv3-mcp-connector
pnpm vitest run \
  src/tools/cmo-decide.test.ts \
  src/robynn-client.test.ts \
  src/tools/cmo-agent.test.ts \
  src/tools/cmo-text.test.ts \
  src/ui/cmo-agui-render.test.ts \
  src/tools/all-tools.test.ts
pnpm typecheck
```
- [ ] **Expected:** all PASS

### Required unit cases (copy into tests if missing)

#### `buildCmoAguiFields` / runner
1. Prefers `finalized_response_blocks` over `live_response_blocks`
2. Drops invalid block objects without throwing
3. `has_decision_cards=true` iff a `decision_card` survives parsing
4. `clarify_pending=true` only when decision cards exist **and** output is empty/clarify-like
5. Failed runs zero out AGUI fields even if metadata still has blocks

#### MCP text + tools
1. No blocks → text equals `output` (or default summary)
2. Clarify + decision card → text includes question, option labels, and block-type counts
3. Pending + live blocks → keeps poll/`run_id` guidance **and** includes AGUI fields in `structuredContent`
4. `robynn_run_status` completed payload mirrors AGUI fields from API

#### Renderers
1. Each Phase B type produces non-empty escaped HTML for a minimal valid fixture
2. `tone_picker` (or other unknown) increments `skippedTypes` and appears in footer
3. Malicious strings in labels are HTML-escaped (`<script>` not executable)

#### Decide
1. Valid `decision_id`/`option_id` starts a new run on the same `thread_id`
2. Continuation message uses `buildCheckpointReply` semantics (`Proceed with this checkpoint.`)
3. Unknown decision/option returns tool/API error (not a new CMO run)
4. Cross-org / missing run returns not-found style error

### Manual smoke (staging or local with real auth)

Run only after the matching automated gate is green. Use a test org API key / MCP OAuth token. Replace placeholders.

#### Smoke A — structured passthrough

- [ ] **Start a clarify-style CMO run**
```bash
curl -sS -X POST "$ROBYNN_API/api/cli/mcp/cmo/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Plan a multi-channel launch campaign for us","assistant_id":"cmo_v3","route_hint":"auto"}' \
  | tee /tmp/agui-mcp-a-run.json
```
- [ ] **If `status` is `pending`**, poll until complete:
```bash
RUN_ID=$(jq -r '.data.run_id' /tmp/agui-mcp-a-run.json)
curl -sS "$ROBYNN_API/api/agents/cmo/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | tee /tmp/agui-mcp-a-poll.json
```
- [ ] **Pass criteria**
  - JSON includes `response_blocks` array (may be empty on some prompts; for a bare “plan a campaign” ask, prefer a fixture/org that produces clarify cards)
  - When cards exist: `has_decision_cards=true` and at least one block has `"type":"decision_card"`
  - `output` remains a string (legacy text not removed)

#### Smoke B — MCP Apps report (hosted worker / local wrangler)

- [ ] Start worker: `cd /agent/repos/robynnv3-mcp-connector && npx wrangler dev`
- [ ] Call `robynn_cmo_agent` from an MCP client (or connector test harness) with a result that includes Phase B blocks
- [ ] Open the `ui://reports/cmo-agui.html` / linked report resource
- [ ] **Pass criteria**
  - Table/metric/decision sections visible for present block types
  - Unknown types do not crash the report
  - Decision card shows question + options (read-only is OK before Phase C)

#### Smoke C — decide loop

- [ ] From Smoke A result, pick `decision_id` + `option_id`:
```bash
THREAD_ID=$(jq -r '.data.thread_id' /tmp/agui-mcp-a-poll.json)
RUN_ID=$(jq -r '.data.id // .data.run_id' /tmp/agui-mcp-a-poll.json)
DECISION_ID=$(jq -r '.data.response_blocks[] | select(.type=="decision_card") | .decisionId' /tmp/agui-mcp-a-poll.json | head -1)
OPTION_ID=$(jq -r --arg d "$DECISION_ID" '.data.response_blocks[] | select(.decisionId==$d) | .options[0].id' /tmp/agui-mcp-a-poll.json)

curl -sS -X POST "$ROBYNN_API/api/cli/mcp/cmo/decide" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"thread_id\":\"$THREAD_ID\",\"run_id\":\"$RUN_ID\",\"decision_id\":\"$DECISION_ID\",\"option_id\":\"$OPTION_ID\"}" \
  | tee /tmp/agui-mcp-c-decide.json
```
- [ ] **Pass criteria**
  - Response `status` is `success` or `pending` (not validation error)
  - New `run_id` differs from the clarify run
  - Same `thread_id` is preserved
- [ ] **Negative check**
```bash
curl -sS -X POST "$ROBYNN_API/api/cli/mcp/cmo/decide" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"thread_id\":\"$THREAD_ID\",\"run_id\":\"$RUN_ID\",\"decision_id\":\"$DECISION_ID\",\"option_id\":\"not-a-real-option\"}"
```
  - Expect error payload / non-success; must **not** start a silent success run

### Regression checklist

- [ ] Existing guided tools still register (`pnpm vitest run src/tools/all-tools.test.ts`)
- [ ] `robynn_cmo_agent` without blocks still returns readable `output` text
- [ ] Docs no longer claim content/research default to `cmo_v2`
- [ ] No new dependency on live SSE / `artifact_draft_delta` in MCP path

### Evidence to attach on PRs

For each implementation PR description, paste:
1. The automated gate command + final PASS line counts
2. For Phase A/C API PRs: redacted curl JSON snippets showing `response_blocks` / decide success
3. For Phase B: note which block fixtures the renderer tests cover

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| `response_blocks` / flags on `CmoAgentResult` | 1 |
| Runner attaches blocks from run metadata | 2 |
| Run poll returns blocks | 2 |
| MCP structuredContent passthrough | 3–4 |
| Text fallback with decision questions | 3–4 |
| Docs default `cmo_v3` | 5, 10 |
| MCP Apps report resource | 6 |
| Phase B block subset render + unknown skip | 7 |
| `robynn_cmo_decide` API + tool | 8–9 |
| Capability catalog / matrix updates | 8, 10 |
| No live SSE | Global constraint (no task) |
| content/research best-effort | Deferred follow-up if poll helper not shared cheaply |

## Follow-ups (do not block v1)

- CLI parity for `robynn_cmo_decide` / AGUI fields
- `robynn_create_content` / `robynn_research` AGUI passthrough if not covered by shared poll shaping
- Interactive in-report decision submit via MCP Apps postMessage (tool remains source of truth)
- Broader block types (`outline`, `variation_picker`, etc.)
`)
