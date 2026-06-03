// GraphQL protocol adapter: introspect an endpoint, build an operation index
// from its Query/Mutation root fields, generate a .d.ts of the schema types, and
// run model code against a thin POST client. No external deps - raw fetch.

import { toFileUrl } from "@std/path";
import { ensureCacheDir } from "./paths.ts";
import type { ProtocolAdapter } from "./adapter.ts";
import { clampDescription, clampEnum } from "./operation.ts";
import type { OperationInfo, OperationParam } from "./operation.ts";
import type { RegistryEntry } from "./registry.ts";

const INTROSPECTION_QUERY =
  `query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { ...FullType } } }
fragment FullType on __Type { kind name description fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } } inputFields { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated: true) { name } possibleTypes { ...TypeRef } }
fragment InputValue on __InputValue { name description type { ...TypeRef } }
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
}
interface GqlField {
  name: string;
  description?: string | null;
  args: InputValue[];
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string | null;
  fields?: GqlField[] | null;
  inputFields?: InputValue[] | null;
  enumValues?: { name: string }[] | null;
  possibleTypes?: TypeRef[] | null;
}
interface GqlSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: FullType[];
}

const BUILTIN_SCALARS: Record<string, string> = {
  Int: "number",
  Float: "number",
  String: "string",
  ID: "string",
  Boolean: "boolean",
};

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function introspect(
  endpoint: string,
  token: string | undefined,
): Promise<GqlSchema> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach GraphQL endpoint ${endpoint}: ${String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Introspection failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const json = await res.json() as {
    data?: { __schema?: GqlSchema };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(
      `Introspection failed: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const schema = json.data?.__schema;
  if (!schema) {
    throw new Error(
      "Introspection returned no __schema (the endpoint may have introspection disabled or need a token).",
    );
  }
  return schema;
}

/** Render a type ref in GraphQL SDL form: NON_NULL(LIST(NON_NULL(User))) -> "[User!]!". */
function renderTypeRef(t: TypeRef): string {
  if (t.kind === "NON_NULL" && t.ofType) return renderTypeRef(t.ofType) + "!";
  if (t.kind === "LIST" && t.ofType) return "[" + renderTypeRef(t.ofType) + "]";
  return t.name ?? "Unknown";
}

// ---- operation index ----

/** Unwrap NON_NULL/LIST wrappers to the underlying named type (for enum lookup). */
function namedTypeName(t: TypeRef): string | undefined {
  let cur: TypeRef | null | undefined = t;
  while (cur && (cur.kind === "NON_NULL" || cur.kind === "LIST")) {
    cur = cur.ofType;
  }
  return cur?.name ?? undefined;
}

function buildParams(
  args: InputValue[],
  enumsByType: Map<string, string[]>,
): OperationParam[] {
  return args.map((a) => {
    const param: OperationParam = {
      name: a.name,
      in: "argument" as const,
      required: a.type.kind === "NON_NULL",
      type: renderTypeRef(a.type),
    };
    const description = clampDescription(a.description);
    if (description) param.description = description;
    const named = namedTypeName(a.type);
    const values = named ? enumsByType.get(named) : undefined;
    if (values) {
      const clamped = clampEnum(values);
      if (clamped) param.enum = clamped;
    }
    return param;
  });
}

function fieldsToOps(
  type: FullType | undefined,
  method: string,
  tag: string,
  enumsByType: Map<string, string[]>,
): OperationInfo[] {
  if (!type?.fields) return [];
  return type.fields.map((f) => {
    const op: OperationInfo = {
      method,
      path: f.name,
      operationId: f.name,
      tags: [tag],
      params: buildParams(f.args ?? [], enumsByType),
      returns: renderTypeRef(f.type),
    };
    if (f.description) op.summary = f.description;
    return op;
  });
}

function buildOperationIndex(schema: GqlSchema): OperationInfo[] {
  const byName = new Map<string, FullType>();
  const enumsByType = new Map<string, string[]>();
  for (const t of schema.types) {
    if (!t.name) continue;
    byName.set(t.name, t);
    if (t.kind === "ENUM" && t.enumValues?.length) {
      enumsByType.set(t.name, t.enumValues.map((v) => v.name));
    }
  }
  const queryType = schema.queryType
    ? byName.get(schema.queryType.name)
    : undefined;
  const mutationType = schema.mutationType
    ? byName.get(schema.mutationType.name)
    : undefined;
  return [
    ...fieldsToOps(queryType, "query", "Query", enumsByType),
    ...fieldsToOps(mutationType, "mutation", "Mutation", enumsByType),
  ];
}

// ---- schema .d.ts generation ----

function tsType(t: TypeRef, kinds: Map<string, string>): string {
  if (t.kind === "NON_NULL" && t.ofType) return tsNonNull(t.ofType, kinds);
  return `${tsNonNull(t, kinds)} | null`;
}
function tsNonNull(t: TypeRef, kinds: Map<string, string>): string {
  if (t.kind === "NON_NULL" && t.ofType) return tsNonNull(t.ofType, kinds);
  if (t.kind === "LIST" && t.ofType) return `Array<${tsType(t.ofType, kinds)}>`;
  const name = t.name ?? "unknown";
  if (BUILTIN_SCALARS[name]) return BUILTIN_SCALARS[name];
  const kind = kinds.get(name);
  if (kind === "SCALAR") return "unknown";
  return kind ? name : "unknown";
}

function generateSchemaDts(schema: GqlSchema): string {
  const kinds = new Map<string, string>();
  for (const t of schema.types) if (t.name) kinds.set(t.name, t.kind);

  const out: string[] = [
    "// AUTO-GENERATED by anyapi-mcp (graphql schema types) - do not edit.",
    "",
  ];
  for (const t of schema.types) {
    const name = t.name;
    if (!name || name.startsWith("__") || BUILTIN_SCALARS[name]) continue;

    if (t.kind === "OBJECT" || t.kind === "INTERFACE") {
      const fields = (t.fields ?? []).map((f) =>
        `  ${f.name}: ${tsType(f.type, kinds)};`
      );
      out.push(`export interface ${name} {`, ...orEmpty(fields), "}", "");
    } else if (t.kind === "INPUT_OBJECT") {
      const fields = (t.inputFields ?? []).map((f) => {
        const optional = f.type.kind === "NON_NULL" ? "" : "?";
        return `  ${f.name}${optional}: ${tsType(f.type, kinds)};`;
      });
      out.push(`export interface ${name} {`, ...orEmpty(fields), "}", "");
    } else if (t.kind === "ENUM") {
      const vals = (t.enumValues ?? []).map((v) => JSON.stringify(v.name));
      out.push(
        `export type ${name} = ${vals.length ? vals.join(" | ") : "never"};`,
        "",
      );
    } else if (t.kind === "UNION") {
      const members = (t.possibleTypes ?? []).map((p) => p.name).filter(
        Boolean,
      );
      out.push(
        `export type ${name} = ${
          members.length ? members.join(" | ") : "unknown"
        };`,
        "",
      );
    } else if (t.kind === "SCALAR") {
      out.push(`export type ${name} = unknown;`, "");
    }
  }
  return out.join("\n");
}

function orEmpty(fields: string[]): string[] {
  return fields.length ? fields : ["  [key: string]: unknown;"];
}

// ---- adapter ----

export const graphqlAdapter: ProtocolAdapter = {
  kind: "graphql",

  async prepare(source, opts) {
    const log = opts.onProgress ?? (() => {});
    if (!isUrl(source)) {
      throw new Error(
        `GraphQL source must be an http(s) endpoint URL, got "${source}".`,
      );
    }
    log(`Introspecting GraphQL endpoint ${source} ...`);
    const schema = await introspect(source, opts.token);
    const baseUrl = opts.baseUrlOverride ?? source;
    const operations = buildOperationIndex(schema);
    return {
      name: new URL(baseUrl).host,
      baseUrl,
      hosts: [new URL(baseUrl).host],
      operations,
      writeTypes: async (outPath: string) => {
        await ensureCacheDir();
        await Deno.writeTextFile(outPath, generateSchemaDts(schema));
      },
    };
  },

  buildHarness(entry: RegistryEntry, code: string): string {
    const typesUrl = toFileUrl(entry.typesPath).href;
    return [
      "// AUTO-GENERATED anyapi-mcp execute harness (graphql) - do not edit.",
      `import type * as Schema from ${JSON.stringify(typesUrl)};`,
      "",
      `const endpoint = ${JSON.stringify(entry.baseUrl)};`,
      `const token = Deno.env.get("ANYAPI_MCP_TOKEN");`,
      "",
      "// Run a GraphQL operation. Annotate the result with Schema types, e.g.",
      "//   const { data } = await client.query<{ user: Schema.User }>(`{ user(id:1){ id } }`);",
      "async function gql<T = unknown>(",
      "  query: string,",
      "  variables?: Record<string, unknown>,",
      "): Promise<{ data?: T; errors?: Array<{ message: string }> }> {",
      `  const headers: Record<string, string> = { "content-type": "application/json" };`,
      `  if (token) headers["Authorization"] = "Bearer " + token;`,
      "  const res = await fetch(endpoint, {",
      `    method: "POST",`,
      "    headers,",
      "    body: JSON.stringify({ query, variables }),",
      "  });",
      "  return await res.json();",
      "}",
      "const client = { query: gql, mutate: gql };",
      "",
      "await (async () => {",
      code,
      "})();",
      "",
    ].join("\n");
  },
};
