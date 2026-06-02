// The API registry: one JSON object per line in apis.jsonl.
//
// Secrets are NEVER stored here. For bearer auth we store only `tokenKey`, the
// keystore account name under which the secret lives.

import { ensureConfigDir, registryPath } from "./paths.ts";

export type Auth =
  | { kind: "none" }
  | { kind: "bearer"; header: string; tokenKey: string };

/** Which protocol adapter handles this API. */
export type ApiKind = "openapi" | "graphql" | "soap";

export interface RegistryEntry {
  /** Slug, unique, used on the CLI and in execute. */
  id: string;
  name: string;
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
  /** Absolute path to the generated .d.ts in the cache dir. */
  typesPath: string;
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

/** Rewrite the registry without the entry for `id`. Returns true if one was removed. */
export async function removeEntry(id: string): Promise<boolean> {
  const entries = await readRegistry();
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  const body = kept.map((e) => JSON.stringify(e)).join("\n");
  await ensureConfigDir();
  await Deno.writeTextFile(registryPath(), body.length ? body + "\n" : "");
  return true;
}
