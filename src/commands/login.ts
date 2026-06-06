// `anyapi-mcp login <id>` - authenticate an OAuth 2.0 API via the browser.
//
// Stores the OAuth app credentials in the keystore (client secret read without
// echo, like `add --token`), opens the provider's consent page, captures the
// redirect on a local callback server, and stores the resulting token bundle.
// Also doubles as re-auth: with credentials already stored, `anyapi-mcp login
// <id>` just re-runs the browser flow. Endpoint/scope overrides are persisted to
// the registry so later refreshes and agent-triggered re-auth reuse them.

import { parseArgs } from "@std/cli/parse-args";
import { promptSecret } from "@std/cli/prompt-secret";
import { findEntry, type RegistryEntry, updateEntry } from "../registry.ts";
import {
  defaultRedirectUri,
  describeExpiry,
  loadClient,
  type OAuthClient,
  runAuthorizationCodeFlow,
  saveClient,
  saveToken,
} from "../oauth.ts";
import { loginWithAppPassword } from "../atproto-auth.ts";

const HELP =
  `anyapi-mcp login - authenticate an API: OAuth (browser) or atproto (app password)

Usage:
  anyapi-mcp login <id> [options]

For an atproto API, this stores an app password instead:
  anyapi-mcp login <id> [--identifier <handle>]   (app password read without echo, or piped via stdin)

Options:
  --identifier <handle>     atproto: account handle/email to authenticate as (if not set at add time)
  --client-id <id>          OAuth app client id (required on first login)
  --client-secret <secret>  Client secret (omit to be prompted without echo; or pipe via stdin)
  --scope <name>            Scope to request (repeatable; default: the API's configured scopes)
  --scope-separator <sep>   Scope separator in the authorize URL (default " "; Strava uses ",")
  --redirect-uri <url>      Local callback URL to listen on (default ${defaultRedirectUri()})
  --port <n>                Shortcut to set the callback port (host localhost, path /callback)
  --auth-url <url>          Override the stored authorize endpoint
  --token-url <url>         Override the stored token endpoint
  --no-browser              Print the authorize URL instead of opening a browser
  -h, --help                Show this help

The redirect/callback URL must be registered with the provider's OAuth app.
Create the app first, then run this with its client id/secret.`;

/** Read the client secret without echo (TTY) or from piped stdin; "" means none. */
async function readClientSecret(): Promise<string | undefined> {
  let value: string;
  if (Deno.stdin.isTerminal()) {
    value =
      (promptSecret("Paste client secret (hidden; blank for none): ") ?? "")
        .trim();
  } else {
    value = (await new Response(Deno.stdin.readable).text()).trim();
  }
  return value === "" ? undefined : value;
}

/** Read an app password without echo (TTY) or from piped stdin. */
async function readAppPassword(): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    return (promptSecret("Paste app password (input hidden): ") ?? "").trim();
  }
  return (await new Response(Deno.stdin.readable).text()).trim();
}

/**
 * atproto login: store an app password and mint a first session. createSession
 * validates the credentials, so a wrong password fails before anything persists.
 */
async function loginAtproto(
  entry: RegistryEntry,
  identifierFlag: string | undefined,
): Promise<void> {
  if (entry.auth.kind !== "atproto") return; // for narrowing; never reached
  const auth = entry.auth;
  const identifier = identifierFlag ?? auth.identifier;
  if (!identifier) {
    console.error(
      `anyapi-mcp login: "${entry.id}" has no identifier; pass --identifier <handle>.`,
    );
    Deno.exit(1);
  }

  const password = await readAppPassword();
  if (!password) {
    console.error("anyapi-mcp login: empty app password; aborting.");
    Deno.exit(1);
  }

  // Persist a changed identifier before minting so later refreshes reuse it.
  if (identifier !== auth.identifier) {
    auth.identifier = identifier;
    if (!(await updateEntry(entry))) {
      console.error(
        `anyapi-mcp login: "${entry.id}" is no longer registered; aborting.`,
      );
      Deno.exit(1);
    }
  }

  try {
    const session = await loginWithAppPassword(
      auth,
      entry.baseUrl,
      identifier,
      password,
    );
    console.error(
      `\nAuthenticated "${entry.id}" as ${session.handle || identifier}${
        session.did ? ` (${session.did})` : ""
      }.\n` +
        `  App password stored in the OS keychain; sessions refresh automatically.`,
    );
  } catch (err) {
    console.error(
      `anyapi-mcp login: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}

export async function runLogin(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: [
      "identifier",
      "client-id",
      "client-secret",
      "scope",
      "scope-separator",
      "redirect-uri",
      "port",
      "auth-url",
      "token-url",
    ],
    collect: ["scope"],
    boolean: ["help", "no-browser"],
    alias: { h: "help" },
  });
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const id = typeof flags._[0] === "string" ? flags._[0] : "";
  if (!id) {
    console.error("anyapi-mcp login: missing <id>\n");
    console.error(HELP);
    Deno.exit(1);
  }

  const entry = await findEntry(id);
  if (!entry) {
    console.error(`anyapi-mcp login: no API with id "${id}".`);
    Deno.exit(1);
  }
  if (entry.auth.kind === "atproto") {
    await loginAtproto(entry, flags.identifier);
    return;
  }
  if (entry.auth.kind !== "oauth2") {
    console.error(
      `anyapi-mcp login: "${id}" is not an OAuth or atproto API (auth: ${entry.auth.kind}). ` +
        `Re-add it with --oauth (and --auth-url/--token-url if its spec doesn't declare them).`,
    );
    Deno.exit(1);
  }
  const auth = entry.auth;

  // Apply endpoint/scope overrides onto the entry so refresh + re-auth reuse them.
  if (flags["auth-url"]) auth.authorizationUrl = flags["auth-url"];
  if (flags["token-url"]) auth.tokenUrl = flags["token-url"];
  if (flags["scope-separator"] !== undefined) {
    auth.scopeSeparator = flags["scope-separator"];
  }
  if (flags["redirect-uri"]) {
    auth.redirectUri = flags["redirect-uri"];
  } else if (flags.port) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`anyapi-mcp login: invalid --port "${flags.port}".`);
      Deno.exit(1);
    }
    auth.redirectUri = defaultRedirectUri(port);
  }
  const flagScopes = (flags.scope as string[] | undefined) ?? [];
  if (flagScopes.length) auth.scopes = flagScopes;

  // Resolve client credentials: flags override stored; prompt for the secret when
  // logging in with a new/changed client id and none was supplied.
  const stored = await loadClient(auth);
  const clientId = flags["client-id"] ?? stored?.clientId;
  if (!clientId) {
    console.error(
      `anyapi-mcp login: no client id stored for "${id}"; pass --client-id <id>.`,
    );
    Deno.exit(1);
  }
  let clientSecret: string | undefined;
  if (flags["client-secret"] !== undefined) {
    clientSecret = flags["client-secret"] || undefined;
  } else if (stored && clientId === stored.clientId) {
    clientSecret = stored.clientSecret;
  } else {
    clientSecret = await readClientSecret();
  }
  const client: OAuthClient = { clientId };
  if (clientSecret) client.clientSecret = clientSecret;

  if (auth.scopes.length === 0) {
    console.error(
      "Note: requesting no scopes. Pass --scope <name> (repeatable) to request access.",
    );
  }

  // Validate the (possibly overridden) endpoints before persisting, so a bad
  // --auth-url/--token-url/--redirect-uri can't leave broken values on the entry.
  for (
    const [label, value] of [
      ["--auth-url", auth.authorizationUrl],
      ["--token-url", auth.tokenUrl],
      ["redirect URI", auth.redirectUri],
    ] as const
  ) {
    try {
      new URL(value);
    } catch {
      console.error(`anyapi-mcp login: invalid ${label}: "${value}".`);
      Deno.exit(1);
    }
  }

  // Persist creds and the (possibly updated) entry before the interactive flow.
  await saveClient(auth, client);
  if (!(await updateEntry(entry))) {
    console.error(
      `anyapi-mcp login: "${id}" is no longer registered; aborting.`,
    );
    Deno.exit(1);
  }

  console.error(
    `Make sure your OAuth app's redirect/callback URL is: ${auth.redirectUri}`,
  );
  if (auth.scopes.length) {
    console.error(`Requesting scopes: ${auth.scopes.join(", ")}`);
  }

  try {
    const token = await runAuthorizationCodeFlow({
      authorizationUrl: auth.authorizationUrl,
      tokenUrl: auth.tokenUrl,
      client,
      scopes: auth.scopes,
      scopeSeparator: auth.scopeSeparator,
      redirectUri: auth.redirectUri,
      extraAuthParams: auth.extraAuthParams,
      openBrowser: !flags["no-browser"],
      onProgress: (m) => console.error(m),
    });
    await saveToken(auth, token);
    console.error(
      `\nAuthenticated "${id}".\n` +
        `  granted scopes: ${
          token.scope ?? (auth.scopes.join(", ") || "(default)")
        }\n` +
        `  ${describeExpiry(token)}\n` +
        (token.refreshToken
          ? "  refresh token stored; the access token will refresh automatically."
          : "  no refresh token returned; you may need to log in again when it expires."),
    );
  } catch (err) {
    console.error(
      `anyapi-mcp login: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}
