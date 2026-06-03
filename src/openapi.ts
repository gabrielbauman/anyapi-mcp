// OpenAPI protocol adapter: load a JSON or YAML spec, derive its base URL +
// hosts, build a compact operation index for search, generate a typed .d.ts via
// openapi-typescript, and run model code against an openapi-fetch client.
//
// Swagger 2.0 (OpenAPI 2.0) specs are converted to OpenAPI 3.0 up front (see
// maybeConvertSwagger2): openapi-typescript rejects 2.0, and the index code
// below reads 3.x shapes (`servers`, `requestBody`). Everything downstream then
// operates on a 3.x document regardless of the source version.
//
// The parsed spec is an untyped external document, so we navigate it with small
// typed accessors (obj/arr/str) rather than trusting its shape.

import swagger2openapi from "swagger2openapi";
import { parse as parseYaml } from "@std/yaml";
import { toFileUrl } from "@std/path";
import { ensureCacheDir } from "./paths.ts";
import type { ProtocolAdapter } from "./adapter.ts";
import { clampDescription, clampEnum } from "./operation.ts";
import type { OperationInfo, OperationParam } from "./operation.ts";
import type { RegistryEntry } from "./registry.ts";
import type { DiscoveredOAuth } from "./oauth.ts";

/** Pinned so regenerated types stay stable across machines. */
const OPENAPI_TS_VERSION = "7.13.0";
/** Pinned to match what the sandbox warms into its module cache. */
const OPENAPI_FETCH_VERSION = "0.17.0";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Json)
    : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
function stripTrailingSlash(s: string): string {
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/**
 * Parse spec text as JSON, falling back to YAML. JSON is tried first so JSON
 * specs keep exact JSON semantics (and skip the slower YAML path); a YAML spec
 * fails the JSON parse and is then parsed as YAML. This parse only feeds the
 * operation index and base-URL derivation below; type generation is handled
 * separately by openapi-typescript, which parses YAML or JSON itself.
 */
function parseSpec(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON; fall through to YAML.
  }
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(
      `Spec is not valid JSON or YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Load a spec from a URL or a local path, parsing it as JSON or YAML. */
export async function loadSpec(specSource: string): Promise<Json> {
  let text: string;
  if (isUrl(specSource)) {
    const res = await fetch(specSource);
    if (!res.ok) {
      throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } else {
    text = await Deno.readTextFile(specSource);
  }
  const spec = obj(parseSpec(text));
  if (!spec) throw new Error("Spec did not parse to an object.");
  return spec;
}

// ---- Swagger 2.0 -> OpenAPI 3.0 ----

/** True for a Swagger 2.0 (OpenAPI 2.0) document, identified by its `swagger` field. */
function isSwagger2(spec: Json): boolean {
  const version = spec.swagger;
  return typeof version === "string" && version.startsWith("2");
}

/**
 * If `spec` is Swagger 2.0, convert it to an OpenAPI 3.0 document; otherwise
 * return undefined so the caller keeps the original 3.x spec. openapi-typescript
 * and the 3.x-shaped index code below don't understand 2.0, so this is the one
 * place that bridges the version gap.
 */
async function maybeConvertSwagger2(
  spec: Json,
  source: string,
  log: (message: string) => void,
): Promise<Json | undefined> {
  if (!isSwagger2(spec)) return undefined;
  log("Detected Swagger 2.0; converting to OpenAPI 3.0 ...");
  let openapi: unknown;
  try {
    const result = await swagger2openapi.convertObj(spec, {
      patch: true, // auto-fix minor spec errors instead of aborting
      warnOnly: true, // tolerate non-fatal validation issues
      // Inline external $refs (resolved relative to `source`) during conversion
      // so the converted document is self-contained. generateTypesFromSpec then
      // writes it to a temp file whose directory can't affect ref resolution -
      // which matters for multi-file local specs and relative refs in remote ones.
      resolve: true,
      source,
    });
    openapi = result?.openapi;
  } catch (err) {
    throw new Error(
      `Failed to convert Swagger 2.0 spec to OpenAPI 3.0: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const converted = obj(openapi);
  if (!converted) {
    throw new Error("Swagger 2.0 conversion produced no OpenAPI 3.0 document.");
  }
  return converted;
}

// ---- local $ref resolution (#/...) ----

function decodePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Follow a local JSON-pointer $ref to its target, with a depth guard for cycles. */
function resolveRef(root: Json, node: unknown, depth = 0): unknown {
  const o = obj(node);
  if (o && typeof o.$ref === "string" && depth < 16) {
    const ref = o.$ref;
    if (ref.startsWith("#/")) {
      let cur: unknown = root;
      for (const raw of ref.slice(2).split("/")) {
        const key = decodePointer(raw);
        const co = obj(cur);
        if (co && key in co) {
          cur = co[key];
        } else if (Array.isArray(cur) && /^\d+$/.test(key)) {
          cur = (cur as unknown[])[Number(key)];
        } else {
          return node; // unresolved - return the original node
        }
      }
      return resolveRef(root, cur, depth + 1);
    }
  }
  return node;
}

function refName(ref: string): string {
  return decodePointer(ref.split("/").pop() ?? ref);
}

/** A short, human-readable type hint for a schema node (for search payloads). */
function schemaHint(root: Json, schemaNode: unknown): string {
  const direct = obj(schemaNode);
  if (direct && typeof direct.$ref === "string") return refName(direct.$ref);
  const s = obj(resolveRef(root, schemaNode));
  if (!s) return "any";
  const t = str(s.type);
  if (t === "array") {
    const items = s.items;
    const io = obj(items);
    if (io && typeof io.$ref === "string") return `${refName(io.$ref)}[]`;
    const resolved = obj(resolveRef(root, items));
    return `${(resolved && str(resolved.type)) ?? "any"}[]`;
  }
  if (t) return t;
  if (s.properties || s.allOf || s.oneOf || s.anyOf) return "object";
  return "any";
}

/** Stringify a JSON enum list (skipping nulls); undefined if there's nothing usable. */
function enumValues(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = v
    .filter((x) => x !== null && x !== undefined)
    .map((x) => typeof x === "string" ? x : JSON.stringify(x));
  return out.length ? out : undefined;
}

/**
 * Allowed values for a parameter schema: a direct `enum`, or - for an array
 * parameter (e.g. Open-Meteo's `daily`/`hourly`) - the `enum` of its items.
 */
function schemaEnum(root: Json, schemaNode: unknown): string[] | undefined {
  const s = obj(resolveRef(root, schemaNode));
  if (!s) return undefined;
  const direct = enumValues(s.enum);
  if (direct) return direct;
  if (str(s.type) === "array") {
    const items = obj(resolveRef(root, s.items));
    if (items) return enumValues(items.enum);
  }
  return undefined;
}

function buildParams(root: Json, rawParams: unknown[]): OperationParam[] {
  const params: OperationParam[] = [];
  for (const raw of rawParams) {
    const p = obj(resolveRef(root, raw));
    if (!p) continue;
    const name = str(p.name);
    const location = str(p.in);
    if (!name || !location) continue;
    if (
      location !== "path" && location !== "query" &&
      location !== "header" && location !== "cookie"
    ) continue;
    const param: OperationParam = {
      name,
      in: location,
      required: p.required === true || location === "path",
      type: schemaHint(root, p.schema),
    };
    const description = clampDescription(str(p.description));
    if (description) param.description = description;
    const values = schemaEnum(root, p.schema);
    if (values) {
      const clamped = clampEnum(values);
      if (clamped) param.enum = clamped;
    }
    params.push(param);
  }
  return params;
}

function buildRequestBodyHint(root: Json, op: Json): string | undefined {
  const rb = obj(resolveRef(root, op.requestBody));
  if (!rb) return undefined;
  const content = obj(rb.content);
  if (!content) return undefined;
  const mediaTypes = Object.keys(content);
  if (mediaTypes.length === 0) return undefined;
  const preferred = mediaTypes.includes("application/json")
    ? "application/json"
    : mediaTypes[0];
  const mt = obj(content[preferred]);
  const hint = mt ? schemaHint(root, mt.schema) : "any";
  const required = rb.required === true ? " (required)" : "";
  return `${preferred}: ${hint}${required}`;
}

/** Walk spec.paths and produce one OperationInfo per (path, method). */
export function buildOperationIndex(spec: Json): OperationInfo[] {
  const paths = obj(spec.paths);
  if (!paths) return [];
  const operations: OperationInfo[] = [];
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = obj(resolveRef(spec, pathItemRaw));
    if (!pathItem) continue;
    const sharedParams = arr(pathItem.parameters);
    for (const method of HTTP_METHODS) {
      const op = obj(pathItem[method]);
      if (!op) continue;
      const tags = arr(op.tags)
        .map((t) => str(t))
        .filter((t): t is string => t !== undefined);
      const info: OperationInfo = {
        method,
        path,
        operationId: str(op.operationId) ?? `${method}:${path}`,
        tags,
        params: buildParams(spec, [...sharedParams, ...arr(op.parameters)]),
      };
      const summary = str(op.summary) ?? str(op.description);
      if (summary) info.summary = summary;
      const hint = buildRequestBodyHint(spec, op);
      if (hint) info.requestBodyHint = hint;
      operations.push(info);
    }
  }
  return operations;
}

// ---- OAuth discovery ----

/**
 * Find an OAuth2 authorization-code flow in the spec's security schemes. Runs on
 * the (already converted) 3.x document, so Swagger 2.0 `securityDefinitions` have
 * become `components.securitySchemes` with `flows.authorizationCode`. The URLs a
 * spec advertises can be wrong (Strava's are); callers may override them.
 */
export function discoverOAuth(spec: Json): DiscoveredOAuth | undefined {
  const components = obj(spec.components);
  const schemes = components && obj(components.securitySchemes);
  if (!schemes) return undefined;
  for (const raw of Object.values(schemes)) {
    const scheme = obj(raw);
    if (!scheme || str(scheme.type) !== "oauth2") continue;
    const flows = obj(scheme.flows);
    const ac = flows && obj(flows.authorizationCode);
    if (!ac) continue;
    const authorizationUrl = str(ac.authorizationUrl);
    const tokenUrl = str(ac.tokenUrl);
    if (!authorizationUrl || !tokenUrl) continue;
    const scopeObj = obj(ac.scopes);
    return {
      authorizationUrl,
      tokenUrl,
      scopes: scopeObj ? Object.keys(scopeObj) : [],
    };
  }
  return undefined;
}

// ---- base URL / hosts ----

/**
 * Hosts that serve raw spec/text files but never a live API. A base URL derived
 * onto one of these means the spec declared no usable server (or only a relative
 * one, resolved against wherever the spec itself was fetched), so we fail loudly
 * instead of silently pointing every request at a file CDN.
 */
const SPEC_HOSTING_HOSTS: ReadonlySet<string> = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "raw.githack.com",
  "rawcdn.githack.com",
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "cdn.statically.io",
]);

function looksLikeSpecHostingHost(host: string): boolean {
  return SPEC_HOSTING_HOSTS.has(host.toLowerCase().split(":")[0]);
}

/**
 * The first server object found at the document, path-item, or operation level,
 * in that precedence order. OpenAPI 3.x allows `servers` at all three levels;
 * many real specs (Open-Meteo among them) declare it only per-path, where a
 * top-level-only lookup finds nothing and wrongly falls back to the spec's host.
 */
function firstServer(spec: Json): Json | undefined {
  const top = obj(arr(spec.servers)[0]);
  if (top) return top;
  const paths = obj(spec.paths);
  if (!paths) return undefined;
  const pathItems = Object.values(paths)
    .map((p) => obj(resolveRef(spec, p)))
    .filter((p): p is Json => p !== undefined);
  for (const pathItem of pathItems) {
    const s = obj(arr(pathItem.servers)[0]);
    if (s) return s;
  }
  for (const pathItem of pathItems) {
    for (const method of HTTP_METHODS) {
      const op = obj(pathItem[method]);
      const s = op && obj(arr(op.servers)[0]);
      if (s) return s;
    }
  }
  return undefined;
}

/** Substitute `{var}` placeholders in a server URL with the variables' defaults. */
function applyServerVars(url: string, server: Json): string {
  const vars = obj(server.variables);
  if (!vars) return url;
  return url.replace(/\{([^}]+)\}/g, (m, name: string) => {
    const v = obj(vars[name]);
    return (v && str(v.default)) ?? m;
  });
}

function deriveBaseUrl(spec: Json, specSource: string): string {
  const server = firstServer(spec);
  const rawUrl = server ? str(server.url) : undefined;
  if (server && rawUrl) {
    const url = applyServerVars(rawUrl, server);
    if (isUrl(url)) return stripTrailingSlash(url);
    if (isUrl(specSource)) {
      return stripTrailingSlash(new URL(url, specSource).toString());
    }
    return stripTrailingSlash(url); // relative server + local spec: best effort
  }
  if (isUrl(specSource)) {
    const u = new URL(specSource);
    return `${u.protocol}//${u.host}`;
  }
  throw new Error(
    "Could not determine a base URL from the spec; pass --base-url.",
  );
}

/**
 * Derive an absolute base URL from the spec's servers (document, path, or
 * operation level), resolving relative URLs against the spec source and
 * substituting `{vars}`. Falls back to the spec's own host only when no server
 * is declared anywhere. Throws if the result lands on a known spec-hosting host
 * (e.g. raw.githubusercontent.com) - a strong signal the real server was not
 * found - so the caller fixes it with --base-url instead of registering a broken
 * API that would send every request to a file CDN.
 */
export function resolveBaseUrl(spec: Json, specSource: string): string {
  const baseUrl = deriveBaseUrl(spec, specSource);
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return baseUrl; // relative base from a local spec; hostsFromBaseUrl rejects it
  }
  if (looksLikeSpecHostingHost(host)) {
    throw new Error(
      `Derived base URL "${baseUrl}" points at ${host}, which hosts raw spec ` +
        `files rather than a live API - the spec likely declares its server only ` +
        `per-path/operation or relatively, or not at all. Pass --base-url (CLI) / ` +
        `baseUrl (add_api) with the real API base, e.g. https://api.example.com.`,
    );
  }
  return baseUrl;
}

export function hostsFromBaseUrl(baseUrl: string): string[] {
  try {
    return [new URL(baseUrl).host];
  } catch {
    throw new Error(
      `Base URL "${baseUrl}" is not absolute. Pass --base-url with a full https:// URL.`,
    );
  }
}

export function specName(spec: Json): string {
  const info = obj(spec.info);
  return (info && str(info.title)) || "API";
}

// ---- type generation ----

/** Generate the typed .d.ts via the openapi-typescript CLI into `outPath`. */
async function generateTypes(
  specSource: string,
  outPath: string,
): Promise<void> {
  await ensureCacheDir();
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      `npm:openapi-typescript@${OPENAPI_TS_VERSION}`,
      specSource,
      "-o",
      outPath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `openapi-typescript failed (exit ${code}):\n${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
}

/**
 * Generate types from an in-memory (converted) spec. openapi-typescript reads a
 * path or URL, so the spec is materialized to a temp file solely for the CLI run
 * and removed afterward. The spec is self-contained (maybeConvertSwagger2 already
 * inlined external $refs), so the temp directory has no bearing on resolution.
 */
async function generateTypesFromSpec(
  spec: Json,
  outPath: string,
): Promise<void> {
  await ensureCacheDir();
  const specFile = await Deno.makeTempFile({
    prefix: "anyapi-openapi3-",
    suffix: ".json",
  });
  try {
    await Deno.writeTextFile(specFile, JSON.stringify(spec));
    await generateTypes(specFile, outPath);
  } finally {
    await Deno.remove(specFile).catch(() => {});
  }
}

// ---- adapter ----

export const openapiAdapter: ProtocolAdapter = {
  kind: "openapi",

  async prepare(source, opts) {
    const log = opts.onProgress ?? (() => {});
    log(`Loading spec from ${source} ...`);
    const loaded = await loadSpec(source);
    // Swagger 2.0 sources are normalized to OpenAPI 3.0 here; `converted` is
    // undefined for specs that were already 3.x.
    const converted = await maybeConvertSwagger2(loaded, source, log);
    const spec = converted ?? loaded;
    const baseUrl = opts.baseUrlOverride ?? resolveBaseUrl(spec, source);
    const hosts = hostsFromBaseUrl(baseUrl);
    const operations = buildOperationIndex(spec);
    const oauth = discoverOAuth(spec);
    return {
      name: specName(spec),
      baseUrl,
      hosts,
      operations,
      ...(oauth ? { oauth } : {}),
      // openapi-typescript can't read the original Swagger 2.0 `source`, so a
      // converted spec is fed to it as OpenAPI 3.0 instead.
      writeTypes: (outPath: string) =>
        converted
          ? generateTypesFromSpec(converted, outPath)
          : generateTypes(source, outPath),
    };
  },

  buildHarness(entry: RegistryEntry, code: string): string {
    const typesUrl = toFileUrl(entry.typesPath).href;
    const authHeader =
      entry.auth.kind === "bearer" || entry.auth.kind === "oauth2"
        ? entry.auth.header
        : "Authorization";
    return `// AUTO-GENERATED anyapi-mcp execute harness (openapi) - do not edit.
import createClient from "npm:openapi-fetch@${OPENAPI_FETCH_VERSION}";
import type { paths } from ${JSON.stringify(typesUrl)};

const token = Deno.env.get("ANYAPI_MCP_TOKEN");
const client = createClient<paths>({
  baseUrl: ${JSON.stringify(entry.baseUrl)},
  headers: token ? { ${JSON.stringify(authHeader)}: \`Bearer \${token}\` } : {},
});

await (async () => {
${code}
})();
`;
  },
};
