// `anyapi-mcp serve` - stdio MCP server exposing `search`, `execute`,
// `authenticate`, `configure_oauth`, `add_api`, `list_apis`, and `remove_api`.
//
// The registry is re-read on each call (hot-reload), so an API registered mid-
// session - via the add_api tool or the `anyapi-mcp add` CLI - is usable without a
// restart. Parsed operation indexes are cached by id + addedAt.
//
// stdout carries ONLY the MCP JSON-RPC stream. Every diagnostic goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "@std/path";
import { z } from "zod";
import {
  type ApiKind,
  type OAuth2Auth,
  readRegistry,
  type RegistryEntry,
  updateEntry,
} from "../registry.ts";
import { isUrl } from "../openapi.ts";
import { type OperationInfo, readOpsIndex } from "../operation.ts";
import { getSecret } from "../keystore.ts";
import {
  CODEGEN_VERSION,
  regenerateApis,
  registerApi,
  unregisterApi,
} from "../register.ts";
import { getAdapter } from "../adapters.ts";
import { runSandboxed } from "../execute/run.ts";
import {
  describeExpiry,
  ensureAccessToken,
  loadClient,
  loadToken,
  OAuthNeedsLoginError,
  RESERVED_AUTHORIZE_PARAMS,
  runAuthorizationCodeFlow,
  saveToken,
} from "../oauth.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
// The capability map (list_apis drill-in) shows only the busiest areas so it stays
// an overview, not a second index; a fine-grained spec can carry hundreds of tags.
const MAX_CAPABILITY_TAGS = 40;

const SEARCH_DESCRIPTION =
  `Search registered API operations by keyword. Returns compact matches - ` +
  `{ api, method, path, operationId, summary, params, requestBodyHint } - so you ` +
  `can learn which path + method to call and roughly what arguments it takes. Each ` +
  `param lists its name and type, plus a description and its allowed "enum" values ` +
  `when the spec provides them, so you can pick valid arguments without a failed call. ` +
  `Feed what you learn into the "execute" tool. When an endpoint exists in several ` +
  `versions, the newest (e.g. v2 over v1) is ranked first unless your query names a ` +
  `version. Optionally pass "api" to restrict the search to one registered API id, and "limit" to ` +
  `cap how many matches come back (default 25, max 50).`;

/** Per-kind client-shape blurbs, assembled into the execute description for the kinds present. */
const EXEC_SHAPE_BULLETS: Record<ApiKind, string> = {
  openapi:
    '- OpenAPI: an openapi-fetch client - `const { data, error } = await client.GET("/pet/{petId}", ' +
    "{ params: { path: { petId: 1 } } });`. Methods are GET/POST/PUT/PATCH/DELETE; options are " +
    "{ params: { path, query }, body }; each returns { data, error, response }. response.status is " +
    "always set; on success data is set, on an HTTP error error is set (no throw) - narrow on data.\n",
  graphql:
    "- GraphQL (search method QUERY/MUTATION): `client.query(query, variables?)` and " +
    "`client.mutate(query, variables?)`, each returning { data, errors }; introspected types are " +
    "available as Schema.* (e.g. `client.query<{ user: Schema.User }>(...)`).\n",
  soap: "- SOAP (kind soap): one method per operation - " +
    "`const { status, data, raw } = await client.OperationName({ ...args });` (data is the parsed Body).\n",
};

/**
 * The execute tool description, carrying only the client-shape blurbs for the API
 * kinds actually registered - an OpenAPI-only setup needn't keep the GraphQL/SOAP
 * shapes in always-on context. Falls back to all kinds when the registry is empty.
 */
function buildExecuteDescription(kinds: Set<ApiKind>): string {
  const head =
    `Run TypeScript against a registered API. A typed "client" is already in scope, with auth ` +
    `injected automatically. The client's shape depends on the API's kind (shown by list_apis; ` +
    `search's method also signals it):\n`;
  const order: ApiKind[] = ["openapi", "graphql", "soap"];
  const bullets = order
    .filter((k) => kinds.size === 0 || kinds.has(k))
    .map((k) => EXEC_SHAPE_BULLETS[k])
    .join("");
  const tail =
    `console.log anything you want back. Chain multiple calls in one execution: intermediate results ` +
    `stay in the sandbox instead of round-tripping through you. Set check:false to skip type-checking ` +
    `for one run (use when a stale spec enum rejects a value the live API accepts; you lose type ` +
    `feedback that run). Set timeoutMs to raise the 30s default (max 120000) for long or paginated ` +
    `runs. Input: { api: <registered id>, code: <typescript>, check?: boolean, timeoutMs?: number }.`;
  return head + bullets + tail;
}

const AUTHENTICATE_DESCRIPTION =
  "Start the OAuth browser login for a registered OAuth API: opens the user's browser to the " +
  "provider's consent page, captures the redirect locally, and stores the resulting tokens (which " +
  "then auto-refresh). Call this when execute reports that an API needs authentication, or to " +
  "recover after a session could not be refreshed. Requires that the user has already set up the " +
  "OAuth app credentials once via `anyapi-mcp login` - this tool never accepts secrets. The call " +
  "blocks until the user finishes in the browser (or it times out). Input: { api: <registered id> }.";

const CONFIGURE_OAUTH_DESCRIPTION =
  "Adjust the safe OAuth request parameters for a registered OAuth API to fix provider quirks you " +
  "discover (e.g. a provider that wants comma-separated scopes, a narrower scope set, or an extra " +
  "authorize-URL param like access_type=offline). Settable: `scopes` (full replacement set), " +
  "`scopeSeparator`, and `extraAuthParams` (merged into the existing map; a key with an empty-string " +
  "value removes it). For security this tool does NOT change the authorize/token endpoints - those " +
  "carry the client secret and are CLI-only (`anyapi-mcp login --auth-url/--token-url`). Call with " +
  "only { api } to read the current config. After changing scopes, call `authenticate` to mint a " +
  "token with the new scopes. Input: { api, scopes?, scopeSeparator?, extraAuthParams? }.";

const ADD_API_DESCRIPTION =
  "Register a new API so search/execute can use it. Pass an OpenAPI spec URL (kind " +
  '"openapi", the default), a GraphQL endpoint URL (kind "graphql", introspected), or a WSDL ' +
  'URL (kind "soap"). Generates a typed client and makes the API available immediately (no ' +
  "restart). Use this for public APIs. For an API that requires a secret token, do NOT pass the " +
  "token here - tell the user to run `anyapi-mcp add <url> --token [--kind …]` in a " +
  "shell, which stores it in the OS keychain. If the spec's server can't be derived (it lands on a " +
  "raw-file host like raw.githubusercontent.com), registration fails loudly - pass baseUrl with the " +
  "real API base. If an id already exists, pass force:true to overwrite it in place (e.g. to fix a " +
  "wrong baseUrl); an OAuth API stays logged in across the overwrite. " +
  "Input: { specUrl, kind?, id?, name?, baseUrl?, docsUrl?, force? }.";

const LIST_APIS_DESCRIPTION =
  "List the registered APIs as JSON - each with id, name, kind (openapi/graphql/soap), baseUrl, " +
  "operation count, a short description (when the spec provides one), auth status (including OAuth " +
  "login/expiry), and docsUrl. Use it to see what's available and what each API is for, or to confirm " +
  "an add_api/remove_api took effect. Pass an `api` id to get just that one API plus its capability " +
  "map - the operation tags with per-tag counts - so you can see an API's areas before searching " +
  "within one. The kind determines the execute client shape.";

const REMOVE_API_DESCRIPTION =
  "Unregister an API by id: removes its registry entry, deletes any stored secrets (bearer token, " +
  "or OAuth client credentials + tokens) from the OS keychain, and cleans up its cached client types " +
  "and operation index. Use it to clear a mistaken or stale registration (or pass force:true to " +
  "add_api to overwrite one in place instead). Input: { api: <registered id> }.";

/** How-to-register guidance, surfaced when the registry is empty. */
function howToAdd(): string {
  return [
    "Register one with the add_api tool, e.g.:",
    `  add_api({"specUrl":"https://petstore3.swagger.io/api/v3/openapi.json"})`,
    "The API is usable immediately via search + execute (no restart).",
    "For an API that needs a secret token, don't pass it to add_api - run this in a shell so the",
    "token goes to your OS keychain instead of this conversation:",
    "  anyapi-mcp add <openapi-spec-url> --token",
  ].join("\n");
}

function buildInstructions(entries: RegistryEntry[]): string {
  const intro =
    "anyapi-mcp turns HTTP APIs (OpenAPI, GraphQL, SOAP) into code you run. `search` finds " +
    "operations; `execute` runs TypeScript against a typed `client` (chain several calls in one " +
    "execute - intermediate data stays in the sandbox, saving round-trips). `list_apis` shows what's " +
    "registered; `add_api` registers more (force:true overwrites a wrong one) and `remove_api` " +
    "deletes one. To see what an API can do, call `list_apis` with its `api` id for a description " +
    "and its capability areas (operation tags), then `search` within one.";
  const oauthNote =
    "\n\nSome APIs use OAuth 2.0. If execute reports that one needs authentication, call the " +
    "`authenticate` tool with its id to open a browser login for the user (or tell the user to run " +
    "`anyapi-mcp login <id>`). Tokens then refresh automatically. If a login fails because of a " +
    "provider quirk (wrong scopes, scope separator, or a missing authorize param), use " +
    "`configure_oauth` to correct the safe request params, then authenticate again.";
  if (entries.length === 0) {
    return `${intro}\n\nNo APIs are registered yet.\n${howToAdd()}`;
  }
  const ids = entries
    .map((e) =>
      `${e.id} (${e.name})${e.auth.kind === "oauth2" ? " [OAuth]" : ""}`
    )
    .join(", ");
  const hasOAuth = entries.some((e) => e.auth.kind === "oauth2");
  return `${intro}${hasOAuth ? oauthNote : ""}\n\nRegistered APIs: ${ids}.\n` +
    `Register more anytime with add_api or \`anyapi-mcp add\`.`;
}

// ---- registry state (hot-reloaded each call) ----

interface ServeState {
  entries: RegistryEntry[];
  opsById: Map<string, OperationInfo[]>;
}

// Parsed operation indexes, cached by `${id}@${addedAt}` so a re-added API
// (new addedAt) reloads while unchanged ones stay cached.
const opsCache = new Map<string, OperationInfo[]>();

async function loadState(): Promise<ServeState> {
  const entries = await readRegistry();
  const opsById = new Map<string, OperationInfo[]>();
  for (const entry of entries) {
    const key = `${entry.id}@${entry.addedAt}`;
    let ops = opsCache.get(key);
    if (!ops) {
      const loaded = await readOpsIndex(entry.id);
      if (loaded) {
        ops = loaded;
        opsCache.set(key, ops);
      }
    }
    if (ops) opsById.set(entry.id, ops);
  }
  return { entries, opsById };
}

// ---- search ----

interface SearchMatch {
  api: string;
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  params: OperationInfo["params"];
  requestBodyHint?: string;
  returns?: string;
}

/** Split on case boundaries and non-alphanumerics: "findPetsByStatus" -> [find,pets,by,status]. */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Per-field, per-token match strength: exact word > prefix > substring. */
function fieldScore(words: string[], text: string, token: string): number {
  let best = 0;
  for (const w of words) {
    if (w === token) return 1;
    if (token.length >= 3 && (w.startsWith(token) || token.startsWith(w))) {
      best = Math.max(best, 0.7);
    }
  }
  if (best === 0 && token.length >= 3 && text.includes(token)) best = 0.4;
  return best;
}

/**
 * Highest vN(.M) version among tokens (e.g. ["v2","users"] -> 2, ["v1","beta"] -> 1),
 * else 0. Used only as a ranking tiebreaker so newer API versions surface first.
 */
function versionRank(tokens: string[]): number {
  let best = 0;
  for (const t of tokens) {
    const m = /^v(\d+)(?:[._](\d+))?$/.exec(t);
    if (m) {
      best = Math.max(best, Number(m[1]) + (m[2] ? Number(m[2]) / 1000 : 0));
    }
  }
  return best;
}

function scoreOp(op: OperationInfo, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  // Word-aware so "repositories" matches "repos" (prefix) and "status" matches
  // "findByStatus" (camelCase split) - keyword search, no embeddings.
  const fields: { words: string[]; text: string; weight: number }[] = [
    {
      words: tokenize(op.operationId),
      text: op.operationId.toLowerCase(),
      weight: 5,
    },
    { words: tokenize(op.path), text: op.path.toLowerCase(), weight: 4 },
    {
      words: op.tags.flatMap(tokenize),
      text: op.tags.join(" ").toLowerCase(),
      weight: 3,
    },
    {
      words: tokenize(op.summary ?? ""),
      text: (op.summary ?? "").toLowerCase(),
      weight: 2,
    },
  ];
  let score = 0;
  for (const token of tokens) {
    for (const f of fields) {
      score += fieldScore(f.words, f.text, token) * f.weight;
    }
    if (op.method.toLowerCase() === token) score += 2;
  }
  return score;
}

function searchOperations(
  state: ServeState,
  query: string,
  apiFilter: string | undefined,
  limit: number | undefined,
): SearchMatch[] {
  const tokens = tokenize(query);
  const scored: { score: number; version: number; match: SearchMatch }[] = [];
  for (const entry of state.entries) {
    if (apiFilter && entry.id !== apiFilter) continue;
    const ops = state.opsById.get(entry.id);
    if (!ops) continue;
    // Version may live in the id (base-path-versioned APIs) or per-operation.
    const entryVersion = versionRank(tokenize(entry.id));
    for (const op of ops) {
      const score = scoreOp(op, tokens);
      if (score <= 0) continue;
      const version = Math.max(
        entryVersion,
        versionRank([...tokenize(op.path), ...tokenize(op.operationId)]),
      );
      const match: SearchMatch = {
        api: entry.id,
        method: op.method.toUpperCase(),
        path: op.path,
        operationId: op.operationId,
        params: op.params,
      };
      if (op.summary) match.summary = op.summary;
      if (op.requestBodyHint) match.requestBodyHint = op.requestBodyHint;
      if (op.returns) match.returns = op.returns;
      scored.push({ score, version, match });
    }
  }
  // Relevance first; for equal relevance (e.g. /v1/x vs /v2/x), prefer the newer
  // version. A query that names a version scores it higher, so it still wins.
  scored.sort((a, b) => (b.score - a.score) || (b.version - a.version));
  const cap = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  return scored.slice(0, cap).map((s) => s.match);
}

// ---- execute ----

function formatResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  return [
    `exit code: ${exitCode}`,
    `--- stdout ---\n${stdout.trimEnd()}`,
    `--- stderr ---\n${stderr.trimEnd()}`,
  ].join("\n");
}

async function executeRequest(
  entries: RegistryEntry[],
  api: string,
  code: string,
  opts: { check?: boolean; timeoutMs?: number } = {},
): Promise<{ text: string; isError: boolean }> {
  if (entries.length === 0) {
    return {
      text: `No APIs are registered yet.\n\n${howToAdd()}`,
      isError: true,
    };
  }

  const entry = entries.find((e) => e.id === api);
  if (!entry) {
    const known = entries.map((e) => e.id).join(", ");
    return {
      text: `Unknown api "${api}". Registered ids: ${known}`,
      isError: true,
    };
  }

  let token: string | undefined;
  if (entry.auth.kind === "bearer") {
    token = await getSecret(entry.auth.tokenKey);
    if (!token) {
      return {
        text: `No token stored for "${api}" (${entry.auth.tokenKey}). ` +
          `Re-register with: anyapi-mcp add ${entry.specSource} --id ${api} --token`,
        isError: true,
      };
    }
  } else if (entry.auth.kind === "oauth2") {
    // Refresh happens here in the parent (full network + keystore); the sandbox
    // only ever receives the resulting access token.
    try {
      token = await ensureAccessToken(entry, entry.auth);
    } catch (err) {
      if (err instanceof OAuthNeedsLoginError) {
        return { text: await oauthGuidance(entry, err.message), isError: true };
      }
      throw err;
    }
  }

  const source = getAdapter(entry.kind).buildHarness(entry, code);
  const { stdout, stderr, exitCode } = await runSandboxed(
    source,
    entry.hosts,
    token,
    { check: opts.check, timeoutMs: opts.timeoutMs },
  );
  const note = opts.check === false
    ? "note: type-checking was disabled for this run (check:false).\n"
    : "";
  return {
    text: note + formatResult(stdout, stderr, exitCode),
    isError: exitCode !== 0,
  };
}

// ---- oauth ----

/**
 * Guidance returned when an OAuth API needs (re-)authentication. Steers the agent
 * to the `authenticate` tool when credentials already exist (re-auth can run
 * without a human typing secrets), and to the CLI `login` otherwise.
 */
async function oauthGuidance(
  entry: RegistryEntry,
  reason: string,
): Promise<string> {
  if (entry.auth.kind !== "oauth2") return reason;
  const hasClient = (await loadClient(entry.auth)) !== undefined;
  if (hasClient) {
    return `${reason}\n\n` +
      `Credentials are already configured, so you can call the "authenticate" tool ` +
      `with { api: "${entry.id}" } to open a browser login for the user. ` +
      `Or the user can run \`anyapi-mcp login ${entry.id}\` in a shell.`;
  }
  return `${reason}\n\n` +
    `This API uses OAuth and no app credentials are set up yet. Ask the user to:\n` +
    `  1. create an OAuth app with the provider${
      entry.docsUrl ? ` (${entry.docsUrl})` : ""
    } and set its redirect URL to ${entry.auth.redirectUri}\n` +
    `  2. run \`anyapi-mcp login ${entry.id} --client-id <id> --client-secret <secret>\`\n` +
    `Secrets must go through that CLI, never this conversation. After that, ` +
    `execute will work and the token will auto-refresh.`;
}

async function authenticateRequest(
  entries: RegistryEntry[],
  api: string,
): Promise<{ text: string; isError: boolean }> {
  const entry = entries.find((e) => e.id === api);
  if (!entry) {
    const known = entries.map((e) => e.id).join(", ") || "(none)";
    return {
      text: `Unknown api "${api}". Registered ids: ${known}`,
      isError: true,
    };
  }
  if (entry.auth.kind !== "oauth2") {
    return {
      text:
        `"${api}" does not use OAuth (auth: ${entry.auth.kind}); nothing to authenticate.`,
      isError: true,
    };
  }
  const auth = entry.auth;
  const client = await loadClient(auth);
  if (!client) {
    return {
      text:
        `Can't start OAuth for "${api}": no client credentials are stored. ` +
        `The user must create an OAuth app and run ` +
        `\`anyapi-mcp login ${api} --client-id <id> --client-secret <secret>\` once ` +
        `(this tool never handles secrets).`,
      isError: true,
    };
  }
  try {
    // Logs go to stderr (never stdout) to preserve the MCP frame stream.
    const token = await runAuthorizationCodeFlow({
      authorizationUrl: auth.authorizationUrl,
      tokenUrl: auth.tokenUrl,
      client,
      scopes: auth.scopes,
      scopeSeparator: auth.scopeSeparator,
      redirectUri: auth.redirectUri,
      extraAuthParams: auth.extraAuthParams,
      onProgress: (m) => console.error(m),
    });
    await saveToken(auth, token);
    return {
      text: `Authenticated "${api}" (${describeExpiry(token)}). ` +
        `The access token is stored and will auto-refresh. You can now call execute.`,
      isError: false,
    };
  } catch (err) {
    return {
      text: `Authentication for "${api}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }
}

/** Read-only summary of an entry's OAuth config (endpoints shown but CLI-only). */
async function reportOAuthConfig(
  entry: RegistryEntry,
  auth: OAuth2Auth,
): Promise<string> {
  const tokenStored = (await loadToken(auth)) !== undefined;
  return [
    `OAuth config for "${entry.id}":`,
    `  scopes:          [${auth.scopes.join(", ")}]`,
    `  scopeSeparator:  ${JSON.stringify(auth.scopeSeparator)}`,
    `  extraAuthParams: ${JSON.stringify(auth.extraAuthParams ?? {})}`,
    `  redirectUri:     ${auth.redirectUri}`,
    `  authorizationUrl: ${auth.authorizationUrl}  (CLI-only)`,
    `  tokenUrl:         ${auth.tokenUrl}  (CLI-only)`,
    `  authenticated:   ${tokenStored ? "yes" : "no"}`,
    "",
    "Editable here: scopes, scopeSeparator, extraAuthParams. " +
    "Change endpoints with `anyapi-mcp login --auth-url/--token-url`.",
  ].join("\n");
}

interface ConfigureOAuthArgs {
  api: string;
  scopes?: string[];
  scopeSeparator?: string;
  extraAuthParams?: Record<string, string>;
}

async function configureOAuthRequest(
  entries: RegistryEntry[],
  args: ConfigureOAuthArgs,
): Promise<{ text: string; isError: boolean }> {
  const entry = entries.find((e) => e.id === args.api);
  if (!entry) {
    const known = entries.map((e) => e.id).join(", ") || "(none)";
    return {
      text: `Unknown api "${args.api}". Registered ids: ${known}`,
      isError: true,
    };
  }
  if (entry.auth.kind !== "oauth2") {
    return {
      text:
        `"${args.api}" does not use OAuth (auth: ${entry.auth.kind}); nothing to configure.`,
      isError: true,
    };
  }
  const auth = entry.auth;

  const changes: string[] = [];

  if (args.extraAuthParams !== undefined) {
    // Normalize keys (trim) and match reserved names case-insensitively so a
    // stray "Redirect_Uri" or " state" can't bypass the guard.
    const reserved = Object.keys(args.extraAuthParams).filter((k) =>
      RESERVED_AUTHORIZE_PARAMS.has(k.trim().toLowerCase())
    );
    if (reserved.length) {
      return {
        text:
          `Refusing to set reserved authorize params: ${
            reserved.join(", ")
          }. ` +
          `These are managed by anyapi-mcp; the authorize/token endpoints can only ` +
          `be changed via \`anyapi-mcp login --auth-url/--token-url\`.`,
        isError: true,
      };
    }
    // Merge into the existing map; an empty-string value removes a key.
    const next: Record<string, string> = { ...(auth.extraAuthParams ?? {}) };
    for (const [rawKey, v] of Object.entries(args.extraAuthParams)) {
      const key = rawKey.trim();
      if (!key) continue;
      if (v === "") delete next[key];
      else next[key] = v;
    }
    if (Object.keys(next).length) auth.extraAuthParams = next;
    else delete auth.extraAuthParams;
    changes.push(
      `extraAuthParams = ${JSON.stringify(auth.extraAuthParams ?? {})}`,
    );
  }

  if (args.scopeSeparator !== undefined) {
    auth.scopeSeparator = args.scopeSeparator;
    changes.push(`scopeSeparator = ${JSON.stringify(args.scopeSeparator)}`);
  }

  let scopesChanged = false;
  if (args.scopes !== undefined) {
    auth.scopes = args.scopes;
    scopesChanged = true;
    changes.push(`scopes = [${args.scopes.join(", ")}]`);
  }

  if (changes.length === 0) {
    return { text: await reportOAuthConfig(entry, auth), isError: false };
  }

  if (!(await updateEntry(entry))) {
    return {
      text:
        `Could not persist OAuth config for "${args.api}": it is no longer ` +
        `registered (it may have been removed concurrently). Re-check with the CLI.`,
      isError: true,
    };
  }
  const followUp = scopesChanged
    ? ` Scopes changed - call the authenticate tool for "${args.api}" to mint a token with the new scopes.`
    : ` Takes effect at the next login; call authenticate if a fresh consent is needed.`;
  return {
    text: `Updated OAuth config for "${args.api}":\n  ${
      changes.join("\n  ")
    }\n${followUp}`,
    isError: false,
  };
}

// ---- list / remove ----

/**
 * Tag -> operation-count map for an API's ops, busiest first (untagged ops
 * bucketed), capped to the `limit` biggest areas. Like the enum/description caps,
 * this keeps the capability view an overview rather than a second full index; the
 * dropped count is returned so truncation is never silent.
 */
function tagCounts(
  ops: OperationInfo[],
  limit: number,
): { tags: Record<string, number>; truncated: number } {
  const counts = new Map<string, number>();
  for (const op of ops) {
    const tags = op.tags.length ? op.tags : ["(untagged)"];
    for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const sorted = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return {
    tags: Object.fromEntries(sorted.slice(0, limit)),
    truncated: Math.max(0, sorted.length - limit),
  };
}

/**
 * JSON summary of registered APIs (id, name, description, kind, base, op count,
 * auth). With `apiFilter` set, returns just that API and adds its `capabilities`
 * map (operation tags -> counts) - the heavier territory view, paid only on a
 * drill-in so the unfiltered inventory stays lean.
 */
async function listApisResult(
  state: ServeState,
  apiFilter?: string,
): Promise<string> {
  const entries = apiFilter
    ? state.entries.filter((e) => e.id === apiFilter)
    : state.entries;
  if (apiFilter && entries.length === 0) {
    const known = state.entries.map((e) => e.id).join(", ") || "(none)";
    return `Unknown api "${apiFilter}". Registered ids: ${known}`;
  }
  const apis: Record<string, unknown>[] = [];
  for (const e of entries) {
    const ops = state.opsById.get(e.id);
    let auth: string = e.auth.kind;
    if (e.auth.kind === "oauth2") {
      const token = await loadToken(e.auth);
      auth = token
        ? `oauth2 (logged in, ${describeExpiry(token)})`
        : "oauth2 (not logged in)";
    }
    const api: Record<string, unknown> = {
      id: e.id,
      name: e.name,
      kind: e.kind,
      baseUrl: e.baseUrl,
      operations: ops ? ops.length : null,
      auth,
    };
    if (e.description) api.description = e.description;
    if (e.docsUrl) api.docsUrl = e.docsUrl;
    if (apiFilter && ops) {
      const { tags, truncated } = tagCounts(ops, MAX_CAPABILITY_TAGS);
      api.capabilities = tags;
      if (truncated > 0) {
        api.capabilitiesNote = `showing the ${MAX_CAPABILITY_TAGS} busiest of ${
          MAX_CAPABILITY_TAGS + truncated
        } capability areas; search to reach the rest`;
      }
    }
    apis.push(api);
  }
  return JSON.stringify(apis, null, 2);
}

async function removeApiRequest(
  entries: RegistryEntry[],
  api: string,
): Promise<{ text: string; isError: boolean }> {
  const { removed, secretsNote } = await unregisterApi(api);
  if (!removed) {
    const known = entries.map((e) => e.id).join(", ") || "(none)";
    return {
      text: `Unknown api "${api}"; nothing to remove. Registered ids: ${known}`,
      isError: true,
    };
  }
  return {
    text: `Removed "${api}"${secretsNote ? ` (${secretsNote})` : ""}. ` +
      `Its types and operation index are deleted; it no longer appears in search/execute.`,
    isError: false,
  };
}

// ---- server ----

export async function runServe(_args: string[]): Promise<void> {
  const startup = await loadState();
  console.error(
    `anyapi-mcp serve: ${startup.entries.length} API(s) registered` +
      (startup.entries.length
        ? `: ${startup.entries.map((e) => e.id).join(", ")}`
        : " (use the add_api tool or `anyapi-mcp add` to register one)"),
  );

  // After an anyapi-mcp upgrade the cached client code may predate the current
  // generators. Rebuild any entry whose codegenVersion is older before serving
  // (one source re-fetch per stale API). Resilient: a failure logs and keeps the
  // old, still-working code. All output stays on stderr - stdout is the MCP
  // frame stream. The bumped addedAt makes the tools reload the fresh ops index.
  const stale = startup.entries.filter(
    (e) => e.codegenVersion !== CODEGEN_VERSION,
  );
  if (stale.length > 0) {
    console.error(
      `anyapi-mcp serve: codegen version changed; regenerating ${stale.length} ` +
        `API(s) (${stale.map((e) => e.id).join(", ")}) ...`,
    );
    const results = await regenerateApis({
      ids: stale.map((e) => e.id),
      onProgress: (m) => console.error(m),
    });
    for (const r of results) {
      if (!r.ok) {
        console.error(
          `anyapi-mcp serve: regeneration failed for ${r.id}: ${r.error} ` +
            `(keeping existing code).`,
        );
      }
    }
    console.error(
      `anyapi-mcp serve: regenerated ${
        results.filter((r) => r.ok).length
      }/${stale.length} API(s).`,
    );
  }

  // Regeneration above never changes an entry's kind or the registered set, so
  // the kinds drive the execute description correctly here.
  const executeDescription = buildExecuteDescription(
    new Set<ApiKind>(startup.entries.map((e) => e.kind)),
  );

  const server = new McpServer(
    { name: "anyapi-mcp", version: "0.1.0" },
    { instructions: buildInstructions(startup.entries) },
  );

  const searchShape = {
    query: z.string(),
    api: z.string().optional(),
    limit: z.number().int().positive().optional(),
  };
  type SearchArgs = z.infer<z.ZodObject<typeof searchShape>>;
  server.registerTool(
    "search",
    {
      title: "Search API operations",
      description: SEARCH_DESCRIPTION,
      inputSchema: searchShape,
    },
    async ({ query, api, limit }: SearchArgs) => {
      const state = await loadState();
      if (state.entries.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text:
              `No APIs are registered yet, so there is nothing to search.\n\n${howToAdd()}`,
          }],
        };
      }
      const matches = searchOperations(state, query, api, limit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(matches),
        }],
      };
    },
  );

  const executeShape = {
    api: z.string().describe("Registered API id (see list_apis)"),
    code: z.string().describe(
      "TypeScript to run; a typed `client` is in scope",
    ),
    check: z.boolean().optional().describe(
      "Type-check before running (default true). Set false to bypass a stale spec " +
        "enum that rejects a value the live API accepts; you lose type feedback that run.",
    ),
    timeoutMs: z.number().optional().describe(
      "Max run time in ms (default 30000, clamped to 1000-120000); raise it for long or paginated runs.",
    ),
  };
  type ExecuteArgs = z.infer<z.ZodObject<typeof executeShape>>;
  server.registerTool(
    "execute",
    {
      title: "Execute TypeScript against an API",
      description: executeDescription,
      inputSchema: executeShape,
    },
    async ({ api, code, check, timeoutMs }: ExecuteArgs) => {
      const { entries } = await loadState();
      const { text, isError } = await executeRequest(entries, api, code, {
        check,
        timeoutMs,
      });
      return { content: [{ type: "text" as const, text }], isError };
    },
  );

  const authenticateShape = { api: z.string() };
  type AuthenticateArgs = z.infer<z.ZodObject<typeof authenticateShape>>;
  server.registerTool(
    "authenticate",
    {
      title: "Authenticate an OAuth API",
      description: AUTHENTICATE_DESCRIPTION,
      inputSchema: authenticateShape,
    },
    async ({ api }: AuthenticateArgs) => {
      const { entries } = await loadState();
      const { text, isError } = await authenticateRequest(entries, api);
      return { content: [{ type: "text" as const, text }], isError };
    },
  );

  const configureOAuthShape = {
    api: z.string().describe("Registered OAuth API id"),
    scopes: z.array(z.string()).optional().describe(
      "Full replacement set of scopes to request at the next login",
    ),
    scopeSeparator: z.string().optional().describe(
      'Scope separator in the authorize URL (" " for RFC 6749, "," for Strava)',
    ),
    extraAuthParams: z.record(z.string(), z.string()).optional().describe(
      "Extra authorize-URL params, merged in; an empty-string value removes a key. " +
        "Reserved params (client_id, redirect_uri, response_type, scope, state) are rejected.",
    ),
  };
  type ConfigureOAuthToolArgs = z.infer<
    z.ZodObject<typeof configureOAuthShape>
  >;
  server.registerTool(
    "configure_oauth",
    {
      title: "Configure OAuth request parameters",
      description: CONFIGURE_OAUTH_DESCRIPTION,
      inputSchema: configureOAuthShape,
    },
    async (args: ConfigureOAuthToolArgs) => {
      const { entries } = await loadState();
      const { text, isError } = await configureOAuthRequest(entries, args);
      return { content: [{ type: "text" as const, text }], isError };
    },
  );

  const addApiShape = {
    specUrl: z.string().describe(
      'OpenAPI spec URL (or path); a GraphQL endpoint URL for kind "graphql"; a WSDL URL for kind "soap"',
    ),
    kind: z.enum(["openapi", "graphql", "soap"]).optional().describe(
      'Protocol adapter: "openapi" (default), "graphql", or "soap"',
    ),
    id: z.string().optional().describe(
      "Id used by search/execute (default: the base URL in reverse-DNS form, e.g. com.github.api)",
    ),
    name: z.string().optional().describe(
      "Human-friendly name (default: spec title)",
    ),
    baseUrl: z.string().optional().describe(
      "Override the base URL derived from the spec's servers[]",
    ),
    docsUrl: z.string().optional().describe(
      "Documentation URL to store and surface",
    ),
    force: z.boolean().optional().describe(
      "Overwrite an existing API with the same id instead of failing (e.g. to fix a wrong baseUrl)",
    ),
  };
  type AddApiArgs = z.infer<z.ZodObject<typeof addApiShape>>;
  server.registerTool(
    "add_api",
    {
      title: "Register an API",
      description: ADD_API_DESCRIPTION,
      inputSchema: addApiShape,
    },
    async (
      { specUrl, kind, id, name, baseUrl, docsUrl, force }: AddApiArgs,
    ) => {
      try {
        const specSource = isUrl(specUrl) ? specUrl : resolve(specUrl);
        const { entry, operationCount, overwritten } = await registerApi({
          specSource,
          kind,
          id,
          name,
          baseUrl,
          docsUrl,
          force,
        });
        const kindFlag = entry.kind === "openapi"
          ? ""
          : ` --kind ${entry.kind}`;
        const head =
          `${
            overwritten ? "Re-registered" : "Registered"
          } "${entry.id}" (${entry.name}): ` +
          `${operationCount} operations, base ${entry.baseUrl}. ` +
          `Available now - call search with api "${entry.id}", then execute.`;
        const authHelp = entry.auth.kind === "oauth2"
          ? ` This API uses OAuth 2.0. The user must create an OAuth app (redirect ` +
            `URL ${entry.auth.redirectUri}) and run \`anyapi-mcp login ${entry.id} ` +
            `--client-id <id> --client-secret <secret>\` in a shell (secrets never go ` +
            `through this chat). After that, execute works and you can call the ` +
            `authenticate tool to re-login if a session expires.`
          : ` If requests come back 401/403 this API needs a token: run ` +
            `\`anyapi-mcp add ${specSource} --id ${entry.id} --token${kindFlag}\` in a shell so the token ` +
            `is stored in your OS keychain (never through this chat).`;
        return { content: [{ type: "text" as const, text: head + authHelp }] };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `add_api failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }],
          isError: true,
        };
      }
    },
  );

  const listApisShape = {
    api: z.string().optional().describe(
      "Registered API id; when set, returns just that API plus its capability map (operation tags)",
    ),
  };
  type ListApisArgs = z.infer<z.ZodObject<typeof listApisShape>>;
  server.registerTool(
    "list_apis",
    {
      title: "List registered APIs",
      description: LIST_APIS_DESCRIPTION,
      inputSchema: listApisShape,
    },
    async ({ api }: ListApisArgs) => {
      const state = await loadState();
      return {
        content: [{
          type: "text" as const,
          text: await listApisResult(state, api),
        }],
      };
    },
  );

  const removeApiShape = {
    api: z.string().describe("Registered API id to unregister"),
  };
  type RemoveApiArgs = z.infer<z.ZodObject<typeof removeApiShape>>;
  server.registerTool(
    "remove_api",
    {
      title: "Unregister an API",
      description: REMOVE_API_DESCRIPTION,
      inputSchema: removeApiShape,
    },
    async ({ api }: RemoveApiArgs) => {
      const { entries } = await loadState();
      const { text, isError } = await removeApiRequest(entries, api);
      return { content: [{ type: "text" as const, text }], isError };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("anyapi-mcp serve: ready on stdio.");
}
