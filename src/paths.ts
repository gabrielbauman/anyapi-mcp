// Filesystem locations for anyapi-mcp.
//
// Config (the registry) lives under $XDG_CONFIG_HOME/anyapi-mcp or ~/.config/anyapi-mcp.
// Cache (generated .d.ts files) lives under $XDG_CACHE_HOME/anyapi-mcp or ~/.cache/anyapi-mcp.
// macOS does not define XDG vars by default, so we fall back to the ~/.config and
// ~/.cache convention on both macOS and Linux.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";

function homeDir(): string {
  const home = Deno.env.get("HOME");
  if (!home || home.trim() === "") {
    throw new Error("HOME is not set; cannot resolve anyapi-mcp directories");
  }
  return home;
}

function xdgDir(envVar: string, fallbackSubdir: string): string {
  const fromEnv = Deno.env.get(envVar);
  if (fromEnv && fromEnv.trim() !== "") {
    return join(fromEnv, "anyapi-mcp");
  }
  return join(homeDir(), fallbackSubdir, "anyapi-mcp");
}

/** Directory holding the registry file. Not guaranteed to exist yet. */
export function configDir(): string {
  return xdgDir("XDG_CONFIG_HOME", ".config");
}

/** Directory holding generated .d.ts files. Not guaranteed to exist yet. */
export function cacheDir(): string {
  return xdgDir("XDG_CACHE_HOME", ".cache");
}

/** Ensure the config dir exists and return its path. */
export async function ensureConfigDir(): Promise<string> {
  const dir = configDir();
  await ensureDir(dir);
  return dir;
}

/** Ensure the cache dir exists and return its path. */
export async function ensureCacheDir(): Promise<string> {
  const dir = cacheDir();
  await ensureDir(dir);
  return dir;
}

/** Absolute path to the JSONL registry file. */
export function registryPath(): string {
  return join(configDir(), "apis.jsonl");
}

/**
 * Absolute path to the generated types file for a given API id. The extension
 * is adapter-chosen: `.d.ts` for type-only outputs (OpenAPI, GraphQL), `.ts` for
 * a runtime client module (SOAP).
 */
export function typesPathFor(id: string, ext = ".d.ts"): string {
  return join(cacheDir(), `${id}${ext}`);
}

/**
 * Absolute path to the cached operation index for a given API id. Built at
 * `add` time so `list` (op count) and `serve` (fuzzy search) work offline
 * without re-fetching the spec.
 */
export function opsPathFor(id: string): string {
  return join(cacheDir(), `${id}.ops.json`);
}
