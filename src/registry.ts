// The API registry: one JSON object per line in apis.jsonl.
//
// Secrets are NEVER stored here. For bearer auth we store only `tokenKey`, the
// keystore account name under which the secret lives. For OAuth we likewise store
// only the keystore account names (`clientKey`, `tokenKey`) - the client secret,
// access token, and refresh token all live in the keystore (see src/oauth.ts).

import { ensureConfigDir, registryPath } from "./paths.ts";

/**
 * OAuth 2.0 authorization-code config for an API. Holds everything needed to run
 * the browser login and to refresh tokens, but NO secrets: the client
 * credentials and token bundle live in the keystore under `clientKey`/`tokenKey`.
 */
export interface OAuth2Auth {
  kind: "oauth2";
  /** Header the access token is injected into (default "Authorization"). */
  header: string;
  /** Provider authorize endpoint (the page the user's browser is sent to). */
  authorizationUrl: string;
  /** Provider token endpoint (code exchange + refresh). */
  tokenUrl: string;
  /** Scopes requested at login. Mutable: `login` writes the chosen set here. */
  scopes: string[];
  /** Separator for the scope param. RFC 6749 uses " "; some providers (Strava) use ",". */
  scopeSeparator: string;
  /** redirect_uri the local callback server listens on; must be registered with the provider. */
  redirectUri: string;
  /** Extra fixed params appended to the authorize URL (e.g. Google's access_type=offline). */
  extraAuthParams?: Record<string, string>;
  /** Keystore account holding the JSON OAuthClient (clientId + clientSecret). */
  clientKey: string;
  /** Keystore account holding the JSON OAuthToken bundle (access/refresh/expiry). */
  tokenKey: string;
}

export type Auth =
  | { kind: "none" }
  | { kind: "bearer"; header: string; tokenKey: string }
  | OAuth2Auth;

/** Which protocol adapter handles this API. */
export type ApiKind = "openapi" | "graphql" | "soap";

export interface RegistryEntry {
  /** Slug, unique, used on the CLI and in execute. */
  id: string;
  name: string;
  /** Short human description from the source spec, surfaced by list_apis (optional). */
  description?: string;
  /** Protocol adapter for this API (defaults to "openapi" for older entries). */
  kind: ApiKind;
  /** URL or absolute local path the source was loaded from. */
  specSource: string;
  baseUrl: string;
  /** Hostnames the execute sandbox is allowed to reach. */
  hosts: string[];
  /** Documentation URL: stored and surfaced, never parsed. */
  docsUrl?: string;
  auth: Auth;
  /**
   * Absolute path to the generated types/client file in the cache dir: a `.d.ts`
   * for type-only outputs (OpenAPI, GraphQL), a `.ts` runtime module for SOAP.
   */
  typesPath: string;
  /**
   * The `CODEGEN_VERSION` the cached artifacts (types + ops index) were built
   * under. Absent on entries written before this field existed; a missing or
   * older value is treated as stale, so `serve` regenerates it on startup (and
   * `anyapi-mcp regenerate` rebuilds on demand). See register.ts.
   */
  codegenVersion?: number;
  addedAt: string;
}

/** Read every registry entry. Returns [] if the registry file does not exist. */
export async function readRegistry(): Promise<RegistryEntry[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(registryPath());
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const entries: RegistryEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as RegistryEntry;
      entry.kind ??= "openapi"; // back-compat for entries written before adapters
      entries.push(entry);
    } catch {
      console.error(
        `anyapi-mcp: skipping malformed registry line: ${trimmed.slice(0, 80)}`,
      );
    }
  }
  return entries;
}

/** Find a single entry by id. */
export async function findEntry(
  id: string,
): Promise<RegistryEntry | undefined> {
  return (await readRegistry()).find((e) => e.id === id);
}

/** Append one entry to the registry, creating the file/dir if needed. */
export async function appendEntry(entry: RegistryEntry): Promise<void> {
  await ensureConfigDir();
  await Deno.writeTextFile(registryPath(), JSON.stringify(entry) + "\n", {
    append: true,
  });
}

/**
 * Atomically rewrite the whole registry: write a temp file in the same directory
 * and rename it over the target, so an interrupted write can't truncate or
 * corrupt the registry (rename is atomic within a filesystem).
 */
async function writeRegistry(entries: RegistryEntry[]): Promise<void> {
  const dir = await ensureConfigDir();
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  const tmp = await Deno.makeTempFile({
    dir,
    prefix: "apis.",
    suffix: ".jsonl.tmp",
  });
  try {
    await Deno.writeTextFile(tmp, body.length ? body + "\n" : "");
    await Deno.rename(tmp, registryPath());
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** Replace the entry with the same id. Returns false if no entry matched. */
export async function updateEntry(entry: RegistryEntry): Promise<boolean> {
  const entries = await readRegistry();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return false;
  entries[idx] = entry;
  await writeRegistry(entries);
  return true;
}

/** Rewrite the registry without the entry for `id`. Returns true if one was removed. */
export async function removeEntry(id: string): Promise<boolean> {
  const entries = await readRegistry();
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  await writeRegistry(kept);
  return true;
}
