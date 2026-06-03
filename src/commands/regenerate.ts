// `anyapi-mcp regenerate` - rebuild generated client code for registered APIs
// from their saved sources, without touching stored credentials or OAuth config.
// Run it after upgrading anyapi-mcp so cached types/ops match the new generators
// (serve also does this automatically for stale entries on startup).

import { parseArgs } from "@std/cli/parse-args";
import { readRegistry } from "../registry.ts";
import { regenerateApis } from "../register.ts";

const HELP =
  `anyapi-mcp regenerate - rebuild generated client code for registered APIs

Usage:
  anyapi-mcp regenerate [id ...] [options]

Re-fetches each API's source (OpenAPI spec, GraphQL schema, or WSDL) and rebuilds
its typed client + operation index in place. Saved credentials and OAuth config
are left untouched - this only refreshes generated code, so run it after a new
anyapi-mcp version changes how that code is generated. With no id, regenerates
every registered API.

Options:
  --stale-only   Only regenerate APIs whose code predates this anyapi-mcp build
  -h, --help     Show this help`;

export async function runRegenerate(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    boolean: ["help", "stale-only"],
    alias: { h: "help" },
  });
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const ids = flags._.map(String).filter(Boolean);
  const entries = await readRegistry();
  if (entries.length === 0) {
    console.log(
      "No APIs registered yet. Add one with: anyapi-mcp add <spec-url>",
    );
    return;
  }

  // Reject unknown ids up front so a typo is a hard error, not a silent no-op.
  if (ids.length > 0) {
    const known = new Set(entries.map((e) => e.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(
        `anyapi-mcp regenerate: unknown id(s): ${unknown.join(", ")}`,
      );
      console.error(`Registered ids: ${[...known].join(", ")}`);
      Deno.exit(1);
    }
  }

  const results = await regenerateApis({
    ids: ids.length > 0 ? ids : undefined,
    staleOnly: flags["stale-only"],
    onProgress: (m) => console.error(m), // progress to stderr; report to stdout
  });

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped++;
    } else if (r.ok) {
      ok++;
      console.log(`  ok    ${r.id}  (${r.operationCount} operations)`);
    } else {
      failed++;
      console.log(`  FAIL  ${r.id}  - ${r.error}`);
    }
  }

  const summary = [`${ok} regenerated`];
  if (skipped > 0) summary.push(`${skipped} already current`);
  if (failed > 0) summary.push(`${failed} failed`);
  console.log(summary.join(", ") + ".");
  if (failed > 0) Deno.exit(1);
}
