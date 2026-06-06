// AT Protocol app-password session auth. Like the OAuth module, everything here
// runs in the *parent* serve/CLI process (full network + keystore). The execute
// sandbox only ever receives a short-lived access JWT via ANYAPI_MCP_TOKEN; the
// app password and the refresh JWT never enter it.
//
// A session is minted with com.atproto.server.createSession (identifier + app
// password) and kept fresh with com.atproto.server.refreshSession. Because the
// app password is stored in the keystore, a dead session re-mints with no browser
// and no human - so this "self-heals" where OAuth would need a fresh login.
//
// Secrets boundary (mirrors the bearer/OAuth ones): the registry stores only
// keystore account names (passwordKey, sessionKey). The app password and the
// session bundle live exclusively in the keystore.

import { deleteSecret, getSecret, setSecret } from "./keystore.ts";
import type { AtprotoAuth, RegistryEntry } from "./registry.ts";

/** A session bundle, stored as JSON under the keystore `sessionKey`. */
export interface AtprotoSession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

/** Refresh when the access JWT is within this window of its (decoded) expiry. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Thrown when an atproto API can't be used until the user (re-)authenticates
 * (no app password stored, or the stored one no longer works). The serve layer
 * turns this into guidance rather than a hard failure.
 */
export class AtprotoNeedsLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtprotoNeedsLoginError";
  }
}

// ---- keystore ----

export function loadAppPassword(
  auth: AtprotoAuth,
): Promise<string | undefined> {
  return getSecret(auth.passwordKey);
}
export async function saveAppPassword(
  auth: AtprotoAuth,
  password: string,
): Promise<void> {
  await setSecret(auth.passwordKey, password);
}
async function loadSession(
  auth: AtprotoAuth,
): Promise<AtprotoSession | undefined> {
  const raw = await getSecret(auth.sessionKey);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AtprotoSession;
  } catch {
    return undefined;
  }
}
async function saveSession(
  auth: AtprotoAuth,
  session: AtprotoSession,
): Promise<void> {
  await setSecret(auth.sessionKey, JSON.stringify(session));
}
/** Delete the session (always) and, if `forgetPassword`, the app password too. */
export async function clearAtprotoSecrets(
  auth: AtprotoAuth,
  opts: { forgetPassword?: boolean } = {},
): Promise<{ session: boolean; password: boolean }> {
  const session = await deleteSecret(auth.sessionKey);
  const password = opts.forgetPassword
    ? await deleteSecret(auth.passwordKey)
    : false;
  return { session, password };
}

// ---- session endpoints (com.atproto.server.*) ----

function xrpcUrl(baseUrl: string, nsid: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/xrpc/${nsid}`;
}

interface SessionResponse {
  accessJwt?: string;
  refreshJwt?: string;
  did?: string;
  handle?: string;
  error?: string;
  message?: string;
}

function parseSession(json: SessionResponse): AtprotoSession {
  if (!json.accessJwt || !json.refreshJwt) {
    throw new Error(
      json.error
        ? `${json.error}${json.message ? `: ${json.message}` : ""}`
        : "session response missing accessJwt/refreshJwt",
    );
  }
  return {
    accessJwt: json.accessJwt,
    refreshJwt: json.refreshJwt,
    did: json.did ?? "",
    handle: json.handle ?? "",
  };
}

async function postSession(
  url: string,
  init: { body?: string; bearer?: string },
): Promise<AtprotoSession> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.bearer) headers["authorization"] = `Bearer ${init.bearer}`;
  const res = await fetch(url, { method: "POST", headers, body: init.body });
  const text = await res.text();
  let json: SessionResponse;
  try {
    json = JSON.parse(text) as SessionResponse;
  } catch {
    throw new Error(
      `atproto session endpoint returned non-JSON (HTTP ${res.status}): ${
        text.slice(0, 200)
      }`,
    );
  }
  if (!res.ok && !json.accessJwt) {
    throw new Error(
      json.error
        ? `${json.error}${json.message ? `: ${json.message}` : ""}`
        : `HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return parseSession(json);
}

/** Mint a fresh session from an app password (com.atproto.server.createSession). */
export function createSession(
  baseUrl: string,
  identifier: string,
  password: string,
): Promise<AtprotoSession> {
  return postSession(xrpcUrl(baseUrl, "com.atproto.server.createSession"), {
    body: JSON.stringify({ identifier, password }),
  });
}

/** Exchange the refresh JWT for a fresh session (com.atproto.server.refreshSession). */
function refreshSession(
  baseUrl: string,
  refreshJwt: string,
): Promise<AtprotoSession> {
  return postSession(xrpcUrl(baseUrl, "com.atproto.server.refreshSession"), {
    bearer: refreshJwt,
  });
}

/**
 * Mint a session from an app password and persist both (used by `anyapi-mcp
 * login`). createSession runs first, so a wrong password throws before anything
 * is stored. Returns the new session (the caller reports who it's for).
 */
export async function loginWithAppPassword(
  auth: AtprotoAuth,
  baseUrl: string,
  identifier: string,
  password: string,
): Promise<AtprotoSession> {
  const session = await createSession(baseUrl, identifier, password);
  await saveAppPassword(auth, password);
  await saveSession(auth, session);
  return session;
}

/** Decode a JWT's `exp` claim to epoch ms, or undefined if absent/unparseable. */
function jwtExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function nearExpiry(jwt: string): boolean {
  const exp = jwtExpiryMs(jwt);
  if (exp === undefined) return false; // can't tell; assume usable
  return Date.now() >= exp - EXPIRY_SKEW_MS;
}

/**
 * Return a usable access JWT, or `undefined` to run anonymously. Escalates only
 * as far as needed:
 *   0. no identifier configured => anonymous; return undefined (public reads);
 *   1. a cached, unexpired access JWT is used as-is;
 *   2. else refreshSession (using the refresh JWT);
 *   3. else createSession (using the stored app password) - the self-heal path.
 * An empty identifier means the user never set up credentials (both `login` and
 * `add --app-password` require one), so it's anonymous by intent rather than a
 * dropped session. When an identifier IS set but there's no usable session/app
 * password, throws AtprotoNeedsLoginError to steer the caller to
 * `anyapi-mcp login` (rather than silently 401ing on an authed endpoint).
 * Persists any newly minted/refreshed session back to the keystore.
 */
export async function ensureAtprotoAccessToken(
  entry: RegistryEntry,
  auth: AtprotoAuth,
): Promise<string | undefined> {
  if (!auth.identifier) return undefined;

  const session = await loadSession(auth);
  if (session && !nearExpiry(session.accessJwt)) return session.accessJwt;

  if (session?.refreshJwt) {
    try {
      const refreshed = await refreshSession(entry.baseUrl, session.refreshJwt);
      await saveSession(auth, refreshed);
      return refreshed.accessJwt;
    } catch {
      // The refresh JWT is likely expired/revoked; fall through to a fresh login.
    }
  }

  const password = await loadAppPassword(auth);
  if (!password) {
    throw new AtprotoNeedsLoginError(
      `"${entry.id}" (atproto) is set up for ${auth.identifier} but isn't logged ` +
        `in. Ask the user to run \`anyapi-mcp login ${entry.id}\` (stores an app ` +
        `password in the OS keychain; secrets never go through this chat).`,
    );
  }
  try {
    const fresh = await createSession(entry.baseUrl, auth.identifier, password);
    await saveSession(auth, fresh);
    return fresh.accessJwt;
  } catch (err) {
    throw new AtprotoNeedsLoginError(
      `"${entry.id}" (atproto) could not authenticate as ${auth.identifier} (${
        err instanceof Error ? err.message : String(err)
      }). The app password may be wrong or revoked; re-run ` +
        `\`anyapi-mcp login ${entry.id}\`.`,
    );
  }
}

/** A human-readable login status for `list` / `list_apis`. */
export async function atprotoAuthStatus(
  auth: AtprotoAuth,
): Promise<{ text: string; needsLogin: boolean }> {
  // No identifier => anonymous by design; public reads work, so no login is owed.
  if (!auth.identifier) {
    return {
      text:
        "atproto (anonymous - public reads; re-add with an identifier to write)",
      needsLogin: false,
    };
  }
  const session = await loadSession(auth);
  if (session) {
    const who = session.handle || auth.identifier || session.did || "?";
    return { text: `atproto (logged in as ${who})`, needsLogin: false };
  }
  const hasPassword = (await getSecret(auth.passwordKey)) !== undefined;
  if (hasPassword) {
    return {
      text:
        `atproto (app password stored for ${auth.identifier}; session mints on first use)`,
      needsLogin: false,
    };
  }
  return {
    text: `atproto (not logged in as ${auth.identifier})`,
    needsLogin: true,
  };
}
