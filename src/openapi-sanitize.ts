// Post-process openapi-typescript output so a recursive schema can't break the
// whole-program type check that `execute` runs before letting model code out of
// the sandbox.
//
// The problem: openapi-typescript references every schema by an indexed-access
// type, `components["schemas"]["X"]`. When a schema sits in a reference cycle -
// directly ("arbitrary JSON value" types that nest objects/arrays of themselves,
// e.g. Cloudflare's `workers-kv_any`), or indirectly via a $ref cycle - that
// indexed access ends up inside the very member it indexes, and TypeScript
// rejects the *entire* file:
//
//   TS2502: '"workers-kv_any"' is referenced directly or indirectly in its own
//           type annotation.
//
// Because the check is whole-program, one such schema blocks checked `execute`
// for every operation in the API - exactly the large specs (Cloudflare, AT
// Protocol) where type-checked calls help most.
//
// The recursion itself is legal; only the indexed-access *self*-reference is not.
// A named recursive type alias that nests through an object/array type-checks
// fine (`type A = string | { [k: string]: A } | A[]`). So for each schema in a
// cycle we lift its body out to a top-level alias and point the cyclic references
// at the alias names. The member declaration stays (now `"X": <alias>;`), so
// every external `components["schemas"]["X"]` reference still resolves. Specs with
// no cyclic schema are returned byte-for-byte unchanged.

/** Prefix for the lifted aliases. Numbered, so it can't collide with a schema-derived identifier or with openapi-typescript's fixed top-level names (paths/webhooks/components/$defs/operations). */
const ALIAS_PREFIX = "__anyapi_rec_";

/** Matches every indexed-access reference to a schema, `components["schemas"]["<name>"]`, capturing the (still-escaped) name literal. Used to rewrite references in a lifted body. */
const SCHEMA_REF =
  /components\s*\[\s*"schemas"\s*\]\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/g;

/** Same pattern, sticky - matches only at `lastIndex`. Used to test for a reference at a specific scan position. */
const SCHEMA_REF_AT =
  /components\s*\[\s*"schemas"\s*\]\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/y;

export interface SanitizeResult {
  /** The (possibly rewritten) file text. */
  text: string;
  /** How many schemas were lifted into recursive aliases (0 = unchanged). */
  lifted: number;
}

/** A top-level member parsed out of the `components.schemas` object literal. */
interface SchemaMember {
  /** Decoded schema name - matches the key in `components["schemas"]["..."]`. */
  name: string;
  /** Index of the first char of the type expression (just after the `:`). */
  typeStart: number;
  /** Index of the `;` terminating the member. */
  typeEnd: number;
}

/**
 * Break self-referential schema alias cycles in openapi-typescript output.
 * Pure: takes the file text, returns the (possibly rewritten) text plus a count.
 */
export function sanitizeRecursiveSchemaAliases(src: string): SanitizeResult {
  // Anchored to a line start so the phrase can't be matched inside a JSDoc
  // description (which would misplace the lifted-alias insertion point).
  const comp = /(?:^|\n)export interface components\b/.exec(src);
  if (!comp) return { text: src, lifted: 0 };
  const compIdx = comp.index + (src[comp.index] === "\n" ? 1 : 0);

  const schemas = locateSchemasObject(src, compIdx);
  if (!schemas) return { text: src, lifted: 0 };

  const members = scanSchemaMembers(
    src,
    schemas.contentStart,
    schemas.contentEnd,
  );
  if (members.length === 0) return { text: src, lifted: 0 };

  const cyclic = findCyclicSchemas(src, members);
  if (cyclic.size === 0) return { text: src, lifted: 0 };

  // Assign each cyclic schema a stable alias name, in member (source) order.
  const aliasByIndex = new Map<number, string>();
  let counter = 0;
  for (let i = 0; i < members.length; i++) {
    if (cyclic.has(i)) aliasByIndex.set(i, ALIAS_PREFIX + counter++);
  }
  const indexByName = new Map<string, number>();
  members.forEach((m, i) => indexByName.set(m.name, i));

  // Within a lifted body, a reference to another *cyclic* schema must point at
  // that schema's alias (to keep the cycle behind a lazy named boundary).
  // References to non-cyclic schemas stay as `components["schemas"]["Y"]`: a
  // non-cyclic Y can't reach back into a cycle, so it resolves fine.
  const rewriteCyclicRefs = (body: string): string =>
    body.replace(SCHEMA_REF, (whole, captured: string) => {
      const name = decodeStringLiteral(captured);
      if (name === undefined) return whole;
      const idx = indexByName.get(name);
      if (idx !== undefined && aliasByIndex.has(idx)) {
        return aliasByIndex.get(idx)!;
      }
      return whole;
    });

  const declLines: string[] = [
    "// anyapi-mcp: recursive schemas lifted to named aliases so checked execute " +
    "passes (see openapi-sanitize.ts).",
  ];
  // Each edit is a slice replacement against the ORIGINAL string; applied back
  // to front so earlier indices stay valid.
  const edits: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < members.length; i++) {
    const alias = aliasByIndex.get(i);
    if (!alias) continue;
    const body = src.slice(members[i].typeStart, members[i].typeEnd);
    declLines.push(`type ${alias} = ${rewriteCyclicRefs(body).trim()};`);
    // Replace the member's type expression (leading space included) with the alias.
    edits.push({
      start: members[i].typeStart,
      end: members[i].typeEnd,
      text: ` ${alias}`,
    });
  }
  // Hoist the alias declarations just above `export interface components`.
  edits.push({
    start: compIdx,
    end: compIdx,
    text: declLines.join("\n") + "\n",
  });

  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { text: out, lifted: aliasByIndex.size };
}

/**
 * Locate the `{ ... }` body of `components.schemas`. Returns the inner content
 * range (between the braces), or null when there is no schemas object (e.g.
 * `schemas: never;` for a spec with no components/schemas).
 */
function locateSchemasObject(
  src: string,
  compIdx: number,
): { contentStart: number; contentEnd: number } | null {
  const ifaceOpen = src.indexOf("{", compIdx);
  if (ifaceOpen === -1) return null;
  // `schemas` is the first member of the components interface.
  const re = /\bschemas\s*:/g;
  re.lastIndex = ifaceOpen + 1;
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < src.length && isSpace(src[i])) i++;
  if (src[i] !== "{") return null; // `schemas: never;` - nothing to do
  const close = matchBrace(src, i);
  if (close === -1) return null;
  return { contentStart: i + 1, contentEnd: close };
}

/**
 * Split the schemas object body into its top-level members. String- and
 * comment-aware so braces/semicolons inside JSDoc or string-literal types (enum
 * values, the `[key: string]:` index signatures of nested objects) don't fool
 * the member boundaries.
 */
function scanSchemaMembers(
  src: string,
  start: number,
  end: number,
): SchemaMember[] {
  const members: SchemaMember[] = [];
  let i = start;
  let depth = 0;
  let segStart = start;
  let keyColon = -1;
  while (i < end) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i, end);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i, end);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, end);
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === ":" && keyColon === -1) {
        keyColon = i;
      } else if (c === ";") {
        if (keyColon !== -1) {
          const name = decodeMemberKey(src.slice(segStart, keyColon));
          if (name !== undefined) {
            members.push({ name, typeStart: keyColon + 1, typeEnd: i });
          }
        }
        segStart = i + 1;
        keyColon = -1;
      }
    }
    i++;
  }
  return members;
}

/**
 * The set of member indices that participate in a reference cycle that TypeScript
 * would actually reject (TS2502) - a self-loop or a strongly-connected group of
 * two or more, counting only *eager* references (see eagerSchemaRefs). Found by
 * iteratively peeling nodes that can't be on a cycle - those with no outgoing or
 * no incoming eager edge - leaving exactly the cyclic ones.
 *
 * Counting only eager references is what keeps this from rewriting the many
 * schemas in a real spec that reference each other through object properties
 * (a lazy position TypeScript resolves fine); only references reachable without
 * passing through a `{ ... }` object type defeat the lazy boundary.
 */
function findCyclicSchemas(
  src: string,
  members: SchemaMember[],
): Set<number> {
  const indexByName = new Map<string, number>();
  members.forEach((m, i) => indexByName.set(m.name, i));

  const n = members.length;
  const out: Set<number>[] = members.map(() => new Set<number>());
  const inc: Set<number>[] = members.map(() => new Set<number>());
  for (let i = 0; i < n; i++) {
    const body = src.slice(members[i].typeStart, members[i].typeEnd);
    for (const name of eagerSchemaRefs(body)) {
      const j = indexByName.get(name);
      if (j !== undefined) {
        out[i].add(j);
        inc[j].add(i);
      }
    }
  }

  const outDeg = out.map((s) => s.size);
  const inDeg = inc.map((s) => s.size);
  const peeled = new Array<boolean>(n).fill(false);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (outDeg[i] === 0 || inDeg[i] === 0) queue.push(i);
  }
  while (queue.length > 0) {
    const u = queue.pop()!;
    if (peeled[u]) continue;
    peeled[u] = true;
    for (const v of out[u]) {
      if (!peeled[v] && --inDeg[v] === 0) queue.push(v);
    }
    for (const w of inc[u]) {
      if (!peeled[w] && --outDeg[w] === 0) queue.push(w);
    }
  }

  const cyclic = new Set<number>();
  for (let i = 0; i < n; i++) if (!peeled[i]) cyclic.add(i);
  return cyclic;
}

/**
 * Decoded names of the *eager* schema references in a member's type expression:
 * those reachable from the type root without crossing into a `{ ... }` object
 * type (a property or index-signature value, which TypeScript resolves lazily).
 * Unions, intersections, arrays, tuples and parentheses are eager-transparent;
 * only object braces form a lazy boundary. References inside strings or comments
 * are skipped. These are exactly the references that, if they close a cycle, fail
 * the type check with TS2502.
 */
function eagerSchemaRefs(body: string): string[] {
  const names: string[] = [];
  const n = body.length;
  let i = 0;
  let objectDepth = 0;
  while (i < n) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "*") {
      i = skipBlockComment(body, i, n);
      continue;
    }
    if (c === "/" && body[i + 1] === "/") {
      i = skipLineComment(body, i, n);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(body, i, n);
      continue;
    }
    if (c === "{") {
      objectDepth++;
      i++;
      continue;
    }
    if (c === "}") {
      if (objectDepth > 0) objectDepth--;
      i++;
      continue;
    }
    if (objectDepth === 0 && c === "c" && body.startsWith("components", i)) {
      SCHEMA_REF_AT.lastIndex = i;
      const m = SCHEMA_REF_AT.exec(body);
      if (m) {
        const name = decodeStringLiteral(m[1]);
        if (name !== undefined) names.push(name);
        i = SCHEMA_REF_AT.lastIndex;
        continue;
      }
    }
    i++;
  }
  return names;
}

// ---- small scanners ----

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function skipBlockComment(src: string, i: number, end: number): number {
  const e = src.indexOf("*/", i + 2);
  return e === -1 || e + 2 > end ? end : e + 2;
}

function skipLineComment(src: string, i: number, end: number): number {
  const e = src.indexOf("\n", i + 2);
  return e === -1 || e >= end ? end : e + 1;
}

/** Skip a string/template literal starting at the opening quote `src[i]`. */
function skipString(src: string, i: number, end: number): number {
  const quote = src[i];
  i++;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return end;
}

/** Return the index of the `}` matching the `{` at `openIdx`, or -1. */
function matchBrace(src: string, openIdx: number): number {
  let i = openIdx;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i, src.length);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i, src.length);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, src.length);
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (--depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Decode a member key (the text before its `:`) to the canonical schema name:
 * strips leading JSDoc/whitespace and an optional `?`, then unquotes a string
 * key or returns a bare identifier. Returns undefined for anything else.
 */
function decodeMemberKey(raw: string): string | undefined {
  let t = stripLeadingTrivia(raw).trim();
  if (t.endsWith("?")) t = t.slice(0, -1).trim();
  if (!t) return undefined;
  if (t.startsWith('"')) return decodeStringLiteral(t.slice(1, -1));
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : undefined;
}

/** Drop leading whitespace and block or line comments. */
function stripLeadingTrivia(s: string): string {
  let i = 0;
  for (;;) {
    while (i < s.length && isSpace(s[i])) i++;
    if (s.startsWith("/*", i)) {
      const e = s.indexOf("*/", i + 2);
      i = e === -1 ? s.length : e + 2;
    } else if (s.startsWith("//", i)) {
      const e = s.indexOf("\n", i + 2);
      i = e === -1 ? s.length : e + 1;
    } else {
      return s.slice(i);
    }
  }
}

/** Unescape the inner text of a double-quoted TS/JSON string literal. */
function decodeStringLiteral(inner: string): string | undefined {
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return undefined;
  }
}
