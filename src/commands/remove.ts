// `anyapi-mcp remove <id>` - remove an API: its registry entry, stored token, and
// cached artifacts (.d.ts, ops index). The removal itself lives in
// ../register.ts (shared with the `remove_api` MCP tool).

import { parseArgs } from "@std/cli/parse-args";
import { unregisterApi } from "../register.ts";

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

  const { removed, secretsNote } = await unregisterApi(id);
  if (!removed) {
    console.error(`anyapi-mcp remove: no API with id "${id}".`);
    Deno.exit(1);
  }
  if (secretsNote) console.error(secretsNote.replace(/^d/, "D"));
  console.error(`Removed "${id}".`);
}
