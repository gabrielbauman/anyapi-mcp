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
| `--no-auth`                       | Register without authentication (the default).                                                          |

```sh
# bearer auth, prompted without echo:
anyapi-mcp add https://api.github.com/openapi.json --token

# bearer auth, piped (CI):
echo "$GITHUB_TOKEN" | anyapi-mcp add <spec-url> --token

# no auth - id defaults to the reverse-DNS base URL (here: io.swagger.petstore3.api.v3):
anyapi-mcp add https://petstore3.swagger.io/api/v3/openapi.json

# graphql - introspect an endpoint (id: com.trevorblades.countries):
anyapi-mcp add https://countries.trevorblades.com/ --kind graphql

# soap - read a public WSDL pointing at a live service:
anyapi-mcp add "http://www.dneonline.com/calculator.asmx?WSDL" --kind soap
```

### `list`

Lists registered APIs with id, name, base URL, operation count, and auth kind.

### `remove <id>`

Removes the registry entry, deletes the stored token from the keystore, and
cleans up cached files.

### `serve`

Runs the stdio MCP server. It re-reads the registry on each call (so newly
registered APIs are picked up without a restart) and exposes:

- **`search`** - `{ query, api? }` → compact operation matches (`api`, `method`,
  `path`, `operationId`, `summary`, `params`, `requestBodyHint`).
- **`execute`** - `{ api, code }` → runs `code` against a typed `client` and
  returns `{ stdout, stderr, exitCode }` verbatim.
- **`add_api`** - `{ specUrl, kind?, id?, name?, baseUrl?, docsUrl? }` →
  registers a new API (`kind` `openapi`, `graphql`, or `soap`, no-auth) so the
  model can self-serve public APIs. Tokens are **not** accepted here; for
  authenticated APIs use `anyapi-mcp add … --token` so the secret goes to the OS
  keychain, not the conversation.

The server also sends MCP `instructions` at connect time describing the
workflow, and - when the registry is empty - exactly how to register an API.

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
it, and the net allowlist means it can't be exfiltrated. **Type-checking stays
on** (`--check`) so the model sees type errors and can self-correct - calling an
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
  registry. The registry only records the keystore account name (`tokenKey`).
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
  auto-converted to 3.0 - plus GraphQL endpoints and SOAP/WSDL services; bearer
  / no auth. `search` is keyword-based over the operation index - no embeddings
  or freeform-doc search. Each `execute` is a fresh subprocess (no persistent
  state between calls).

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
