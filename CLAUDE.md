# CLAUDE.md

anyapi-mcp is a Deno 2.x CLI + stdio MCP server (TypeScript, strict) that turns
an HTTP API (OpenAPI, GraphQL, or SOAP/WSDL) into a typed client the model
drives by writing code. See [README.md](README.md) for the user-facing pitch.

## Commands

```sh
deno task dev <subcommand>   # run from source (add | list | remove | serve)
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

- `src/main.ts`: argv dispatch to the four subcommands.
- `src/commands/{add,install,list,remove,serve}.ts`: one file per subcommand.
  `serve.ts` is the MCP server exposing `search`, `execute`, `add_api`;
  `install.ts` registers anyapi-mcp with Claude Code / Desktop.
- `src/adapter.ts`: the `ProtocolAdapter` seam. `prepare()` turns a source into
  base URL + hosts + operation index + generated client types; `buildHarness()`
  builds the `execute` preamble that puts a typed `client` in scope.
- `src/adapters.ts`: discriminated-union registry keyed by `kind`. **Adding a
  protocol means a new entry here plus an adapter file, not a plugin system.**
- `src/openapi.ts` / `src/graphql.ts` / `src/soap.ts`: the three adapters.
- `src/registry.ts`: the `apis.jsonl` registry (one `RegistryEntry` per line).
- `src/register.ts`: registration logic shared by `add` and `add_api`.
- `src/operation.ts`: operation index + keyword `search` (no embeddings).
- `src/keystore.ts`: OS keychain access (`security` on macOS, `secret-tool` on
  Linux). Service name is `anyapi-mcp`; accounts look like `anyapi-mcp:<id>`.
- `src/paths.ts`: XDG dirs. Registry under `~/.config/anyapi-mcp`, generated
  types under `~/.cache/anyapi-mcp`.
- `src/execute/run.ts`: the sandboxed subprocess runner.

## Invariants (do not break)

- **stdout hygiene:** in `serve`, stdout carries only MCP JSON-RPC frames. All
  logging goes to **stderr** (`console.error`). Never `console.log` in the serve
  path.
- **The execute sandbox** runs model code in a `deno` subprocess with
  `--allow-net=<registered API hosts only>`, `--allow-env=ANYAPI_MCP_TOKEN`, no
  read/write/run, and a 30s timeout. Type-checking stays **on** (`--check`) so
  the model sees type errors. Don't widen these grants.
- **Secrets** live only in the OS keystore. The registry stores the keystore
  account (`tokenKey`), never the token. `add_api` (the MCP tool) must not
  accept tokens; those go through the `anyapi-mcp add ... --token` CLI.
- `serve` re-reads the registry on each call, so a mid-session `add_api`/`add`
  is usable without restart. Keep it stateless across calls.
- Strict TS is on (`noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`). Keep it clean; CI fails on lint/fmt/check.

## v1 scope

JSON OpenAPI specs (convert YAML first), GraphQL endpoints, SOAP/WSDL (WSDL 1.1,
document/literal). Bearer or no auth. Each `execute` is a fresh subprocess with
no persisted state.
