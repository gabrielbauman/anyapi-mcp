// `anyapi-mcp add` - CLI front-end for registerApi. Handles flags and the no-echo
// token read; the registration itself lives in ../register.ts (shared with the
// `add_api` MCP tool).

import { parseArgs } from "@std/cli/parse-args";
import { promptSecret } from "@std/cli/prompt-secret";
import { resolve } from "@std/path";
import { isUrl } from "../openapi.ts";
import type { ApiKind } from "../registry.ts";
import { registerApi } from "../register.ts";

const HELP =
  `anyapi-mcp add - register an API (OpenAPI spec or GraphQL endpoint)

Usage:
  anyapi-mcp add <url-or-path> [options]

Options:
  --kind <openapi|graphql|soap>  Protocol (default: openapi). "graphql" introspects an endpoint; "soap" reads a WSDL URL.
  --id <slug>        Id used on the CLI and in execute (default: base URL in reverse-DNS form, e.g. com.github.api)
  --name <name>      Human-friendly name (default: spec title / endpoint host)
  --base-url <url>   Override the base URL derived from the source
  --docs <url>       Documentation URL to store and surface (not parsed)
  --token            Store a bearer token (read without echo, or piped via stdin)
  --no-auth          Register without authentication (default)
  -h, --help         Show this help`;

/** Read a token without echo from a TTY, or from piped stdin in non-interactive use. */
async function readToken(): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    return (promptSecret("Paste token (input hidden): ") ?? "").trim();
  }
  return (await new Response(Deno.stdin.readable).text()).trim();
}

export async function runAdd(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: ["id", "name", "base-url", "docs", "kind"],
    boolean: ["help", "no-auth", "token"],
    alias: { h: "help" },
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const rawSource = typeof flags._[0] === "string" ? flags._[0] : "";
  if (!rawSource) {
    console.error("anyapi-mcp add: missing <url-or-path>\n");
    console.error(HELP);
    Deno.exit(1);
  }
  if (flags.token && flags["no-auth"]) {
    console.error(
      "anyapi-mcp add: pass either --token or --no-auth, not both.",
    );
    Deno.exit(1);
  }

  const specSource = isUrl(rawSource) ? rawSource : resolve(rawSource);

  // Read the token (if any) before the slow type-gen step so the prompt comes first.
  let token: string | undefined;
  if (flags.token) {
    token = await readToken();
    if (!token) {
      console.error("anyapi-mcp add: empty token; aborting.");
      Deno.exit(1);
    }
  }

  try {
    const { entry, operationCount } = await registerApi({
      specSource,
      kind: flags.kind as ApiKind | undefined,
      id: flags.id,
      name: flags.name,
      baseUrl: flags["base-url"],
      docsUrl: flags.docs,
      token,
      onProgress: (m) => console.error(m),
    });
    console.error(
      `Registered "${entry.id}" (${entry.name})\n` +
        `  kind:     ${entry.kind}\n` +
        `  base URL: ${entry.baseUrl}\n` +
        `  hosts:    ${entry.hosts.join(", ")}\n` +
        `  ops:      ${operationCount}\n` +
        `  auth:     ${entry.auth.kind}${
          entry.auth.kind === "bearer" ? ` (${entry.auth.tokenKey})` : ""
        }\n` +
        `  types:    ${entry.typesPath}`,
    );
  } catch (err) {
    console.error(
      `anyapi-mcp add: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}
