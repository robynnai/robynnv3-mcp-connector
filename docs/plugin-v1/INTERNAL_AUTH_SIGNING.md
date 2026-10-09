# Worker -> app internal authentication (COS-PLUGIN-001 P03)

Status: implemented by P03 on both sides.

- Worker: `src/internal-mcp-auth.ts` (this repo)
- App (`robynnai/robynnv3`): `src/lib/server/oauth/internal-mcp-auth.ts`, enforced in `src/routes/api/oauth/token/+server.ts`

P03 is the only owner of this contract. P10 reuses the same primitives for `POST /api/oauth/introspect`; it should not define a second scheme.

## 1. Secrets

| Name | Where | Purpose | Fallback |
|---|---|---|---|
| `MCP_INTERNAL_AUTH_SECRET` | Worker secret **and** app env, same value | Worker authentication on internal app calls | **None.** If it is unset, the Worker refuses to call the app (503 at `/callback`, no refresh), and the app rejects every Worker request with `401 invalid_client`. |
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

`robynn-cli` is an existing app client that P01's contract did not list. A Worker-issued token can no longer be exchanged for a CLI session.

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
