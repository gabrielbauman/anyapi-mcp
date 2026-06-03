# anyapi-mcp

**anyapi-mcp is one local MCP server that lets your model talk to almost any
HTTP API.** Add it once to Claude Code or Claude Desktop, then point it at any
API you find (an OpenAPI spec, a GraphQL endpoint, or a SOAP/WSDL service) and
your model can search and call it right away. No separate server or custom
integration per API: one server covers everything you register, and it stays
token-efficient however many calls a task takes.

Under the hood it generates a typed client from the API's own description and
exposes just three tools: `search` to find operations, `execute` to run a short
TypeScript program against that client, and `add_api` to register more. Instead
of one MCP tool per endpoint clogging the context window, the model writes code
and runs it in a locked-down sandbox; intermediate results stay in that
subprocess rather than round-tripping through the model, so a ten-step workflow
costs one tool call and a handful of tokens, not ten.

Because that client is fully typed, the model drives the API without guesswork:
a wrong argument is a type error, caught before any request leaves the machine.

Point an MCP client at `anyapi-mcp serve` with **nothing registered yet** and
the server explains what it is and how to register one, so an empty server
self-onboards instead of dead-ending. APIs added mid-session work immediately,
no restart.

```sh
anyapi-mcp add https://example.com/openapi.json --docs https://example.com/docs --token
anyapi-mcp list
anyapi-mcp serve            # stdio MCP server, for Claude Desktop / Claude Code
```

## Requirements

- [Deno](https://deno.com/) **2.x** (tested on 2.8).
- macOS or Linux.
  - macOS: tokens are stored in the login keychain via `security`.
  - Linux: tokens are stored via `secret-tool` - install `libsecret-tools` (e.g.
    `apt-get install libsecret-tools`).
- `execute` runs the model's code in a `deno` subprocess, so **`deno` must be on
  `PATH`** - including when you run the compiled binary (which is otherwise
  self-contained).

## Install

The quickest way - builds from source, so you'll need [Deno](https://deno.com/)
**2.x** (it's a runtime dependency too; see [Requirements](#requirements)):

```sh
curl -fsSL https://gabrielbauman.github.io/anyapi-mcp/install.sh | sh
```

It fetches the source, runs `deno task compile`, and drops an `anyapi-mcp`
binary in `~/.local/bin` (override the location with `ANYAPI_MCP_BIN_DIR`).

Or build it yourself:

```sh
deno task compile          # produces a self-contained ./anyapi-mcp binary
mv ./anyapi-mcp ~/.local/bin/   # or anywhere on your PATH
```

Then point your MCP client at it automatically:

```sh
anyapi-mcp install           # adds it to Claude Code and/or Claude Desktop
```

Or run from source during development:

```sh
deno task dev list         # = deno run -A src/main.ts list
```

## Commands

### `add <url-or-path> [options]`

Inspects the source (an OpenAPI spec, a GraphQL endpoint, or a WSDL), derives
the base URL and host, builds a searchable operation index, generates a typed
client, and writes a registry entry.

| Option                            | Description                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--kind <openapi\|graphql\|soap>` | Protocol (default: `openapi`). `graphql` introspects an endpoint; `soap` reads a WSDL URL.              |
| `--id <slug>`                     | Id used on the CLI and in `execute` (default: the base URL in reverse-DNS form, e.g. `com.github.api`). |
| `--name <name>`                   | Human-friendly name (default: spec `info.title`).                                                       |
| `--base-url <url>`                | Override the base URL derived from the spec's `servers[]`.                                              |
| `--docs <url>`                    | Documentation URL to store and surface (not parsed).                                                    |
| `--token`                         | Store a bearer token. Read without echo from a TTY, or piped via stdin.                                 |
| `--oauth`                         | Treat the API as OAuth 2.0 even if the spec doesn't declare it.                                         |
| `--auth-url` / `--token-url`      | OAuth authorize / token endpoints (override the spec's values).                                         |
| `--scope <name>`                  | Scope to request at login (repeatable; default: the spec's scopes).                                     |
| `--scope-separator <sep>`         | Scope separator in the authorize URL (default `" "`; Strava uses `","`).                                |
| `--no-auth`                       | Register without authentication.                                                                        |

OpenAPI specs that declare an **OAuth 2.0 authorization-code flow are detected
automatically**: the API is registered as `oauth2`, and you run
[`login`](#login-id-options) once to authenticate (see [OAuth](#oauth-apis)).

```sh
# bearer auth, prompted without echo:
anyapi-mcp add https://api.github.com/openapi.json --token

# bearer auth, piped (CI):
echo "$GITHUB_TOKEN" | anyapi-mcp add <spec-url> --token

# no auth - id defaults to the reverse-DNS base URL (here: io.swagger.petstore3.api.v3):
anyapi-mcp add https://petstore3.swagger.io/api/v3/openapi.json

# OAuth is auto-detected from the spec; just add, then `login`:
anyapi-mcp add https://developers.strava.com/swagger/swagger.json --id com.strava.api

# graphql - introspect an endpoint (id: com.trevorblades.countries):
anyapi-mcp add https://countries.trevorblades.com/ --kind graphql

# soap - read a public WSDL pointing at a live service:
anyapi-mcp add "http://www.dneonline.com/calculator.asmx?WSDL" --kind soap
```

### `list`

Lists registered APIs with id, name, base URL, operation count, and auth kind.
For OAuth APIs it also shows live login status and token expiry (e.g.
`oauth2 (logged in, expires in 5h)` or `oauth2 (not logged in)`).

### `login <id> [options]`

Authenticates an OAuth 2.0 API in the browser (see [OAuth](#oauth-apis)). Stores
the OAuth app credentials in the keystore (the client secret is read without
echo, like `add --token`), opens the provider's consent page, captures the
redirect on a local one-shot callback server, and saves the resulting tokens
(which then refresh automatically). Re-running it re-authenticates.

| Option                       | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `--client-id <id>`           | OAuth app client id (required on first login).                              |
| `--client-secret <s>`        | Client secret (omit to be prompted without echo; or pipe via stdin).        |
| `--scope <name>`             | Scope to request (repeatable; default: the API's configured scopes).        |
| `--scope-separator <sep>`    | Scope separator in the authorize URL (default `" "`; Strava uses `","`).    |
| `--redirect-uri <url>`       | Local callback URL to listen on (default `http://localhost:9876/callback`). |
| `--port <n>`                 | Shortcut to set the callback port (host `localhost`, path `/callback`).     |
| `--auth-url` / `--token-url` | Override the stored authorize / token endpoint.                             |
| `--no-browser`               | Print the authorize URL instead of opening a browser (headless/SSH).        |

### `logout <id> [--forget-client]`

Removes the stored OAuth tokens for an API (it stays registered). By default the
OAuth app credentials are kept so the next `login` needs no flags;
`--forget-client` removes those too.

### `remove <id>`

Removes the registry entry, deletes stored secrets from the keystore (bearer
token, or OAuth client credentials + tokens), and cleans up cached files.

### `serve`

Runs the stdio MCP server. It re-reads the registry on each call (so newly
registered APIs are picked up without a restart) and exposes:

- **`search`** - `{ query, api? }` → compact operation matches (`api`, `method`,
  `path`, `operationId`, `summary`, `params`, `requestBodyHint`).
- **`execute`** - `{ api, code }` → runs `code` against a typed `client` and
  returns `{ stdout, stderr, exitCode }` verbatim. For OAuth APIs the access
  token is refreshed automatically first; if the API isn't authenticated, the
  result explains how to fix it (call `authenticate`, or run
  `anyapi-mcp login`).
- **`authenticate`** - `{ api }` → opens the user's browser to (re-)authenticate
  an OAuth API and stores the tokens. Lets the model recover from an expired or
  revoked session without leaving the chat. It never accepts secrets — the user
  must have run `anyapi-mcp login` once to set up the OAuth app credentials.
- **`configure_oauth`** - `{ api, scopes?, scopeSeparator?, extraAuthParams? }`
  → lets the model fix OAuth provider quirks it discovers (wrong scope set,
  comma-vs-space separator, an extra authorize param like
  `access_type=offline`). It only touches **safe** request params — never the
  authorize/token endpoints (those carry the client secret and stay CLI-only),
  and reserved params like `redirect_uri`/`client_id` are rejected. Call with
  just `{ api }` to read the current config.
- **`add_api`** - `{ specUrl, kind?, id?, name?, baseUrl?, docsUrl? }` →
  registers a new API (`kind` `openapi`, `graphql`, or `soap`) so the model can
  self-serve public APIs. Secrets are **not** accepted here; for authenticated
  APIs use `anyapi-mcp add … --token` (bearer) or `anyapi-mcp login` (OAuth) so
  the secret goes to the OS keychain, not the conversation.

The server also sends MCP `instructions` at connect time describing the
workflow, and - when the registry is empty - exactly how to register an API.

### OAuth APIs

Many user-facing APIs (Strava, Google, GitHub, …) use **OAuth 2.0**. anyapi-mcp
supports the authorization-code flow end to end:

1. **Add the API.** OpenAPI specs that declare an authorization-code flow are
   detected automatically (`anyapi-mcp add <spec>` registers it as `oauth2`).
   For sources that don't declare one, pass
   `--oauth --auth-url … --token-url …`.
2. **Create an OAuth app** with the provider and set its redirect/callback URL
   to the one `add`/`login` prints (default `http://localhost:9876/callback`).
   You get a **client id** and **client secret**.
3. **Log in once:**
   ```sh
   anyapi-mcp login com.strava.api --client-id <id> --client-secret <secret> \
     --scope read --scope activity:read_all
   ```
   This opens your browser, you approve, and the tokens are stored in the OS
   keychain. The access token then **refreshes automatically** before each
   `execute` — you don't log in again until you revoke access.

From then on the model just calls `search`/`execute` as usual. If a session
can't be refreshed (e.g. you revoked the app), the model can call the
`authenticate` tool to re-open the browser login — no secrets pass through the
conversation, since the client credentials are already in the keychain.

A small built-in quirks table fixes well-known providers whose specs are wrong
or non-standard — e.g. Strava's spec lists `/api/v3/oauth/*` (the live endpoints
are `/oauth/*`) and Strava wants comma-separated scopes. For anything else, the
**registry entry is the override** (it's what every refresh reads):
`anyapi-mcp login --auth-url/--token-url/--scope-separator/--scope` writes the
corrected values onto it. The model can also fix the **safe** params it
discovers (scopes, scope separator, extra authorize params) with the
`configure_oauth` tool — but the authorize/token endpoints are CLI-only, since
`tokenUrl` is where the client secret is POSTed and shouldn't be agent-writable.

Notes & limits: only the **authorization-code** grant is supported (no PKCE,
implicit, client-credentials, or password grants). Built-in quirks seed defaults
at `add` time only, so a quirk discovered later won't retroactively rewrite an
already-registered API — re-`add`, `login --auth-url …`, or `configure_oauth`
(safe params) to apply it.

### `install`

Wires anyapi-mcp into your local MCP clients so you don't edit configs by hand.
With no arguments it sets up whatever it finds: **Claude Code** (via
`claude mcp add`, user scope) and, on macOS, **Claude Desktop** (adds an
`mcpServers.anyapi-mcp` entry to its config, leaving existing servers untouched;
restart Desktop to load it). Run the installed binary so it registers its own
path. Options: `--client code|desktop|all`, `--command <path>`,
`--scope user|project|local`, `--name <name>`, `--dry-run`.

## Pointing an MCP client at it

The quickest path is the `install` command above: `anyapi-mcp install` registers
anyapi-mcp with Claude Code and/or Claude Desktop for you. To wire it up by hand
instead:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "anyapi-mcp": {
      "command": "/absolute/path/to/anyapi-mcp",
      "args": ["serve"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add anyapi-mcp -- /absolute/path/to/anyapi-mcp serve
```

Then ask the model to, for example, "search the github API for listing a user's
repos, then fetch detail on the most recently updated one." It will `search`,
write a short TypeScript program, and `execute` it - typically a single
multi-step `execute` call rather than many tool round-trips.

## How `execute` works (the sandbox)

For each call, `anyapi-mcp` writes a wrapper file shaped like:

```ts
import createClient from "npm:openapi-fetch@0.17.0";
import type { paths } from "file:///…/<id>.d.ts";

const token = Deno.env.get("ANYAPI_MCP_TOKEN");
const client = createClient<paths>({
  baseUrl: "<baseUrl>",
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

await (async () => {
  /* your code, with `client` in scope */
})();
```

and runs it in a `deno` subprocess scoped with:

- `--allow-net=<api hosts only>` - even buggy or hostile code can't reach
  anything but the registered API.
- `--allow-env=ANYAPI_MCP_TOKEN` - the only environment variable the code can
  read.
- no `--allow-read` / `--allow-write` / `--allow-run`.
- a 30-second timeout.

The token is injected into the subprocess environment only; the model never sees
it, and the net allowlist means it can't be exfiltrated. For OAuth APIs the
parent process refreshes the access token (in the keychain) **before** building
the harness, so the sandbox only ever receives a currently-valid token and never
touches the refresh token or token endpoint. **Type-checking stays on**
(`--check`) so the model sees type errors and can self-correct - calling an
operation with the wrong arguments returns the exact expected shape.

Writing code with `openapi-fetch`: `response` is always present, so check
`response.status`; on success `data` is set, on an HTTP error `error` is set (no
throw). For operations whose spec declares no error schema, `error` is typed
`never` - narrow on `data` (or read `response.status`) rather than `if (error)`.

For a **GraphQL** API the harness instead exposes
`client.query(query, variables)` and `client.mutate(...)` (a typed POST wrapper
returning `{ data, errors }`) plus the introspected schema types as `Schema.*` -
annotate results like `client.query<{ user: Schema.User }>(...)`.

For a **SOAP** API the harness exposes one method per operation -
`client.<Operation>({ ...args })` with typed args - returning
`{ status, data, raw }` where `data` is the parsed SOAP `Body`. anyapi-mcp
builds the envelope and parses the response for you.

## Design notes & limits

- **Secrets** live in the OS keystore (service `anyapi-mcp`), never in the
  registry. The registry only records keystore account names (`tokenKey`; for
  OAuth also `clientKey`). OAuth refresh and the browser login run in the parent
  process — the execute sandbox only ever receives a ready access token, never
  the client secret or refresh token.
- **Files**: registry at `$XDG_CONFIG_HOME/anyapi-mcp/apis.jsonl` (default
  `~/.config/anyapi-mcp`); generated `.d.ts` and operation indexes at
  `$XDG_CACHE_HOME/anyapi-mcp` (default `~/.cache/anyapi-mcp`).
- **Ids**: the default id is the base URL in reverse-DNS form - the host
  reversed plus the base-path segments (`https://api.github.com` →
  `com.github.api`; `https://petstore3.swagger.io/api/v3` →
  `io.swagger.petstore3.api.v3`). Including the path keeps distinct APIs on one
  host (e.g. `/v1` vs `/v2`) distinct. Pass `--id` (or `add_api`'s `id`) to
  override.
- **stdout hygiene**: in `serve`, stdout carries only MCP frames; all logging
  goes to stderr.
- **Protocols & adapters**: each protocol is an in-tree `ProtocolAdapter`
  (`src/adapter.ts`) - a `prepare()` that turns a source into base URL + hosts +
  an operation index + generated types, and a `buildHarness()` that puts a typed
  `client` in scope. OpenAPI, GraphQL, and SOAP/WSDL ship today; adding one is a
  new arm in `src/adapters.ts`, not a plugin system. The registry, `search`, and
  the execute sandbox are protocol-agnostic.
- **SOAP scope**: WSDL 1.1, SOAP 1.1/1.2, document/literal, public WSDL → live
  service. Not covered: rpc/encoded, WS-Security / SOAP headers, MTOM, external
  XSD imports, WSDL 2.0.
- **v1 scope**: OpenAPI specs in JSON or YAML - OpenAPI 3.x, or Swagger 2.0
  auto-converted to 3.0 - plus GraphQL endpoints and SOAP/WSDL services; **no /
  bearer / OAuth 2.0 authorization-code** auth (no PKCE, implicit,
  client-credentials, or password grants). `search` is keyword-based over the
  operation index - no embeddings or freeform-doc search. Each `execute` is a
  fresh subprocess (no persistent state between calls); OAuth tokens persist in
  the keychain and refresh automatically.

## Development

```sh
deno task dev <subcommand>   # run from source
deno task compile            # build ./anyapi-mcp
deno task check              # type-check
deno task lint               # lint
deno task fmt                # check formatting (drop --check in deno.json to apply)
```

## License

[Apache-2.0](LICENSE).
