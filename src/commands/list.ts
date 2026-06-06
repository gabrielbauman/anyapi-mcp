// `anyapi-mcp list` - list registered APIs with id, name, base URL, and op count.

import { readRegistry } from "../registry.ts";
import { readOpsIndex } from "../operation.ts";
import { describeExpiry, loadToken } from "../oauth.ts";
import { atprotoAuthStatus } from "../atproto-auth.ts";

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
    // For OAuth, surface live login/expiry status (one keystore lookup per entry).
    let authText: string = e.auth.kind;
    let loginHint = false;
    if (e.auth.kind === "oauth2") {
      const token = await loadToken(e.auth);
      authText = token
        ? `oauth2 (logged in, ${describeExpiry(token)})`
        : "oauth2 (not logged in)";
      loginHint = !token;
    } else if (e.auth.kind === "atproto") {
      const status = await atprotoAuthStatus(e.auth);
      authText = status.text;
      loginHint = status.needsLogin;
    }
    console.log(`${e.id}  -  ${e.name}`);
    console.log(`  base URL: ${e.baseUrl}`);
    console.log(`  kind: ${e.kind}   ops: ${count}   auth: ${authText}`);
    if (loginHint) console.log(`  -> run: anyapi-mcp login ${e.id}`);
    if (e.docsUrl) console.log(`  docs: ${e.docsUrl}`);
    console.log("");
  }
}
