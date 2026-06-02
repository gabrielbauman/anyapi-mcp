// SOAP/WSDL protocol adapter. Fetches a public WSDL pointing at a live service,
// parses it (WSDL 1.1, SOAP 1.1/1.2, document/literal), builds an operation
// index, and generates a self-contained TypeScript client module the harness
// imports. Model code calls `client.<Operation>({ ...args })`.
//
// Out of scope (v1): rpc/encoded style, WS-Security / SOAP headers, MTOM,
// external XSD imports, WSDL 2.0. Auth is bearer / none.

import { XMLParser } from "fast-xml-parser";
import { toFileUrl } from "@std/path";
import { ensureCacheDir } from "./paths.ts";
import type { ProtocolAdapter } from "./adapter.ts";
import type { OperationInfo } from "./operation.ts";
import type { RegistryEntry } from "./registry.ts";

/** Keep in sync with the deno.json import map; baked into the generated module. */
const FXP_VERSION = "4.5.6";

// deno-lint-ignore no-explicit-any
type Xml = any;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}
function local(qname: string | undefined): string {
  if (!qname) return "";
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function tsIdent(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : (s || "_");
}
function propKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

const XSD_TS: Record<string, string> = {
  string: "string",
  normalizedString: "string",
  token: "string",
  anyURI: "string",
  QName: "string",
  date: "string",
  dateTime: "string",
  time: "string",
  duration: "string",
  base64Binary: "string",
  hexBinary: "string",
  int: "number",
  integer: "number",
  long: "number",
  short: "number",
  byte: "number",
  unsignedInt: "number",
  unsignedLong: "number",
  unsignedShort: "number",
  unsignedByte: "number",
  nonNegativeInteger: "number",
  positiveInteger: "number",
  decimal: "number",
  float: "number",
  double: "number",
  boolean: "boolean",
};

interface SoapField {
  name: string;
  xsdType: string;
  tsType: string;
  optional: boolean;
  array: boolean;
}
interface SoapStruct {
  name: string;
  fields: SoapField[];
}
interface SoapOp {
  name: string;
  soapAction: string;
  element: string; // request wrapper element (local name)
  params: SoapField[];
  returns: string;
  doc: string;
}
interface ParsedWsdl {
  serviceName: string;
  endpoint: string;
  soapVersion: "1.1" | "1.2";
  targetNamespace: string;
  structs: SoapStruct[];
  ops: SoapOp[];
}

function parseWsdl(rawXml: string): ParsedWsdl {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    attributeNamePrefix: "@_",
  });
  const doc = parser.parse(rawXml);
  const def: Xml = doc.definitions;
  if (!def) throw new Error("Not a WSDL 1.1 document (no <definitions> root).");

  const targetNamespace = str(def["@_targetNamespace"]);

  // Endpoint + service name from the first SOAP port.
  const service: Xml = asArray(def.service)[0];
  if (!service) throw new Error("WSDL has no <service>.");
  const serviceName = str(service["@_name"]);
  const ports = asArray<Xml>(service.port);
  const soapPort = ports.find((p) => p?.address?.["@_location"]);
  const endpoint = str(soapPort?.address?.["@_location"]);
  if (!endpoint) {
    throw new Error("WSDL service has no SOAP port with an address location.");
  }
  const soapVersion: "1.1" | "1.2" = rawXml.includes("/wsdl/soap/")
    ? "1.1"
    : "1.2";

  // Schemas: element + complexType maps; known type names for TS resolution.
  const schemas = asArray<Xml>(def.types?.schema);
  const schemaNs = str(schemas[0]?.["@_targetNamespace"]) || targetNamespace;
  const elements = new Map<string, Xml>();
  const complexTypes = new Map<string, Xml>();
  for (const schema of schemas) {
    for (const el of asArray<Xml>(schema.element)) {
      if (el["@_name"]) elements.set(str(el["@_name"]), el);
    }
    for (const ct of asArray<Xml>(schema.complexType)) {
      if (ct["@_name"]) complexTypes.set(str(ct["@_name"]), ct);
    }
  }
  const typeMap = new Map<string, string>();
  for (const name of [...elements.keys(), ...complexTypes.keys()]) {
    typeMap.set(name, tsIdent(name));
  }
  const tsOf = (xsdType: string | undefined): string => {
    const ln = local(xsdType);
    if (!ln) return "unknown";
    if (XSD_TS[ln]) return XSD_TS[ln];
    return typeMap.get(ln) ?? "unknown";
  };
  const fieldsOf = (complexType: Xml): SoapField[] => {
    if (!complexType) return [];
    const seq = complexType.sequence ?? complexType.all ?? complexType.choice;
    return asArray<Xml>(seq?.element)
      .filter((e) => e["@_name"])
      .map((e) => {
        const max = e["@_maxOccurs"];
        return {
          name: str(e["@_name"]),
          xsdType: local(str(e["@_type"])),
          tsType: tsOf(str(e["@_type"])),
          optional: str(e["@_minOccurs"]) === "0",
          array: max === "unbounded" || (max !== undefined && str(max) !== "1"),
        };
      });
  };
  const elementFields = (elementName: string): SoapField[] => {
    const el = elements.get(elementName);
    return el ? fieldsOf(el.complexType) : [];
  };

  // Structs to emit as interfaces (named by element or complexType).
  const structs: SoapStruct[] = [];
  const seen = new Set<string>();
  for (const [name, el] of elements) {
    const id = tsIdent(name);
    if (seen.has(id)) continue;
    seen.add(id);
    structs.push({ name: id, fields: fieldsOf(el.complexType) });
  }
  for (const [name, ct] of complexTypes) {
    const id = tsIdent(name);
    if (seen.has(id)) continue;
    seen.add(id);
    structs.push({ name: id, fields: fieldsOf(ct) });
  }

  // soapAction per operation, from any binding.
  const soapActions = new Map<string, string>();
  for (const binding of asArray<Xml>(def.binding)) {
    for (const op of asArray<Xml>(binding.operation)) {
      const name = str(op["@_name"]);
      const action = str(op.operation?.["@_soapAction"]);
      if (name && !soapActions.has(name)) soapActions.set(name, action);
    }
  }

  // message name -> request/response wrapper element (local name).
  const msgElement = new Map<string, string>();
  for (const msg of asArray<Xml>(def.message)) {
    const part = asArray<Xml>(msg.part)[0];
    const el = local(str(part?.["@_element"])) || local(str(part?.["@_name"]));
    msgElement.set(str(msg["@_name"]), el);
  }

  // Operations from the portType.
  const portType: Xml = asArray(def.portType)[0];
  const ops: SoapOp[] = [];
  for (const op of asArray<Xml>(portType?.operation)) {
    const name = str(op["@_name"]);
    if (!name) continue;
    const inEl = msgElement.get(local(str(op.input?.["@_message"]))) ?? name;
    const outEl = msgElement.get(local(str(op.output?.["@_message"]))) ?? "";
    const resultFields = outEl ? elementFields(outEl) : [];
    ops.push({
      name,
      soapAction: soapActions.get(name) ?? "",
      element: inEl,
      params: elementFields(inEl),
      returns: outEl ? (resultFields[0]?.xsdType || tsIdent(outEl)) : "unknown",
      doc: str(op.documentation),
    });
  }
  if (ops.length === 0) {
    throw new Error("WSDL has no operations in its portType.");
  }

  return {
    serviceName,
    endpoint,
    soapVersion,
    targetNamespace: schemaNs,
    structs,
    ops,
  };
}

function buildOperationIndex(wsdl: ParsedWsdl): OperationInfo[] {
  return wsdl.ops.map((op) => {
    const info: OperationInfo = {
      method: "POST",
      path: op.name,
      operationId: op.name,
      tags: [wsdl.serviceName],
      params: op.params.map((p) => ({
        name: p.name,
        in: "argument" as const,
        required: !p.optional,
        type: p.array ? `${p.xsdType || "any"}[]` : (p.xsdType || "any"),
      })),
      returns: op.returns,
    };
    if (op.doc) info.summary = op.doc;
    return info;
  });
}

function emitInterfaces(structs: SoapStruct[]): string {
  const lines: string[] = [];
  for (const st of structs) {
    lines.push(`export interface ${st.name} {`);
    if (st.fields.length === 0) {
      lines.push("  [key: string]: unknown;");
    } else {
      for (const f of st.fields) {
        const t = f.array ? `Array<${f.tsType}>` : f.tsType;
        lines.push(`  ${propKey(f.name)}${f.optional ? "?" : ""}: ${t};`);
      }
    }
    lines.push("}", "");
  }
  return lines.join("\n");
}

/** Generate the self-contained client module written to <id>.ts. */
function generateClientModule(wsdl: ParsedWsdl): string {
  const structNames = new Set(wsdl.structs.map((s) => s.name));
  const ops = wsdl.ops.map((op) => {
    const argType = structNames.has(tsIdent(op.element))
      ? tsIdent(op.element)
      : "Record<string, unknown>";
    return { key: propKey(op.name), argType, name: op.name };
  });

  return `// AUTO-GENERATED anyapi-mcp SOAP client - do not edit.
import { XMLParser } from "npm:fast-xml-parser@${FXP_VERSION}";

${emitInterfaces(wsdl.structs)}
const TARGET_NS = ${JSON.stringify(wsdl.targetNamespace)};
const SOAP_VERSION: "1.1" | "1.2" = ${JSON.stringify(wsdl.soapVersion)};
const ENDPOINT = ${JSON.stringify(wsdl.endpoint)};
const OPS: Record<string, { soapAction: string; element: string }> = ${
    JSON.stringify(
      Object.fromEntries(
        wsdl.ops.map((
          o,
        ) => [o.name, { soapAction: o.soapAction, element: o.element }]),
      ),
      null,
      2,
    )
  };

export interface SoapResult {
  status: number;
  // deno-lint-ignore no-explicit-any
  data: any;
  raw: string;
}

const _parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: true });

function _esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c));
}
function _toXml(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return _esc(String(value));
  let out = "";
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      for (const item of v) out += \`<\${k}>\${_toXml(item)}</\${k}>\`;
    } else {
      out += \`<\${k}>\${_toXml(v)}</\${k}>\`;
    }
  }
  return out;
}

export function createClient(opts: { endpoint?: string; token?: string } = {}) {
  const endpoint = opts.endpoint ?? ENDPOINT;
  async function invoke(opName: string, args: object = {}): Promise<SoapResult> {
    const op = OPS[opName];
    if (!op) throw new Error("Unknown SOAP operation: " + opName);
    const envNs = SOAP_VERSION === "1.2"
      ? "http://www.w3.org/2003/05/soap-envelope"
      : "http://schemas.xmlsoap.org/soap/envelope/";
    const inner = \`<\${op.element} xmlns="\${TARGET_NS}">\${_toXml(args)}</\${op.element}>\`;
    const body =
      \`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="\${envNs}"><soap:Body>\${inner}</soap:Body></soap:Envelope>\`;
    const headers: Record<string, string> = {};
    if (SOAP_VERSION === "1.2") {
      headers["content-type"] = \`application/soap+xml; charset=utf-8; action="\${op.soapAction}"\`;
    } else {
      headers["content-type"] = "text/xml; charset=utf-8";
      headers["SOAPAction"] = \`"\${op.soapAction}"\`;
    }
    if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
    const res = await fetch(endpoint, { method: "POST", headers, body });
    const raw = await res.text();
    // deno-lint-ignore no-explicit-any
    let data: any = raw;
    try {
      const parsed = _parser.parse(raw);
      const env = parsed?.Envelope ?? parsed;
      data = env?.Body ?? env;
    } catch { /* leave raw text as data */ }
    return { status: res.status, data, raw };
  }
  return {
    invoke,
${
    ops.map((o) =>
      `    ${o.key}: (args: ${o.argType}): Promise<SoapResult> => invoke(${
        JSON.stringify(o.name)
      }, args),`
    ).join("\n")
  }
  };
}
`;
}

export const soapAdapter: ProtocolAdapter = {
  kind: "soap",
  typesExtension: ".ts",

  async prepare(source, opts) {
    const log = opts.onProgress ?? (() => {});
    if (!/^https?:\/\//i.test(source)) {
      throw new Error(`SOAP source must be a WSDL URL, got "${source}".`);
    }
    log(`Fetching WSDL ${source} ...`);
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch WSDL: ${res.status} ${res.statusText}`);
    }
    const wsdl = parseWsdl(await res.text());
    const baseUrl = opts.baseUrlOverride ?? wsdl.endpoint;
    return {
      name: wsdl.serviceName || new URL(baseUrl).host,
      baseUrl,
      hosts: [new URL(baseUrl).host],
      operations: buildOperationIndex(wsdl),
      writeTypes: async (outPath: string) => {
        await ensureCacheDir();
        await Deno.writeTextFile(
          outPath,
          generateClientModule({ ...wsdl, endpoint: baseUrl }),
        );
      },
    };
  },

  buildHarness(entry: RegistryEntry, code: string): string {
    const url = JSON.stringify(toFileUrl(entry.typesPath).href);
    return [
      "// AUTO-GENERATED anyapi-mcp execute harness (soap) - do not edit.",
      `import { createClient } from ${url};`,
      `const token = Deno.env.get("ANYAPI_MCP_TOKEN");`,
      "// Call operations as: const r = await client.<OperationName>({ ...args });",
      "// r is { status, data, raw }; data is the parsed SOAP Body.",
      `const client = createClient({ endpoint: ${
        JSON.stringify(entry.baseUrl)
      }, token: token ?? undefined });`,
      "",
      "await (async () => {",
      code,
      "})();",
      "",
    ].join("\n");
  },
};
