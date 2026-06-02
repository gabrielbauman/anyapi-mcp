// OpenAPI protocol adapter: load a JSON spec, derive its base URL + hosts, build
// a compact operation index for search, generate a typed .d.ts via
// openapi-typescript, and run model code against an openapi-fetch client.
//
// The spec is untyped external JSON, so we navigate it with small typed
// accessors (obj/arr/str) rather than trusting its shape.

import { toFileUrl } from "@std/path";
import { ensureCacheDir } from "./paths.ts";
import type { ProtocolAdapter } from "./adapter.ts";
import type { OperationInfo, OperationParam } from "./operation.ts";
import type { RegistryEntry } from "./registry.ts";

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

/** Load + JSON-parse a spec from a URL or a local path. */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "Spec is not valid JSON. anyapi-mcp v1 supports JSON OpenAPI specs; " +
        "convert a YAML spec to JSON first.",
    );
  }
  const spec = obj(parsed);
  if (!spec) throw new Error("Spec did not parse to a JSON object.");
  return spec;
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
    params.push({
      name,
      in: location,
      required: p.required === true || location === "path",
      type: schemaHint(root, p.schema),
    });
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

// ---- base URL / hosts ----

/** Derive an absolute base URL from servers[0], resolving relative URLs and {vars}. */
export function resolveBaseUrl(spec: Json, specSource: string): string {
  const first = obj(arr(spec.servers)[0]);
  let url = first ? str(first.url) : undefined;
  if (url) {
    const vars = first ? obj(first.variables) : undefined;
    if (vars) {
      url = url.replace(/\{([^}]+)\}/g, (m, name: string) => {
        const v = obj(vars[name]);
        return (v && str(v.default)) ?? m;
      });
    }
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

// ---- adapter ----

export const openapiAdapter: ProtocolAdapter = {
  kind: "openapi",

  async prepare(source, opts) {
    const log = opts.onProgress ?? (() => {});
    log(`Loading spec from ${source} ...`);
    const spec = await loadSpec(source);
    const baseUrl = opts.baseUrlOverride ?? resolveBaseUrl(spec, source);
    const hosts = hostsFromBaseUrl(baseUrl);
    const operations = buildOperationIndex(spec);
    return {
      name: specName(spec),
      baseUrl,
      hosts,
      operations,
      writeTypes: (outPath: string) => generateTypes(source, outPath),
    };
  },

  buildHarness(entry: RegistryEntry, code: string): string {
    const typesUrl = toFileUrl(entry.typesPath).href;
    const authHeader = entry.auth.kind === "bearer"
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
