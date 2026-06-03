// Shared API-registration core, used by both the `add` CLI command and the
// `add_api` MCP tool. Protocol-specific work (inspect the source, generate the
// client types, build the operation index) is delegated to a ProtocolAdapter;
// this module handles id derivation, the registry write, and token storage.

import { getAdapter } from "./adapters.ts";
import {
  type ApiKind,
  appendEntry,
  type Auth,
  findEntry,
  type OAuth2Auth,
  type RegistryEntry,
  removeEntry,
  updateEntry,
} from "./registry.ts";
import { writeOpsIndex } from "./operation.ts";
import { deleteSecret, setSecret } from "./keystore.ts";
import { opsPathFor, typesPathFor } from "./paths.ts";
import {
  clearOAuthSecrets,
  defaultRedirectUri,
  type DiscoveredOAuth,
  quirkForAuthUrl,
} from "./oauth.ts";

/**
 * Build a reverse-DNS id from a base URL: the host reversed, then the base-path
 * segments. "https://petstore3.swagger.io/api/v3" -> "io.swagger.petstore3.api.v3";
 * "https://api.github.com" -> "com.github.api".
 */
export function reverseDnsId(baseUrl: string): string {
  const u = new URL(baseUrl);
  const host = u.host.split(":")[0].toLowerCase(); // drop any :port
  const hostLabels = host.split(".").filter(Boolean).reverse();
  const pathSegments = u.pathname.split("/").filter(Boolean).map((s) =>
    s.toLowerCase()
  );
  return [...hostLabels, ...pathSegments].join(".");
}

/** Normalize an id to a safe slug that may contain dots: lowercase, [a-z0-9.-] only. */
export function normalizeId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export interface RegisterOptions {
  /** URL or absolute local path to the source (OpenAPI spec or GraphQL endpoint). */
  specSource: string;
  kind?: ApiKind;
  id?: string;
  name?: string;
  baseUrl?: string;
  docsUrl?: string;
  /** If provided, stored in the keystore and the entry becomes bearer auth. */
  token?: string;
  /** Force OAuth2 even when discovery finds nothing (manual setup). */
  oauth?: boolean;
  /** Override/supply the OAuth authorize + token endpoints (else discovered). */
  authUrl?: string;
  tokenUrl?: string;
  /** Scopes to request at login (else the source's advertised scopes). */
  scopes?: string[];
  /** Override the scope separator (RFC 6749 " "; some providers use ","). */
  scopeSeparator?: string;
  /** Register with no auth even if OAuth was discovered. */
  noAuth?: boolean;
  /** Overwrite an existing entry with the same id instead of failing. */
  force?: boolean;
  /** Optional progress sink (the CLI passes console.error; the MCP tool omits it). */
  onProgress?: (message: string) => void;
}

/**
 * Resolve the OAuth config to store, given discovered values and explicit
 * overrides. Precedence: explicit flag > known-provider quirk > discovered. The
 * quirk is looked up by the effective authorize host - an explicit --auth-url if
 * given, otherwise the spec's - so a spec with the right host but wrong paths
 * (Strava) still gets corrected.
 */
function resolveOAuth(
  id: string,
  discovered: DiscoveredOAuth | undefined,
  opts: RegisterOptions,
): OAuth2Auth {
  const baseAuthUrl = opts.authUrl ?? discovered?.authorizationUrl;
  const baseTokenUrl = opts.tokenUrl ?? discovered?.tokenUrl;
  if (!baseAuthUrl || !baseTokenUrl) {
    throw new Error(
      "OAuth requested but no authorization/token URL was found; pass --auth-url and --token-url.",
    );
  }
  const quirk = quirkForAuthUrl(baseAuthUrl);
  return {
    kind: "oauth2",
    header: "Authorization",
    authorizationUrl: opts.authUrl ?? quirk?.authorizationUrl ?? baseAuthUrl,
    tokenUrl: opts.tokenUrl ?? quirk?.tokenUrl ?? baseTokenUrl,
    scopes: opts.scopes ?? discovered?.scopes ?? [],
    scopeSeparator: opts.scopeSeparator ?? quirk?.scopeSeparator ?? " ",
    redirectUri: defaultRedirectUri(),
    clientKey: `anyapi-mcp:${id}:client`,
    tokenKey: `anyapi-mcp:${id}:oauth`,
  };
}

export interface RegisterResult {
  entry: RegistryEntry;
  operationCount: number;
  /** True when this call overwrote an existing entry with the same id. */
  overwritten: boolean;
}

/** Keystore account names a given auth config references (none for kind "none"). */
function secretAccounts(auth: Auth): string[] {
  if (auth.kind === "bearer") return [auth.tokenKey];
  if (auth.kind === "oauth2") return [auth.clientKey, auth.tokenKey];
  return [];
}

/**
 * On overwrite, delete keystore secrets the old auth referenced that the new one
 * no longer does (e.g. a bearer token left behind when re-registering as no-auth,
 * or OAuth credentials dropped when switching to bearer). A same-kind re-register
 * keeps its accounts, so an OAuth API stays logged in across a re-register that
 * only fixes its base URL.
 */
async function cleanupOrphanedSecrets(
  oldAuth: Auth,
  newAuth: Auth,
): Promise<void> {
  const keep = new Set(secretAccounts(newAuth));
  for (const account of secretAccounts(oldAuth)) {
    if (!keep.has(account)) await deleteSecret(account);
  }
}

export interface UnregisterResult {
  /** False when no entry matched the id. */
  removed: boolean;
  /** What secrets were cleared (empty string when none, or when not found). */
  secretsNote: string;
}

/**
 * Remove an API: its registry entry, stored secrets (bearer token, or OAuth
 * client credentials + tokens), and cached artifacts (generated types + ops
 * index). Shared by the `remove` CLI command and the `remove_api` MCP tool.
 * Returns removed:false when no entry matches `id`.
 */
export async function unregisterApi(id: string): Promise<UnregisterResult> {
  const entry = await findEntry(id);
  if (!entry) return { removed: false, secretsNote: "" };

  let secretsNote = "";
  if (entry.auth.kind === "bearer") {
    const removed = await deleteSecret(entry.auth.tokenKey);
    secretsNote = removed ? "deleted bearer token" : "no bearer token stored";
  } else if (entry.auth.kind === "oauth2") {
    const { token, client } = await clearOAuthSecrets(entry.auth, {
      forgetClient: true,
    });
    secretsNote = `deleted OAuth secrets (token: ${
      token ? "yes" : "none"
    }, client: ${client ? "yes" : "none"})`;
  }

  await removeEntry(id);

  for (const path of [entry.typesPath, opsPathFor(id)]) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  return { removed: true, secretsNote };
}

/**
 * Register an API. Throws (with a user-facing message) on a bad/duplicate id or
 * an unreadable source. The token, if any, is stored only after type generation
 * succeeds, so a failed registration leaves no orphaned secret.
 */
export async function registerApi(
  opts: RegisterOptions,
): Promise<RegisterResult> {
  const log = opts.onProgress ?? (() => {});
  const kind: ApiKind = opts.kind ?? "openapi";
  const adapter = getAdapter(kind);

  const prepared = await adapter.prepare(opts.specSource, {
    baseUrlOverride: opts.baseUrl,
    token: opts.token,
    onProgress: log,
  });

  const baseUrl = prepared.baseUrl;
  const hosts = prepared.hosts;
  const name = opts.name ?? prepared.name;
  // Default the id to the base URL in reverse-DNS form: host reversed plus path
  // segments (e.g. com.github.api, io.swagger.petstore3.api.v3). --id overrides.
  const id = normalizeId(opts.id ?? reverseDnsId(baseUrl));
  if (!id) {
    throw new Error(
      "Could not derive an id from the base URL; pass an explicit id.",
    );
  }
  const existing = await findEntry(id);
  if (existing && !opts.force) {
    throw new Error(
      `An API with id "${id}" already exists. Re-run with force (CLI: --force, ` +
        `add_api: force:true) to overwrite it, choose another id, or remove it first.`,
    );
  }

  const typesPath = typesPathFor(id, adapter.typesExtension);
  log(`Generating types for ${prepared.operations.length} operations ...`);
  await prepared.writeTypes(typesPath);
  await writeOpsIndex(id, prepared.operations);

  // Auth precedence: an explicit --token wins (bearer); --no-auth forces none;
  // otherwise OAuth is adopted when discovered or explicitly requested. The
  // browser login happens later via `anyapi-mcp login` - registration only
  // records the (unauthenticated) OAuth config.
  let auth: Auth = { kind: "none" };
  if (opts.token !== undefined) {
    const tokenKey = `anyapi-mcp:${id}`;
    await setSecret(tokenKey, opts.token);
    auth = { kind: "bearer", header: "Authorization", tokenKey };
  } else if (!opts.noAuth) {
    const wantOAuth = opts.oauth || prepared.oauth !== undefined ||
      (opts.authUrl !== undefined && opts.tokenUrl !== undefined);
    if (wantOAuth) auth = resolveOAuth(id, prepared.oauth, opts);
  }

  const entry: RegistryEntry = {
    id,
    name,
    kind,
    specSource: opts.specSource,
    baseUrl,
    hosts,
    auth,
    typesPath,
    addedAt: new Date().toISOString(),
  };
  if (opts.docsUrl) entry.docsUrl = opts.docsUrl;

  if (existing) {
    // In-place overwrite. The fresh addedAt invalidates serve's ops cache; the
    // regenerated types/ops files already replaced the old ones at the same
    // paths; same-id keystore accounts are preserved (an OAuth API stays logged
    // in). Only drop secrets, and a types file at a now-stale path (kind change),
    // that the new entry no longer references.
    await cleanupOrphanedSecrets(existing.auth, entry.auth);
    if (existing.typesPath !== entry.typesPath) {
      await Deno.remove(existing.typesPath).catch(() => {});
    }
    if (!(await updateEntry(entry))) await appendEntry(entry);
  } else {
    await appendEntry(entry);
  }

  return {
    entry,
    operationCount: prepared.operations.length,
    overwritten: existing !== undefined,
  };
}
