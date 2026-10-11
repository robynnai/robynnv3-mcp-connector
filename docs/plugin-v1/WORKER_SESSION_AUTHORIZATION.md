# Worker session binding, per-call reauthorization, Vault and refresh (COS-PLUGIN-001 P10)

Status: implemented on `plugin-v1/p10-worker-session-vault` (stacked on P06, with P12 merged in).
Contract: [`AUTHORIZATION_CONTRACT.md`](./AUTHORIZATION_CONTRACT.md) §5, §6.3, §6.4, §8, D5–D7.
App counterpart: robynnv3 `POST /api/oauth/introspect` (branch `plugin-v1/p10-introspect`).

## 1. What every `/mcp` request goes through

`createOAuthProviderOptions` wraps `RobynnMCP.serve("/mcp")` in `withMcpPreflight` (`src/authorization/mcp-preflight.ts`). It runs as the provider's API handler, so the host bearer is already validated, and before anything reaches a session Durable Object:

1. **Path.** Only `/mcp`. The fetch wrapper (P06) has already 404'd every other `/mcp*` and `/sse*` path.
2. **Host token.** `env.OAUTH_PROVIDER.unwrapToken(bearer)` gives the provider grant id (`hostGrantId`) and the token-level scope, which may be downscoped (F4). `null` ⇒ `401 invalid_token`.
3. **Legacy cutover.** Props that are not a hardened grant (`authVersion !== 2`, or a missing/invalid `appGrantId`, `credentialVersion`, user or org, or a user that differs from the token's) ⇒ the provider grant is revoked and the host gets `401 invalid_token` with `WWW-Authenticate: Bearer … error="invalid_token"`.
4. **Headers.** Every client `x-robynn-*`, `x-partykit-*` and `cf-mcp-*` header is dropped. agents 0.7.5 copies all request headers into the session DO's upgrade request (pinned in `src/__tests__/session-binding.real-agents.test.ts`), so these could otherwise smuggle props or a forged preflight stamp.
5. **Session binding.** A request that names an `mcp-session-id` (POST, GET or DELETE) must match the binding stored in that session DO's own storage. The Worker reads it over DO RPC (`RobynnMCP.getSessionBinding()`, which reads storage directly and never runs `onStart`). Missing or different ⇒ `404` JSON-RPC `-32001 Session not found`, and the host re-initializes. The binding is `{hostGrantId, userId, organizationId, appGrantId}`.
6. **Per-call reauthorization.** If the body holds any `tools/call`:
   - one signed introspection call to the app (`introspectUpstreamGrant`, contract §5), with the stored `credential_version` and, for the audit trail, `host_grant_id` and the first tool's `operation`;
   - `effective = hostToken.scope ∩ grant.scope ∩ props.scopes ∩ introspection.scopes`;
   - each call is decided by `TOOL_POLICY` (§3).

   Outcomes:

   | Introspection | Result |
   |---|---|
   | inactive (`grant_revoked`, `grant_expired`, `grant_not_found`, `identity_mismatch`, `membership_inactive`, `user_disabled`; the last is reserved and not emitted by the app in v1, see AUTHORIZATION_CONTRACT §5) | provider grant revoked; `401 invalid_token` |
   | inactive `credential_version_stale` | `401 invalid_token`; the grant is **kept**, so the host's refresh picks up the new version |
   | unavailable (network, non-200, malformed, secret unset) | MCP tool error `authorization_unavailable` (retryable); nothing is forwarded; nothing is revoked |
   | active, but the tool's scope ∉ `effective` | tool error `insufficient_scope` with `required_scope` |
   | unknown tool | tool error `tool_not_permitted` |
   | memory tool with `scope:"session"` | tool error `unsupported_memory_scope` |

   A batch is all-or-nothing: if any `tools/call` is refused, nothing is forwarded. Refused calls get their tool error, other requests in the batch get JSON-RPC `-32000`, and notifications get nothing.
7. **Forward.** The request goes on with the sanitized headers, `x-robynn-session-binding` (the request identity) and, for authorized tool calls, `x-robynn-preflight: {"appGrantId","tools"}`. The props gain `hostGrantId`.

`initialize`, `tools/list`, `ping`, `resources/*` and notifications need steps 1–5 only. There is no positive authorization cache.

## 2. The session Durable Object (`RobynnMCP`)

- **Binding is write-once.** `onStart(props)` calls `admitStartProps`: the first complete props (the `initialize` caller, F15–F16) are stored as the binding. Later props are adopted only for the identical binding. Mismatching props are never passed to `McpAgent.onStart`, so they are never persisted, and a cold DO after eviction keeps its bound user's state (F17).
- **Upgrade check.** A websocket-upgrade request (the form in which agents delivers each MCP request) is refused with 404 unless `x-robynn-session-binding` matches the stored binding.
- **Cold adoption** applies the same token ordering against the stored props (review N4).
- **Warm adoption.** partyserver ignores later callers' props on a warm DO (F17), so the DO would otherwise keep using an expired upstream token after the host refreshed. `RobynnMCP.fetch` intercepts partyserver's set-name request: if its props carry the same binding and a fresher upstream token (by the token's unverified `exp`, ordering only), it calls `updateProps` and `client.setAccessToken`. An older host access token, still valid until it expires (F13), cannot roll the session back.
- **No in-session refresh (D6).** `RobynnClient` is created without a refresh hook. An upstream 401 surfaces as a fixed `authorization_expired: …` tool error that never echoes the upstream body. The host's own refresh renews both layers.
- **Unauthenticated fallback.** Without usable hardened props, `init()` registers P12's `registerUnauthenticatedStatusTool` (title, hints, host-neutral copy) instead of the old inline, unannotated and Claude-specific tool.
- **Server instructions.** `initialize` returns short host-neutral instructions (`src/server-instructions.ts`): one bound organization; read-only versus execution access and what `insufficient_scope` means; poll the named status tool; and what to do on `authorization_expired` or `authorization_unavailable`.

## 3. `TOOL_POLICY`

`src/authorization/tool-policy.ts` builds the policy from `contracts/tool-route-map.json` at module load: `requiredScope`, `scopeByArgument` (`robynn_conversations`: `list` ⇒ `brand:read`, anything else ⇒ the tool's `requiredScope`) and `argumentPolicy` rejections (memory `scope:"session"`). A map flip, such as P07's † tools or D-A, changes enforcement with no code change. With the shipped map, 16 tools are `brand:read` and 32 are `tools:execute`.

## 4. Vault

Vault tools read R2 directly, so no app route can enforce anything for them. Two layers apply:

1. **The preflight** (§1). After revocation the host gets `401` before the session is addressed; when introspection is unavailable the call is refused. Either way R2 is never reached.
2. **The gate at the R2 call site** (`src/authorization/vault-gate.ts`). `registerVaultTools(server, vault, authorize)` runs `authorize(tool, extra)` before every R2 operation. `createVaultGate` requires a hardened session (`authVersion === 2`, UUID `appGrantId`) and the preflight stamp in `extra.requestInfo.headers` naming this tool and this session's grant. The default gate denies everything. Denial is `authorization_unavailable`, and nothing is read.

Bounds (`src/vault-r2.ts`): objects over 1 MiB are refused with their body cancelled unread; paths and prefixes over 1024 characters and cursors over 1024 characters are refused before any R2 call. The prefix and path traversal checks are unchanged.

## 5. Refresh

`grant_type=refresh_token` at `/token`:

0. **One view of the body (review B1).** `readTokenRequestContext` reads the `/token` form exactly as the provider does: with `formData()`, and only when the media-type essence is exactly `application/x-www-form-urlencoded`. Anything else gets `400 invalid_request` before the provider, as does a repeated `grant_type`, `code`, `redirect_uri`, `refresh_token`, `code_verifier`, `client_id` or `scope`. Without this, a multipart body labelled `…; x=application/x-www-form-urlencoded` (or a UTF-8 BOM) let the Worker and the provider read different `refresh_token` values. One caller's own legacy refresh could then revoke, or route into the coordinator of, another user's grant; this was reproduced on `8606b79`. The callback also requires the Worker's parsed `refresh_token` to name the provider-validated user (`RefreshRequestMismatchError` ⇒ `400 invalid_grant`, nothing revoked). A permanent failure revokes only that bound identity (`UpstreamGrantRevokedError.revokeTarget`).
1. **Serialization.** The wrapper reads `{userId}:{grantId}` from the refresh token (F1, F11; the token itself is not kept) and forwards the request to the Durable Object `refresh:{grantId}` (`RefreshCoordinator`, binding `REFRESH_COORDINATOR`). That DO runs one refresh at a time per grant. A request identical to the one in flight (same `Authorization`, content type and body, compared by sha256) receives a copy of the in-flight result instead of a second upstream refresh. Workers KV is not used: it is eventually consistent. If the binding is missing, a loopback (local) Worker refreshes in-process and logs `oauth.refresh.unserialized`, with P05's 30-second grace window as the backstop. Any other Worker refuses with `503 temporarily_unavailable` and leaves the grant un-rotated (review N3). `src/wrangler-durable-objects.test.ts` pins the binding and migration `v2`.
2. **Callback** (`src/authorization/upstream-refresh.ts`). It never returns `undefined` (F12), and it throws a typed error instead:

   | Situation | Error | Host gets |
   |---|---|---|
   | legacy/incomplete props | `UpstreamGrantRevokedError` | provider grant revoked, `400 invalid_grant` |
   | `MCP_INTERNAL_AUTH_SECRET` unset, network error, 401 (our signature), 429, 5xx, other 400 | `UpstreamUnavailableError` | `503 temporarily_unavailable`; grant **not** rotated |
   | app `400 invalid_grant` | `UpstreamGrantRevokedError` | revoked, `400 invalid_grant` |
   | rotated answer unusable (malformed, no `gid`, wrong audience, or another user, org or grant) | `UpstreamGrantRevokedError` | revoked, `400 invalid_grant` |
   | refresh-time introspection inactive | `UpstreamGrantRevokedError` | revoked, `400 invalid_grant` |
   | nothing requested is on the grant (checked **before** the app is called; review N2) | `RefreshScopeError` | `400 invalid_scope` |
   | the request's `refresh_token` does not name the validated user | `RefreshRequestMismatchError` | `400 invalid_grant`, nothing revoked |

   On success the new props hold the rotated upstream pair and the new `credentialVersion`. `scopes = props.scopes ∩ token scope ∩ introspection scopes`, so they never widen. `accessTokenScope = requested ∩ scopes`. If a role narrowing after rotation leaves that empty, the token is issued with no scope rather than stranding the rotated pair; the preflight then refuses every tool. Finally, `accessTokenTTL = clamp(min(3600, expires_in) − 60, ≥ 60)`. The app base URL always comes from `env`, never from props.
3. **Introspection outage at refresh.** If introspection is unavailable *after* the app has rotated, the refresh still completes, narrowed to the token's scope. The app's rotation RPC has just re-checked the grant and membership itself (P05 `oauth_rotate_refresh_token`), and every tool call is introspected again before it runs. Failing here would strand the rotated upstream token, and the next refresh after the 30-second grace window would trip `refresh_reuse` revocation.

## 6. Ship notes

- `wrangler.toml` adds the `REFRESH_COORDINATOR` binding and migration `v2` (`new_sqlite_classes = ["RefreshCoordinator"]`). The class stores nothing.
- P02's `wrangler.local.toml` needs the same binding and migration. Its config test requires the same DO classes and migrations as `wrangler.toml`.
- Deploy the app's `/api/oauth/introspect` (and its rate-limit bypass) **before** this Worker. Otherwise every tool call answers `authorization_unavailable` and every `/callback` fails closed.
- Existing legacy grants (no `authVersion: 2`) are revoked on their first `/mcp` request or refresh. Users reconnect.

## 7. Tests

- `src/__tests__/worker-session-authorization.test.ts` (25): the real fetch entry, provider, preflight, `RobynnMCP`, `RefreshCoordinator` and tool handlers. agents' transport is emulated from the P01 facts. Covers another user's token on an existing session (POST and DELETE), eviction, the DO defense in depth, reconnect, header stripping, legacy cutover, revocation mid-session, membership removal, a stale credential version, introspection outage, the read-only matrix, argument policy, scope intersection and downscoping, batches, Vault (including after revocation, forged headers and the in-DO gate) and the refresh matrix with concurrency.
- `src/__tests__/session-binding.real-agents.test.ts`: header propagation and `RobynnMCP.onStart` against the installed agents code.
- `src/__tests__/worker-module-exports.test.ts`: the main module exports only functions and classes. A non-function export stops workerd from starting; this was found live.
- Unit tests: `tool-policy`, `session-binding`, `upstream-refresh`, `refresh-coordinator`, plus Vault gate and bounds in `src/tools/vault.test.ts`.
- Live: `cos-share/reports/plugin/P10-evidence/live.mjs` (34 checks on the plugin-local stack).
