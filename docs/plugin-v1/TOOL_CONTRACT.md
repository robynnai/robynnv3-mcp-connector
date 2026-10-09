# Robynn plugin v1 — tool contract (COS-PLUGIN-001 P01)

Status: **baseline + P12 applied** (titles, hints and descriptions ship from `plugin-v1/p12-tool-metadata`; see §6). Machine-readable twin: [`contracts/tool-route-map.json`](../../contracts/tool-route-map.json).
Baseline: MCP Worker `85d7781`, app `6dd04bb`. Authorization rules: [`AUTHORIZATION_CONTRACT.md`](./AUTHORIZATION_CONTRACT.md).
App-side per-route detail and owning packages: app repo `docs/plugin-v1/MCP_ROUTE_MATRIX.md`.

## 1. Catalog counts (reproduced from code)

`src/__tests__/catalog-baseline.test.ts` parses the registrar calls in `RobynnMCP.init()` (M `src/index.ts:100-136`) and the CLI `mcp` command (M `src/cli/index.ts:147-171`), runs them against a real `McpServer`, and calls `tools/list` through the SDK `Client` over an in-memory transport.

| Surface | Count | Why |
|---|---:|---|
| Worker, Vault available (`VAULT` binding + `props.organizationId`) | **48** | 24 registrars |
| Worker, Vault unavailable | **46** | `registerVaultTools` skipped (M `src/index.ts:127-136`) |
| Local CLI (`robynn mcp`, stdio) | **40** | no Vault (2) and website family `core` (M `src/cli/index.ts:163`) drops 6 tools: `robynn_website_audit_v2`, `_v2_status`, `robynn_website_optimization_audit`, `_status`, `robynn_website_audit_orchestrator`, `_status` |

P01 annotation baseline (Worker, 48 tools): `readOnlyHint` true **31** / false **17**; `destructiveHint` true **1**; `openWorldHint` true **14**; all 48 declare the three booleans explicitly; `idempotentHint` declared on **0**; tool-level `title` on **0**.

**After P12** (asserted by `catalog-baseline.test.ts`): `readOnlyHint` true **21** / false **27**; `destructiveHint` true **7**; `openWorldHint` true **19**; `idempotentHint` true **26** / false **16** / omitted **6**; a unique `title` on all **48** (top-level and `annotations.title`). The readOnly split is 21/27 rather than P01's proposed 25/23 because the four † tools stay non-read-only until P07 (see †). The existing "registers exactly 41 tools" test (M `src/tools/all-tools.test.ts:695-728`) is a partial harness (omits Hermes' 5 and Vault's 2) and does not establish the remote inventory.

The unauthenticated fallback (`robynn_status` registered by M `src/index.ts:50-64` when props carry no access token) is a separate, unannotated registration and is not part of the 48.

## 2. Per-tool contract

Conventions used for the proposed hints (P12 implements them; P13 snapshots them):

- **readOnlyHint** — false if *any* path of the call persists or advances Robynn state, reserves/charges credits, or writes to a third party. HTTP method is irrelevant (several GETs write; several POSTs are pure reads).
- **destructiveHint** — true when a call can overwrite or replace existing user data (singleton rebuilds, keyed upserts that clobber, third-party updates). Append-only writes and new-version inserts are not destructive.
- **openWorldHint** — true when the call reaches third parties on the user's behalf: web search/crawl of arbitrary URLs, connected apps (Composio/Arcade, Strapi, Google APIs), paid data vendors, or an agent run that holds a connectors-scoped token. Robynn's own DB, R2, LangGraph and LLM providers used as processors are **not** open world.
- **idempotentHint** — `T` only with evidence that a repeat call has no additional effect; `F` when a repeat duplicates work/charges/writes; `–` (omit) when unproven.
- **Scope** — see AUTHORIZATION_CONTRACT §7: `readOnlyHint:false ⇒ tools:execute`; read-only tools that charge, generate, crawl caller URLs or run generic connected-app queries are also `tools:execute`. `*` = argument-dependent scope.
- **Retry-safe** — whether the Worker client may automatically retry after 5xx/network failure (P11 input). Today it retries **every** call once (M `src/robynn-client.ts:168-200`).
- **†** — read-only hint and `brand:read` scope require P07 to remove the hidden "Brand Completeness" write from the brand-book read path (A `src/lib/services/brand-hub-docs/brand-book-v2-service.ts` `calculateBrandCompleteness`). **P12 ships the conservative values** (`readOnlyHint:false`, `tools:execute`), keyed off `BRAND_BOOK_READS_PERSIST_COMPLETENESS` in M `src/tools/brand-book.ts`. The post-P07 values are in the map as `hintsAfterP07` / `requiredScopeAfterP07`; flip the constant and the map together.

Summary of the changes: P01 proposed that **27 of 48 tools** change at least one of the three existing hints (10 flipping `readOnlyHint`), for totals of readOnly **25**. As shipped by P12 with the † tools conservative, **30 tools** change and **12** flip `readOnlyHint`, for readOnly **21**; the other totals are unchanged: destructive **7**, openWorld **19**; `idempotentHint` true **26** / false **16** / omitted **6**; **22** tools are not retry-safe. Scope split: **20 `brand:read` / 28 `tools:execute`** after P07; **16 / 32** while the † tools stay conservative (as shipped by P12).

| # | Tool | Title | Scope | P01 RO/D/OW | Shipped RO/D/OW/Idem (P12) | Changed | App route(s) | Retry-safe | CLI |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | `robynn_brand_context` | Get Brand Context | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/context/{scope}` | yes | yes |
| 2 | `robynn_brand_context_search` | Search Brand Context | brand:read | T/F/F | T/F/F/T | — | POST `/api/cli/mcp/brand-context/search` | yes | yes |
| 3 | `robynn_status` | Check Robynn Connection | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/context/summary` | yes | yes |
| 4 | `robynn_usage` | Check Credit Balance | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/usage` | yes | yes |
| 5 | `robynn_create_content` | Draft Content with Robynn | tools:execute | F/F/F | F/F/T/F | openWorld | POST `/api/agents/cmo/threads` (thread_id omitted)<br>POST `/api/agents/cmo/threads/{threadId}/runs`<br>GET `/api/agents/cmo/runs/{runId}` (short in-tool poll) | **no** | yes |
| 6 | `robynn_research` | Run Market Research | tools:execute | F/F/F | F/F/T/F | openWorld | POST `/api/agents/cmo/threads` (thread_id omitted)<br>POST `/api/agents/cmo/threads/{threadId}/runs`<br>GET `/api/agents/cmo/runs/{runId}` (short in-tool poll) | **no** | yes |
| 7 | `robynn_assist` | Ask the Robynn Assistant | tools:execute | F/F/F | F/F/T/F | openWorld | POST `/api/agents/cmo/threads` (thread_id omitted)<br>POST `/api/agents/cmo/threads/{threadId}/runs`<br>GET `/api/agents/cmo/runs/{runId}` (short in-tool poll) | **no** | yes |
| 8 | `robynn_conversations` | List or Start Conversations | tools:execute* | F/F/F | F/F/F/F | — | GET `/api/agents/cmo/threads` (action=list)<br>POST `/api/agents/cmo/threads` (action=create) | **no** | yes |
| 9 | `robynn_run_status` | Check Run Status | tools:execute | T/F/F | F/F/F/T | readOnly | GET `/api/agents/cmo/runs/{runId}` | yes | yes |
| 10 | `robynn_cmo_agent` | Run the Robynn CMO Agent | tools:execute | F/F/F | F/F/T/F | openWorld | POST `/api/cli/mcp/cmo/run` | **no** | yes |
| 11 | `robynn_cmo_decide` | Answer a CMO Decision | tools:execute | F/F/F | F/F/T/T | openWorld | POST `/api/cli/mcp/cmo/decide` | yes | yes |
| 12 | `robynn_geo_analysis` | Analyze AI Search Visibility (GEO) | tools:execute | T/F/F | T/F/T/– | openWorld | POST `/api/cli/mcp/geo-analysis`<br>POST `/api/agents/geo/execute` (internal hop) | **no** | yes |
| 13 | `robynn_competitive_battlecard` | Build a Competitive Battlecard | tools:execute | T/F/F | F/T/T/F | readOnly, destructive, openWorld | POST `/api/cli/mcp/competitive-battlecard` | **no** | yes |
| 14 | `robynn_seo_opportunities` | Find SEO Opportunities | tools:execute | T/F/F | T/F/T/– | openWorld | POST `/api/cli/mcp/seo-opportunities`<br>POST `/api/agents/seo/execute` (internal hop) | **no** | yes |
| 15 | `robynn_brand_book_status` | Check Brand Book Completeness | tools:execute † | T/F/F | F/F/F/T † | readOnly | GET `/api/cli/mcp/brand-book/status` | yes | yes |
| 16 | `robynn_brand_book_gap_analysis` | Analyze Brand Book Gaps | tools:execute † | T/F/F | F/F/F/T † | readOnly | POST `/api/cli/mcp/brand-book/gap-analysis` | yes | yes |
| 17 | `robynn_brand_book_strategy` | Plan Brand Book Improvements | tools:execute † | T/F/F | F/F/F/T † | readOnly | POST `/api/cli/mcp/brand-book/strategy` | yes | yes |
| 18 | `robynn_brand_reflections` | List Brand Reflections | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/mcp/brand-book/reflections` | yes | yes |
| 19 | `robynn_trigger_brand_reflections` | Generate Brand Reflections | tools:execute | F/F/F | F/F/F/F | — | POST `/api/cli/mcp/brand-book/trigger-reflections` | **no** | yes |
| 20 | `robynn_publish_brand_book_html` | Export Brand Book as HTML | tools:execute † | F/F/F | F/F/T/T † | openWorld | POST `/api/cli/mcp/brand-book/publish-html` | yes | yes |
| 21 | `robynn_campaign_creator` | Create a Marketing Campaign | tools:execute | F/F/T | F/F/T/F | — | POST `/api/cli/mcp/marketing-campaign` | **no** | yes |
| 22 | `robynn_campaign_status` | Check Campaign Status | tools:execute | T/F/T | F/F/F/– | readOnly, openWorld | GET `/api/cli/mcp/marketing-campaign/status` | **no** | yes |
| 23 | `robynn_website_audit` | Start a Website Audit | tools:execute | T/F/T | F/F/T/F | readOnly | POST `/api/cli/mcp/website/audit` | **no** | yes |
| 24 | `robynn_website_audit_status` | Check Website Audit Status | tools:execute | T/F/T | F/F/F/T | readOnly, openWorld | GET `/api/cli/mcp/website/audit/status` | yes | yes |
| 25 | `robynn_website_audit_v2` | Start a Website Audit (v2) | tools:execute | T/F/T | F/F/T/F | readOnly | POST `/api/cli/mcp/website/audit-v2` | **no** | no |
| 26 | `robynn_website_audit_v2_status` | Check Website Audit (v2) Status | brand:read | T/F/T | T/F/F/T | openWorld | GET `/api/cli/mcp/website/audit-v2/status` | yes | no |
| 27 | `robynn_website_optimization_audit` | Start a Website Optimization Audit | tools:execute | T/F/T | F/F/T/F | readOnly | POST `/api/cli/mcp/website/optimization-audit` | **no** | no |
| 28 | `robynn_website_optimization_audit_status` | Check Website Optimization Audit Status | brand:read | T/F/T | T/F/F/T | openWorld | GET `/api/cli/mcp/website/optimization-audit/status` | yes | no |
| 29 | `robynn_website_audit_orchestrator` | Start a Multi-Agent Website Audit | tools:execute | T/F/T | F/F/T/F | readOnly | POST `/api/cli/mcp/website/audit-orchestrator` | **no** | no |
| 30 | `robynn_website_audit_orchestrator_status` | Check Multi-Agent Website Audit Status | brand:read | T/F/T | T/F/F/T | openWorld | POST `/api/cli/mcp/website/audit-orchestrator/status` | yes | no |
| 31 | `robynn_website_strategy` | Build a Website Strategy | tools:execute | T/F/T | T/F/T/– | — | POST `/api/cli/mcp/website/strategy` | **no** | yes |
| 32 | `robynn_content_plan` | Plan Content | tools:execute | F/F/F | T/F/F/– | readOnly | POST `/api/cli/mcp/content-plan` | **no** | yes |
| 33 | `robynn_weekly_visibility_report` | Get Weekly Visibility Report | brand:read | T/F/F | T/F/T/T | openWorld | POST `/api/cli/mcp/weekly-visibility-report` | yes | yes |
| 34 | `robynn_capabilities` | List Robynn Capabilities | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/mcp/capabilities` | yes | yes |
| 35 | `robynn_brand_source_add` | Add a Brand Source | tools:execute | F/F/T | F/T/F/– | destructive, openWorld | POST `/api/cli/brand/sources` | **no** | yes |
| 36 | `robynn_brand_rebuild` | Rebuild Brand Context | tools:execute | F/F/F | F/T/F/T | destructive | POST `/api/cli/brand/rebuild` | yes | yes |
| 37 | `robynn_connected_apps` | List Connected Apps | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/connectors/capabilities` | yes | yes |
| 38 | `robynn_connected_app_capabilities` | Get Connected App Capabilities | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/connectors/capabilities` | yes | yes |
| 39 | `robynn_query_connected_app` | Query a Connected App | tools:execute | T/F/F | T/F/T/T | openWorld | POST `/api/cli/connectors/read` | yes | yes |
| 40 | `robynn_connected_app_action` | Act in a Connected App | tools:execute | F/T/T | F/T/T/F | — | POST `/api/cli/connectors/act` | **no** | yes |
| 41 | `robynn_publish_strapi_draft` | Save a Strapi Draft | tools:execute | F/F/T | F/T/T/F | destructive | POST `/api/cli/mcp/strapi-draft`<br>POST `/api/publish` (internal hop) | **no** | yes |
| 42 | `robynn_thread_upsert` | Save a Conversation Thread | tools:execute | F/F/F | F/T/F/T | destructive | POST `/api/cli/threads` | yes | yes |
| 43 | `robynn_thread_append` | Append to a Conversation Thread | tools:execute | F/F/F | F/F/F/F | — | POST `/api/cli/threads/{threadId}/messages` | **no** | yes |
| 44 | `robynn_memory_write` | Save a Memory | tools:execute | F/F/F | F/T/F/F | destructive | POST `/api/cli/memory` | **no** | yes |
| 45 | `robynn_memory_get` | Get a Memory | brand:read | T/F/F | T/F/F/T | — | GET `/api/cli/memory` | yes | yes |
| 46 | `robynn_memory_search` | Search Memories | brand:read | T/F/F | T/F/F/T | — | POST `/api/cli/memory/search` | yes | yes |
| 47 | `robynn_vault_list` | List Vault Files | brand:read | T/F/F | T/F/F/T | — | R2 `VAULT binding: list {organizationId}/…` | yes | no |
| 48 | `robynn_vault_read` | Read a Vault File | brand:read | T/F/F | T/F/F/T | — | R2 `VAULT binding: get {organizationId}/{path}` | yes | no |

## 3. Evidence per tool

### `robynn_brand_context`

- **Registrar:** M `src/tools/context.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** GET, no writes; 'full' may read the org's R2 vault (brand-context-service.ts:201).
- **Side effects:** none. **Charges:** none. **External access:** Cloudflare R2 vault read when vault flag is on (internal).
- **Object ownership:** org from token; scope param is a fixed enum.
- **Gaps:** P07 — `src/routes/api/cli/context/[scope]/+server.ts` `GET`: validateApiKey only: no membership, role or scope check; P07 — `src/lib/server/oauth/validate-token.ts` `validateOAuthToken`: drops the JWT scope claim; return a discriminated credential with scopes.

### `robynn_brand_context_search`

- **Registrar:** M `src/tools/context.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** retrieval only; incidental telemetry/snapshot cache writes (persistence-service.ts:637,753-766) are not user-visible.
- **Side effects:** org_context_request_telemetry insert; org_context_snapshots archive+insert in v2 mode. **Charges:** none. **External access:** none.
- **Object ownership:** organization_website_id (:137-150) and sub_brand_id (sub-brand-service.ts:149-166) checked against org.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin.

### `robynn_status`

- **Registrar:** M `src/tools/status.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** GET /api/cli/context/summary, no writes.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** org from token.
- **Gaps:** P07 — `src/routes/api/cli/context/[scope]/+server.ts` `GET`: validateApiKey only: no membership, role or scope check; P12 — `mcp:src/tools/status.ts` `registerStatusTools`: setup skill needs bound org + granted permissions in the result (P10 introspection supplies them).

### `robynn_usage`

- **Registrar:** M `src/tools/status.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22) (Bearer branch).
- **Hint evidence:** reads get_token_breakdown RPC only (TokenService.ts:497-499).
- **Side effects:** none. **Charges:** reads balance only. **External access:** none.
- **Object ownership:** Bearer branch uses token org; session branch checks membership (:49-59).
- **Gaps:** P07 — `src/routes/api/cli/usage/+server.ts` `GET (Bearer branch)`: validateApiKey only: no membership, role or scope check.

### `robynn_create_content`

- **Registrar:** M `src/tools/content.ts`. **App auth today:** agentsApiGuard + requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** creates thread + run, reserves credits, LangGraph run with connectors-scoped agent token.
- **Side effects:** instant_agent_threads (org-visible) insert; instant_agent_runs, instant_agent_messages, brand_hub_docs/artifacts, interactions_history (src/lib/server/instant-agent/runs.ts startInstantAgentRun/finalizeRunIfNeeded). **Charges:** checkRoryTurnCap (src/lib/server/billing/rory-cap.ts:49, fails open) + reserveOrShadow 'instant-agent-chat' (threads/[threadId]/runs/+server.ts:69-80); terminal settle via apply_instant_agent_run_terminal_billing_effect. **External access:** LangGraph CMO run; mints robynn_agent_run_token scope=connectors (runs.ts:11173-11178) usable at /api/cli/connectors/{read,act,execute}; Creative Engine workload token; OpenAI embeddings.
- **Object ownership:** thread_id via verifyThreadAccess (org + owner-or-org-visible) before billing; no collab-project check. **Paired with:** robynn_run_status.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P11 — `mcp:src/tools/content.ts` `registerContentTools`: send a deterministic client_request_key; startRun retry can duplicate run + charge; P12 — `mcp:src/robynn-client.ts` `startRun/getRun`: thread_id/run_id unvalidated and not URL-encoded (path traversal to other same-origin routes); P10 — `src/lib/server/instant-agent/runs.ts` `startInstantAgentRun`: connectors agent-run token minted for OAuth-initiated runs regardless of granted scope.

### `robynn_research`

- **Registrar:** M `src/tools/research.ts`. **App auth today:** agentsApiGuard + requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** same run path as create_content (type=research).
- **Side effects:** instant_agent_threads (org-visible) insert; instant_agent_runs, instant_agent_messages, brand_hub_docs/artifacts, interactions_history (src/lib/server/instant-agent/runs.ts startInstantAgentRun/finalizeRunIfNeeded). **Charges:** checkRoryTurnCap (src/lib/server/billing/rory-cap.ts:49, fails open) + reserveOrShadow 'instant-agent-chat' (threads/[threadId]/runs/+server.ts:69-80); terminal settle via apply_instant_agent_run_terminal_billing_effect. **External access:** LangGraph CMO run; mints robynn_agent_run_token scope=connectors (runs.ts:11173-11178) usable at /api/cli/connectors/{read,act,execute}; Creative Engine workload token; OpenAI embeddings; agent web research not verified in app code.
- **Object ownership:** as robynn_create_content. **Paired with:** robynn_run_status.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P11 — `mcp:src/tools/research.ts` `registerResearchTools`: no client_request_key; unsafe retry.

### `robynn_assist`

- **Registrar:** M `src/tools/assist.ts`. **App auth today:** agentsApiGuard + requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** same run path; caller-controlled claude_skill_slug/history_summary/memory_enabled forwarded to LangGraph.
- **Side effects:** instant_agent_threads (org-visible) insert; instant_agent_runs, instant_agent_messages, brand_hub_docs/artifacts, interactions_history (src/lib/server/instant-agent/runs.ts startInstantAgentRun/finalizeRunIfNeeded). **Charges:** checkRoryTurnCap (src/lib/server/billing/rory-cap.ts:49, fails open) + reserveOrShadow 'instant-agent-chat' (threads/[threadId]/runs/+server.ts:69-80); terminal settle via apply_instant_agent_run_terminal_billing_effect. **External access:** LangGraph CMO run; mints robynn_agent_run_token scope=connectors (runs.ts:11173-11178) usable at /api/cli/connectors/{read,act,execute}; Creative Engine workload token; OpenAI embeddings.
- **Object ownership:** as robynn_create_content. **Paired with:** robynn_run_status.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P09 — `src/lib/server/mcp/orchestrator-contract.ts` `CmoThreadRunRequestSchema`: cap history_summary, allow-list claude_skill_slug, constrain memory_enabled to caller memory; P11 — `mcp:src/tools/assist.ts` `registerAssistTools`: no client_request_key; unsafe retry.

### `robynn_conversations`

- **Registrar:** M `src/tools/conversations.ts`. **App auth today:** agentsApiGuard + requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** action=create inserts an org-visible instant_agent_threads row (threads/+server.ts:82-93); list is a pure read.
- **Side effects:** create: instant_agent_threads insert (visibility=organization). **Charges:** none. **External access:** none.
- **Object ownership:** list filtered to org + own/org-visible (:30-36); master-key subject sees private threads.
- **Scope by argument:** `{"action":{"list":"brand:read","create":"tools:execute"}}`.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P09 — `src/routes/api/agents/cmo/threads/+server.ts` `POST`: MCP-created threads default to org visibility.

### `robynn_run_status`

- **Registrar:** M `src/tools/runs.ts`. **App auth today:** agentsApiGuard + requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** GET syncInstantAgentRun can finalize the run: writes messages, brand_hub_docs, threads, settles billing (runs.ts:11612-11638,12010-12077); CAS + deterministic ids make repeats idempotent.
- **Side effects:** finalization writes on first terminal poll. **Charges:** settles/releases the run's existing reservation only. **External access:** LangGraph state read; OpenAI embeddings via recordInteraction.
- **Object ownership:** getRunById unscoped, then org check (:16-19) + verifyThreadAccess (:21-30) before sync; no run.user_id check. **Paired with:** robynn_create_content|robynn_research|robynn_assist|robynn_cmo_agent.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P11 — `src/routes/api/agents/cmo/runs/[runId]/+server.ts` `GET`: failed/cancelled runs return HTTP 500 -> client retry, status=failed never surfaced; P09 — `src/routes/api/agents/cmo/_compat.ts` `verifyThreadAccess`: org members can read others' runs in org-visible threads.

### `robynn_cmo_agent`

- **Registrar:** M `src/tools/cmo-agent.ts`. **App auth today:** requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** creates thread/run, reserves credits, LangGraph CMO with connectors token.
- **Side effects:** instant_agent_threads (org-visible) insert; instant_agent_runs, instant_agent_messages, brand_hub_docs/artifacts, interactions_history (src/lib/server/instant-agent/runs.ts startInstantAgentRun/finalizeRunIfNeeded); up to 8s in-request sync (cmo-agent-runner.ts:217-230). **Charges:** reserveOrShadow 'instant-agent-chat' (cmo/run/+server.ts:44-55); no Rory turn cap. **External access:** LangGraph CMO run; mints robynn_agent_run_token scope=connectors (runs.ts:11173-11178) usable at /api/cli/connectors/{read,act,execute}; Creative Engine workload token; OpenAI embeddings.
- **Object ownership:** optional thread_id via verifyThreadAccess after the billing reserve (cmo-agent-runner.ts:158-169). **Paired with:** robynn_run_status, robynn_cmo_decide.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P11 — `src/routes/api/cli/mcp/cmo/run/+server.ts` `POST`: failed run returns 500 -> client retry -> duplicate thread/run/reservation; tool sends no idempotency key; P07 — `src/routes/api/cli/mcp/cmo/run/+server.ts` `POST`: add checkRoryTurnCap parity with threads/[threadId]/runs.

### `robynn_cmo_decide`

- **Registrar:** M `src/tools/cmo-decide.ts`. **App auth today:** requireCmoCompatibilityContext (src/routes/api/agents/cmo/_compat.ts:39).
- **Hint evidence:** claims the decision gate (CAS) and starts a continuation run; gate-scoped continuation key collapses retries (conversation-decision.ts:245-314).
- **Side effects:** instant_agent_runs.metadata gate claim/close + continuation run effects. **Charges:** reserveOrShadow (decide/+server.ts:64-75); released on no-new-run/failure. **External access:** LangGraph CMO run; mints robynn_agent_run_token scope=connectors (runs.ts:11173-11178) usable at /api/cli/connectors/{read,act,execute}; Creative Engine workload token; OpenAI embeddings.
- **Object ownership:** thread verifyThreadAccess; run org+thread match; decision/option validated against run blocks (conversation-decision.ts:170-209); no run.user_id check. **Paired with:** robynn_cmo_agent.
- **Gaps:** P07 — `src/routes/api/agents/cmo/_compat.ts` `requireCmoCompatibilityContext`: no membership/scope; master-key sentinel; agentsApiGuard admits any valid bearer; P11 — `src/routes/api/cli/mcp/cmo/decide/+server.ts` `POST`: catch releases the reservation even after a continuation was admitted; P09 — `src/lib/server/instant-agent/conversation-decision.ts` `runConversationDecision`: any org member can resolve another member's gate.

### `robynn_geo_analysis`

- **Registrar:** M `src/tools/geo.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15); agentsApiGuard via signed internalFetch.
- **Hint evidence:** no Robynn persistence; multi-LLM fan-out incl. Perplexity web search (agents multi_llm_query.py); generative cost.
- **Side effects:** LangGraph thread+run (no org metadata); no Supabase writes. **Charges:** none on the MCP path (dashboard bills 'geo-scan'). **External access:** ChatGPT/Claude/Gemini/Perplexity sonar-pro web search; Anthropic.
- **Object ownership:** no caller ids; downstream execute route trusts body organization_id.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P07 — `src/routes/api/agents/geo/execute/+server.ts` `POST`: organization_id taken from the body; agentsApiGuard admits any org's bearer -> cross-tenant brand-context read; P11 — `src/routes/api/cli/mcp/geo-analysis/+server.ts` `POST`: 500s mirrored -> client re-runs a full multi-LLM analysis; no billing reservation; P12 — `mcp:src/tools/geo.ts` `registerGeoTools`: openWorldHint must be true; analysis_depth is dropped; disclose LLM fan-out.

### `robynn_competitive_battlecard`

- **Registrar:** M `src/tools/battlecard.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** may insert competitor_intel_profiles (weekly schedule); agent inserts battlecards/recommendations and overwrites profile threat score/metadata; paid vendors + competitor site fetch.
- **Side effects:** competitor_intel_profiles insert (api.ts:248-258); competitor_battlecards/competitor_recommendations inserts and profile overwrite (agents). **Charges:** none (bypasses intel-dispatcher reserveOrShadow 'competitor-intel-run'). **External access:** Serper, DataForSEO, Ahrefs, Semrush, direct fetch of competitor domain, Anthropic.
- **Object ownership:** competitor resolved by name within org; agent re-verifies competitor_id.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/routes/api/cli/mcp/competitive-battlecard/+server.ts` `POST`: bypasses dispatchCompetitorIntelRun (no CAS lock, billing or run row); retry writes a second battlecard; P08 — `src/lib/server/mcp/api.ts` `findOrCreateCompetitorProfile`: creates a durable scheduled object as a side effect; null-domain race duplicates; P12 — `mcp:src/tools/battlecard.ts` `registerBattlecardTools`: readOnly/openWorld wrong; dropped inputs; local-disk report paths.

### `robynn_seo_opportunities`

- **Registrar:** M `src/tools/seo.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15); agentsApiGuard via signed internalFetch.
- **Hint evidence:** no writes found; scrapes caller company_url via Serper and queries Exa/Firecrawl/Semrush.
- **Side effects:** none found. **Charges:** none on the MCP path (dashboard bills 'seo-scan'). **External access:** Serper scrape/search, Exa, Firecrawl, Semrush, Anthropic.
- **Object ownership:** no caller ids.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/routes/api/cli/mcp/seo-opportunities/+server.ts` `POST`: 500/504 mirrored -> client re-runs a paid run; P12 — `mcp:src/tools/seo.ts` `registerSeoTools`: openWorldHint must be true; unbounded keyword/competitor arrays.

### `robynn_brand_book_status`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** intended read; currently upserts the derived 'Brand Completeness' doc (brand-book-v2-service.ts:181-196,1871).
- **Side effects:** brand_hub_docs 'Brand Completeness' upsert + brand-context cache invalidation (to be removed). **Charges:** none. **External access:** none.
- **Object ownership:** no caller ids.
- **† Conditional:** ships `readOnlyHint:false` + `tools:execute` (P12); becomes `T/F/F/T` + `brand:read` once P07 removes the completeness write.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P07 — `src/lib/services/brand-hub-docs/brand-book-v2-service.ts` `calculateBrandCompleteness (via aggregateBrandBookData)`: read path upserts the 'Brand Completeness' brand_hub_docs row; remove the write or P12 must mark the tool readOnlyHint:false + tools:execute.

### `robynn_brand_book_gap_analysis`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** deterministic, no LLM (brand-book-adapters.ts:255-372); same hidden completeness write.
- **Side effects:** completeness upsert (to be removed). **Charges:** none. **External access:** none.
- **Object ownership:** no caller ids.
- **† Conditional:** as robynn_brand_book_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P07 — `src/lib/services/brand-hub-docs/brand-book-v2-service.ts` `calculateBrandCompleteness (via aggregateBrandBookData)`: read path upserts the 'Brand Completeness' brand_hub_docs row; remove the write or P12 must mark the tool readOnlyHint:false + tools:execute.

### `robynn_brand_book_strategy`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** deterministic templates (brand-book-adapters.ts:374-485); same hidden completeness write.
- **Side effects:** completeness upsert (to be removed). **Charges:** none. **External access:** none.
- **Object ownership:** no caller ids.
- **† Conditional:** as robynn_brand_book_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P07 — `src/lib/services/brand-hub-docs/brand-book-v2-service.ts` `calculateBrandCompleteness (via aggregateBrandBookData)`: read path upserts the 'Brand Completeness' brand_hub_docs row; remove the write or P12 must mark the tool readOnlyHint:false + tools:execute.

### `robynn_brand_reflections`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** org-filtered changelog reads only (changelog-service.ts:254,805).
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** no caller ids.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin.

### `robynn_trigger_brand_reflections`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** processes the pending changelog queue: inserts/updates brand_hub_docs_changelog and brand_reflection_clusters; LLM synthesis.
- **Side effects:** rate-limit upsert; changelog + reflection cluster writes. **Charges:** none (LLM spend unmetered). **External access:** LangGraph brand_reflection -> Anthropic (no web).
- **Object ownership:** no caller ids; reads org-wide conversation_memories. **Paired with:** robynn_brand_reflections.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/lib/server/mcp/brand-book-adapters.ts` `assertTriggerReflectionsCooldown/armTriggerReflectionsCooldown`: non-atomic cooldown armed only on success; retry/concurrency reprocesses the queue; P09 — `src/lib/services/brand-hub-docs-changelog/aggregate-pattern-analyser.ts` `gatherCorpus`: reads all users' conversation_memories into org-visible evidence; P12 — `mcp:src/tools/brand-book.ts` `registerBrandBookTools`: dry_run description inaccurate (synthesis skipped).

### `robynn_publish_brand_book_html`

- **Registrar:** M `src/tools/brand-book.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** inline HTML export, no storage/public URL (brand-book-adapters.ts:612-656); server fetches the stored logo URL (brand-book-export-service.ts:404).
- **Side effects:** completeness upsert (to be removed). **Charges:** none. **External access:** fetch of stored logo previewUrl with no allow-list (possible SSRF).
- **Object ownership:** no caller ids.
- **† Conditional:** as robynn_brand_book_status; tool does NOT publish — returns HTML inline.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P07 — `src/lib/services/brand-hub-docs/brand-book-v2-service.ts` `calculateBrandCompleteness (via aggregateBrandBookData)`: read path upserts the 'Brand Completeness' brand_hub_docs row; remove the write or P12 must mark the tool readOnlyHint:false + tools:execute; P07 — `src/lib/services/brand-book-export-service.ts` `imageUrlToBase64`: possible full-read SSRF via stored logo URL; allow-list/validate; P12 — `mcp:src/tools/brand-book.ts` `registerBrandBookTools`: description must say export, not publish; theme/include_private_sections ignored.

### `robynn_campaign_creator`

- **Registrar:** M `src/tools/campaign.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** LangGraph marketing_campaign_builder run; persists thread, brand_hub_docs, messages and a tokenized report.
- **Side effects:** persistCampaignArtifact: instant_agent_threads, brand_hub_docs, create_doc_version, instant_agent_messages, storage upsert + tokenized report URL. **Charges:** none found. **External access:** LangGraph marketing_campaign_builder (web use not verified).
- **Object ownership:** no caller ids. **Gate:** robynn-ai environment slug only. **Paired with:** robynn_campaign_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/routes/api/cli/mcp/marketing-campaign/+server.ts` `POST`: 502/500 -> client retry -> new LangGraph run + duplicate artifact; P07 — `src/lib/server/mcp/api.ts` `resolveMcpEnvironment`: unordered limit(1) environment selection.

### `robynn_campaign_status`

- **Registrar:** M `src/tools/campaign.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** GET persists the campaign artifact on success and re-uploads/updates on every repeat poll (campaign-artifact-persistence.ts:143-173).
- **Side effects:** persistCampaignArtifact writes (as creator); concurrent first polls can duplicate. **Charges:** none. **External access:** LangGraph reads.
- **Object ownership:** NONE: caller-supplied LangGraph thread/run ids read directly with no org/assistant metadata check. **Gate:** robynn-ai environment slug only. **Paired with:** robynn_campaign_creator.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P08 — `src/lib/server/mcp/marketing-campaign-runner.ts` `getMarketingCampaignRunStatus`: verify LangGraph thread metadata.organization_id and assistant_id before reading state (cross-tenant read + persist); P08 — `src/lib/server/mcp/campaign-artifact-persistence.ts` `persistCampaignArtifact`: unique (org, thread, run) + skip re-store when already persisted; P12 — `mcp:src/tools/campaign.ts` `registerCampaignTools`: readOnlyHint true is wrong.

### `robynn_website_audit`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** BillingService.charge 'website-audit-report' (50 cr) before dispatch; inserts prospect_audits; public audit_url.
- **Side effects:** prospect_audits insert/updates; LangGraph cmo_audit_v1 thread+run; public tokenized audit page. **Charges:** direct non-refundable charge before validation (+server.ts:88-105). **External access:** agent crawls caller website_url (no app-side SSRF guard).
- **Object ownership:** no caller object ids. **Gate:** robynn-ai environment slug only. **Paired with:** robynn_website_audit_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/routes/api/cli/mcp/website/audit/+server.ts` `POST`: charges before runner failures; 500 without refund + client retry = double charge; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: readOnlyHint true is wrong; disclose charge and robynn-ai restriction; goals/competitors/analysis_depth ignored.

### `robynn_website_audit_status`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** status GET advances the audit: LangGraph poll, LLM extraction, prospect_audits updates (prospect-audit-runner.ts:421-429,510-514); converges once complete.
- **Side effects:** prospect_audits updates; storage read; Anthropic extraction. **Charges:** none. **External access:** LangGraph + Anthropic (processors).
- **Object ownership:** NONE: fetchProspectAudit selects by id only (prospect-audit-runner.ts:164-179). **Gate:** robynn-ai environment slug only. **Paired with:** robynn_website_audit.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P08 — `src/lib/server/mcp/prospect-audit-runner.ts` `fetchProspectAudit / pollMcpProspectAuditStatus`: no organization_id filter: reads/advances other orgs' audits and returns their audit_url + LangGraph ids; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: readOnlyHint true is wrong.

### `robynn_website_audit_v2`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** reserveOrShadow 'website-audit-v2' (50 cr); creates scans/pages/recommendations/heal findings; crawls.
- **Side effects:** design_studio_optimization_scans/_scan_pages/_recommendations, design_studio_heal_findings, design_studio_sites platform detection. **Charges:** reservation; released on dispatch failure or active-scan reuse. **External access:** public-URL-guarded crawl (Firecrawl/native fetch), LangGraph website_optimization_v2.
- **Object ownership:** site_id org-scoped; goal_id unvalidated when site_id absent (scan-runner.ts:480). **Paired with:** robynn_website_audit_v2_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P08 — `src/lib/server/design-studio/seo-geo/v2/scan-runner.ts` `startCliWebsiteAuditV2`: validate goal_id against org when site_id is absent; P11 — `src/lib/server/design-studio/seo-geo/v2/scan-runner.ts` `findReusableActiveV2Scan`: 30-min reuse is only partial retry protection; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: readOnlyHint true is wrong; mode ignored; site_id description.

### `robynn_website_audit_v2_status`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** pure read via org-scoped getScan (v2/scan-runner.ts:549-556).
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** getScan(scanId, organizationId). **Paired with:** robynn_website_audit_v2.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: openWorldHint should be false.

### `robynn_website_optimization_audit`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireAgentMcpApiContext (src/lib/server/mcp/api.ts:57) -> validateConnectorGatewayAuth.
- **Hint evidence:** reserveOrShadow 'website-optimization-v3'; fresh scan id per call; crawls + LLM.
- **Side effects:** scans/pages/recommendations; evidence_graph.start_request for cron replay. **Charges:** reservation (units = estimate), settled by runner. **External access:** public-URL-guarded crawl; LangGraph v3 or local v3 Firecrawl/LLM.
- **Object ownership:** site_id org-scoped; goal_id unvalidated (contracts.ts:507). **Paired with:** robynn_website_optimization_audit_status.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P11 — `src/lib/server/design-studio/seo-geo/v3/scan-runner.ts` `startCliWebsiteOptimizationAuditV3`: fresh randomUUID per call; idempotency_scan_id stripped by the MCP schema; P08 — `src/lib/server/design-studio/seo-geo/v3/scan-runner.ts` `startCliWebsiteOptimizationAuditV3`: goal_id persisted without org/site validation; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: readOnlyHint true is wrong; no confirmed_estimate_id/site_id inputs.

### `robynn_website_optimization_audit_status`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireAgentMcpApiContext (src/lib/server/mcp/api.ts:57) -> validateConnectorGatewayAuth.
- **Hint evidence:** pure read via org-scoped getScan (v3/scan-runner.ts:560-567).
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** getScan(run_id, organizationId). **Paired with:** robynn_website_optimization_audit.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: openWorldHint should be false.

### `robynn_website_audit_orchestrator`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** reserveOrShadow 'website-audit-orchestrator' (50 cr); starts a v3 scan; description wrongly says read-only.
- **Side effects:** same as v3 start. **Charges:** reservation; released on error/estimate-only. **External access:** public-URL-guarded crawl; LangGraph/Firecrawl/LLM via v3.
- **Object ownership:** site_id org-scoped (:159-194). **Paired with:** robynn_website_audit_orchestrator_status.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `src/routes/api/cli/mcp/website/audit-orchestrator/+server.ts` `POST`: new billing session + scan per request; retry duplicates; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: description says read-only; it charges and persists.

### `robynn_website_audit_orchestrator_status`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** pure read through org-scoped getScan; POST transport only.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** getScan(run_id, organizationId). **Paired with:** robynn_website_audit_orchestrator.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P12 — `mcp:src/tools/website.ts` `registerWebsiteTools`: openWorldHint should be false.

### `robynn_website_strategy`

- **Registrar:** M `src/tools/website.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** no DB writes (persist_artifacts:false); synchronous LangGraph website_report_v1 that crawls the caller URL; uncharged LLM-heavy run.
- **Side effects:** none found. **Charges:** none (uncharged LLM run). **External access:** LangGraph crawl of caller website_url without app-side SSRF guard.
- **Object ownership:** no caller ids.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P11 — `mcp:src/robynn-client.ts` `fetchWithRetry`: automatic 5xx/network retry re-runs this non-idempotent call.

### `robynn_content_plan`

- **Registrar:** M `src/tools/content-plan.ts`. **App auth today:** requireMcpApiContext (src/lib/server/mcp/api.ts:15).
- **Hint evidence:** no app writes found (dry_run is only forwarded); LangGraph planner /runs/wait, LLM cost.
- **Side effects:** none found. **Charges:** none (LLM spend unmetered). **External access:** LangGraph content planner (no web).
- **Object ownership:** research_artifact_id and project_id org-scoped; research_packet unbounded.
- **Gaps:** P07 — `src/lib/server/mcp/api.ts` `requireMcpApiContext`: no active-membership, role or OAuth scope check; OAuth sub 'organization_master_key' would impersonate first admin; P12 — `mcp:src/tools/content-plan.ts` `registerContentPlanTools`: dry_run text implies calendar writes the app never performs; P09 — `src/lib/server/mcp/contracts.ts` `ContentPlanRequestSchema`: bound research_packet size.

### `robynn_weekly_visibility_report`

- **Registrar:** M `src/tools/weekly-visibility.ts`. **App auth today:** requireAgentMcpApiContext (src/lib/server/mcp/api.ts:57) -> validateConnectorGatewayAuth.
- **Hint evidence:** no writes found; live GSC/GA4 reads via Composio for the org's own connected properties.
- **Side effects:** none found. **Charges:** none. **External access:** Google Search Console + GA4 via Composio (read).
- **Object ownership:** website and GSC connection resolved within org.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P12 — `mcp:src/tools/weekly-visibility.ts` `registerWeeklyVisibilityTools`: openWorldHint must be true (live Google API reads).

### `robynn_capabilities`

- **Registrar:** M `src/tools/capabilities.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42).
- **Hint evidence:** static catalog + org connection summaries.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** org-scoped summaries.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership.

### `robynn_brand_source_add`

- **Registrar:** M `src/tools/brand-operations.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42) + role==='admin'.
- **Hint evidence:** brand_hub_docs update-or-insert keyed by idempotency_key reused as draftId/collectionId; can overwrite existing docs; no crawl started.
- **Side effects:** brand_hub_docs website draft or ingested text upsert (non-atomic). **Charges:** none. **External access:** none.
- **Object ownership:** org-scoped lookup, but key collides with UI-created drafts/collections. **Paired with:** robynn_brand_rebuild.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P11 — `src/lib/services/brand-hub-docs/brand-hub-docs-service.ts` `upsertWebsiteSourceDraft / upsertIngestedText`: dedicated atomic idempotency key instead of draftId/collectionId; P12 — `mcp:src/tools/brand-operations.ts` `registerBrandOperationTools`: openWorld false, destructive true.

### `robynn_brand_rebuild`

- **Registrar:** M `src/tools/brand-operations.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42) + admin.
- **Hint evidence:** overwrites the brand_context singleton from current sources (brand-hub-docs-service.ts:6420-6444); deterministic.
- **Side effects:** brand_hub_docs brand_context overwrite; LangGraph cache invalidation. **Charges:** none. **External access:** none (internal cache invalidation).
- **Object ownership:** no caller ids. **Paired with:** robynn_brand_source_add.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P12 — `mcp:src/tools/brand-operations.ts` `registerBrandOperationTools`: destructiveHint true.

### `robynn_connected_apps`

- **Registrar:** M `src/tools/connectors.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42).
- **Hint evidence:** local catalog + org connection metadata only.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** org-scoped connections.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership.

### `robynn_connected_app_capabilities`

- **Registrar:** M `src/tools/connectors.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42).
- **Hint evidence:** same route filtered by provider_key.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** org-scoped connections.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership.

### `robynn_query_connected_app`

- **Registrar:** M `src/tools/connectors.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42).
- **Hint evidence:** curated read actions executed live against third-party apps via Composio/Arcade; incidental policy/log writes.
- **Side effects:** connector_policies insert/update (re-adds admin-removed read actions), connector_action_logs insert, connection health update. **Charges:** none. **External access:** Composio/Arcade -> HubSpot, GSC, GA, Google Ads, GitHub, ....
- **Object ownership:** connection_id UUID, org-scoped strict. **Paired with:** robynn_connected_app_capabilities.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P07 — `src/lib/services/connectors/connector-policy-service.ts` `syncExistingPolicyReads`: read path silently widens an admin-restricted allow-list; P12 — `mcp:src/tools/connectors.ts` `registerConnectorTools`: openWorldHint must be true.

### `robynn_connected_app_action`

- **Registrar:** M `src/tools/connector-act.ts`. **App auth today:** validateConnectorGatewayAuth (src/lib/server/auth/connector-gateway-auth.ts:42).
- **Hint evidence:** third-party writes via Composio/Arcade; replay only for completed ok rows.
- **Side effects:** connector_action_audit upsert (overwrites prior non-ok rows) + unchecked updates; policy/log/connection writes; third-party writes. **Charges:** none. **External access:** Composio/Arcade write execution (idempotency_key forwarded).
- **Object ownership:** connection_id org-scoped but non-strict fallback to default connection (connector-execution-service.ts:383-427); write_confirmed self-asserted. **Paired with:** robynn_connected_app_capabilities.
- **Gaps:** P07 — `src/lib/server/auth/connector-gateway-auth.ts` `validateConnectorGatewayAuth`: membership checked but no scope; owner mapped to collaborator (:83); master key -> admin without membership; P11 — `src/routes/api/cli/connectors/act/+server.ts` `POST`: atomic claim, request digest, no re-run of pending rows, checked updates, strict connection_id; P07 — `src/lib/services/connectors/connector-policy-service.ts` `evaluateActionPolicy`: write gate admits every active member; P11 — `mcp:src/robynn-client.ts` `fetchWithRetry`: automatic 5xx/network retry re-runs this non-idempotent call; P12 — `mcp:src/tools/connector-act.ts` `registerConnectorActionTools`: description over-claims idempotency.

### `robynn_publish_strapi_draft`

- **Registrar:** M `src/tools/strapi.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22); validateApiKey (src/lib/server/auth/validate-api-key.ts:22) (forwarded bearer).
- **Hint evidence:** creates or updates a document in the org's connected Strapi; random source id per call without artifact_id.
- **Side effects:** publishing_logs, rory_artifacts update, brand_hub_docs metadata merge, audit event; Strapi create/update. **Charges:** none. **External access:** Strapi API; PostHog.
- **Object ownership:** artifact_id org-checked but any brand_hub_docs type; /api/publish updates at :1035/:1054 lack org filters.
- **Gaps:** P07 — `src/routes/api/cli/mcp/strapi-draft/+server.ts` `POST`: validateApiKey only: no membership, role or scope check; P08 — `src/routes/api/publish/+server.ts` `POST`: org filters on rory_artifacts update and merge_doc_metadata; restrict artifact_id doc types; P11 — `src/routes/api/cli/mcp/strapi-draft/+server.ts` `POST`: stable source id / idempotency key; no client retry; P12 — `mcp:src/tools/strapi.ts` `registerStrapiTools`: destructiveHint true.

### `robynn_thread_upsert`

- **Registrar:** M `src/tools/hermes-bridge.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** hermes_threads upsert on (host_id, session_id) overwrites org/user/title (hermes-bridge.ts:65-69).
- **Side effects:** hermes_threads upsert. **Charges:** none. **External access:** none.
- **Object ownership:** NONE: conflict key lacks organization_id -> cross-org thread takeover. **Paired with:** robynn_thread_append.
- **Gaps:** P07 — `src/routes/api/cli/threads/+server.ts` `POST`: validateApiKey only: no membership, role or scope check; P09 — `src/lib/services/hermes-bridge.ts` `upsertThread`: tenant-scope the conflict key/constraint; refuse reassigning a foreign thread.

### `robynn_thread_append`

- **Registrar:** M `src/tools/hermes-bridge.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** hermes_messages insert, no idempotency key.
- **Side effects:** hermes_messages insert. **Charges:** none. **External access:** none.
- **Object ownership:** thread org check only (:28-36); no user ownership; system/assistant roles accepted. **Paired with:** robynn_thread_upsert.
- **Gaps:** P07 — `src/routes/api/cli/threads/[threadId]/messages/+server.ts` `POST`: validateApiKey only: no membership, role or scope check; P09 — `src/routes/api/cli/threads/[threadId]/messages/+server.ts` `POST`: user-level ownership + role restriction; P11 — `src/lib/services/hermes-bridge.ts` `appendMessage`: idempotency key.

### `robynn_memory_write`

- **Registrar:** M `src/tools/hermes-bridge.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** overwrites by key; unified source_key not user-qualified (agent-memory-substrate.ts:51-53,126-143); legacy NULL user_id duplicates.
- **Side effects:** hermes_memories upsert (legacy) or org_knowledge_documents/chunks upsert+delete (unified). **Charges:** none. **External access:** OpenAI embeddings (processor).
- **Object ownership:** user scope can overwrite another user's memory (unified); session scope unbound. **Paired with:** robynn_memory_get.
- **Argument policy:** `{"scope":{"session":"reject: unsupported_memory_scope (OAuth)"}}`.
- **Gaps:** P07 — `src/routes/api/cli/memory/+server.ts` `POST`: validateApiKey only: no membership, role or scope check; P09 — `src/lib/services/agent-memory-substrate.ts` `writeMemoryUnified`: user-qualify source_key for user scope; P09 — `src/lib/services/hermes-bridge.ts` `writeMemoryLegacy`: NULLS NOT DISTINCT / correct conflict for org+session; P09 — `src/routes/api/cli/memory/+server.ts` `POST`: reject scope=session for OAuth; P12 — `mcp:src/tools/hermes-bridge.ts` `registerHermesBridgeTools`: destructiveHint true; 'session = scoped to this thread' is false.

### `robynn_memory_get`

- **Registrar:** M `src/tools/hermes-bridge.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** GET read.
- **Side effects:** none. **Charges:** none. **External access:** none.
- **Object ownership:** org filter; user filter only for scope=user; legacy org/session lookup likely broken (.eq('user_id', null)). **Paired with:** robynn_memory_write.
- **Argument policy:** `{"scope":{"session":"reject: unsupported_memory_scope (OAuth)"}}`.
- **Gaps:** P07 — `src/routes/api/cli/memory/+server.ts` `GET`: validateApiKey only: no membership, role or scope check; P09 — `src/lib/services/hermes-bridge.ts` `getMemoryLegacy`: .is(null) for org/session; session scoping.

### `robynn_memory_search`

- **Registrar:** M `src/tools/hermes-bridge.ts`. **App auth today:** validateApiKey (src/lib/server/auth/validate-api-key.ts:22).
- **Hint evidence:** hybrid search, no writes.
- **Side effects:** none. **Charges:** none. **External access:** OpenAI query embedding (processor).
- **Object ownership:** legacy: omitted scope returns other users' user-scoped rows; unified: omits caller's own rows.
- **Argument policy:** `{"scope":{"session":"reject: unsupported_memory_scope (OAuth)"}}`.
- **Gaps:** P07 — `src/routes/api/cli/memory/search/+server.ts` `POST`: validateApiKey only: no membership, role or scope check; P09 — `src/lib/services/hermes-bridge.ts` `searchMemory / searchMemoryLegacy (+ hermes_memory_search RPC)`: always pass caller userId; only org-visible + caller-private rows.

### `robynn_vault_list`

- **Registrar:** M `src/tools/vault.ts`. **App auth today:** none — props.organizationId only (M src/index.ts:127-130).
- **Hint evidence:** R2 list under the org prefix (vault-r2.ts).
- **Side effects:** none. **Charges:** none. **External access:** Cloudflare R2 (internal).
- **Object ownership:** prefix-scoped to props.organizationId; no current grant/membership check. **Gate:** requires VAULT binding + organizationId in props. **Paired with:** robynn_vault_read.
- **Gaps:** P10 — `mcp:src/tools/vault.ts` `registerVaultTools`: authorize (introspection) before every R2 operation; fail closed; object-size bounds.

### `robynn_vault_read`

- **Registrar:** M `src/tools/vault.ts`. **App auth today:** none — props.organizationId only (M src/index.ts:127-130).
- **Hint evidence:** R2 get of one object under the org prefix.
- **Side effects:** none. **Charges:** none. **External access:** Cloudflare R2 (internal).
- **Object ownership:** prefix-scoped to props.organizationId; path checks in vault-r2.ts. **Gate:** requires VAULT binding + organizationId in props. **Paired with:** robynn_vault_list.
- **Gaps:** P10 — `mcp:src/tools/vault.ts` `registerVaultTools`: authorize before every R2 operation; fail closed; object-size bounds.

## 4. Starter → poller pairs

| Starter | Poller | Poller writes? | Poller scope |
|---|---|---|---|
| `robynn_create_content`, `robynn_research`, `robynn_assist`, `robynn_cmo_agent` | `robynn_run_status` | yes — first terminal poll finalizes the run (idempotent) | `tools:execute` |
| `robynn_cmo_agent` (clarify) | `robynn_cmo_decide` | starts a continuation run | `tools:execute` |
| `robynn_campaign_creator` | `robynn_campaign_status` | yes — persists/re-uploads the artifact every success poll | `tools:execute` |
| `robynn_website_audit` | `robynn_website_audit_status` | yes — advances + persists the prospect audit | `tools:execute` |
| `robynn_website_audit_v2` | `robynn_website_audit_v2_status` | no | `brand:read` |
| `robynn_website_optimization_audit` | `robynn_website_optimization_audit_status` | no | `brand:read` |
| `robynn_website_audit_orchestrator` | `robynn_website_audit_orchestrator_status` | no | `brand:read` |

Skills (P15) must call the **exact** paired poller and preserve the returned job identifiers.

## 5. Inputs for later packages

- **P12** (done, §6): applied `titleProposal` as the tool-level `title`, `proposedHints` (with `idempotentHint` only where present), and rewrote descriptions to disclose `charges` / `externalAccess` / `environmentGate`. `catalog-baseline.test.ts` now expects 21/27/7/19 (25/23/7/19 after the P07 † flip) and checks the map's `currentHints` in the same change. Each P12 gap in the map carries a `resolution`.
- **P13**: snapshot the real `tools/list` (names, titles, annotations, input schemas) and keep `contracts/tool-route-map.json` in lock-step; prove 48/46/40.
- **P10**: build the Worker `TOOL_POLICY` from `requiredScope`, `scopeByArgument`, `argumentPolicy`.
- **P11**: disable automatic retry for every tool with `retrySafe:false`; add idempotency keys where listed.
- **P07/P08/P09**: the `gaps` arrays name the exact app file + function; the app route matrix groups them by route.

## 6. P12 implementation notes

- **Registration.** All 48 tools register through `server.registerTool` (the SDK's `server.tool()` is deprecated) or `registerAppTool`. Both spread `toolMetadata(title, hints)` from M `src/tools/util.ts`, which sets the top-level `title`, mirrors it into `annotations.title` for hosts that only read the annotation, and declares the three safety booleans plus `idempotentHint` where the map has evidence.
- **Input schemas.** No tool was renamed and no input schema changed shape. The map's `inputSchemaDigest` hashes each `tools/list` `inputSchema` with string `description` keys removed, so the test fails on any shape change but allows wording fixes. Parameter wording changed on 10 tools: `currently ignored` markers for inputs the app drops (`analysis_depth`; website audit `goals` / `competitors` / `analysis_depth`; v2 `mode`; brand-book export `theme` / `include_private_sections`); v2 `site_id` = Website Studio site; `dry_run` semantics for `robynn_trigger_brand_reflections` and `robynn_content_plan`; memory `session` scope; connector `idempotency_key` replay; `run_id` starters.
- **Description conventions.** Each description says:
  - what the tool does;
  - what it saves or overwrites;
  - whether it uses Robynn credits (and whether that is refundable);
  - which third parties it reaches;
  - whether a repeat call duplicates work;
  - which exact poller or starter it pairs with (§4).
- **Description checks** (`catalog-baseline.test.ts`):
  - every starter names its exact poller, and every poller names its starter;
  - charging tools say "credits";
  - `robynn-ai`-gated tools say so;
  - non-read-only tools never call themselves read-only;
  - `robynn_publish_brand_book_html` is described as an export, not a publication.
- **D-A.** The `robynn_query_connected_app` description does not mention its scope. The single flip point is `requiredScope` in the map (see its `openDecision` note), mirrored by the P07 route scope.
- **Path-id guard.** `robynn_create_content`, `robynn_research`, `robynn_assist`, `robynn_run_status` and `robynn_thread_append` reject `thread_id` / `run_id` values outside `[A-Za-z0-9_-]{1,128}` before any request (`isSafePathId`). This closes the same-origin path-traversal gap at the tool layer. P11 should still `encodeURIComponent` path ids in M `src/robynn-client.ts`.
- **Unauthenticated fallback.** `registerUnauthenticatedStatusTool` (M `src/tools/status.ts`) gives the fallback `robynn_status` the same title and hints plus host-neutral copy. Wiring it into `RobynnMCP.init()` (M `src/index.ts`) is left to the owner of that file (P10); until then the old unannotated, Claude-specific fallback remains.
- **Not done in P12** (would change input schemas or files owned elsewhere):
  - bounding the `robynn_seo_opportunities` arrays;
  - adding `confirmed_estimate_id` / `site_id` to `robynn_website_optimization_audit`;
  - returning the bound organization and granted permissions from `robynn_status` (needs P10 introspection);
  - Worker server instructions (none exist today; they would live in M `src/index.ts`).

