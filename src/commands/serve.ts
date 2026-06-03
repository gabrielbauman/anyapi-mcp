// `anyapi-mcp serve` - stdio MCP server exposing `search`, `execute`,
// `authenticate`, `configure_oauth`, and `add_api`.
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
  type OAuth2Auth,
  readRegistry,
  type RegistryEntry,
  updateEntry,
} from "../registry.ts";
import { isUrl } from "../openapi.ts";
import { type OperationInfo, readOpsIndex } from "../operation.ts";
import { getSecret } from "../keystore.ts";
import { registerApi } from "../register.ts";
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

const MAX_RESULTS = 25;

const SEARCH_DESCRIPTION =
  `Search registered API operations by keyword. Returns compact matches - ` +
  `{ api, method, path, operationId, summary, params, requestBodyHint } - so you ` +
  `can learn which path + method to call and roughly what arguments it takes. ` +
  `Feed what you learn into the "execute" tool. When an endpoint exists in several ` +
  `versions, the newest (e.g. v2 over v1) is ranked first unless your query names a ` +
  `version. Optionally pass "api" to restrict the search to one registered API id.`;

const EXECUTE_DESCRIPTION =
  `Run TypeScript against a registered API. A typed openapi-fetch client named ` +
  `"client" is already in scope, with auth injected automatically. Call it like ` +
  '`const { data, error } = await client.GET("/pet/{petId}", { params: { path: { petId: 1 } } });` ' +
  "- methods are GET/POST/PUT/PATCH/DELETE, options are { params: { path, query }, body }, " +
  `and each returns { data, error, response }. ` +
  "`response.status` is always available; on success `data` is set, on an HTTP error " +
  "`error` is set (no throw) - narrow on `data` for success. console.log anything you want back. " +
  `Chain multiple calls in one execution: intermediate results stay in the sandbox ` +
  `instead of round-tripping through you. Input: { api: <registered id>, code: <typescript> }.`;

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
  "shell, which stores it in the OS keychain. Input: { specUrl, kind?, id?, name?, baseUrl?, docsUrl? }.";

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
    "anyapi-mcp turns OpenAPI HTTP APIs into code you run. `search` finds operations; `execute` runs " +
    "TypeScript against a typed openapi-fetch `client` (chain several calls in one execute - " +
    "intermediate data stays in the sandbox, saving round-trips). `add_api` registers new APIs.";
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
  return scored.slice(0, MAX_RESULTS).map((s) => s.match);
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
  );
  return {
    text: formatResult(stdout, stderr, exitCode),
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
    const reserved = Object.keys(args.extraAuthParams).filter((k) =>
      RESERVED_AUTHORIZE_PARAMS.has(k)
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
    for (const [k, v] of Object.entries(args.extraAuthParams)) {
      if (v === "") delete next[k];
      else next[k] = v;
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

  await updateEntry(entry);
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

// ---- server ----

export async function runServe(_args: string[]): Promise<void> {
  const startup = await loadState();
  console.error(
    `anyapi-mcp serve: ${startup.entries.length} API(s) registered` +
      (startup.entries.length
        ? `: ${startup.entries.map((e) => e.id).join(", ")}`
        : " (use the add_api tool or `anyapi-mcp add` to register one)"),
  );

  const server = new McpServer(
    { name: "anyapi-mcp", version: "0.1.0" },
    { instructions: buildInstructions(startup.entries) },
  );

  const searchShape = { query: z.string(), api: z.string().optional() };
  type SearchArgs = z.infer<z.ZodObject<typeof searchShape>>;
  server.registerTool(
    "search",
    {
      title: "Search API operations",
      description: SEARCH_DESCRIPTION,
      inputSchema: searchShape,
    },
    async ({ query, api }: SearchArgs) => {
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
      const matches = searchOperations(state, query, api);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(matches, null, 2),
        }],
      };
    },
  );

  const executeShape = { api: z.string(), code: z.string() };
  type ExecuteArgs = z.infer<z.ZodObject<typeof executeShape>>;
  server.registerTool(
    "execute",
    {
      title: "Execute TypeScript against an API",
      description: EXECUTE_DESCRIPTION,
      inputSchema: executeShape,
    },
    async ({ api, code }: ExecuteArgs) => {
      const { entries } = await loadState();
      const { text, isError } = await executeRequest(entries, api, code);
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
  };
  type AddApiArgs = z.infer<z.ZodObject<typeof addApiShape>>;
  server.registerTool(
    "add_api",
    {
      title: "Register an API",
      description: ADD_API_DESCRIPTION,
      inputSchema: addApiShape,
    },
    async ({ specUrl, kind, id, name, baseUrl, docsUrl }: AddApiArgs) => {
      try {
        const specSource = isUrl(specUrl) ? specUrl : resolve(specUrl);
        const { entry, operationCount } = await registerApi({
          specSource,
          kind,
          id,
          name,
          baseUrl,
          docsUrl,
        });
        const kindFlag = entry.kind === "openapi"
          ? ""
          : ` --kind ${entry.kind}`;
        const head =
          `Registered "${entry.id}" (${entry.name}): ${operationCount} operations, ` +
          `base ${entry.baseUrl}. Available now - call search with api "${entry.id}", then execute.`;
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("anyapi-mcp serve: ready on stdio.");
}
