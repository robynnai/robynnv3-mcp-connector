# Worker OAuth front door (COS-PLUGIN-001 P06)

Status: implemented on `plugin-v1/p06-worker-auth`. This file records what the Worker does on `/authorize`, `/callback` and `/token`, and the choices P06 made where P01's `AUTHORIZATION_CONTRACT.md` (§6.1, §6.2) left one open.

Code:

- `src/auth-handler.ts`: the `/authorize` and `/callback` handlers, the launch and error pages, and the discovery documents.
- `src/authorization/oauth-policy.ts`: scopes, PKCE, resources, the `ADVERTISE_SSE` flag and the API path allow-list.
- `src/authorization/state.ts`: browser-bound, single-use transactions.
- `src/authorization/upstream-grant.ts`: token-response parsing, the candidate identity and the introspection client.
- `src/authorization/token-binding.ts`: binds `redirect_uri` at `/token` (F10).
- `src/index.ts`: `createOAuthProviderOptions` and the fetch wrapper.
- `src/safe-log.ts`: the redacting logger.

## 1. `/authorize`

Checks run in this order. Requests that fail before the client and redirect URI are validated get a static 400 page. Requests that fail afterwards get an RFC 6749 error redirect to the host, carrying the host's `state`.

| Check | Failure |
|---|---|
| `parseAuthRequest` succeeds. This covers an unknown client, an unregistered redirect, a malformed `resource`, `plain` or omitted PKCE method (`allowPlainPKCE:false`), and `response_type=token` (implicit flow off). | 400 page `invalid_request` |
| `client_id` and `redirect_uri` are present, and `lookupClient` finds the client. The provider skips client checks when `client_id` is empty. | 400 page `invalid_request` |
| `response_type == "code"` | redirect `unsupported_response_type` |
| `code_challenge_method == "S256"`, and `code_challenge` matches `^[A-Za-z0-9_-]{43}$`. This closes F9: the provider alone accepts S256 with no challenge. | redirect `invalid_request` |
| Scope: omitted ⇒ `brand:read`; any unknown item ⇒ reject. The value is canonicalized (deduped, ordered) but **never widened**. | redirect `invalid_scope` |
| `resource` (every value) is one of `{base}`, `{base}/`, `{base}/mcp`. `{base}/sse` is accepted only if `ADVERTISE_SSE`. | redirect `invalid_target` |

On success the Worker:

- stores a transaction in KV (`oauth_state:<state>`, TTL 600 s). The transaction holds the parsed host request, the requested scopes, the normalized DCR `client_name`, the Worker callback URL and `sha256(browser nonce)`.
- sets the cookie `__Host-robynn_oauth_<state>=<nonce>; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`. On plain-HTTP loopback dev the `__Host-` prefix and `Secure` are dropped.
- redirects to the app's `/oauth/authorize` with `client_id=robynn-mcp-worker`, `redirect_uri={base}/callback`, `state`, `scope=<exactly the requested set>`, `response_type=code`, and `client_name` when the client has one.

`state` is 32 random bytes in base64url (43 characters), which fits the app's `MCP_STATE_PATTERN` (P04).

`client_name` comes from the **DCR registration**, never from the request. Control, zero-width and bidi characters are removed, whitespace is collapsed, and the length is capped at 64. The app HTML-escapes it.

### Resource choices

- **Values are not rewritten or merged.** The provider later requires the token request's `resource` to be one of the authorize-time values (exact string), and it matches audience by origin plus path prefix. The old `normalizeOAuthRequestResource` merged the origin and `/sse` aliases into every request. That made the audience origin-wide and is removed.
- **`{base}/` is accepted.** The MCP TypeScript SDK sends `new URL(prm.resource).href`, which ends in `/`.
- **`{base}/sse` is rejected** (`invalid_target`), not mapped to `/mcp`. SSE was never served (F19), so no working client sends it.
- **Missing `resource` stays allowed** for compatibility. The resulting token has no audience restriction. Provider tokens are only meaningful at this Worker anyway, and every API path other than `/mcp` is 404'd (§4).

## 2. `/callback`

The callback fails closed. `completeAuthorization` runs only after every step below succeeds.

1. **State and browser binding.** `state` must match the pattern and exist in KV, and the record must parse as a version-2 transaction. The cookie for that state must hash (constant time) to the stored value. A duplicated cookie name is refused. A missing or wrong cookie returns a 400 page and **leaves the record in place**, so a leaked state cannot cancel its owner's flow.
2. **Single use.** The record is deleted before use, and the cookie is cleared on the response. A record older than 600 s is refused even if KV still returns it. *Limit:* KV is eventually consistent, so delete-before-use is best effort across locations. A replay still needs the browser cookie, and the app consumes its code atomically.
3. **App error.** `error=access_denied` (P04 Deny), `invalid_scope`, `invalid_request`, `temporarily_unavailable` and `server_error` pass through to the host. Any other value becomes `server_error`. Nothing is reflected.
4. **Client binding** (P04 residual). The client must still exist, and its normalized name must equal the name shown on the consent page. Otherwise the result is `access_denied`.
5. **Signed code exchange** (P03, unchanged). A missing secret, network failure or upstream 5xx gives `temporarily_unavailable`; an upstream 4xx gives `server_error`. The error body is never read.
6. **Token response shape.** It must contain `access_token` and `refresh_token` as bounded printable strings, and a positive `expires_in` if present.
7. **Candidate identity.** The JWT payload is decoded only to address the grant; the Worker cannot verify the signature. The payload must have:
   - `type=access`, `aud=robynn-api:mcp`, `iss=robynn.ai`, `cid=robynn-mcp-worker`;
   - `exp > now`;
   - UUID `sub` and `org` (no sentinel, no nil);
   - UUID `gid`;
   - integer `ver ≥ 1`;
   - a valid `scope`.

   Anything else gives `server_error`. **There is no fallback to `"unknown"`.**
8. **Introspection** (contract §5). The Worker sends a signed `POST /api/oauth/introspect` with `{grant_id, user_id, organization_id, client_id, credential_version}`; no credentials are in the body.
   - It must return 200 with `active:true` and the identical tuple.
   - `active:false` or a mismatched tuple gives `access_denied`.
   - Any other status, a malformed body or a network error gives `temporarily_unavailable`.
9. **Scope.** Both the introspection scopes and the JWT scopes must be ⊆ the host's requested scopes; otherwise the result is `invalid_scope`. This covers the P04 residual: a hidden consent field can be edited in the browser. The grant is the canonical intersection of the two, and it must be non-empty.
10. **Complete.** `completeAuthorization` is called with `userId`, the granted `scope` and `revokeExistingGrants: true`, plus:
    - metadata: `organizationId`, `appGrantId`, `hostClientName`, `upstreamClientId`, `authVersion: 2`;
    - props: `accessToken`, `refreshToken`, `userId`, `organizationId`, `appGrantId`, `credentialVersion`, `scopes`, `authVersion: 2`, `authorizeRedirectUri`, `_apiBaseUrl`.

The browser is then sent back to the host. An http(s) redirect URI (the usual loopback case) gets a 302. A native custom scheme gets the launch page.

### Fail-closed until P05 and P10

Today the app's tokens have no `gid` (P05 adds grants), and `/api/oauth/introspect` does not exist (P10). Until both land, every `/callback` ends with an error to the host:

- `server_error` (`upstream_grant_id_missing`) when the token has no `gid`;
- `temporarily_unavailable` (introspection 404) when the token has a `gid` but introspection is missing.

This is intended: the brief says to fail closed rather than trust a base64 decode. The positive path is proven with a contract-shaped app stub in `src/__tests__/provider-contract.worker-options.test.ts`.

## 3. `/token`: `redirect_uri` binding (F10)

The provider accepts any **registered** `redirect_uri` at `/token`, or none when PKCE is used. The Worker binds it to the authorization transaction:

- `/callback` stores the authorize-time redirect in the grant props (`authorizeRedirectUri`). The props are encrypted inside the grant, so the binding is strongly consistent and needs no extra KV key.
- The fetch wrapper reads `grant_type` and `redirect_uri` from a clone of the form body. `createOAuthProvider(env, tokenRequest)` passes them to `tokenExchangeCallback`.
- For `authorization_code`, the callback requires a single `redirect_uri` that is present and identical. It returns `newProps` without the binding, so the API handler never sees it.
- On a mismatch the callback throws. The provider calls it **before** it consumes the code (installed source, `handleAuthorizationCodeGrant`), so the legitimate client can still redeem the code. The wrapper maps the throw to `400 {"error":"invalid_grant"}`.
- Any other throw on `/token` gives `500 server_error`, with only the error class logged.

The refresh path is unchanged: P10 owns F12 fail-open, serialization and introspection on refresh.

## 4. Transport surface (D-C / D10)

- `apiRoute` is `["/mcp"]`. SSE is not served.
- The fetch wrapper answers every path under `/mcp*` or `/sse*` other than exactly `/mcp` with `404 {"error":"not_found"}` **before** the provider. This covers `/mcpx`, `/mcp/`, `/mcp/openai`, `/mcp/lazy`, `/sse` and `/sse/message`. These requests get no auth challenge and never reach a handler.
- `ADVERTISE_SSE = false` (`src/authorization/oauth-policy.ts`) is the single switch. It controls the approved resource aliases, `/.well-known/oauth-protected-resource/sse` and `endpoints.sse` in the landing JSON. Flipping it re-advertises SSE but **does not serve it**. Serving SSE would need a `?sessionId=` session binding, server-generated ids and per-call authorization (P01 F20).
- The provider is constructed with `allowPlainPKCE:false`, `allowImplicitFlow:false` and `allowTokenExchangeGrant:false`. Authorization-server metadata therefore advertises `code_challenge_methods_supported: ["S256"]` and `response_types_supported: ["code"]`.

## 5. Pages

- **Launch page** (native redirect URIs only). It refuses to render unless:
  - the launch URL is a custom scheme (not `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, `mailto:`, `filesystem:`, `http(s):`);
  - the launch URL uses RFC 3986 characters only and is at most 4096 characters long;
  - the fallback URL is http(s).

  URLs are HTML-escaped in attributes and embedded in the inline script as script-safe JSON (`<`, `>`, `&`, U+2028 and U+2029 are `\u`-escaped). The page sends `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (the URL carries the code) and `Cache-Control: no-store`.
- **Error pages** use static copy per error code only, with no script.
- **Copy** is host-neutral ("Returning to your app", "Open your app"). The landing JSON, `/.well-known/mcp.json` and the unauthenticated `robynn_status` fallback no longer mention Claude.

## 6. Logging

`safeLog.{info,warn,error}(event, fields)` emits one JSON line per call, and only primitive fields are accepted.

- Values in fields named like code, state, token, secret, cookie, signature, verifier, challenge, nonce, location, body, query, bearer, jwt, props, credential or session id are replaced with `[redacted]`.
- Every string value is scrubbed:
  - URLs lose their query and fragment;
  - JWTs and provider `a:b:c` tokens are removed;
  - `key=value` credential pairs are masked;
  - long mixed-case or digit runs are removed;
  - control characters are removed;
  - the value is truncated to 160 characters.
- `errorKind(err)` logs the error class only, never the message.

The old logs that leaked are replaced:

- `[OAuthTrace]` logged the `Location` header (code and state);
- `[TokenRefresh]` logged the upstream refresh body;
- `[Auth] Token exchange failed` logged the upstream body.

The canary test drives the success path (exchange, refresh, MCP call) and the failure paths. It asserts that no code, state, verifier, cookie, host or app token, JWT payload, secret, `?`, `code=` or `state=` appears in any log line.

## 7. Not in P06

- **P10:** per-call reauthorization; session binding; Vault gating; refresh-callback fail-closed (F12) and serialization; legacy-grant cutover (`authVersion !== 2`); `x-robynn-*` header stripping; wiring `registerUnauthenticatedStatusTool`; writing `worker_grant_id` back to the app grant (contract §6.2 step 5); the app's `/api/oauth/introspect` route.
- **P11:** retries.
- **P12:** tool metadata.
- **Model-facing errors:** `RobynnClient` still throws `API error <status>: <body>` into tool results (`src/robynn-client.ts`). Sanitizing tool errors belongs to P11, which owns that file, or to P10/P12.
