// AT Protocol (atproto / lexicon / XRPC) adapter: build an operation index and a
// typed method map from the lexicons shipped in @atproto/api, and run model code
// against a thin XRPC fetch client.
//
// Unlike the other adapters we generate NO types of our own. The harness imports
// the official lexicon types straight from @atproto/api (type-only, so nothing
// from the SDK runs in the sandbox), and writeTypes emits only a small
// NSID -> { params, input, output } map (`XrpcMethods`) that points at those
// official types. That map is what lets `client.query("app.bsky.feed.getTimeline",
// ...)` infer its params and result from the NSID string literal.
//
// Method names come from @atproto/api's own `ids` export (NSID -> exported
// namespace), never derived, so a `Lex.<Name>` reference can't drift from what the
// package exports and break the whole-program type check `execute` runs.
//
// Auth is app-password sessions, managed entirely in the parent (src/atproto-auth.ts);
// the sandbox only ever receives a short-lived access JWT via ANYAPI_MCP_TOKEN.

import { toFileUrl } from "@std/path";
import { ensureCacheDir } from "./paths.ts";
import type { ProtocolAdapter } from "./adapter.ts";
import { applyEnum, clampDescription } from "./operation.ts";
import type { OperationInfo, OperationParam } from "./operation.ts";
import type { RegistryEntry } from "./registry.ts";

/**
 * Pinned so the op index, the generated method map, and the harness's type-only
 * import all read the same lexicon set. @atproto/api re-exports every per-method
 * type namespace (AppBskyFeedGetTimeline, ...) through its main entry, plus the
 * runtime `schemas`/`ids` we read here.
 */
const ATPROTO_API = "npm:@atproto/api@0.20.9";

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// --- minimal, defensive lexicon navigation (the dynamic import is untyped) ---

type Json = Record<string, unknown>;
function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Json)
    : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

interface Lexicons {
  /** LexiconDoc[] - each with `id` (NSID) and `defs.main`. */
  schemas: unknown[];
  /** Exported-namespace name -> NSID, e.g. AppBskyFeedGetTimeline -> app.bsky.feed.getTimeline. */
  ids: Record<string, string>;
}

async function loadLexicons(): Promise<Lexicons> {
  const mod = await import(ATPROTO_API) as { schemas?: unknown; ids?: unknown };
  const schemas = Array.isArray(mod.schemas) ? mod.schemas : [];
  const ids = obj(mod.ids) ?? {};
  if (schemas.length === 0) {
    throw new Error(`${ATPROTO_API} exported no lexicon schemas.`);
  }
  return { schemas, ids: ids as Record<string, string> };
}

/** A query/procedure pulled from the lexicons, with its exact exported namespace name. */
export interface XrpcMethod {
  nsid: string;
  /** PascalCase namespace as exported by @atproto/api, e.g. AppBskyFeedGetTimeline. */
  nsName: string;
  type: "query" | "procedure";
  /** Whether the lexicon declares an output schema (else the result is typed `unknown`). */
  hasOutputSchema: boolean;
}

/** Tag = the NSID minus its final segment: "app.bsky.feed.getTimeline" -> "app.bsky.feed". */
export function namespaceTag(nsid: string): string {
  const i = nsid.lastIndexOf(".");
  return i > 0 ? nsid.slice(0, i) : nsid;
}

/** Render a lexicon parameter's type for search display (e.g. "string", "integer[]"). */
function paramTypeName(def: Json): string {
  const t = str(def.type) ?? "unknown";
  if (t === "array") {
    const items = obj(def.items);
    return `${(items && str(items.type)) ?? "unknown"}[]`;
  }
  return t;
}

/** A closed `enum` on a lexicon param (knownValues is an open set, deliberately not surfaced). */
function paramEnum(def: Json): string[] | undefined {
  const e = def.enum;
  if (!Array.isArray(e) || e.length === 0) return undefined;
  const out = e.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

function buildParams(parameters: Json | undefined): OperationParam[] {
  const props = parameters && obj(parameters.properties);
  if (!props) return [];
  const requiredList = parameters && Array.isArray(parameters.required)
    ? parameters.required
    : [];
  const required = new Set(
    requiredList.filter((x): x is string => typeof x === "string"),
  );
  const params: OperationParam[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const def = obj(raw);
    if (!def) continue;
    const param: OperationParam = {
      name,
      in: "query",
      required: required.has(name),
      type: paramTypeName(def),
    };
    const description = clampDescription(str(def.description));
    if (description) param.description = description;
    const values = paramEnum(def);
    if (values) applyEnum(param, values);
    params.push(param);
  }
  return params;
}

/** Short type hint for a lexicon input/output schema node (ref name, "object", "union", ...). */
function schemaHint(schema: Json | undefined): string | undefined {
  if (!schema) return undefined;
  const t = str(schema.type);
  if (t === "ref") return str(schema.ref) ?? "ref";
  if (t === "union") return "union";
  return t;
}

/** Walk the lexicons into the search index + the typed method list, from one pass. */
export function buildIndexAndMethods(
  schemas: unknown[],
  ids: Record<string, string>,
): { operations: OperationInfo[]; methods: XrpcMethod[] } {
  const nsidToName = new Map<string, string>();
  for (const [name, nsid] of Object.entries(ids)) {
    if (typeof nsid === "string") nsidToName.set(nsid, name);
  }
  const operations: OperationInfo[] = [];
  const methods: XrpcMethod[] = [];
  for (const raw of schemas) {
    const doc = obj(raw);
    const nsid = doc && str(doc.id);
    const defs = doc && obj(doc.defs);
    const main = defs && obj(defs.main);
    const type = main && str(main.type);
    if (!nsid || !main || (type !== "query" && type !== "procedure")) continue;
    // Use the package's own NSID -> namespace name; skip anything it doesn't
    // export (can't be typed safely, and a dangling Lex.<Name> would fail check).
    const nsName = nsidToName.get(nsid);
    if (!nsName) continue;

    const input = obj(main.input);
    const output = obj(main.output);
    const op: OperationInfo = {
      method: type,
      path: nsid,
      operationId: nsid,
      tags: [namespaceTag(nsid)],
      params: buildParams(obj(main.parameters)),
    };
    const summary = clampDescription(str(main.description));
    if (summary) op.summary = summary;
    if (input) {
      const encoding = str(input.encoding) ?? "application/json";
      const hint = schemaHint(obj(input.schema)) ??
        (encoding === "application/json" ? "object" : "bytes");
      op.requestBodyHint = `${encoding}: ${hint}`;
    }
    const returns = output ? schemaHint(obj(output.schema)) : undefined;
    if (returns) op.returns = returns;
    operations.push(op);

    methods.push({
      nsid,
      nsName,
      type,
      hasOutputSchema: !!(output && obj(output.schema)),
    });
  }
  return { operations, methods };
}

/**
 * The generated .d.ts: a map from each XRPC NSID to its official @atproto/api
 * param/input/output types. Imported (type-only) by the harness, so the client's
 * query/procedure signatures resolve from the NSID string literal.
 */
export function generateMethodMap(methods: XrpcMethod[]): string {
  const lines = [
    "// AUTO-GENERATED by anyapi-mcp (atproto lexicon method map) - do not edit.",
    "// Each XRPC NSID maps to its official @atproto/api param/input/output types,",
    "// so the execute client infers them from the NSID string literal.",
    `import type * as Lex from ${JSON.stringify(ATPROTO_API)};`,
    "",
    "export interface XrpcMethods {",
  ];
  for (const m of methods) {
    const output = m.hasOutputSchema
      ? `Lex.${m.nsName}.OutputSchema`
      : "unknown";
    lines.push(
      `  ${JSON.stringify(m.nsid)}: {`,
      `    type: ${JSON.stringify(m.type)};`,
      `    params: Lex.${m.nsName}.QueryParams;`,
      `    input: Lex.${m.nsName}.InputSchema;`,
      `    output: ${output};`,
      "  };",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

export const atprotoAdapter: ProtocolAdapter = {
  kind: "atproto",

  async prepare(source, opts) {
    const log = opts.onProgress ?? (() => {});
    // The harness appends `/xrpc/<nsid>`, so the base is the service root. Strip a
    // trailing slash and a trailing `/xrpc` (a natural paste - e.g. the public
    // AppView's public.api.bsky.app/xrpc) so requests don't land on /xrpc/xrpc/...
    const baseUrl = (opts.baseUrlOverride ?? source)
      .replace(/\/+$/, "")
      .replace(/\/xrpc$/i, "")
      .replace(/\/+$/, "");
    if (!isUrl(baseUrl)) {
      throw new Error(
        `atproto source must be a PDS/service URL (e.g. https://bsky.social or ` +
          `https://public.api.bsky.app), got "${source}".`,
      );
    }
    const host = new URL(baseUrl).host;
    log(`Loading atproto lexicons from ${ATPROTO_API} ...`);
    const { schemas, ids } = await loadLexicons();
    const { operations, methods } = buildIndexAndMethods(schemas, ids);
    return {
      name: `AT Protocol (${host})`,
      baseUrl,
      hosts: [host],
      operations,
      writeTypes: async (outPath: string) => {
        await ensureCacheDir();
        await Deno.writeTextFile(outPath, generateMethodMap(methods));
      },
    };
  },

  buildHarness(entry: RegistryEntry, code: string): string {
    const typesUrl = toFileUrl(entry.typesPath).href;
    return `// AUTO-GENERATED anyapi-mcp execute harness (atproto) - do not edit.
import type { XrpcMethods } from ${JSON.stringify(typesUrl)};

type QueryNsid = {
  [K in keyof XrpcMethods]: XrpcMethods[K]["type"] extends "query" ? K : never;
}[keyof XrpcMethods];
type ProcedureNsid = {
  [K in keyof XrpcMethods]: XrpcMethods[K]["type"] extends "procedure" ? K
    : never;
}[keyof XrpcMethods];

const service = ${JSON.stringify(entry.baseUrl)}.replace(/\\/+$/, "");
const token = Deno.env.get("ANYAPI_MCP_TOKEN");

function buildQuery(params: unknown): string {
  const sp = new URLSearchParams();
  for (
    const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)
  ) {
    if (v === undefined || v === null) continue;
    // atproto array params repeat the key (?uri=a&uri=b), never comma-join.
    if (Array.isArray(v)) for (const item of v) sp.append(k, String(item));
    else sp.append(k, String(v));
  }
  const q = sp.toString();
  return q ? \`?\${q}\` : "";
}

async function xrpc(
  nsid: string,
  method: "GET" | "POST",
  params: unknown,
  input: unknown,
) {
  const url = \`\${service}/xrpc/\${nsid}\` +
    (method === "GET" ? buildQuery(params) : "");
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = \`Bearer \${token}\`;
  let body: BodyInit | undefined;
  if (method === "POST" && input !== undefined) {
    // Binary inputs (e.g. com.atproto.repo.uploadBlob) go as a raw octet-stream
    // body; everything else is JSON.
    if (
      input instanceof Uint8Array || input instanceof ArrayBuffer ||
      input instanceof Blob
    ) {
      headers["content-type"] = "application/octet-stream";
      body = input;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(input);
    }
  }
  const res = await fetch(url, { method, headers, body });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json")
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const detail = data && typeof data === "object" && "message" in data
      ? \`: \${(data as { message?: unknown }).message}\`
      : data
      ? \`: \${String(data).slice(0, 200)}\`
      : "";
    throw new Error(
      \`XRPC \${method} \${nsid} -> HTTP \${res.status} \${res.statusText}\${detail}\`,
    );
  }
  return data;
}

// A typed XRPC client: the NSID string literal selects the official @atproto/api
// types for params, input, and the awaited result. Auth is injected automatically.
const client = {
  query<K extends QueryNsid>(
    nsid: K,
    params: XrpcMethods[K]["params"],
  ): Promise<XrpcMethods[K]["output"]> {
    return xrpc(nsid, "GET", params, undefined);
  },
  procedure<K extends ProcedureNsid>(
    nsid: K,
    input: XrpcMethods[K]["input"],
  ): Promise<XrpcMethods[K]["output"]> {
    return xrpc(nsid, "POST", undefined, input);
  },
};

await (async () => {
${code}
})();
`;
  },
};
