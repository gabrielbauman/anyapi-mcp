// `anyapi-mcp logout <id>` - drop the stored OAuth tokens for an API, leaving it
// registered. By default the OAuth app credentials (client id/secret) are kept so
// a later `login` needs no flags; --forget-client removes those too.

import { parseArgs } from "@std/cli/parse-args";
import { findEntry } from "../registry.ts";
import { clearOAuthSecrets } from "../oauth.ts";

const HELP = `anyapi-mcp logout - remove stored OAuth tokens for an API

Usage:
  anyapi-mcp logout <id> [--forget-client]

Options:
  --forget-client   Also delete the stored client id/secret (re-enter them at next login)
  -h, --help        Show this help`;

export async function runLogout(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    boolean: ["help", "forget-client"],
    alias: { h: "help" },
  });
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const id = typeof flags._[0] === "string" ? flags._[0] : "";
  if (!id) {
    console.error(
      "anyapi-mcp logout: missing <id>\nUsage: anyapi-mcp logout <id>",
    );
    Deno.exit(1);
  }

  const entry = await findEntry(id);
  if (!entry) {
    console.error(`anyapi-mcp logout: no API with id "${id}".`);
    Deno.exit(1);
  }
  if (entry.auth.kind !== "oauth2") {
    console.error(
      `anyapi-mcp logout: "${id}" is not an OAuth API (auth: ${entry.auth.kind}); nothing to do.`,
    );
    Deno.exit(1);
  }

  const { token, client } = await clearOAuthSecrets(entry.auth, {
    forgetClient: flags["forget-client"],
  });
  console.error(
    token
      ? `Logged out of "${id}" (token removed).`
      : `"${id}" had no stored token.`,
  );
  if (flags["forget-client"]) {
    console.error(
      client
        ? "Client credentials removed; pass --client-id/--client-secret at next login."
        : "No client credentials were stored.",
    );
  }
}
