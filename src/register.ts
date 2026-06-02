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
  type RegistryEntry,
} from "./registry.ts";
import { writeOpsIndex } from "./operation.ts";
import { setSecret } from "./keystore.ts";
import { typesPathFor } from "./paths.ts";

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
  /** Optional progress sink (the CLI passes console.error; the MCP tool omits it). */
  onProgress?: (message: string) => void;
}

export interface RegisterResult {
  entry: RegistryEntry;
  operationCount: number;
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
  if (await findEntry(id)) {
    throw new Error(
      `An API with id "${id}" already exists. Choose another id, or remove it first.`,
    );
  }

  const typesPath = typesPathFor(id, adapter.typesExtension);
  log(`Generating types for ${prepared.operations.length} operations ...`);
  await prepared.writeTypes(typesPath);
  await writeOpsIndex(id, prepared.operations);

  let auth: Auth = { kind: "none" };
  if (opts.token !== undefined) {
    const tokenKey = `anyapi-mcp:${id}`;
    await setSecret(tokenKey, opts.token);
    auth = { kind: "bearer", header: "Authorization", tokenKey };
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
  await appendEntry(entry);

  return { entry, operationCount: prepared.operations.length };
}
