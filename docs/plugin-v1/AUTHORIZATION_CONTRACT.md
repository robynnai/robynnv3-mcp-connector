# Robynn plugin v1 — authorization contract (COS-PLUGIN-001 P01)

Status: **contract lock for P03–P11, P16**. Source of truth for the plan's §6 "minimal authorization design".
Baseline: MCP Worker `85d7781`, app `6dd04bb` (both = `origin/main` on 2026-10-09).
Proof: `src/__tests__/provider-contract.test.ts` (31 cases) and `src/__tests__/catalog-baseline.test.ts`.

Notation: **M** = this repo (`robynnv3-mcp-connector`), **A** = `robynnv3`. Line numbers are at the baseline SHAs.
Per-route gaps live in A `docs/plugin-v1/MCP_ROUTE_MATRIX.md`; per-tool scope/hints live in
[`TOOL_CONTRACT.md`](./TOOL_CONTRACT.md) and [`contracts/tool-route-map.json`](../../contracts/tool-route-map.json).

---

## 1. Decisions locked by this package

| # | Decision | Basis |
|---|---|---|
| D1 | **No `@cloudflare/workers-oauth-provider` upgrade for v1.** Every required contract below is implementable on 0.3.0. | §2 facts F1–F14, all proven by test |
| D2 | Keep two token layers (host↔Worker provider tokens; Worker↔app JWT) and one MCP surface `/mcp`. | Plan §6 |
| D3 | Scope vocabulary stays `brand:read`, `tools:execute`. Omitted scope ⇒ `brand:read`. Unknown scope ⇒ reject (`invalid_scope`). Never widen. | Plan §6; F6, F7 |
| D4 | The **app** owns the durable grant record (`oauth_grants`); the provider grant is a cache that the Worker revokes when the app grant dies. | F12, F13; no app grant table exists today |
| D5 | Authorization is checked **per `tools/call` in the Worker fetch wrapper** (before the Durable Object), plus independently in every app route. No positive authorization cache in v1. | F3, F4, F15–F18 |
| D6 | The DO must not refresh upstream credentials itself; refresh happens only on the provider `/token` path. | F10, F11; split-brain at M `src/index.ts:73-93` |
| D7 | MCP sessions are bound to one provider grant; a different grant presenting an existing `mcp-session-id` gets `404 Session not found`. | F15–F18 |
| D8 | OAuth credentials can never resolve to the organization master-key admin path. | A `src/lib/server/mcp/api.ts:30-47`, `_compat.ts:61-77` |
| D9 | Session-scoped memory is rejected for OAuth callers (`unsupported_memory_scope`). | Plan decision; A `hermes-bridge-types.ts:11-24` |
| D10 | `/sse` stays registered only if a target host needs it; otherwise P06 removes it from `apiRoute`. Claude Code 2.1.29x and Codex 0.16x use streamable HTTP. Either way, unknown `/mcp*` and `/sse*` paths are rejected by the wrapper (F14). | F14 |

---

## 2. Proven facts about the installed dependencies

Each fact names the test (in `src/__tests__/provider-contract.test.ts`) that proves it. A future upgrade that changes a fact must fail that test first.

### workers-oauth-provider 0.3.0

| ID | Fact | Consequence for the contract |
|---|---|---|
| F1 | Grants live at KV `grant:{userId}:{grantId}`; every access/refresh token string is `{userId}:{grantId}:{secret}`. | `grantId` is recoverable from any bearer/refresh token without a lookup. |
| F2 | Props are AES-GCM encrypted with a key wrapped by the token; the upstream app credential never appears in KV plaintext. | Keep upstream tokens only in props. |
| F3 | The API handler receives **only decrypted props** in `ctx.props` — no scope, no grantId, no clientId. | Wrapper must fetch them itself. |
| F4 | `env.OAUTH_PROVIDER.unwrapToken(bearer)` returns `{grantId, userId, scope (token-level, possibly downscoped), grant: {clientId, scope, props}}`. | This is how the wrapper learns host-token scope and grant identity. |
| F5 | Token scope is **not enforced** at API time — a `brand:read` token reaches the API handler. | Worker must enforce scope per tool. |
| F6 | `/token` silently **narrows** requested scope to the grant; it never widens and never errors on extra scopes. `accessTokenScope` from the callback can also only narrow. | Downscoping is safe; widening is impossible at this layer. |
| F7 | `parseAuthRequest` returns **unfiltered** scopes (e.g. `admin:everything`); `completeAuthorization` stores whatever the Worker passes. | Worker must validate scopes before redirecting to the app. |
| F8 | `completeAuthorization` accepts any `userId`, including `"unknown"`. | Worker must validate identity (M `auth-handler.ts:337-350`). |
| F9 | PKCE: optional by default; `plain` accepted by default. `allowPlainPKCE:false` rejects `plain` **and** an omitted method (parser defaults to `plain`), but **`code_challenge_method=S256` with no `code_challenge` still yields a non-PKCE code**. Wrong verifier and code replay are rejected; replay revokes the grant. | P06 must set `allowPlainPKCE:false` **and** reject a missing `code_challenge` in the Worker `/authorize` handler. |
| F10 | Token exchange accepts **any registered** `redirect_uri` for the client, not the one used at `/authorize`; with PKCE it may be omitted entirely. | P06 records the authorize-time redirect in its state and the wrapper rejects a mismatching `redirect_uri` at `/token` (or rely on PKCE + single-URI clients; record the choice in P06). |
| F11 | `tokenExchangeCallback` receives `{grantType, clientId, userId, scope, requestedScope, props}` — **no grantId**. | Wrapper parses grantId from the refresh token in the request body (F1). |
| F12 | Callback returns nothing ⇒ refresh **succeeds with stale props** (current M `src/index.ts:209-222` fails open). Callback **throws** ⇒ `provider.fetch` rejects (no OAuth body) and the grant is **not rotated**; the same refresh token works again later. Returning `refreshTokenTTL` during refresh ⇒ `400 invalid_request`, no rotation. | Fail-closed refresh = throw a typed error, catch it in the Worker fetch wrapper, map to `invalid_grant` (permanent, + revoke) or `temporarily_unavailable` (transient). |
| F13 | `newProps` affect **new** access tokens only; **existing access tokens keep their props snapshot** until expiry. Refresh does not revoke the old access token; the previous refresh token stays valid until the new one is used. | Revocation must be grant-wide (`revokeGrant`), never "rotate and hope". |
| F14 | `revokeGrant(grantId, userId)` deletes the grant and **all** its access tokens; `/token` RFC 7009 revocation of a refresh token kills the grant, of an access token only that token. `completeAuthorization` revokes earlier grants for the same `userId`+`clientId` by default. `listUserGrants` returns non-secret grant metadata. `apiRoute` matching is a raw prefix (`/mcpx`, `/mcp-lazy`, `/mcp/openai` all reach the API handler). Audience from `resource` is enforced by origin + path-prefix. | Revocation primitive exists; path allow-list must be done by the Worker. Note M `normalizeOAuthRequestResource` (`auth-handler.ts:46-66`) merges the origin root into `resource`, which makes the audience origin-wide. |

### agents 0.7.5 / partyserver 0.3.3

| ID | Fact | Consequence |
|---|---|---|
| F15 | `McpAgent.serve("/mcp")` addresses the DO as `idFromName("streamable-http:" + mcp-session-id)` — **session id only**, not user/grant. The initialize request gets `newUniqueId()`. | Any valid token + a known session id reaches that DO. |
| F16 | The current request's `ctx.props` is forwarded to the DO on **every** request (`x-partykit-props`). Unknown session ids return `404 Session not found`. | Per-request props are available at the DO boundary. |
| F17 | partyserver calls `onStart(props)` **once per activation**: a warm DO ignores later callers' props; after eviction the **latest caller's** props are adopted. | Without a binding check a warm DO runs tools with the first caller's credentials, and a cold one with whoever came last. |
| F18 | `McpAgent.onStart(props)` persists props to DO storage key `props` when given, else reloads them. `RobynnMCP.updateProps` (M `src/index.ts:90`) writes only DO storage, never the provider grant. | DO-side refresh diverges from the provider grant (split brain). |

---

## 3. Grant record (app-owned, P05)

New table `public.oauth_grants` (additive migration; service-role only RLS, like `oauth_refresh_tokens` in A `supabase/migrations/20260308140000_add_oauth_tables.sql`). Writer's `writer_connections` (`20260909180000_writer_native_connections.sql`) is the reference model.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | **grant_id**; carried as JWT claim `gid` |
| `user_id` | `uuid` FK `auth.users` | never the `organization_master_key` sentinel |
| `organization_id` | `uuid` FK `organizations` | chosen explicitly at consent (P04) |
| `client_id` | `text` | upstream client, `robynn-mcp-worker` |
| `host_client_id` | `text` null | Worker DCR client id (display + targeted invalidation) |
| `host_client_name` | `text` null | escaped display only |
| `scopes` | `text[]` | subset of `{brand:read, tools:execute}`; non-empty; immutable for the grant's life |
| `credential_version` | `int` default 1 | claim `ver`; bump to invalidate all outstanding access JWTs |
| `status` | `text` check in (`active`,`revoked`) | |
| `revoked_at`, `revoked_reason` | `timestamptz`, `text` | reasons: `user_revoked`, `membership_removed`, `refresh_reuse`, `admin`, `legacy_cutover` |
| `created_at`, `last_used_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | absolute grant lifetime (proposal: 90 days); refresh never extends it |
| `worker_user_id`, `worker_grant_id` | `text` null | provider grant key parts, filled by the Worker after `completeAuthorization` (for targeted Worker revocation) |

Linked changes:

- `oauth_authorization_codes`: add `grant_id uuid` (FK), keep exact `scope` (drop the full-scope default at A `src/lib/server/oauth/codes.ts:31` and in the migration default).
- `oauth_refresh_tokens`: add `grant_id uuid` (FK), `parent_token_hash text`, `used_at timestamptz`, `replaced_by text`. Rotation = one RPC that consumes the presented token and inserts the child atomically; presenting a consumed token revokes the grant (`refresh_reuse`).
- Access JWT (A `src/lib/server/oauth/tokens.ts:generateAccessToken`) — see §4.

## 4. Upstream access-token claims (app JWT, P03/P05)

Header `{"alg":"HS256","typ":"JWT"}` — validated, not ignored. Secret: `OAUTH_JWT_SECRET` only (no `CONNECTOR_STATE_SECRET` fallback). Agent-run tokens get their own `aud`.

| Claim | Value | Validation in `validateAccessToken` |
|---|---|---|
| `iss` | `robynn.ai` | exact |
| `aud` | `robynn-api:mcp` (fixed constant, new) | exact; agent-run tokens use `robynn-api:agent-run` |
| `type` | `access` | exact |
| `sub` | user UUID | UUID; reject `organization_master_key` and any non-UUID |
| `org` | organization UUID | UUID |
| `gid` | grant UUID | UUID; required for OAuth tokens minted after cutover |
| `ver` | integer | `== oauth_grants.credential_version` (checked in the per-route authorization step, §6) |
| `cid` | `robynn-mcp-worker` | exact |
| `scope` | space-separated subset of the grant scopes | each item ∈ allowed set |
| `iat`, `exp` | integers (seconds) | finite numbers; `exp > now` strictly; `exp - iat ≤ 3600` |
| `jti` | random | presence only (audit) |

`validateOAuthToken` (A `src/lib/server/oauth/validate-token.ts`) returns a **discriminated** credential (P07):

```ts
type RobynnCredential =
  | { kind: "oauth"; userId: string; organizationId: string; grantId: string; scopes: Scope[]; credentialVersion: number; clientId: string }
  | { kind: "user_api_key"; keyId: string; userId: string; organizationId: string }
  | { kind: "org_master_key"; organizationId: string }          // legacy machine credential; never reachable from a JWT
  | { kind: "agent_run"; userId: string; organizationId: string; runId: string; scope: "connectors" | "completion" }
```

## 5. Introspection endpoint (app, P10)

`POST /api/oauth/introspect` — new file A `src/routes/api/oauth/introspect/+server.ts`. Worker-only.

**Authentication:** Worker HMAC with `MCP_INTERNAL_AUTH_SECRET` (no fallback) over `v2.<ts>.<nonce>.POST./api/oauth/introspect.<sha256(body)>`; ±300 s window; nonce single-use (KV/DB, 10 min). Missing/invalid ⇒ `401 {"error":"invalid_client"}` before any DB read. Extend A `src/lib/server/auth/internal-signature.ts` (currently signs method+path+ts only) and M `src/internal-mcp-auth.ts`.

**Request** (no credentials in the body — the Worker is the trusted confidential client and addresses the grant by identity tuple):

```json
{
  "grant_id": "6f0c…",                     // props.appGrantId (from upstream JWT gid at /callback)
  "user_id": "1111…",
  "organization_id": "aaaa…",
  "client_id": "robynn-mcp-worker",
  "host_grant_id": "Kx9…",                 // provider grantId (audit only)
  "operation": { "tool": "robynn_memory_write", "required_scope": "tools:execute" }  // optional, audit
}
```

**Response 200, active:**

```json
{
  "active": true,
  "grant_id": "6f0c…",
  "user_id": "1111…",
  "organization_id": "aaaa…",
  "organization": { "id": "aaaa…", "name": "Synthetic Org A", "slug": "synthetic-a" },
  "client_id": "robynn-mcp-worker",
  "scopes": ["brand:read", "tools:execute"],
  "role": "member",
  "membership_status": "active",
  "credential_version": 3,
  "grant_expires_at": "2027-01-07T00:00:00Z",
  "checked_at": "2026-10-09T18:00:00Z"
}
```

`scopes` here is the **effective** app-side permission set: `grant.scopes` minus anything the current role forbids (§7). Never contains tokens, refresh tokens, emails, or secrets.

**Response 200, inactive** (RFC 7662 style — status 200 so the Worker can distinguish "denied" from "unavailable"):

```json
{ "active": false, "reason": "grant_revoked" }
```

`reason` ∈ `grant_not_found`, `grant_revoked`, `grant_expired`, `identity_mismatch` (tuple doesn't match the stored grant), `membership_inactive`, `user_disabled`, `credential_version_stale`.

**Errors:** `401 invalid_client` (signature), `400 invalid_request` (malformed body), `429` (rate limit), `5xx` ⇒ Worker treats as `authorization_unavailable` (fail closed, retryable).

## 6. Worker request pipeline (P06 + P10)

All steps live in a new M `src/authorization/` module, invoked from the default export's `fetch` in M `src/index.ts` (around `oauthProvider.fetch`) and from a thin `apiHandler` wrapper around `RobynnMCP.serve("/mcp")`.

### 6.1 `/authorize` (P06, M `src/auth-handler.ts`)

1. `parseAuthRequest`; require `response_type=code`, a `code_challenge`, and `code_challenge_method=S256` (F9). Provider option `allowPlainPKCE:false`.
2. Scope: omitted ⇒ `["brand:read"]`; any unknown item ⇒ redirect `error=invalid_scope` (F7). Pass the **requested** scope set to the app consent (replace fixed `DEFAULT_OAUTH_SCOPE_STRING` at `auth-handler.ts:247`).
3. `resource`: accept only the approved aliases (`{base}`, `{base}/mcp`, `{base}/sse` if D10 keeps it); do not merge foreign values (`normalizeOAuthRequestResource`, `auth-handler.ts:46-66`).
4. State: random, stored in KV with the parsed request, the authorize-time `redirect_uri`, and a browser-binding nonce set as an `HttpOnly; Secure; SameSite=Lax` cookie; consumed with delete-before-use.

### 6.2 `/callback` (P06)

1. Validate state + cookie nonce; reject replays.
2. Exchange the app code with the signed request (P03 signature covers code **and** refresh).
3. Validate the app token response: call introspection (§5) — not the base64 decode at `auth-handler.ts:337-350`. Require `active`, UUID `user_id`/`organization_id`, `grant_id`, and `scopes ⊆ requested`. Any failure ⇒ error page, **no** `completeAuthorization`. Never `"unknown"`.
4. `completeAuthorization({ userId: user_id, scope: <app-granted scopes>, metadata: { organizationId, appGrantId, hostClientName }, props: { accessToken, refreshToken, userId, organizationId, appGrantId, scopes, authVersion: 2 }, revokeExistingGrants: true })`.
5. Write `worker_user_id`/`worker_grant_id` back to the app grant (signed call; part of P05/P10).
6. Logs: never log `location`, codes, state, tokens or upstream bodies (current leaks: `index.ts:169-173,286-293`, `auth-handler.ts:325`).

### 6.3 `/token` wrapper (P10)

Around `oauthProvider.fetch` for `POST /token`:

1. Clone the request; for `grant_type=authorization_code`, check `redirect_uri` (if present) equals the authorize-time value (F10).
2. For `grant_type=refresh_token`, parse `{userId}:{grantId}` from `refresh_token` (F1, F11) and hold a per-grant lock (KV lease or DO) so concurrent refreshes serialize.
3. `tokenExchangeCallback` (refresh only): call app `/api/oauth/token` (signed refresh). Outcomes:
   - success ⇒ introspect, require same `user_id`/`organization_id`/`grant_id`; return `{ newProps, accessTokenTTL: min(3600, upstream expires_in) - 60, accessTokenScope: intersect(requestedScope, app scopes) }`.
   - `invalid_grant` / inactive ⇒ throw `UpstreamGrantRevoked`.
   - network/5xx ⇒ throw `UpstreamUnavailable`.
4. Wrapper catch: `UpstreamGrantRevoked` ⇒ `revokeGrant(grantId, userId)` then `400 {"error":"invalid_grant"}`; `UpstreamUnavailable` ⇒ `503 {"error":"temporarily_unavailable"}` (grant un-rotated, F12). Any other throw ⇒ `500 {"error":"server_error"}` with a redacted log.
5. Legacy grants (`props.authVersion !== 2`) ⇒ revoke + `invalid_grant` (forces reconnect; plan §6 "legacy credentials").

### 6.4 MCP request preflight (P10) — **before every `/mcp` request reaches the DO**

1. Path allow-list: exactly `/mcp` (and `/sse`, `/sse/message` only if D10 keeps SSE). Anything else under the API prefix ⇒ `404` (F14).
2. Provider has already validated the host token (F3). `summary = env.OAUTH_PROVIDER.unwrapToken(bearer)` ⇒ `hostGrantId`, `hostScopes`, `userId`, `clientId` (F4). `null` ⇒ `401 invalid_token`.
3. Reject `props.authVersion !== 2` ⇒ `401 invalid_token` + revoke (legacy cutover).
4. **Session binding** (D7): for requests carrying `mcp-session-id`, load KV `mcp-session:{sessionId}` ⇒ `{hostGrantId, userId, organizationId, appGrantId}`; mismatch or missing ⇒ `404` JSON-RPC `-32001 Session not found` (forces re-initialize). On a successful `initialize` response, write the binding (TTL = refresh TTL). Strip any client-supplied `x-robynn-*` headers.
5. For each JSON-RPC message with `method == "tools/call"`:
   1. `policy = TOOL_POLICY[params.name]` (generated from `contracts/tool-route-map.json`; unknown tool ⇒ deny `tool_not_permitted`).
   2. Introspect (§5) with `{grant_id: props.appGrantId, user_id, organization_id}`. Inactive ⇒ revoke the provider grant + return `401 invalid_token` (host re-auths). Unavailable ⇒ JSON-RPC tool error `authorization_unavailable` (no forwarding).
   3. `effective = hostScopes ∩ grant.scope (from unwrapToken) ∩ introspection.scopes` (F5, F6).
   4. `policy.requiredScope ∉ effective` ⇒ tool error `insufficient_scope` (no forwarding, no app call).
   5. Tool-specific argument policy: `robynn_memory_*` with `scope:"session"` ⇒ `unsupported_memory_scope` (D9).
6. Forward to `RobynnMCP.serve("/mcp")`. The DO additionally (defense in depth, P10) overrides `fetch` to adopt the current request's props only when `props.appGrantId`/`userId` equal the stored binding, and otherwise refuses the upgrade (F16, F17).
7. `RobynnMCP` stops calling upstream refresh (D6): on upstream `401` the tool returns `authorization_expired` and the host's normal refresh renews both layers.
8. Vault (`robynn_vault_*`) is covered by step 5 because R2 is only reached via `tools/call`; the vault tools additionally require `props.authVersion === 2` and enforce object-size bounds (P10, M `src/tools/vault.ts`, `src/vault-r2.ts`).

`tools/list`, `initialize`, `ping`, `resources/*` need only steps 1–4 (`resources/read` of `ui://reports/*` is static HTML).

## 7. Scope → operation policy

| Requirement | `brand:read` | `tools:execute` |
|---|---|---|
| Meaning | Approved reads of existing org data; idempotent; no charge; no third-party writes. Includes the fixed-purpose analytics read over the org's own connected Google properties (`robynn_weekly_visibility_report`). | Any persistence, any credit reservation/charge, any LLM/agent generation, any crawl of a caller-supplied URL, any generic connected-app query (`robynn_query_connected_app`) or action. |
| Role (current membership) | `owner`, `admin`, `member`, `collaborator` — status `active` | `owner`, `admin`, `member`, `collaborator` — status `active`; **`robynn_connected_app_action` additionally keeps the act route's existing role/write-confirmation policy** (A `src/routes/api/cli/connectors/act/+server.ts`) |
| Charges | never | allowed; tool descriptions must disclose (P12) |
| Consent default | checked | **unchecked**, explicit opt-in (P04) |

Rules:

1. `readOnlyHint:false` ⇒ `tools:execute` (asserted by `catalog-baseline.test.ts`). A read-only tool that charges or runs LLM generation is still `tools:execute` (e.g. `robynn_website_strategy`, `robynn_geo_analysis`, `robynn_seo_opportunities`, `robynn_content_plan`).
2. Starter/poller pairs: a poller that persists or advances work (`robynn_website_audit_status`, `robynn_campaign_status`, `robynn_run_status`) is `tools:execute`; pure pollers are `brand:read`.
3. Per-tool assignment: [`TOOL_CONTRACT.md`](./TOOL_CONTRACT.md) §2, machine-readable in `contracts/tool-route-map.json` (`requiredScope`, plus `scopeByArgument` / `argumentPolicy`). **16 tools are `brand:read`, 32 are `tools:execute`** while the four † brand-book tools stay conservative (P12: `robynn_brand_book_status`, `_gap_analysis`, `_strategy`, `robynn_publish_brand_book_html` still trigger the hidden "Brand Completeness" write). Once P07 removes that write they return to `brand:read`: **20 / 28** (the map's `requiredScopeAfterP07`). `robynn_conversations` is argument-dependent (`action=list` ⇒ `brand:read`, `create` ⇒ `tools:execute`); memory tools reject `scope:"session"`.
4. Open product decision (Madhukar): `robynn_query_connected_app` is `tools:execute` in v1 (live third-party CRM/analytics data through the user's connections is not "existing Robynn data"); downgrading it to `brand:read` later only needs a map change plus a P07 route change.
5. The **app enforces the same mapping per route** (P07) via a helper `requireMcpOperation(request, locals, { scope, roles? })` that replaces `requireMcpApiContext` / `requireAgentMcpApiContext` / `requireCmoCompatibilityContext` for OAuth credentials. Route → scope is in A `docs/plugin-v1/MCP_ROUTE_MATRIX.md`.

## 8. Error codes

Every denial is decided **before** any business work, charge, object read or external call.

### 8.1 OAuth endpoints (Worker `/authorize`, `/callback`, `/token`; app `/api/oauth/token`)

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | malformed request, missing PKCE challenge, `plain`/missing method |
| `invalid_scope` | 400 / redirect | unknown or empty-after-validation scope |
| `invalid_client` | 401 | app token route: missing/invalid Worker signature (code **and** refresh, P03); introspection signature |
| `invalid_grant` | 400 | bad/expired/replayed code, wrong verifier, wrong redirect, revoked grant, refresh reuse, permanent upstream refresh denial |
| `access_denied` | redirect | user denied consent, no eligible organization |
| `temporarily_unavailable` | 503 | upstream refresh/introspection unreachable (grant not rotated) |
| `server_error` | 500 | anything else (redacted) |

### 8.2 MCP transport (Worker `/mcp`)

| Code | HTTP / JSON-RPC | When |
|---|---|---|
| `invalid_token` | 401 + `WWW-Authenticate: Bearer error="invalid_token"` | missing/expired/revoked host token, legacy grant, introspection says inactive |
| session not found | 404, JSON-RPC `-32001` | unknown session id or session bound to another grant/user |
| path not found | 404 | API-prefix path outside the allow-list |

### 8.3 Tool-level (Worker preflight and app routes) — returned as an MCP tool result `isError: true`

`structuredContent.error = { code, message, required_scope?, retryable }`. Messages are host-neutral and never echo upstream bodies.

| Code | App HTTP | Meaning / user guidance |
|---|---|---|
| `insufficient_scope` | 403 | "This connection is read-only. Reconnect Robynn and allow execution to use this tool." |
| `membership_inactive` | 403 | user is no longer an active member of the bound org |
| `role_forbidden` | 403 | role cannot perform this operation |
| `grant_revoked` | 401 | connection revoked; reconnect |
| `authorization_unavailable` | — (Worker) | introspection failed; retryable; nothing was executed |
| `authorization_expired` | 401 | upstream token expired mid-session; host refresh will renew |
| `not_found` | 404 | object id not found **or not owned by the bound org/user** (no ownership oracle) |
| `unsupported_memory_scope` | 400 | `scope:"session"` via OAuth |
| `tool_not_permitted` | — (Worker) | tool absent from the policy map |
| `idempotency_conflict` | 409 | reused idempotency key with a different payload (P11) |
| `environment_not_eligible` | 403 | existing `robynn-ai` environment gate (not an authorization substitute) |

## 9. Test obligations handed to later packages

| Package | Must add tests proving |
|---|---|
| P03 | JWT header/claim matrix (§4) incl. missing/non-numeric `exp`, `exp == now`, sentinel `sub`, wrong `aud`, agent-run token rejected as access token; unsigned/invalid-signature code **and** refresh at A token route; no `CONNECTOR_STATE_SECRET` fallback (A `tokens.test.ts:59` must flip). |
| P04 | explicit org selection, tampered org/scope rejected, omitted ⇒ `brand:read`, unknown ⇒ error, no empty⇒full fallback; Writer regression (`writer-consent*.test.ts`). |
| P05 | `oauth_grants` lifecycle; atomic refresh rotation under concurrency; reuse revokes grant; `credential_version` bump invalidates JWTs. |
| P06 | F7/F9/F10 closed at the Worker (extend `provider-contract.test.ts` with the real `createOAuthProvider` options), state cookie binding, resource allow-list, script-safe interstitial, log canaries. |
| P07 | every route class in the route matrix denies read-only grants on execute routes, removed members, and OAuth `sub=organization_master_key`. |
| P10 | session binding (F15–F17 attack: user B token + user A session id ⇒ 404), introspection fail-closed, revoked grant ⇒ existing session denied, Vault never touches R2 after revocation, refresh fail-closed (F12) with `invalid_grant`/`temporarily_unavailable`, legacy grant cutover. |
| P11 | no automatic retry for non-idempotent tools (`idempotentHint` absent/false in the map). |
| P16 | the full chain end-to-end on local Supabase with synthetic data. |
