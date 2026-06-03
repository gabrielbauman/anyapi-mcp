# CLAUDE.md

anyapi-mcp is a Deno 2.x CLI + stdio MCP server (TypeScript, strict) that turns
an HTTP API (OpenAPI, GraphQL, or SOAP/WSDL) into a typed client the model
drives by writing code. See [README.md](README.md) for the user-facing pitch.

## Commands

```sh
deno task dev <subcommand>   # run from source (add | list | login | logout | remove | serve | install)
deno task compile            # build the self-contained ./anyapi-mcp binary
deno task check              # type-check (deno check src/main.ts)
deno task lint               # deno lint src/
deno task fmt                # deno fmt --check
```

Run `deno task check && deno task lint && deno task fmt` before committing.
There is no test suite yet.

## Architecture

The core (registry, search, execute sandbox) is **protocol-agnostic**; each
protocol plugs in through one in-tree adapter object.

- `src/main.ts`: argv dispatch to the subcommands.
- `src/commands/{add,install,list,login,logout,remove,serve}.ts`: one file per
  subcommand. `serve.ts` is the MCP server exposing `search`, `execute`,
  `authenticate`, `configure_oauth`, `add_api`, `list_apis`, `remove_api`;
  `install.ts` registers anyapi-mcp with Claude Code / Desktop; `login`/`logout`
  manage OAuth sessions.
- `src/adapter.ts`: the `ProtocolAdapter` seam. `prepare()` turns a source into
  base URL + hosts + operation index + generated client types (+ optional
  discovered OAuth config); `buildHarness()` builds the `execute` preamble that
  puts a typed `client` in scope.
- `src/adapters.ts`: discriminated-union registry keyed by `kind`. **Adding a
  protocol means a new entry here plus an adapter file, not a plugin system.**
- `src/openapi.ts` / `src/graphql.ts` / `src/soap.ts`: the three adapters.
  OpenAPI also does OAuth2 discovery (`discoverOAuth`) and derives the base URL
  from document-, path-, or operation-level `servers` (`resolveBaseUrl`),
  failing loudly if the result lands on a raw spec-hosting host (e.g.
  raw.githubusercontent.com) rather than silently registering a broken base.
- `src/oauth.ts`: protocol-agnostic OAuth 2.0 authorization-code support — the
  browser login flow (local one-shot callback server), token storage in the
  keystore, automatic refresh (`ensureAccessToken`), and a small known-provider
  quirks table (e.g. Strava's real endpoints + comma scope separator).
- `src/registry.ts`: the `apis.jsonl` registry (one `RegistryEntry` per line).
  `Auth` is a union: `none` | `bearer` | `oauth2`.
- `src/register.ts`: registration logic shared by `add` and `add_api`; resolves
  the OAuth config (precedence: explicit flag > quirk > discovered). `force`
  upserts in place (fresh `addedAt` invalidates serve's ops cache; same-id
  keystore accounts are preserved, so an OAuth API stays logged in across a
  re-register). `unregisterApi` (shared by `remove` and `remove_api`) deletes
  the entry, its secrets, and its cached artifacts.
- `src/operation.ts`: operation index + keyword `search` (no embeddings). Params
  carry optional `description`/`enum`, surfaced in search (`clampDescription`/
  `applyEnum` bound their size; `enum` holds only real values — an over-cap
  count is noted in `description`, never as a fake enum entry).
- `src/keystore.ts`: OS keychain access (`security` on macOS, `secret-tool` on
  Linux). Service name is `anyapi-mcp`; accounts look like `anyapi-mcp:<id>`
  (bearer), `anyapi-mcp:<id>:client` / `anyapi-mcp:<id>:oauth` (OAuth client
  creds + token bundle, each a JSON blob).
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
  names (`tokenKey`; for OAuth also `clientKey`), never the secret itself. No
  MCP tool may accept secrets: bearer tokens go through
  `anyapi-mcp add --token`, and OAuth client credentials go through
  `anyapi-mcp login` (`--client-id` / `--client-secret`). The agent-facing
  `authenticate` tool only (re-)runs the browser flow with credentials the user
  already stored.
- **Agents may set only the _safe_ OAuth params.** `configure_oauth` (and the
  `login`/`add` CLI) can change `scopes`/`scopeSeparator`/`extraAuthParams`, but
  the `authorizationUrl`/`tokenUrl` endpoints are CLI-only: `tokenUrl` is where
  the client secret is POSTed, so an agent-writable endpoint would be an
  exfiltration vector. `buildAuthorizeUrl` and `configure_oauth` both reject
  `RESERVED_AUTHORIZE_PARAMS` (`client_id`, `redirect_uri`, `response_type`,
  `scope`, `state`) in `extraAuthParams`.
- **OAuth lives in the parent, never the sandbox.** Token refresh and the login
  flow run in the serve/CLI process (full net + keystore). The execute sandbox
  only ever receives a ready access token via `ANYAPI_MCP_TOKEN`; it never sees
  the client secret or refresh token and never calls the token endpoint. Refresh
  happens in `executeRequest` (via `ensureAccessToken`) before the harness runs.
- `serve` re-reads the registry on each call, so a mid-session `add_api`/`add`
  is usable without restart. Keep it stateless across calls.
- Strict TS is on (`noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`). Keep it clean; CI fails on lint/fmt/check.

## v1 scope

OpenAPI specs in JSON or YAML — OpenAPI 3.x, or Swagger 2.0 auto-converted to
3.0 via swagger2openapi — GraphQL endpoints, SOAP/WSDL (WSDL 1.1,
document/literal). Auth: none, bearer, or OAuth 2.0 **authorization-code** (the
only OAuth flow; auto-discovered from OpenAPI security schemes, or set manually
with `--oauth`/`--auth-url`/`--token-url`). No PKCE, no implicit/client-creds/
password grants yet. Each `execute` is a fresh subprocess with no persisted
state; OAuth tokens persist in the keystore and refresh automatically.
