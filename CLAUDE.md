# CLAUDE.md

anyapi-mcp is a Deno 2.x CLI + stdio MCP server (TypeScript, strict) that turns
an HTTP API (OpenAPI, GraphQL, SOAP/WSDL, or AT Protocol/lexicon/XRPC) into a
typed client the model drives by writing code. See [README.md](README.md) for
the user-facing pitch.

## Commands

```sh
deno task dev <subcommand>   # run from source (add | list | regenerate | login | logout | remove | serve | install)
deno task compile            # build the self-contained ./anyapi-mcp binary
deno task check              # type-check (deno check src/main.ts)
deno task lint               # deno lint src/
deno task fmt                # deno fmt --check
deno task test               # deno test -A src/
```

Run `deno task check && deno task lint && deno task fmt` before committing.
Tests are sparse — only `*_test.ts` files alongside the code they cover (e.g.
`src/openapi-sanitize_test.ts`); add one when logic is tricky enough to warrant
it.

## Architecture

The core (registry, search, execute sandbox) is **protocol-agnostic**; each
protocol plugs in through one in-tree adapter object.

- `src/main.ts`: argv dispatch to the subcommands.
- `src/commands/{add,install,list,regenerate,login,logout,remove,serve}.ts`: one
  file per subcommand. `serve.ts` is the MCP server exposing `search`,
  `execute`, `authenticate`, `configure_oauth`, `add_api`, `list_apis`,
  `remove_api`; `install.ts` registers anyapi-mcp with Claude Code, Claude
  Desktop, and OpenCode; `login`/`logout` manage OAuth sessions and atproto
  app-password sessions; `regenerate.ts` rebuilds generated code from saved
  sources (credentials untouched) — and `serve` runs the same pass on stale
  entries at startup (see `register.ts`).
- `src/adapter.ts`: the `ProtocolAdapter` seam. `prepare()` turns a source into
  base URL + hosts + operation index + generated client types (+ optional
  discovered OAuth config); `buildHarness()` builds the `execute` preamble that
  puts a typed `client` in scope.
- `src/adapters.ts`: discriminated-union registry keyed by `kind`. **Adding a
  protocol means a new entry here plus an adapter file, not a plugin system.**
- `src/openapi.ts` / `src/graphql.ts` / `src/soap.ts` / `src/atproto.ts`: the
  protocol adapters. OpenAPI also does OAuth2 discovery (`discoverOAuth`) and
  derives the base URL from document-, path-, or operation-level `servers`
  (`resolveBaseUrl`), failing loudly if the result lands on a raw spec-hosting
  host (e.g. raw.githubusercontent.com) rather than silently registering a
  broken base. After `openapi-typescript` writes the `.d.ts`, OpenAPI
  post-processes it through `src/openapi-sanitize.ts` (see below).
- `src/openapi-sanitize.ts`: post-processes openapi-typescript output so a
  recursive "arbitrary JSON" schema (or a `$ref` cycle) can't fail the
  whole-program type check `execute` runs. openapi-typescript references schemas
  by indexed access (`components["schemas"]["X"]`); when such a reference closes
  a cycle in an _eager_ position (a union/array member, not behind an object
  property/index signature) TypeScript rejects the entire file with `TS2502`,
  blocking checked `execute` for every operation in the API. The sanitizer lifts
  each schema in such a cycle into a top-level recursive `type` alias and points
  the cyclic references at the alias names; the member declaration stays, so
  external references still resolve. Detection counts only eager references, so
  the common case (schemas that reference each other through properties) is left
  byte-for-byte unchanged. Type safety is fully preserved — this fixes the check
  without resorting to `check:false`.
- `src/oauth.ts`: protocol-agnostic OAuth 2.0 authorization-code support — the
  browser login flow (local one-shot callback server), token storage in the
  keystore, automatic refresh (`ensureAccessToken`), and a small known-provider
  quirks table (e.g. Strava's real endpoints + comma scope separator).
- `src/atproto.ts`: the AT Protocol adapter. It generates **no** types of its
  own: `prepare()` dynamic-imports the lexicons shipped in `@atproto/api`
  (pinned `ATPROTO_API`) to build the operation index from the runtime
  `schemas`, and `writeTypes` emits only an `XrpcMethods` map (NSID →
  `{ params, input, output }`) whose members point at the official per-method
  type namespaces. NSID → namespace name comes from the package's own `ids`
  export (never derived), so a `Lex.<Name>` reference can't drift and break the
  whole-program check. The harness imports those types **type-only**
  (`import type * as Lex`), so nothing from the SDK runs in the sandbox; the
  client is a thin XRPC fetch wrapper whose `query`/`procedure` infer params +
  result from the NSID string literal.
- `src/atproto-auth.ts`: app-password session auth, the atproto analogue of
  `oauth.ts`. `ensureAtprotoAccessToken` returns `string | undefined` and
  escalates only as far as needed — empty `identifier` → `undefined` (anonymous;
  public reads, no token) → cached access JWT → `refreshSession` →
  `createSession` from the stored app password (the self-heal path; no browser,
  unlike OAuth) — all in the parent. `identifier` is the intent signal: set
  means "act as this account" (and a missing session/password is a hard
  `AtprotoNeedsLoginError`, not a silent anonymous fallback); empty means
  anonymous by design.
- `src/registry.ts`: the `apis.jsonl` registry (one `RegistryEntry` per line).
  `Auth` is a union: `none` | `bearer` | `oauth2` | `atproto`.
- `src/register.ts`: registration logic shared by `add` and `add_api`; resolves
  the OAuth config (precedence: explicit flag > quirk > discovered). `force`
  upserts in place (fresh `addedAt` invalidates serve's ops cache; same-id
  keystore accounts are preserved, so an OAuth API stays logged in across a
  re-register). `unregisterApi` (shared by `remove` and `remove_api`) deletes
  the entry, its secrets, and its cached artifacts. `regenerateApi`/
  `regenerateApis` re-run only codegen (re-fetch source → rewrite types + ops,
  bump `addedAt`) while preserving the entry's auth/baseUrl/hosts — no secret is
  written or deleted (a bearer token is only read, to re-introspect). Each entry
  records (in `codegenVersion`) the `CODEGEN_VERSION` its artifacts were built
  under; bump that constant when a generator change makes old artifacts stale,
  and `serve` regenerates anything older on startup (an entry missing the stamp
  counts as stale).
- `src/operation.ts`: operation index + keyword `search` (no embeddings). Params
  carry optional `description`/`enum`, surfaced in search (`clampDescription`/
  `applyEnum` bound their size; `enum` holds only real values — an over-cap
  count is noted in `description`, never as a fake enum entry).
- `src/keystore.ts`: OS keychain access (`security` on macOS, `secret-tool` on
  Linux). Service name is `anyapi-mcp`; accounts look like `anyapi-mcp:<id>`
  (bearer), `anyapi-mcp:<id>:client` / `anyapi-mcp:<id>:oauth` (OAuth client
  creds + token bundle), and `anyapi-mcp:<id>:apppass` /
  `anyapi-mcp:<id>:session` (atproto app password + session bundle), each a JSON
  blob.
- `src/paths.ts`: XDG dirs. Registry under `~/.config/anyapi-mcp`, generated
  types under `~/.cache/anyapi-mcp`.
- `src/execute/run.ts`: the sandboxed subprocess runner (per-call `check` and
  `timeoutMs` options; the net/env allowlist is unconditional).

## Invariants (do not break)

- **stdout hygiene:** in `serve`, stdout carries only MCP JSON-RPC frames. All
  logging goes to **stderr** (`console.error`). Never `console.log` in the serve
  path.
- **The execute sandbox** runs model code in a `deno` subprocess with
  `--allow-net=<registered API hosts only>`, `--allow-env=ANYAPI_MCP_TOKEN`, no
  read/write/run, and a timeout (default 30s; `execute` may raise it, capped at
  120s). These grants are the security boundary — **don't widen them**.
  Type-checking is on by default (`--check`) so the model sees type errors;
  `execute`'s `check:false` skips it for one run (e.g. when a stale spec enum
  rejects a value the live API still accepts). That toggle removes only
  `--check` — it never touches the net/env allowlist above, so it is not a grant
  widening.
- **Secrets** live only in the OS keystore. The registry stores keystore account
  names (`tokenKey`; for OAuth also `clientKey`; for atproto `passwordKey` /
  `sessionKey`), never the secret itself. No MCP tool may accept secrets: bearer
  tokens go through `anyapi-mcp add --token`, OAuth client credentials through
  `anyapi-mcp login` (`--client-id` / `--client-secret`), and atproto app
  passwords through `anyapi-mcp login` (`--identifier`, password read without
  echo) or `add --app-password`. The agent-facing `authenticate` tool only
  (re-)runs the OAuth browser flow with credentials the user already stored.
- **Agents may set only the _safe_ OAuth params.** `configure_oauth` (and the
  `login`/`add` CLI) can change `scopes`/`scopeSeparator`/`extraAuthParams`, but
  the `authorizationUrl`/`tokenUrl` endpoints are CLI-only: `tokenUrl` is where
  the client secret is POSTed, so an agent-writable endpoint would be an
  exfiltration vector. `buildAuthorizeUrl` and `configure_oauth` both reject
  `RESERVED_AUTHORIZE_PARAMS` (`client_id`, `redirect_uri`, `response_type`,
  `scope`, `state`) in `extraAuthParams`.
- **OAuth/atproto auth lives in the parent, never the sandbox.** Token/session
  refresh and the login flow run in the serve/CLI process (full net + keystore).
  The execute sandbox only ever receives a ready access token/JWT via
  `ANYAPI_MCP_TOKEN`; it never sees the OAuth client secret/refresh token, nor
  the atproto app password/refresh JWT, and never calls the token or session
  endpoints. Refresh happens in `executeRequest` (via `ensureAccessToken` /
  `ensureAtprotoAccessToken`) before the harness runs.
- `serve` re-reads the registry on each call, so a mid-session `add_api`/`add`
  is usable without restart. Keep it stateless across calls.
- Strict TS is on (`noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`). Keep it clean; CI fails on lint/fmt/check.

## v1 scope

OpenAPI specs in JSON or YAML — OpenAPI 3.x, or Swagger 2.0 auto-converted to
3.0 via swagger2openapi — GraphQL endpoints, SOAP/WSDL (WSDL 1.1,
document/literal), and AT Protocol/lexicon/XRPC (the lexicon set shipped in the
pinned `@atproto/api`; `add --kind atproto <pds-url>`, e.g.
https://bsky.social). Auth: none, bearer, OAuth 2.0 **authorization-code** (the
only OAuth flow; auto-discovered from OpenAPI security schemes, or set manually
with `--oauth`/`--auth-url`/`--token-url`), or atproto **app-password sessions**
(`createSession`/`refreshSession`, minted/refreshed in the parent; the sandbox
gets only the access JWT) — or **anonymous** atproto (no `--identifier`) for
public reads, replacing the old "point an OpenAPI entry at the public AppView"
trick. No PKCE, no implicit/client-creds/password grants, and no atproto
**OAuth** (its DPoP-bound tokens can't be replayed as a bearer through the
sandbox) yet. Each `execute` is a fresh subprocess with no persisted state;
OAuth tokens and atproto sessions persist in the keystore and refresh
automatically.
