# Worker -> app internal authentication (COS-PLUGIN-001 P03)

Status: implemented by P03 on both sides.

- Worker: `src/internal-mcp-auth.ts` (this repo)
- App (`robynnai/robynnv3`): `src/lib/server/oauth/internal-mcp-auth.ts`, enforced in `src/routes/api/oauth/token/+server.ts`

P03 is the only owner of this contract. P10 reuses the same primitives for `POST /api/oauth/introspect`; it should not define a second scheme.

## 1. Secrets

| Name | Where | Purpose | Fallback |
|---|---|---|---|
| `MCP_INTERNAL_AUTH_SECRET` | Worker secret **and** app env, same value | Worker authentication on internal app calls | **None.** If it is unset, the Worker never sends an unsigned request: `/callback` returns 503 and no upstream refresh is attempted. The app rejects every Worker request with `401 invalid_client`. **Caveat (P10):** the provider's refresh callback still fails open (contract F12), so a host refresh "succeeds" with stale upstream props until those upstream credentials expire. That is not an authentication bypass, because the app rejects the stale upstream JWT. |
| `OAUTH_JWT_SECRET` | App env only | Signs upstream access JWTs and Instant Agent run tokens | **None.** If it is unset, issuance throws, validation rejects, and `tryCreateAgentRunToken` returns `null`. |
| `CONNECTOR_STATE_SECRET` | App only, for connector state | Never used for JWTs or internal auth | Not read by the Worker. Removed from `wrangler.toml`. |

The value that was committed in `wrangler.toml` must be treated as public. Deleting the line does not remove it from git history.

## 2. Signature v2

```text
payload   = "v2" "." timestamp "." nonce "." METHOD "." target "." sha256_b64url(body)
signature = "v2." base64url(HMAC-SHA256(MCP_INTERNAL_AUTH_SECRET, payload))
```

| Field | Rule |
|---|---|
| `timestamp` | Unix epoch in milliseconds, exactly 13 digits. Header `x-robynn-mcp-timestamp`. |
| `nonce` | `[A-Za-z0-9_-]{22,64}`. The Worker sends 16 random bytes encoded as base64url (22 characters). Header `x-robynn-mcp-nonce`. |
| `METHOD` | Upper-case HTTP method. |
| `target` | `pathname + search` of the URL actually requested, for example `/api/oauth/token`. Any query string is signed. |
| `body` | The exact raw request body bytes, `""` if there is none. The app verifies against the raw text before it parses anything, so any change to `code`, `refresh_token`, `redirect_uri`, `client_id` or `grant_type` breaks the signature. |
| `signature` | Header `x-robynn-mcp-signature`, format `v2.<43 base64url chars>`. |

Base64url output has no padding.

### Verifier rules (app)

1. Read the raw body (maximum 8 KiB), then parse it. Writer requests (`client_id=robynn-writer`, a public PKCE client) go to the Writer handler and do not need this signature.
2. For every other request:
   - Require `MCP_INTERNAL_AUTH_SECRET`, all three headers in valid format, a timestamp within ±5 minutes, and a constant-time signature match.
   - Require `client_id == "robynn-mcp-worker"`.
   - Any failure returns `401 {"error":"invalid_client"}` before any code or refresh token is looked up.
3. Consume the nonce once, using `public.consume_internal_request_nonce(nonce, expires_at)`. The migration is `20261009150000_oauth_internal_request_nonces.sql` and the expiry is the timestamp plus 6 minutes.
   - A replayed nonce returns `401 invalid_client`.
   - If the store is unavailable, the request gets `503 temporarily_unavailable` (fail closed).
4. Only then is `grant_type` dispatched. Both `authorization_code` and `refresh_token` are covered.

The rate-limit bypass in `hooks.server.ts` runs the same signature check without state. It never consumes the nonce, and it never authenticates a request.

### Shared test vector

Both repos pin this vector, in `src/internal-mcp-auth.test.ts` here and in `src/lib/server/oauth/internal-mcp-auth.test.ts` in the app:

```text
secret    cos-plugin-p03-test-vector-secret
method    POST
target    /api/oauth/token
timestamp 1700000000000
nonce     AAECAwQFBgcICQoLDA0ODw
body      {"grant_type":"refresh_token","refresh_token":"rrt_abab…ab","client_id":"robynn-mcp-worker"}   (64 hex chars after rrt_)
payload   v2.1700000000000.AAECAwQFBgcICQoLDA0ODw.POST./api/oauth/token.uTZuJBwfPNNmG6090dbWyoPvjxvBhaEk8j9nQ2d117M
signature v2.3eKBtY6kjLAIwzF5xtl4mCSeJJpbMG5XbNrHQ8FSrZQ
```

## 3. Worker usage

- `buildSignedTokenRequest(secret, apiBaseUrl, params)` builds the signed `POST /api/oauth/token` request. It always sets `client_id=robynn-mcp-worker` and throws `InternalAuthSecretMissingError` without the secret.
  - `/callback` uses it for `authorization_code` (`src/auth-handler.ts`).
  - The upstream refresh uses it for `refresh_token` (`src/index.ts` `refreshUpstreamAccessToken`).
- `internalMcpRequestHeaders(secret, { method, url, body })` returns the three headers for any other internal call, such as P10's introspection.

## 4. Upstream access JWT (app)

The app's `validateAccessToken` enforces the full schema from `AUTHORIZATION_CONTRACT.md` §4:

- Header: exactly `{"alg":"HS256","typ":"JWT"}`.
- Claims are an allow-list: `iss aud type sub org cid scope iat exp jti`, plus optional `gid`/`ver`, which P05 starts minting.
- `iss` is `robynn.ai`. `aud` is `robynn-api:mcp`. `type` is `access`.
- `sub` and `org` must be non-nil UUIDs. `sub` must not be `organization_master_key`.
- `iat` and `exp` must be safe integers, with `exp > now`, `iat <= now + 60s` and a lifetime of at most 3600 s.
- `jti` is required.

The scope vocabulary depends on `cid`:

| `cid` | Allowed scopes |
|---|---|
| `robynn-mcp-worker` | `brand:read`, `tools:execute` |
| `robynn-cli` | the two above plus `cli:session` |

`robynn-cli` is an existing app client that P01's contract did not list.

CLI-session minting (`requireCliUser`, `POST /api/cli/auth/exchange`) is an allow-list:

- The `Authorization` header must be exactly `Bearer <credential>`. Anything else is 401 before any lookup, so the guard and `validateApiKey` always see the same credential.
- Only a user API key or an existing `robynn-cli` JWT that carries the full CLI scope is accepted. A JWT for any other client, including every Worker-issued token whether read-only or not, is 403.
- A `robynn-cli` JWT may mint a session only for its own organization. A user API key may still select any active membership.

Agent-run tokens use `aud=robynn-api:agent-run`, so neither token type validates as the other.

## 5. Release-owner deploy order (names only; agents set nothing)

1. Generate a fresh `MCP_INTERNAL_AUTH_SECRET`. Set it as a Worker secret and in the app's production env, with the same value in both. Never reuse the committed value.
2. Set a fresh, dedicated app `OAUTH_JWT_SECRET`.
3. Apply the additive app migration `20261009150000_oauth_internal_request_nonces.sql`.
4. Deploy the Worker. It now sends v2-signed code exchanges and refreshes. A pre-P03 app ignores the headers apart from rate limiting, so deploying the Worker first is safe.
5. Deploy the app. From this point unsigned or v1 requests get `401 invalid_client`.
6. Rotate `CONNECTOR_STATE_SECRET` in the app.
   - Before rotating, confirm that `CONNECTOR_TOKEN_ENCRYPTION_KEY` and `CONNECTOR_WRITE_CONFIRMATION_SECRET` are set to distinct values. Both fall back to `CONNECTOR_STATE_SECRET` when unset.
   - If they are unset, stored connector tokens encrypted under the old value become undecryptable.

### Expected effects at app deploy

- Outstanding upstream access JWTs, CLI session JWTs and agent-run tokens fail the new schema or the new secret.
  - The Worker renews upstream tokens through its signed refresh.
  - The CLI renews through `/api/cli/auth/refresh`.
  - Instant Agent runs already in flight lose connector authority for at most their TTL.
- DB-backed refresh tokens are unaffected.

### Pre-deploy checks (release owner, read-only)

1. **Signed target in a deployed app.** Before production, run one signed code exchange and one signed refresh against a Vercel preview or staging deployment. This confirms that the path and query the app sees (`request.url`) equal what the Worker signs (`/api/oauth/token`). The local proof used `vite dev`.
2. **Stored scopes parse.** Every live refresh row must parse under the strict per-client vocabulary, or those users get `invalid_grant` at their next refresh:

   ```sql
   SELECT client_id, scope, count(*) FROM oauth_refresh_tokens
   WHERE NOT revoked AND expires_at > now()
   GROUP BY client_id, scope;
   ```

3. **Expect reconnects.** App deploy invalidates every upstream JWT at once. That triggers the pre-existing DO/provider refresh split-brain (contract D6, F13, F18) for all active sessions together, so some users may need to reconnect unless P10 ships alongside.
4. **Keep the Worker-first window short.** Between the Worker and app deploys, code exchanges lose the token-endpoint rate-limit bypass (`mcpTokenRateLimiter`, 60/h per IP+UA).
5. **In-flight Instant Agent runs.** Completion webhooks for runs in flight at deploy return 401, because their tokens lack the new `aud`. Those runs finish through the poll and recovery finalization paths.

## 6. Consent destination (P19b, P19 RC review R3)

The consent page shows where the browser goes after approval. With open DCR, a client can register any https redirect and call itself "Claude Code". The Worker puts the destination in the `/oauth/authorize` redirect and signs it with the same secret under its own label, so it cannot be confused with a v2 request signature.

```text
redirect_origin = "<scheme>://<host[:port]>"   http(s): from new URL(redirect_uri).host, so userinfo is dropped and IDN is punycode
                = "<scheme>:"                  any other scheme (native app link)
exp             = floor(now / 1000) + 600      the authorization transaction's lifetime
payload         = JSON.stringify(["robynn-consent-destination", "v1", exp, state, redirect_origin])
consent_sig     = "v1." + exp + "." + base64url(HMAC-SHA256(MCP_INTERNAL_AUTH_SECRET, payload))
```

- **`state`** is the Worker's transaction state, the same `state` query parameter the consent page receives.
- **Worker:** `src/authorization/consent-destination.ts`. **App:** `src/lib/server/oauth/consent-destination.ts`.
- **App verifier rules:**
  - both parameters absent: the destination is shown as unconfirmed, in warning style;
  - exactly one present, malformed, expired (more than 60 s past `exp`, or `exp` more than 660 s ahead), a bad MAC, or the secret unset: the request is refused;
  - otherwise the host is shown. It is in warning style unless it is loopback (`localhost`, `127.x.x.x`, `[::1]`).
- **Not a credential:** it authorizes display only and is never consumed. The code exchange is still the v2-signed `POST /api/oauth/token`.

Shared test vector (both repos: `consent-destination.test.ts`):

```text
secret    p19b-test-vector-secret-not-a-real-secret
state     AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd0
origin    https://evil.example
now       1760200000000   (exp 1760200600)
signature v1.1760200600.E3B_PAGLdf6oCfrSjedEYXMcEDl16M6D7ng1zof-Iyo
```

