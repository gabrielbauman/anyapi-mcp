// `anyapi-mcp list` - list registered APIs with id, name, base URL, and op count.

import { readRegistry } from "../registry.ts";
import { readOpsIndex } from "../operation.ts";

export async function runList(_args: string[]): Promise<void> {
  const entries = await readRegistry();
  if (entries.length === 0) {
    console.log(
      "No APIs registered yet. Add one with: anyapi-mcp add <openapi-spec-url>",
    );
    return;
  }

  for (const e of entries) {
    const ops = await readOpsIndex(e.id);
    const count = ops ? String(ops.length) : "?";
    console.log(`${e.id}  -  ${e.name}`);
    console.log(`  base URL: ${e.baseUrl}`);
    console.log(`  kind: ${e.kind}   ops: ${count}   auth: ${e.auth.kind}`);
    if (e.docsUrl) console.log(`  docs: ${e.docsUrl}`);
    console.log("");
  }
}
