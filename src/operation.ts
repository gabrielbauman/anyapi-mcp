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
  /** One-line human description, surfaced in search so the model needn't guess. */
  description?: string;
  /**
   * Allowed values, when the schema constrains them (an OpenAPI `enum`, the
   * `enum` of an array's items, or a GraphQL enum type). Surfaced in search so
   * the model can pick a valid value without a failing call to leak the set.
   */
  enum?: string[];
}

// Caps so search payloads stay compact: a pathological spec can carry huge enums
// or paragraph-long parameter docs, and search returns up to MAX_RESULTS of them.
const MAX_ENUM_VALUES = 64;
const MAX_DESCRIPTION_LEN = 200;

/** Normalize and length-cap a parameter description; undefined if empty. */
export function clampDescription(
  s: string | undefined | null,
): string | undefined {
  if (!s) return undefined;
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return undefined;
  return t.length > MAX_DESCRIPTION_LEN
    ? t.slice(0, MAX_DESCRIPTION_LEN - 1) + "…"
    : t;
}

/** Cap an enum list to a sane size, reporting how many real values were dropped. */
function clampEnum(
  values: string[],
): { values: string[]; truncated: number } | undefined {
  if (values.length === 0) return undefined;
  if (values.length <= MAX_ENUM_VALUES) return { values, truncated: 0 };
  return {
    values: values.slice(0, MAX_ENUM_VALUES),
    truncated: values.length - MAX_ENUM_VALUES,
  };
}

/**
 * Attach a param's allowed values, keeping `enum` to real values only. When the
 * list is capped, the dropped count is noted in `description` (prose) rather than
 * polluting `enum` with a non-value sentinel a caller might select and send.
 */
export function applyEnum(param: OperationParam, values: string[]): void {
  const clamped = clampEnum(values);
  if (!clamped) return;
  param.enum = clamped.values;
  if (clamped.truncated > 0) {
    const note =
      `(+${clamped.truncated} more allowed values; see generated types)`;
    param.description = param.description
      ? `${param.description} ${note}`
      : note;
  }
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
