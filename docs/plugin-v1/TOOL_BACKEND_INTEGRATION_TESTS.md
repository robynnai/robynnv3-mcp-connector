# Tool and backend integration tests (COS-PLUGIN-001 P17)

Plan §10 P17 and §8 "Every-tool contract coverage": every one of the 48
Worker tools is exercised against the **real backend** on the plugin-local
stack, with synthetic data, for three cases: success, error and permission
denied. P13 (`catalog-contract.test.ts`) proves the MCP side against a mocked
app; this suite proves the app side. Mocked tool handlers never stand in for
backend proof here.

- Suite: `src/__tests__/plugin-local/tool-backend.live.test.ts` (46 tests).
- Deterministic backends: `src/__tests__/plugin-local/backend-fixture.ts` and
  `fixture-graphs.ts`.
- Runs with the P16 live suites: `pnpm test:plugin-local`
  ([`OAUTH_INTEGRATION_TESTS.md`](./OAUTH_INTEGRATION_TESTS.md)).

## What is real and what is a fixture

```text
host OAuth (P16 chain: DCR, S256, real sign-in + consent form actions, /callback, /token)
  → real Worker (wrangler dev --local: preflight + introspection, session DO, local R2)
  → real app (SvelteKit routes, P07 authorization, billing RPCs, persistence)
  → real local Supabase (P02 seed + P17 synthetic rows)
  → BackendFixture on loopback :8123 (the only stand-in)
```

`BackendFixture` is one HTTP server, started by the suite, that answers:

| Role | How the app reaches it | Behaviour |
|---|---|---|
| LangGraph Platform API | `LANGGRAPH_API_URL` / `LANGGRAPH_AGENT_URL` = `http://localhost:8123` (P02 default) | `POST /threads`, `POST /threads/{t}/runs`, `GET …/runs/{r}`, `GET …/runs/{r}/stream` (SSE), `GET /threads/{t}/state`, `POST /runs/wait`. Per-graph synthetic outputs in `fixture-graphs.ts`, shaped to the app's parsers. `nextOutcomes(graph, "error")` fails the next run. |
| Composio v3 | `COMPOSIO_API_BASE_URL=http://localhost:8123` | `POST /api/v3/tools/execute/{SLUG}` |
| Strapi | a synthetic `publishing_credentials` row whose `metadata.base_url` is the fixture | `POST /strapi/drafts` returns a `documentId` |
| Egress proxy | `HTTP_PROXY`/`HTTPS_PROXY=http://localhost:8123`, `NODE_USE_ENV_PROXY=1`, `NO_PROXY=localhost,127.0.0.1` | Every non-loopback request the app makes lands here. Only plain HTTP to the synthetic site `192.0.1.17:80` is tunnelled and served (a homepage for the v3 website audit). Any HTTPS, and any other host, is refused (CONNECT 403 / 502). |

Every fixture request is recorded. The suite proves that:

- a denied call reached no backend;
- every LangGraph call carried the fixture key;
- every graph run named a known graph;
- the only egress the app attempted was the synthetic homepage.

No real agent, LLM, connector or third-party service is contacted. The real
cost-bearing agent smoke test (plan §9) is **not** part of P17 and was not run.

## Running

1. Take the stack lock. Archive P02's scripts (`plugin-v1/p02-plugin-local-env`,
   `24ba429`) into a scratch workspace and apply the scratch patches below,
   exactly as P16 did for its patches. Do not edit P02's branch.
   - **P16's two patches:** the 43-character `code_challenge` in
     `plugin-dev-check.sh`, and `wrangler.local.toml` with the
     `REFRESH_COORDINATOR` binding and migration `v2`.
   - **P17 fixture keys:** extend `PL_APPROVED_KEYS` in
     `scripts/plugin-local/lib.sh`, and have `plugin-env-sync.sh` write the
     approved non-LangGraph keys into `robynnv3.env`:
     ```bash
     # plugin-env-sync.sh, after the LANGGRAPH_API_KEY line
     for name in ${APPROVED_NAMES[@]+"${APPROVED_NAMES[@]}"}; do
       case "$name" in LANGGRAPH_*) ;; *) printf '%s=%s\n' "$name" "${!name}" ;; esac
     done
     ```
   - Then write `.workspace-dev/plugin-local/approved-nonprod.env` (mode 600).
     Every value is a loopback URL, a dummy, or (`GRAPHLIT_ENCRYPTION_KEY`) a
     fresh `openssl rand -hex 32`:
     ```text
     LANGGRAPH_API_KEY=p17-local-fixture-key
     GEO_API_KEY=p17-local-fixture-key
     COMPOSIO_API_KEY=p17-local-fixture-composio
     COMPOSIO_API_BASE_URL=http://localhost:8123
     INSTANT_AGENT_INTENT_ROUTER_MODE=off
     GRAPHLIT_ENCRYPTION_KEY=<openssl rand -hex 32>
     HTTP_PROXY=http://localhost:8123
     HTTPS_PROXY=http://localhost:8123
     NO_PROXY=localhost,127.0.0.1
     NODE_USE_ENV_PROXY=1
     ```
     P02's guard validates these like every other value: plain, loopback only.
2. `plugin-dev-up.sh --reset-db` with `PLUGIN_LOCAL_APP_DIR` and
   `PLUGIN_LOCAL_MCP_DIR` pointing at the checkouts under test. A fresh
   reset matters for three reasons:
   - grants block re-seeding;
   - the app keeps the brand-reflections cooldown in process memory for
     5 minutes;
   - the sign-in limiter allows 10 per hour per IP. This suite signs alpha in
     once.
3. Run the app's env-gated suites to produce the vault export (P16 step 2),
   then:
   ```bash
   PLUGIN_LOCAL_STATE_DIR=<workspace>/.workspace-dev/plugin-local \
   PLUGIN_LOCAL_VAULT_EXPORT_DIR=<export dir> pnpm test:plugin-local
   ```
   For this suite alone:
   ```bash
   PLUGIN_LOCAL_LIVE=1 PLUGIN_LOCAL_STATE_DIR=… npx vitest run \
     src/__tests__/plugin-local/tool-backend.live.test.ts --no-file-parallelism
   ```
   With `PLUGIN_LOCAL_LIVE=1`, a missing state dir or vault export fails the
   run instead of skipping it (P16 review N1). Use `PLUGIN_LOCAL_SKIP=vault`
   to opt out of the vault suite explicitly. The suite also refuses to start
   unless the fixture environment above is present in the running app's env
   file.
4. `plugin-dev-down.sh --purge` and release the lock.

**Synthetic additions** (local DB only, written by the suite's `beforeAll` on
top of the P02 seed):

- 100000 purchased credits for orgs A and B;
- an `organization_websites` row (`192.0.1.17`);
- an active org-shared HubSpot `connector_connections` row;
- a Strapi `publishing_credentials` row, with its token encrypted in the app's
  format using the local key.

Fault injection is limited to one privilege, revoked from `service_role`
(and `PUBLIC` for functions) for one call and granted back in `finally`.

## Permission denied (all 48)

| Case | Tools | Proof |
|---|---|---|
| Read-only grant at the Worker | all 28 `tools:execute` tools (`robynn_conversations` with `action=create`) | `insufficient_scope` with `required_scope: tools:execute` before any backend. Zero fixture requests; business-row snapshot and credit balances unchanged. |
| Read-only upstream token at the app (defense in depth) | every app route of the 28 | 403 `insufficient_scope` from the app itself (the token is minted through the real grant RPC and the signed exchange). Nothing written, no fixture request. |
| Stale credential at the Worker | all 20 `brand:read` tools, Vault included | Credential-version bump: every call answers 401 `invalid_token` at introspection. The grant is not revoked; no backend request, nothing written. |
| Removed member at the app | every app route of the 18 non-Vault `brand:read` tools | 403 `membership_inactive`; the response carries no org B data and nothing is written. |
| Role policy | `robynn_brand_rebuild` (collaborator in org B) | 403 `role_forbidden`, nothing written. Also counted as that tool's error case. |

The business-row snapshot covers the following, per synthetic org:

- `hermes_memories`, `hermes_threads`, `hermes_messages`;
- `brand_hub_docs`, the changelog and its trigger rate limits;
- `instant_agent_threads`, `instant_agent_runs`, `interactions_history`;
- `connector_action_audit`, `connector_action_logs`;
- `prospect_audits`, `mcp_campaign_runs`, `design_studio_optimization_scans`;
- `competitor_intel_profiles`, `publishing_logs`;
- `billing_events`, `token_usage`, `org_knowledge_documents`;
- available credits.

## Success and error per tool

The read-back column names what the suite checks in Postgres.

| Tool | Success (and read-back) | Error |
|---|---|---|
| `robynn_brand_context` | Summary returns org A's seeded marker, never org B's (read-only grant) | Unknown scope is refused (input validation) |
| `robynn_brand_context_search` | Finds org A's fixture phrase, not org B's | A blank query is refused |
| `robynn_status` | `connection` = bound org id and name plus permissions, for both read-only and execute grants (P10 N7) | DB fault on `brand_hub_docs`: a sanitized failure |
| `robynn_usage` | The seeded 100000 credits | Revoked `get_token_breakdown`: a sanitized error |
| `robynn_capabilities` | Bound org; 1 active connector | Revoked `connector_connections` read: a sanitized error |
| `robynn_brand_book_status`, `_gap_analysis`, `_strategy`, `robynn_publish_brand_book_html`, `robynn_brand_reflections` | All five under a **read-only** grant (P17 † flip). HTML returned; **no** "Brand Completeness" doc; snapshot unchanged | Revoked `brand_hub_docs` and changelog reads: each is a sanitized error |
| `robynn_trigger_brand_reflections` | Runs; cooldown row armed in the DB | Immediate second run: 429 cooldown |
| `robynn_conversations` | `create` persists an `instant_agent_threads` row for alpha in org A; `list` (read-only grant) shows it | Unknown action is refused |
| `robynn_create_content` | Fixture CMO graph output returned. Run row completed; `billing_events` reserved:5 then finalized:5; `token_usage` 5. Every LangGraph call carries the fixture key | Failed graph run: sanitized run failure |
| `robynn_research`, `robynn_assist` | Fixture output returned | Unknown `thread_id`: refused |
| `robynn_run_status` | The completed run's output | Unknown run: not found |
| `robynn_cmo_agent` → `robynn_cmo_decide` | A decision card opens the clarify gate; `decide` continues the run | Failed graph run is sanitized; an unknown decision id is refused |
| `robynn_geo_analysis` | threads → runs → poll → state through the app's signed internal hop | Failed run: sanitized error |
| `robynn_competitive_battlecard` | The graph writes its card; the route reads it back; the profile is created for org A | Failed graph: sanitized error |
| `robynn_seo_opportunities` | `runs/wait` report through the internal hop | Failed graph: sanitized error |
| `robynn_content_plan` | Planner rows from a research packet | Failed planner: sanitized error |
| `robynn_weekly_visibility_report` | Report for the org's website (read-only grant) | Unknown website: not found |
| `robynn_website_strategy` | `runs/wait` report | Failed graph: sanitized error |
| `robynn_website_audit` → `_status` | Reserve → dispatch → **settle** (P11 N7): `website-audit-report` reserved:50 then finalized:50, `token_usage` 50, credits −50 exactly. The poller persists `report_data` once (status `draft`); repeat polls write nothing | Org B (not robynn-ai) is refused before any charge. Org A polling org B's audit gets not found, with no foreign data |
| `robynn_website_audit_v2` → `_status` | Scan dispatched to the fixture graph; scan row `completed` | A loopback URL is refused; the reservation is released (credits restored, no scan). Unknown scan id is an error |
| `robynn_website_optimization_audit` → `_status` | Homepage through the egress proxy, v3 run over SSE, completed and settled | A loopback URL is refused; unknown run id is an error |
| `robynn_website_audit_orchestrator` → `_status` | Manual top-level page; completed | A loopback URL is refused; unknown run id is an error |
| `robynn_campaign_creator` → `robynn_campaign_status` | Graph markdown saved once; `mcp_campaign_runs.artifact_id` set | Org B is refused at the gate; unknown runs get not found |
| `robynn_brand_source_add` | Text source stored as `Ingested Text` for org A | A website source without a URL is refused |
| `robynn_brand_rebuild` | Admin rebuild upserts `Brand Context` | Collaborator: 403 `role_forbidden`, nothing written |
| `robynn_connected_apps` | Lists the org's HubSpot connection | Revoked connections read: sanitized error |
| `robynn_connected_app_capabilities` | HubSpot read actions | Unconnected provider: error |
| `robynn_query_connected_app` | One fixture Composio call; data returned | Provider 500: sanitized error |
| `robynn_connected_app_action` | Dry run audited (`ok`, `dry_run`). A confirmed write calls Composio once; the replay is served from the audit (no second provider call, one audit row) | Same key with a changed payload: 409 `idempotency_key_reused` |
| `robynn_publish_strapi_draft` | One fixture Strapi call; exactly one new `publishing_logs` row `cmo_agent\|strapi\|success` (P17 app fix) | Org without a credential: `no_credential` |
| `robynn_thread_upsert` | `hermes_threads` row for alpha in org A | Another user's identical host/session key: 409 `thread_key_conflict`; that row is unchanged |
| `robynn_thread_append` | `hermes_messages` row | `role: system` over OAuth: 400 `unsupported_message_role` |
| `robynn_memory_write` / `_get` / `_search` | Org memory written (`hermes_memories` value), read back, and found by lexical search; org B's never appears | `scope: session`: `unsupported_memory_scope` |
| `robynn_vault_list` / `_read` | Synthetic org A object in local R2 is listed and read; org B's is never returned | Traversal (`../<org B>/…`) is refused |

**Whole-run invariants:**

- all 48 tools covered success, error and denied;
- no unexpected egress;
- every LangGraph call keyed;
- no credential, code, signature, password or local secret in the app or
  Worker logs (P16 canary scan, which now also covers PKCE verifiers and
  signatures).

## Findings fixed in P17

1. **Worker refused brand-book reads the app allows.** P07 removed the
   completeness write and serves the four routes as `brand:read`, but the
   Worker flag and map still required `tools:execute`. P17 flipped
   `BRAND_BOOK_READS_PERSIST_COMPLETENESS` and the map (TOOL_CONTRACT †).
2. **MCP Strapi publishes were never logged.** The tool sends
   `source_type: cmo_agent`, which `/api/publish` accepts, but the
   `publishing_logs` check constraint rejected it. The unchecked insert
   dropped the audit row silently.
   - robynnv3 migration `20261010170000_publishing_logs_cmo_agent_source_p17.sql`
     widens the check (additive);
   - the route now reports a failed log insert (codes only).
3. **`robynn_status` reports the connection** (P10 N7, plan §9 step 5). The
   preflight stamp carries the organization and the effective scopes that
   introspection verified for the call. The status tool returns
   `connection: { organization, permissions, can_execute }`.

## Observations, not changed

- **audit-v2 reserves before its URL guard.** `website/audit-v2` reserves 50
  credits, then refuses a non-public URL and releases them. The net charge is
  zero (asserted), but a refused request briefly holds credits.
  `website/optimization-audit` validates first.
- **The battlecard route reads the newest card after the graph returns.** If
  a graph succeeded without writing a card, it would return the previous card.
- **GEO authenticates to LangGraph with `GEO_API_KEY` only**
  (`agents/geo/execute`), not `LANGGRAPH_API_KEY`. Production must keep
  `GEO_API_KEY` set.
- **audit-v2/v3 status answer 500 for an unknown or foreign scan**, not 404.
  The Worker shows a generic message: no data and no oracle beyond "failed".
