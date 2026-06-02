// Protocol-agnostic operation index: the compact, searchable description of an
// API's operations, plus its on-disk cache. Each protocol adapter populates it
// from its own source (an OpenAPI spec, a GraphQL schema, …).

import { ensureCacheDir, opsPathFor } from "./paths.ts";

export interface OperationParam {
  name: string;
  /** "argument" is used by non-HTTP protocols (e.g. GraphQL field args). */
  in: "path" | "query" | "header" | "cookie" | "argument";
  required: boolean;
  type: string;
}

export interface OperationInfo {
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  tags: string[];
  params: OperationParam[];
  requestBodyHint?: string;
  /** Return-type hint (used by GraphQL; OpenAPI leaves it unset). */
  returns?: string;
}

export async function writeOpsIndex(
  id: string,
  ops: OperationInfo[],
): Promise<string> {
  await ensureCacheDir();
  const p = opsPathFor(id);
  await Deno.writeTextFile(p, JSON.stringify(ops));
  return p;
}

export async function readOpsIndex(
  id: string,
): Promise<OperationInfo[] | undefined> {
  try {
    return JSON.parse(
      await Deno.readTextFile(opsPathFor(id)),
    ) as OperationInfo[];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}
