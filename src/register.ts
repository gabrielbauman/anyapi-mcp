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
  readRegistry,
  type RegistryEntry,
  removeEntry,
  updateEntry,
} from "./registry.ts";
import { writeOpsIndex } from "./operation.ts";
import { deleteSecret, getSecret, setSecret } from "./keystore.ts";
import { opsPathFor, typesPathFor } from "./paths.ts";
import {
  clearOAuthSecrets,
  defaultRedirectUri,
  type DiscoveredOAuth,
  quirkForAuthUrl,
} from "./oauth.ts";
import { clearAtprotoSecrets } from "./atproto-auth.ts";

/**
 * Version of the generated-code contract. Bump this whenever a change would make
 * previously-generated artifacts stale relative to the current build: the
 * openapi-typescript output or its post-processing (openapi-sanitize.ts), the
 * GraphQL/SOAP type/client emitters, the SOAP runtime deps baked into the client
 * module, or the operation-index shape (operation.ts). Each registry entry
 * records the version its artifacts were built under; `serve` regenerates any
 * stale entry on startup and `anyapi-mcp regenerate` rebuilds on demand.
 *
 * It is a deliberate counter, not the git hash: tying regeneration to commits
 * would re-fetch every spec on releases that never touched codegen.
 */
export const CODEGEN_VERSION = 1;

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
  /** atproto: handle or email used to mint sessions. */
  identifier?: string;
  /** atproto: app password to store up front (the long-lived secret); else set via `login`. */
  appPassword?: string;
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
  if (auth.kind === "atproto") return [auth.passwordKey, auth.sessionKey];
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
  } else if (entry.auth.kind === "atproto") {
    const { session, password } = await clearAtprotoSecrets(entry.auth, {
      forgetPassword: true,
    });
    secretsNote = `deleted atproto secrets (session: ${
      session ? "yes" : "none"
    }, app password: ${password ? "yes" : "none"})`;
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

  // Auth precedence: an atproto API always uses app-password sessions; otherwise
  // an explicit --token wins (bearer); --no-auth forces none; else OAuth is
  // adopted when discovered or explicitly requested. The actual login happens
  // later via `anyapi-mcp login` - registration only records the config (and
  // stores an app password / token if one was supplied up front).
  let auth: Auth = { kind: "none" };
  if (kind === "atproto") {
    const passwordKey = `anyapi-mcp:${id}:apppass`;
    const sessionKey = `anyapi-mcp:${id}:session`;
    if (opts.appPassword) await setSecret(passwordKey, opts.appPassword);
    auth = {
      kind: "atproto",
      identifier: opts.identifier ?? "",
      passwordKey,
      sessionKey,
    };
  } else if (opts.token !== undefined) {
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
    codegenVersion: CODEGEN_VERSION,
    addedAt: new Date().toISOString(),
  };
  if (opts.docsUrl) entry.docsUrl = opts.docsUrl;
  if (prepared.description) entry.description = prepared.description;

  if (existing) {
    // In-place overwrite. The fresh addedAt invalidates serve's ops cache; the
    // regenerated types/ops files already replaced the old ones at the same
    // paths; same-id keystore accounts are preserved (an OAuth API stays logged
    // in). Only drop secrets, and a types file at a now-stale path (kind change),
    // that the new entry no longer references.
    await cleanupOrphanedSecrets(existing.auth, entry.auth);
    // An atproto re-register that changes the account must not keep acting as the
    // old one: the cached session is the old identifier's, and the stored app
    // password is too (unless this call supplied a new one). Drop them so the next
    // execute re-auths as the new identifier instead of silently using the old.
    if (
      existing.auth.kind === "atproto" && entry.auth.kind === "atproto" &&
      existing.auth.identifier !== entry.auth.identifier
    ) {
      await clearAtprotoSecrets(entry.auth, {
        forgetPassword: !opts.appPassword,
      });
    }
    if (existing.typesPath !== entry.typesPath) {
      try {
        await Deno.remove(existing.typesPath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
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

export interface RegenerateResult {
  id: string;
  /** True when the code was rebuilt, or (with `skipped`) was already current. */
  ok: boolean;
  /** Operation count on the refreshed source (present on a successful rebuild). */
  operationCount?: number;
  /** Set when `staleOnly` skipped an entry already at CODEGEN_VERSION. */
  skipped?: boolean;
  /** Failure reason (present when `ok` is false). */
  error?: string;
}

/**
 * Rebuild ONLY the generated code for an already-registered API: re-fetch its
 * source, regenerate the typed client + operation index in place, and bump the
 * entry's `codegenVersion` and `addedAt` (the latter busts serve's ops cache).
 *
 * The entry's auth, baseUrl, and hosts are preserved verbatim - this is a codegen
 * refresh, not a re-registration. No secret is written or deleted; a bearer token
 * is only READ, to re-inspect a source that needs auth (e.g. GraphQL
 * introspection). On any failure the existing artifacts are left in place and the
 * error is returned, never thrown - a stale-but-working client beats a broken one.
 */
export async function regenerateApi(
  entry: RegistryEntry,
  onProgress?: (message: string) => void,
): Promise<RegenerateResult> {
  const log = onProgress ?? (() => {});
  try {
    const adapter = getAdapter(entry.kind);
    const token = entry.auth.kind === "bearer"
      ? await getSecret(entry.auth.tokenKey)
      : undefined;
    const prepared = await adapter.prepare(entry.specSource, {
      // Pin the registered base URL so a codegen refresh never moves the base or
      // re-derives the host allowlist - that is a re-registration concern.
      baseUrlOverride: entry.baseUrl,
      token,
      onProgress: log,
    });
    await prepared.writeTypes(entry.typesPath);
    await writeOpsIndex(entry.id, prepared.operations);
    const updated: RegistryEntry = {
      ...entry,
      codegenVersion: CODEGEN_VERSION,
      addedAt: new Date().toISOString(),
    };
    if (!(await updateEntry(updated))) {
      return { id: entry.id, ok: false, error: "no longer registered" };
    }
    return {
      id: entry.id,
      ok: true,
      operationCount: prepared.operations.length,
    };
  } catch (err) {
    return {
      id: entry.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Regenerate code for many registered APIs. With `ids`, only those entries are
 * considered; otherwise every registered API. With `staleOnly`, entries already
 * at CODEGEN_VERSION are skipped (serve's post-upgrade startup pass uses this).
 * Each API is independent - one failure never aborts the rest.
 */
export async function regenerateApis(
  opts: {
    ids?: string[];
    staleOnly?: boolean;
    onProgress?: (message: string) => void;
  } = {},
): Promise<RegenerateResult[]> {
  const log = opts.onProgress ?? (() => {});
  let entries = await readRegistry();
  if (opts.ids) {
    const want = new Set(opts.ids);
    entries = entries.filter((e) => want.has(e.id));
  }
  const results: RegenerateResult[] = [];
  for (const entry of entries) {
    if (opts.staleOnly && entry.codegenVersion === CODEGEN_VERSION) {
      results.push({ id: entry.id, ok: true, skipped: true });
      continue;
    }
    log(
      `Regenerating ${entry.id} (${entry.kind}) from ${entry.specSource} ...`,
    );
    results.push(await regenerateApi(entry, log));
  }
  return results;
}
