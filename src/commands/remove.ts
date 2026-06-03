// `anyapi-mcp remove <id>` - remove an API: its registry entry, stored token, and
// cached artifacts (.d.ts, ops index).

import { parseArgs } from "@std/cli/parse-args";
import { findEntry, removeEntry } from "../registry.ts";
import { deleteSecret } from "../keystore.ts";
import { clearOAuthSecrets } from "../oauth.ts";
import { opsPathFor } from "../paths.ts";

export async function runRemove(args: string[]): Promise<void> {
  const flags = parseArgs(args, { boolean: ["help"], alias: { h: "help" } });
  if (flags.help) {
    console.log("Usage: anyapi-mcp remove <id>");
    return;
  }

  const id = typeof flags._[0] === "string" ? flags._[0] : "";
  if (!id) {
    console.error(
      "anyapi-mcp remove: missing <id>\nUsage: anyapi-mcp remove <id>",
    );
    Deno.exit(1);
  }

  const entry = await findEntry(id);
  if (!entry) {
    console.error(`anyapi-mcp remove: no API with id "${id}".`);
    Deno.exit(1);
  }

  if (entry.auth.kind === "bearer") {
    const removed = await deleteSecret(entry.auth.tokenKey);
    console.error(
      removed
        ? `Deleted token ${entry.auth.tokenKey}.`
        : `No stored token found for ${entry.auth.tokenKey}.`,
    );
  } else if (entry.auth.kind === "oauth2") {
    const { token, client } = await clearOAuthSecrets(entry.auth, {
      forgetClient: true,
    });
    console.error(
      `Deleted OAuth secrets (token: ${token ? "yes" : "none"}, client: ${
        client ? "yes" : "none"
      }).`,
    );
  }

  await removeEntry(id);

  for (const path of [entry.typesPath, opsPathFor(id)]) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  console.error(`Removed "${id}".`);
}
