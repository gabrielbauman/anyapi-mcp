// In-tree registry of protocol adapters, keyed by `kind`.

import type { ProtocolAdapter } from "./adapter.ts";
import { openapiAdapter } from "./openapi.ts";
import { graphqlAdapter } from "./graphql.ts";
import { soapAdapter } from "./soap.ts";
import { atprotoAdapter } from "./atproto.ts";

const ADAPTERS: Record<string, ProtocolAdapter> = {
  openapi: openapiAdapter,
  graphql: graphqlAdapter,
  soap: soapAdapter,
  atproto: atprotoAdapter,
};

/** Adapter kinds that can be registered, e.g. for CLI help and validation. */
export const API_KINDS: string[] = Object.keys(ADAPTERS);

export function getAdapter(kind: string): ProtocolAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(
      `Unknown API kind "${kind}". Known kinds: ${API_KINDS.join(", ")}.`,
    );
  }
  return adapter;
}
