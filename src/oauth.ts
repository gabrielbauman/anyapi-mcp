// OAuth 2.0 authorization-code support: the user-facing browser login flow, token
// storage in the OS keystore, and automatic refresh before each execute.
//
// Where this runs: the *parent* serve/CLI process owns everything here. It has
// full network and keystore access. The execute sandbox only ever receives a
// ready-to-use access token via ANYAPI_MCP_TOKEN; it never sees the client
// secret or refresh token and never talks to the token endpoint. Refresh
// therefore happens here, in the parent, just before the harness is built.
//
// Secrets boundary (mirrors the bearer one): the registry stores only keystore
// account names (clientKey, tokenKey). The client secret, access token, and
// refresh token live exclusively in the keystore, each as a JSON blob.

import { deleteSecret, getSecret, setSecret } from "./keystore.ts";
import type { OAuth2Auth, RegistryEntry } from "./registry.ts";

/** OAuth client credentials, stored as JSON under the keystore `clientKey`. */
export interface OAuthClient {
  clientId: string;
  /** Optional: public/PKCE clients have none (PKCE itself is out of scope for v1). */
  clientSecret?: string;
}

/** A token bundle, stored as JSON under the keystore `tokenKey`. */
export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Absent means the provider gave no expiry. */
  expiresAt?: number;
  tokenType: string;
  /** Space-separated scopes the provider actually granted. */
  scope?: string;
}

/** OAuth config discovered from an API source (before any login). */
export interface DiscoveredOAuth {
  authorizationUrl: string;
  tokenUrl: string;
  /** Scope names advertised by the source (informational + default request set). */
  scopes: string[];
}

/** Refresh when the access token is within this window of expiry. */
const EXPIRY_SKEW_MS = 60_000;

/** Default local callback the login flow listens on (override with --redirect-uri/--port). */
export const DEFAULT_REDIRECT_PORT = 9876;
export const DEFAULT_REDIRECT_PATH = "/callback";
export function defaultRedirectUri(
  port: number = DEFAULT_REDIRECT_PORT,
): string {
  return `http://localhost:${port}${DEFAULT_REDIRECT_PATH}`;
}

/**
 * Thrown when an OAuth API can't be used until the user (re-)authenticates. The
 * serve layer turns this into guidance for both the agent and the user rather
 * than a hard failure.
 */
export class OAuthNeedsLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthNeedsLoginError";
  }
}

// ---- provider quirks ----

interface ProviderQuirk {
  authorizationUrl?: string;
  tokenUrl?: string;
  scopeSeparator?: string;
}

/**
 * Real-world OAuth quirks keyed by the authorize-endpoint host. Specs are
 * sometimes wrong or non-standard, so these defaults make well-known providers
 * work with zero extra flags; explicit --auth-url/--token-url/--scope-separator
 * on `add`/`login` override them. Strava's spec lists /api/v3/oauth/* but the
 * live endpoints are /oauth/*, and Strava wants comma-separated scopes, not the
 * RFC 6749 space.
 */
const PROVIDER_QUIRKS: Record<string, ProviderQuirk> = {
  "www.strava.com": {
    authorizationUrl: "https://www.strava.com/oauth/authorize",
    tokenUrl: "https://www.strava.com/oauth/token",
    scopeSeparator: ",",
  },
};

/** Quirks for the host of `authorizationUrl`, or undefined if none are known. */
export function quirkForAuthUrl(
  authorizationUrl: string,
): ProviderQuirk | undefined {
  try {
    return PROVIDER_QUIRKS[new URL(authorizationUrl).host.toLowerCase()];
  } catch {
    return undefined;
  }
}

// ---- keystore (JSON blobs) ----

async function loadJson<T>(account: string): Promise<T | undefined> {
  const raw = await getSecret(account);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function loadClient(auth: OAuth2Auth): Promise<OAuthClient | undefined> {
  return loadJson<OAuthClient>(auth.clientKey);
}
export async function saveClient(
  auth: OAuth2Auth,
  client: OAuthClient,
): Promise<void> {
  await setSecret(auth.clientKey, JSON.stringify(client));
}
export function loadToken(auth: OAuth2Auth): Promise<OAuthToken | undefined> {
  return loadJson<OAuthToken>(auth.tokenKey);
}
export async function saveToken(
  auth: OAuth2Auth,
  token: OAuthToken,
): Promise<void> {
  await setSecret(auth.tokenKey, JSON.stringify(token));
}
/** Delete the token (always) and, if `forgetClient`, the client credentials too. */
export async function clearOAuthSecrets(
  auth: OAuth2Auth,
  opts: { forgetClient?: boolean } = {},
): Promise<{ token: boolean; client: boolean }> {
  const token = await deleteSecret(auth.tokenKey);
  const client = opts.forgetClient ? await deleteSecret(auth.clientKey) : false;
  return { token, client };
}

// ---- token endpoint ----

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  /** Seconds from now (RFC 6749). Some providers send it as a string. */
  expires_in?: number | string;
  /** Epoch seconds (used by e.g. Strava). May also arrive as a string. */
  expires_at?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Coerce a JSON number-or-numeric-string to a finite number, else undefined. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function postToken(
  tokenUrl: string,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(
      `token endpoint returned non-JSON (HTTP ${res.status}): ${
        text.slice(0, 200)
      }`,
    );
  }
  if (!res.ok && !json.access_token) {
    const detail = json.error
      ? `${json.error}${
        json.error_description ? `: ${json.error_description}` : ""
      }`
      : text.slice(0, 200);
    throw new Error(`token request failed (HTTP ${res.status}): ${detail}`);
  }
  return json;
}

/** Turn a raw token response into an OAuthToken, carrying values forward from `prev`. */
function parseTokenResponse(
  json: TokenResponse,
  prev?: OAuthToken,
): OAuthToken {
  if (!json.access_token) {
    throw new Error(
      json.error
        ? `${json.error}${
          json.error_description ? `: ${json.error_description}` : ""
        }`
        : "token endpoint returned no access_token",
    );
  }
  const now = Date.now();
  const expiresIn = asNumber(json.expires_in);
  const expiresAtSec = asNumber(json.expires_at);
  let expiresAt: number | undefined;
  if (expiresIn !== undefined) {
    expiresAt = now + expiresIn * 1000;
  } else if (expiresAtSec !== undefined) {
    expiresAt = expiresAtSec * 1000;
  }

  const token: OAuthToken = {
    accessToken: json.access_token,
    tokenType: json.token_type ?? prev?.tokenType ?? "Bearer",
  };
  // Refresh tokens rotate on some providers (Strava); keep the prior one if the
  // response omits a new one.
  const refresh = json.refresh_token ?? prev?.refreshToken;
  if (refresh) token.refreshToken = refresh;
  if (expiresAt !== undefined) token.expiresAt = expiresAt;
  const scope = json.scope ?? prev?.scope;
  if (scope) token.scope = scope;
  return token;
}

function exchangeAuthCode(opts: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  client: OAuthClient;
}): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.client.clientId,
  };
  if (opts.client.clientSecret) params.client_secret = opts.client.clientSecret;
  return postToken(opts.tokenUrl, params);
}

/** Exchange a refresh token for a fresh access token (used by ensureAccessToken). */
async function refreshAccessToken(
  auth: OAuth2Auth,
  token: OAuthToken,
  client: OAuthClient,
): Promise<OAuthToken> {
  if (!token.refreshToken) throw new Error("no refresh token stored");
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: client.clientId,
  };
  if (client.clientSecret) params.client_secret = client.clientSecret;
  const json = await postToken(auth.tokenUrl, params);
  return parseTokenResponse(json, token);
}

/**
 * Return a usable access token for an OAuth API, refreshing first if it is
 * expired (or within the skew window). Throws OAuthNeedsLoginError when the user
 * must (re-)authenticate. Persists a refreshed token back to the keystore.
 */
export async function ensureAccessToken(
  entry: RegistryEntry,
  auth: OAuth2Auth,
): Promise<string> {
  const token = await loadToken(auth);
  if (!token) {
    throw new OAuthNeedsLoginError(
      `"${entry.id}" uses OAuth and isn't authenticated yet.`,
    );
  }
  const expired = token.expiresAt !== undefined &&
    Date.now() >= token.expiresAt - EXPIRY_SKEW_MS;
  if (!expired) return token.accessToken;

  if (!token.refreshToken) {
    throw new OAuthNeedsLoginError(
      `"${entry.id}"'s access token expired and there is no refresh token; log in again.`,
    );
  }
  const client = await loadClient(auth);
  if (!client) {
    throw new OAuthNeedsLoginError(
      `"${entry.id}"'s access token expired and no client credentials are stored to refresh it; log in again.`,
    );
  }
  try {
    const refreshed = await refreshAccessToken(auth, token, client);
    await saveToken(auth, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    throw new OAuthNeedsLoginError(
      `"${entry.id}"'s session could not be refreshed (${
        err instanceof Error ? err.message : String(err)
      }); the refresh token may be revoked - log in again.`,
    );
  }
}

// ---- authorization-code browser flow ----

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Authorize-URL params anyapi-mcp owns and that `extraAuthParams` must never set.
 * `redirect_uri`/`client_id` in particular steer where the auth code goes, so an
 * agent-supplied override here would be a redirect/exfil vector - hence both
 * buildAuthorizeUrl (which sets these last) and configure_oauth reject them.
 */
export const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
]);

/** Build the provider authorize URL the browser is sent to. */
export function buildAuthorizeUrl(opts: {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  scopeSeparator: string;
  state: string;
  extraParams?: Record<string, string>;
}): string {
  const u = new URL(opts.authorizationUrl);
  // Apply extras first, skipping reserved keys, so the canonical params below
  // always win even if something slipped a reserved key through. Keys are
  // trimmed and matched case-insensitively so a stray "Redirect_Uri" or " state"
  // can't sneak past the reserved-key guard.
  for (const [rawKey, v] of Object.entries(opts.extraParams ?? {})) {
    const key = rawKey.trim();
    if (key && !RESERVED_AUTHORIZE_PARAMS.has(key.toLowerCase())) {
      u.searchParams.set(key, v);
    }
  }
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  if (opts.scopes.length) {
    u.searchParams.set("scope", opts.scopes.join(opts.scopeSeparator));
  }
  u.searchParams.set("state", opts.state);
  return u.toString();
}

/** Best-effort open the system browser. Returns false if no opener is available. */
function openInBrowser(url: string): boolean {
  const os = Deno.build.os;
  const cmd = os === "darwin" ? "open" : os === "windows" ? "cmd" : "xdg-open";
  const args = os === "windows" ? ["/c", "start", "", url] : [url];
  try {
    new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).spawn();
    return true;
  } catch {
    return false;
  }
}

function pageResponse(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;text-align:center">` +
      `<h1>${title}</h1><p>${body}</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export interface LoginFlowOptions {
  authorizationUrl: string;
  tokenUrl: string;
  client: OAuthClient;
  scopes: string[];
  scopeSeparator: string;
  redirectUri: string;
  extraAuthParams?: Record<string, string>;
  /** Open the browser automatically (default true). When false, only print the URL. */
  openBrowser?: boolean;
  /** How long to wait for the redirect before giving up (default 180s). */
  timeoutMs?: number;
  /** Progress sink (stderr in the CLI and in serve - never stdout). */
  onProgress?: (message: string) => void;
}

/**
 * Run the full authorization-code flow: start a one-shot local callback server,
 * open the browser to the consent page, capture the redirect, and exchange the
 * code for tokens. Returns the token bundle (the caller persists it).
 */
export async function runAuthorizationCodeFlow(
  opts: LoginFlowOptions,
): Promise<OAuthToken> {
  const log = opts.onProgress ?? (() => {});

  let redirect: URL;
  try {
    redirect = new URL(opts.redirectUri);
  } catch {
    throw new Error(`redirect URI "${opts.redirectUri}" is not a valid URL.`);
  }
  const port = Number(redirect.port);
  if (!port) {
    throw new Error(
      `redirect URI must include an explicit port (got "${opts.redirectUri}").`,
    );
  }
  const expectedPath = redirect.pathname;
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl({
    authorizationUrl: opts.authorizationUrl,
    clientId: opts.client.clientId,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes,
    scopeSeparator: opts.scopeSeparator,
    state,
    extraParams: opts.extraAuthParams,
  });

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  let server: Deno.HttpServer;
  try {
    server = Deno.serve({
      port,
      hostname: redirect.hostname,
      onListen: () => {}, // suppress the default "Listening on ..." line
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== expectedPath) {
        return new Response("Not found", { status: 404 });
      }
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description");
        rejectCode(
          new Error(
            `authorization denied: ${error}${desc ? ` (${desc})` : ""}`,
          ),
        );
        return pageResponse(
          "Authorization failed",
          "You can close this tab and return to the terminal.",
        );
      }
      const code = url.searchParams.get("code");
      if (!code) {
        return pageResponse("Waiting", "No authorization code was present.");
      }
      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("state mismatch (possible CSRF); aborting."));
        return pageResponse(
          "Authorization failed",
          "State mismatch. You can close this tab.",
        );
      }
      resolveCode(code);
      return pageResponse(
        "Authorized ✓",
        "anyapi-mcp captured the authorization. You can close this tab.",
      );
    });
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `port ${port} is already in use; free it or pass --port/--redirect-uri.`,
      );
    }
    throw err;
  }

  log(`Listening for the OAuth redirect on ${opts.redirectUri}`);
  if (opts.openBrowser !== false) {
    log("Opening your browser to authorize ...");
    if (!openInBrowser(authorizeUrl)) {
      log("Couldn't open a browser automatically.");
    }
  }
  log(
    `If the browser didn't open, visit this URL to authorize:\n  ${authorizeUrl}`,
  );

  const timeoutMs = opts.timeoutMs ?? 180_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () =>
        rej(
          new Error(
            `timed out after ${
              Math.round(timeoutMs / 1000)
            }s waiting for authorization.`,
          ),
        ),
      timeoutMs,
    );
  });

  let code: string;
  try {
    code = await Promise.race([codePromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Let the browser receive the response page before tearing the server down.
    await new Promise((r) => setTimeout(r, 250));
    try {
      await server.shutdown();
    } catch {
      // already stopping
    }
  }

  log("Exchanging authorization code for tokens ...");
  const json = await exchangeAuthCode({
    tokenUrl: opts.tokenUrl,
    code,
    redirectUri: opts.redirectUri,
    client: opts.client,
  });
  return parseTokenResponse(json);
}

/** Human-readable expiry, e.g. "expires in 5h 59m" / "expired" / "no expiry". */
export function describeExpiry(token: OAuthToken): string {
  if (token.expiresAt === undefined) return "no expiry reported";
  const ms = token.expiresAt - Date.now();
  if (ms <= 0) return "expired (will refresh on next use)";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `expires in ${h}h${m ? ` ${m}m` : ""}`;
}
