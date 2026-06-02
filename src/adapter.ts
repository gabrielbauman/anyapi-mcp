// The protocol-adapter seam. Most of anyapi-mcp (registry, search, execute sandbox)
// is protocol-agnostic; an adapter supplies the two protocol-specific pieces:
//   1. prepare()      - turn a source into base URL/hosts + an operation index
//                        + a way to write the generated client types.
//   2. buildHarness() - the execute preamble that puts a typed `client` in scope.
//
// Adapters are plain in-tree objects keyed by `kind` (see adapters.ts) - a
// discriminated union, not a plugin framework.

import type { ApiKind, RegistryEntry } from "./registry.ts";
import type { OperationInfo } from "./operation.ts";

export interface PrepareOptions {
  /** Override the base URL the adapter would otherwise derive. */
  baseUrlOverride?: string;
  /** Bearer token, if the source needs auth to inspect (e.g. GraphQL introspection). */
  token?: string;
  onProgress?: (message: string) => void;
}

export interface PreparedApi {
  name: string;
  baseUrl: string;
  hosts: string[];
  operations: OperationInfo[];
  /** Write the generated client types to `typesPath` (path chosen by the caller). */
  writeTypes(typesPath: string): Promise<void>;
}

export interface ProtocolAdapter {
  kind: ApiKind;
  /** Extension for the generated types/client file (default ".d.ts"; SOAP uses ".ts"). */
  typesExtension?: string;
  prepare(source: string, opts: PrepareOptions): Promise<PreparedApi>;
  buildHarness(entry: RegistryEntry, code: string): string;
}
