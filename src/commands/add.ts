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
  --oauth            Treat this API as OAuth 2.0 even if the spec doesn't declare it
  --auth-url <url>   OAuth authorize endpoint (overrides the spec's value)
  --token-url <url>  OAuth token endpoint (overrides the spec's value)
  --scope <name>     Scope to request at login (repeatable; default: the spec's scopes)
  --scope-separator <sep>  Scope separator in the authorize URL (default " "; Strava uses ",")
  --no-auth          Register without authentication
  --force            Overwrite an existing API with the same id instead of failing
  -h, --help         Show this help

OpenAPI specs that declare an OAuth2 authorization-code flow are detected
automatically; after adding, run \`anyapi-mcp login <id>\` to authenticate.`;

/** Read a token without echo from a TTY, or from piped stdin in non-interactive use. */
async function readToken(): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    return (promptSecret("Paste token (input hidden): ") ?? "").trim();
  }
  return (await new Response(Deno.stdin.readable).text()).trim();
}

export async function runAdd(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: [
      "id",
      "name",
      "base-url",
      "docs",
      "kind",
      "auth-url",
      "token-url",
      "scope",
      "scope-separator",
    ],
    collect: ["scope"],
    boolean: ["help", "no-auth", "token", "oauth", "force"],
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
  if (flags.token && (flags.oauth || flags["auth-url"] || flags["token-url"])) {
    console.error(
      "anyapi-mcp add: --token (bearer) and the OAuth flags are mutually exclusive.",
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

  const scopes = (flags.scope as string[] | undefined) ?? [];
  try {
    const { entry, operationCount, overwritten } = await registerApi({
      specSource,
      kind: flags.kind as ApiKind | undefined,
      id: flags.id,
      name: flags.name,
      baseUrl: flags["base-url"],
      docsUrl: flags.docs,
      token,
      oauth: flags.oauth,
      authUrl: flags["auth-url"],
      tokenUrl: flags["token-url"],
      scopes: scopes.length ? scopes : undefined,
      scopeSeparator: flags["scope-separator"],
      noAuth: flags["no-auth"],
      force: flags.force,
      onProgress: (m) => console.error(m),
    });
    const authLine = entry.auth.kind === "bearer"
      ? `bearer (${entry.auth.tokenKey})`
      : entry.auth.kind === "oauth2"
      ? `oauth2 (not logged in)`
      : entry.auth.kind;
    console.error(
      `${
        overwritten ? "Re-registered" : "Registered"
      } "${entry.id}" (${entry.name})\n` +
        `  kind:     ${entry.kind}\n` +
        `  base URL: ${entry.baseUrl}\n` +
        `  hosts:    ${entry.hosts.join(", ")}\n` +
        `  ops:      ${operationCount}\n` +
        `  auth:     ${authLine}\n` +
        `  types:    ${entry.typesPath}`,
    );
    if (entry.auth.kind === "oauth2") {
      const scopeList = entry.auth.scopes.length
        ? entry.auth.scopes.join(", ")
        : "(none discovered; pass --scope at login)";
      console.error(
        `\nThis API uses OAuth 2.0. To authenticate:\n` +
          `  1. Create an OAuth app with the provider${
            entry.docsUrl ? ` (see ${entry.docsUrl})` : ""
          } and set its\n` +
          `     redirect/callback URL to: ${entry.auth.redirectUri}\n` +
          `  2. Run: anyapi-mcp login ${entry.id} --client-id <id> --client-secret <secret>\n` +
          `  authorize: ${entry.auth.authorizationUrl}\n` +
          `  scopes:    ${scopeList}`,
      );
    }
  } catch (err) {
    console.error(
      `anyapi-mcp add: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}
