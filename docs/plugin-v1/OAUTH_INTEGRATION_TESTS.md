# OAuth integration and revocation tests (COS-PLUGIN-001 P16)

P16 proves the whole host OAuth chain (plan §6) and its revocation paths, end
to end, at two levels:

1. **In process, in every `pnpm test` run.** The Worker's real default export,
   the real `@cloudflare/workers-oauth-provider` with the Worker's options,
   the P06 front door, the P10 preflight, `RobynnMCP` and `RefreshCoordinator`.
   Durable Objects, KV and R2 are in memory; the app is a stateful fake with
   P05/P10 semantics.
2. **Live, on the plugin-local stack.** The real Worker (`wrangler dev
   --local`), the real app (SvelteKit), and the isolated local Supabase with
   the synthetic seed. Nothing in the chain is stubbed: real sign-in form
   action, real consent form action, the Worker's `/callback` with its signed
   exchange and introspection, the host's PKCE exchange, MCP over streamable
   HTTP, refresh through the `RefreshCoordinator` into the app's rotation
   RPC, and revocation through the user's own
   `DELETE /api/user/connected-apps/:id`.

## Files

| File | What it is |
|---|---|
| `src/__tests__/harness/worker-harness.ts` | Shared in-process harness: platform fakes, the stateful fake app (signed code exchange and refresh, introspection, `consentAtApp`), host and MCP helpers. Extracted from P10's suite, which now imports it. |
| `src/__tests__/harness/agents-mcp-emulation.ts`, `cloudflare-workers-stub.ts` | Module replacements for `agents/mcp` and `cloudflare:workers` (P01 F15–F18 facts only). |
| `src/__tests__/oauth-chain.test.ts` | The full chain through the Worker's real HTTP entry points: DCR, `/authorize`, consent, `/callback`, `/token`, `/mcp`, refresh, revocation. Also the negatives that span both token layers. |
| `src/__tests__/vault-private-memory.test.ts` | `robynn_vault_list` / `robynn_vault_read` through the real Worker path, checked with P09b's output contract (post-P09b vault, pre-P09b leaky vault, spelling tricks). |
| `src/__tests__/harness/private-memory-vault-contract.ts`, `src/__tests__/fixtures/private-memory-vault.contract.json` | Byte-identical copy of robynnv3's P09b contract v2 (`plugin-v1/p09b-vault-private-memory` @ `dd56744b8`), plus a port of `findPrivateMemoryExposure`. |
| `src/__tests__/plugin-local/live-stack.ts` | Live helpers: a cookie-jar browser, the real sign-in and consent posts, the host client, MCP over HTTP, local-DB access (isolated container only), Worker-signed app calls, and the log canary scan. |
| `src/__tests__/plugin-local/oauth-chain.live.test.ts` | The live chain and its negatives (25 tests). |
| `src/__tests__/plugin-local/vault-private-memory.live.test.ts` | The real materializer's vault in the Worker's local R2, read back over real OAuth as two org members (3 tests). |

Paired robynnv3 suites (branch `plugin-v1/p16-oauth-integration`):

- `src/lib/server/oauth/__tests__/grant-lifecycle.plugin-local.test.ts`
- `src/lib/server/vault/__tests__/private-memory.plugin-local-export.test.ts`
- `src/routes/api/vault/[orgId]/[...path]/private-memory.test.ts`

## Running the live suites

The live suites are skipped unless `PLUGIN_LOCAL_LIVE=1` and
`PLUGIN_LOCAL_STATE_DIR` are set. Run them only against the isolated
plugin-local stack, and take the shared stack lock first.

1. Start the stack with `--reset-db`, from a P02 workspace checkout.
   - The suites create grants, which have no DELETE privilege by design. The
     seed then refuses to re-run without a reset.
   - The app's sign-in limiter allows 10 sign-ins an hour per IP. Each run
     signs alpha and beta in once per suite file (4 sign-ins). A fresh app
     process starts with a fresh limiter.

   ```bash
   cd <workspace> && PLUGIN_LOCAL_APP_DIR=<robynnv3 checkout> PLUGIN_LOCAL_MCP_DIR=<this checkout> \
     ./scripts/plugin-dev-up.sh --reset-db
   ```

   The MCP checkout needs an untracked `wrangler.local.toml`. Take P02's file
   (branch `plugin-v1/p02-wrangler-local`) and add the `REFRESH_COORDINATOR`
   binding and migration `v2` from `wrangler.toml`. At P02 `24ba429`,
   `scripts/plugin-dev-check.sh` still sends a 47-character `code_challenge`.
   Shorten it to 43 characters in a scratch copy of the scripts.

2. App side, from the robynnv3 checkout. Read the URL and the local
   service-role key from `<workspace>/.workspace-dev/plugin-local/supabase.env`
   into variables, without printing them.

   ```bash
   P16_LOCAL_SUPABASE_URL=… P16_LOCAL_SUPABASE_SERVICE_ROLE_KEY=… P16_VAULT_EXPORT_DIR=$(mktemp -d) \
     pnpm exec vitest run src/lib/server/oauth/__tests__/grant-lifecycle.plugin-local.test.ts \
       src/lib/server/vault/__tests__/private-memory.plugin-local-export.test.ts
   ```

3. Worker side, from this checkout:

   ```bash
   PLUGIN_LOCAL_STATE_DIR=<workspace>/.workspace-dev/plugin-local \
   PLUGIN_LOCAL_VAULT_EXPORT_DIR=<the export dir from step 2> \
     pnpm test:plugin-local
   ```

   - The vault suite uploads the export with `wrangler r2 object put --local`
     under `orgs/<org>/`. It never addresses a remote bucket.
   - `PLUGIN_LOCAL_APP_URL`, `PLUGIN_LOCAL_WORKER_URL` and
     `PLUGIN_LOCAL_DB_CONTAINER` override the defaults. They are refused unless
     they are loopback URLs and the isolated `supabase_db_…cos_plugin…`
     container.

4. Run `./scripts/plugin-dev-down.sh --purge` and release the lock.

The suites write only to the isolated local database. They restore the
membership they flip, and print no secret: values are read into memory and
registered for the log canary scan.

## Coverage against plan §8 "Required security cases"

| Case | Live (plugin-local) | In process |
|---|---|---|
| Full chain: DCR → S256 PKCE → consent → exchange → refresh → revoke | `oauth-chain.live` happy path (6 tests) | `oauth-chain.test` first test |
| Wrong client or redirect (host layer) | `/token` with another registered client or another redirect: no token, and the code still works once for the real host. `/authorize` with an unregistered redirect: 400, no redirect | `oauth-chain.test`; P06 `provider-contract.worker-options` |
| Wrong client or redirect (app layer) | Signed app exchange with another client (401) or another redirect (`invalid_grant`): the code is not consumed. App lifecycle suite: `client_mismatch` / `redirect_mismatch` | `oauth-chain.test`: app code bound to another redirect |
| Tampered org or scope at consent | Stranger org, removed-member org, two orgs: 403/400, no code. Opt-in not requested, unknown scope, empty scope, foreign redirect, foreign client: no code | P06: consent wider than requested ⇒ `invalid_scope` |
| Missing, plain or incorrect PKCE | Missing, plain and S256-without-challenge refused before any hand-off. A wrong verifier mints nothing | P06 worker-options |
| Code replay | Host code replay ⇒ `invalid_grant`, and the minted grant is revoked. App code replay ⇒ `code_reuse` revokes the family; the earlier access token is then 401 at the app | `oauth-chain.test` (both layers) |
| Expired or replayed OAuth state | `/callback` from another browser (no state cookie) ⇒ 400. The owner then succeeds once, and a replay ⇒ 400 | P06 (expired transaction) |
| Unsigned Worker exchange, refresh and introspection | Each one ⇒ 401 `invalid_client` | P03/P10 route tests (app) |
| Refresh reuse | Upstream reuse after the 30-second grace ⇒ the family is revoked (`refresh_reuse`). Inside the grace window ⇒ same child, nothing revoked. Three concurrent host refreshes ⇒ one rotation | P10 coordinator tests |
| Host-token downscope; no widening | A refresh narrowed to `brand:read` cannot execute. Widening at refresh is ignored | P10 |
| Read-only grant calling mutating tools | Default consent ⇒ `brand:read`. `memory_write` and `conversations create` ⇒ `insufficient_scope`, with no row written | P10 (every `tools:execute` tool) |
| Revoked grant | The user's own DELETE ⇒ tools 401 (`invalid_token` with `resource_metadata`), Vault 401, `tools/list` 401, refresh `invalid_grant`. Another user's DELETE ⇒ 404 | `oauth-chain.test`; P10 |
| Removed member | Next call 401, Worker grant revoked, refresh `invalid_grant`, re-consent 403. App suite: role downgrade ⇒ `membership_inactive` | `oauth-chain.test` |
| Another user's session id | POST, GET and DELETE ⇒ 404 `-32001`. The owner's session keeps working | `oauth-chain.test`; P10 (eviction, reconnect) |
| Credential-version bump | 401 without revocation; refresh renews. App suite: stale ⇒ `credential_version_stale` | P10 |
| Legacy grants | A pre-P05 upstream refresh token ⇒ `invalid_grant`, not consumed. A grant-less access JWT ⇒ 401 at the app | P10: legacy Worker grants (no `authVersion: 2`) are revoked and never reach a session |
| Error and log canaries | Every code, state, cookie, token, password and local secret the suites saw is absent from the app, Worker and stack logs | P06/P10 redaction tests |
| Vault never returns another user's private memory | Real materializer export plus pre-P09b leftovers in local R2; alpha and beta each list and read everything ⇒ no exposure | `vault-private-memory.test` |

## Vault: Worker-side private-memory refusal

P09b chose to skip private rows, not to write a per-user subtree. The
materializer's reconcile and the P09b purge remove objects that earlier runs
leaked.

As defense in depth until every vault is rebuilt, `VaultR2` also hides and
refuses `sources/agent-memory/user-…` and `sources/agent-memory/session-…`.
Those are the slugs of `user:` and `session:` agent-memory keys.

- The rule is `VAULT_HIDES_PRIVATE_MEMORY_PATHS` and `isPrivateMemoryVaultPath`
  in `src/vault-r2.ts`, a one-line flip.
- A refused read looks like a missing object, and R2 is never called.
- The app's vault proxy mirrors the rule (`src/lib/server/vault/r2-reader.ts`).

Private documents from other sources cannot be told apart by path: for
example, a Drive file or website row with `visible_to_user_id` set. Only the
materializer and the purge keep those out. The in-process leaky-vault test
pins this residual explicitly.
