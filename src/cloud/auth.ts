import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthRetryableFetchError } from "@supabase/auth-js";
import {
  authStorageKey,
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import type { CredentialRecord, CredentialStore } from "./storage.js";

const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const PASTE_FALLBACK_DELAY_MS = 15_000;
const HIGH_PORT_MIN = 49_152;
const HIGH_PORT_MAX_EXCLUSIVE = 65_536;
const CALLBACK_ATTEMPTS = 32;

export interface AsyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStorage implements AsyncStorage {
  private readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export interface LoginOptions {
  target: CloudTarget;
  store: CredentialStore;
  openBrowser?: (url: string) => Promise<boolean>;
  input?: Readable;
  output?: Writable;
  timeoutMs?: number;
  pasteFallbackDelayMs?: number;
}

export interface LoginResult {
  userId: string;
  deviceId: string;
  storage: "keychain" | "file";
  workspaceId: string | null;
  email: string | null;
}

export interface RefreshedCredential {
  accessToken: string;
  userId: string;
  deviceId: string;
}

interface CallbackReceiver {
  redirectUrl: string;
  origin: string;
  result: Promise<string>;
  close(): Promise<void>;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateCallbackUrl(
  raw: string,
  expectedOrigin: string,
  expectedState: string,
): string {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    throw new Error("pasted callback must be a complete URL");
  }
  if (callback.origin !== expectedOrigin || callback.pathname !== CALLBACK_PATH) {
    throw new Error("callback origin or path does not match this login attempt");
  }
  const state = callback.searchParams.get("state");
  if (state === null || !equalSecret(state, expectedState)) {
    throw new Error("login state mismatch; refusing callback");
  }
  const oauthError = callback.searchParams.get("error_description") ??
    callback.searchParams.get("error");
  if (oauthError) throw new Error(`OAuth login failed: ${oauthError.slice(0, 240)}`);
  const code = callback.searchParams.get("code");
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error("callback is missing a valid authorization code");
  }
  return code;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  return closed;
}

async function callbackReceiver(expectedState: string): Promise<CallbackReceiver> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let origin = "";
  let settled = false;
  const server = createServer((request, response) => {
    try {
      const raw = new URL(request.url ?? "/", origin).toString();
      const code = validateCallbackUrl(raw, origin, expectedState);
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      response.end("CommonSwarm login complete. You can return to the terminal.\n");
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    } catch (error) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      response.end("Swarm login callback rejected.\n");
    }
  });

  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt += 1) {
    const port = randomInt(HIGH_PORT_MIN, HIGH_PORT_MAX_EXCLUSIVE);
    try {
      await listen(server, port);
      server.unref();
      origin = `http://127.0.0.1:${port}`;
      const redirect = new URL(CALLBACK_PATH, origin);
      redirect.searchParams.set("state", expectedState);
      return {
        redirectUrl: redirect.toString(),
        origin,
        result,
        close: async () => {
          if (!settled) {
            settled = true;
            rejectCode(new Error("login callback listener closed"));
          }
          await closeServer(server);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error("unable to bind a random high loopback callback port");
}

function pkceVerifier(): string {
  return base64Url(randomBytes(64));
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthUrl(
  target: CloudTarget,
  redirectUrl: string,
  challenge: string,
): string {
  const url = new URL("/auth/v1/authorize", target.url);
  url.searchParams.set("provider", "github");
  url.searchParams.set("redirect_to", redirectUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

function authClient(
  target: CloudTarget,
  storage: AsyncStorage,
): SupabaseClient {
  return createClient(target.url, target.anonKey, {
    auth: {
      flowType: "pkce",
      storage,
      storageKey: authStorageKey(target),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function openExternalBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "linux"
    ? { executable: "xdg-open", args: [url] }
    : null;
  if (!command) return false;
  return await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function pastedCallback(
  input: Readable | undefined,
  output: Writable,
  origin: string,
  state: string,
): { promise: Promise<string>; close(): void } | null {
  if (!input) return null;
  let resolveCode!: (code: string) => void;
  const promise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  let pending = "";
  const onData = (chunk: Buffer | string) => {
    pending += chunk.toString();
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        resolveCode(validateCallbackUrl(line, origin, state));
      } catch (error) {
        output.write(`${(error as Error).message}\n`);
        output.write("Paste the complete callback URL, or finish in the browser:\n");
      }
    }
  };
  input.on("data", onData);
  return {
    promise,
    close: () => {
      input.off("data", onData);
      input.pause();
    },
  };
}

async function waitForCode(
  receiver: CallbackReceiver,
  state: string,
  input: Readable | undefined,
  output: Writable,
  timeoutMs: number,
  pasteFallbackDelayMs: number,
): Promise<string> {
  const activePastes: Array<{ close(): void }> = [];
  let pasteTimer: NodeJS.Timeout | null = null;
  const paste = input
    ? new Promise<string>((resolve) => {
      pasteTimer = setTimeout(() => {
        output.write(
          "If the browser cannot reach the loopback callback, paste the complete callback URL here:\n",
        );
        const pasted = pastedCallback(input, output, receiver.origin, state);
        if (pasted) activePastes.push(pasted);
        pasted?.promise.then(resolve);
      }, pasteFallbackDelayMs);
    })
    : null;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for the login callback")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      receiver.result,
      ...(paste ? [paste] : []),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (pasteTimer) clearTimeout(pasteTimer);
    for (const pasted of activePastes) pasted.close();
  }
}

function requireSession(session: Session | null): Session {
  if (!session?.refresh_token || !session.access_token || !session.user?.id) {
    throw new Error("GoTrue returned an incomplete session");
  }
  return session;
}

async function registerLoginDevice(
  target: CloudTarget,
  accessToken: string,
  deviceId: string,
): Promise<boolean> {
  const response = await fetch(commandEndpoint(target), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: `login_${randomBytes(12).toString("base64url")}`,
      client_version: CLIENT_PROTOCOL_VERSION,
      command: {
        kind: "register_device",
        device_id: deviceId,
        label: "cswarm-cli",
      },
    }),
  });
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(
      `login device registration returned non-JSON (HTTP ${response.status})`,
    );
  }
  if (response.status === 403) return false;
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).status !== "accepted" ||
    (body as Record<string, unknown>).device_id !== deviceId
  ) {
    throw new Error(`login device registration failed (HTTP ${response.status})`);
  }
  return true;
}

async function discoverSoleWorkspace(
  target: CloudTarget,
  accessToken: string,
  userId: string,
): Promise<string | null> {
  const url = new URL("/rest/v1/memberships", target.url);
  url.searchParams.set("select", "workspace_id");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("revoked_at", "is.null");
  url.searchParams.set("limit", "2");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: target.anonKey,
        "accept-profile": "swarm_read",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body) || body.length !== 1) return null;
  const workspaceId = (body[0] as Record<string, unknown>)?.workspace_id;
  return typeof workspaceId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(workspaceId)
    ? workspaceId
    : null;
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const output = options.output ?? process.stderr;
  const state = base64Url(randomBytes(32));
  const verifier = pkceVerifier();
  const memory = new MemoryStorage();
  const storageKey = authStorageKey(options.target);
  const client = authClient(options.target, memory);
  const initialized = await client.auth.initialize();
  if (initialized.error) {
    throw new Error(`unable to initialize PKCE auth: ${initialized.error.message}`);
  }
  // auth-js storage values are JSON encoded even when the underlying adapter
  // accepts strings. The verifier stays only in this process-local store.
  await memory.setItem(`${storageKey}-code-verifier`, JSON.stringify(verifier));
  const receiver = await callbackReceiver(state);
  const authorizationUrl = oauthUrl(
    options.target,
    receiver.redirectUrl,
    pkceChallenge(verifier),
  );
  const opener = options.openBrowser ?? openExternalBrowser;

  try {
    const opened = await opener(authorizationUrl);
    if (!opened) {
      output.write("Open this URL in a browser to sign in with GitHub:\n");
      output.write(`${authorizationUrl}\n`);
    }
    const code = await waitForCode(
      receiver,
      state,
      options.input ?? (process.stdin.isTTY ? process.stdin : undefined),
      output,
      options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
      opened
        ? options.pasteFallbackDelayMs ?? PASTE_FALLBACK_DELAY_MS
        : 0,
    );
    const exchanged = await client.auth.exchangeCodeForSession(code);
    if (exchanged.error) {
      throw new Error(`PKCE code exchange failed: ${exchanged.error.message}`);
    }
    const session = requireSession(exchanged.data.session);

    return await options.store.withLock(async () => {
      const existing = await options.store.read();
      const existingProfile = await options.store.readProfile();
      const sameUser = existing?.userId === session.user.id ||
        existing === null && existingProfile.userId === session.user.id;
      let deviceId = sameUser && existing?.deviceId
        ? existing.deviceId
        : randomUUID();
      if (
        !await registerLoginDevice(
          options.target,
          session.access_token,
          deviceId,
        )
      ) {
        deviceId = randomUUID();
        if (
          !await registerLoginDevice(
            options.target,
            session.access_token,
            deviceId,
          )
        ) {
          throw new Error("login device registration was forbidden");
        }
      }
      const discoveredWorkspace = await discoverSoleWorkspace(
        options.target,
        session.access_token,
        session.user.id,
      );
      const record: CredentialRecord = {
        version: 1,
        refreshToken: session.refresh_token,
        generation: (existing?.generation ?? -1) + 1,
        deviceId,
        userId: session.user.id,
      };
      await options.store.write(record);
      const workspaceId = discoveredWorkspace ??
        (sameUser ? existingProfile.workspaceId : null);
      await options.store.writeProfile({
        version: 1,
        userId: session.user.id,
        workspaceId,
        email: session.user.email ?? null,
        principalId: sameUser && existingProfile.workspaceId === workspaceId
          ? existingProfile.principalId ?? null
          : null,
        principalName: sameUser && existingProfile.workspaceId === workspaceId
          ? existingProfile.principalName ?? null
          : null,
        pendingCommands: sameUser ? existingProfile.pendingCommands : {},
      });
      return {
        userId: record.userId,
        deviceId: record.deviceId,
        storage: options.store.kind,
        workspaceId,
        email: session.user.email ?? null,
      };
    });
  } finally {
    await receiver.close().catch(() => undefined);
    await memory.removeItem(`${storageKey}-code-verifier`);
  }
}

export async function refreshedCredential(
  target: CloudTarget,
  store: CredentialStore,
): Promise<RefreshedCredential> {
  return await store.withLock(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await store.read();
      if (!before) throw new Error("not logged in; run cswarm login");
      const memory = new MemoryStorage();
      const client = authClient(target, memory);
      const refreshed = await client.auth.refreshSession({
        refresh_token: before.refreshToken,
      });
      if (refreshed.error) {
        const afterFailure = await store.read();
        if (afterFailure && afterFailure.generation !== before.generation) continue;
        // Expired, revoked, or rotated on another device all land here and all have the
        // same remedy, so this deliberately does not classify — it tells the user what to
        // do next instead of forwarding the provider's wording (§ error.message is
        // presentation).
        throw new Error("could not refresh your session; run cswarm login to sign in again");
      }
      const session = requireSession(refreshed.data.session);
      const current = await store.read();
      if (!current || current.generation !== before.generation) continue;
      await store.write({
        ...before,
        refreshToken: session.refresh_token,
        generation: before.generation + 1,
        userId: session.user.id,
      });
      return {
        accessToken: session.access_token,
        userId: session.user.id,
        deviceId: before.deviceId,
      };
    }
    throw new Error("session refresh lost a credential-generation race; retry");
  });
}

/** What logout actually achieved.
 *
 * ~~"`revoked` is deliberately NOT claimed for the account-wide case, because the library
 * hides whether the server agreed."~~ DEAD, and it now says the OPPOSITE of the code: the
 * high-level wrapper hides it, but `admin.signOut` does not, so `revoked` is claimed exactly
 * when the server answered and accepted. What a 200 establishes is bounded, though -- the
 * endpoint revokes refresh tokens and cannot revoke already-issued access JWTs before they
 * expire, which is why the copy says "confirmed the sign-out" rather than "every session is
 * ended". */
export type LogoutOutcome =
  | "already-logged-out"
  /** The server ANSWERED and accepted the sign-out. The only outcome that may claim it. */
  | "revoked"
  | "local-only"
  | "cleared-unverified";

/**
 * What to tell the user after `logout`, saying only what was observed.
 *
 * A pure function because the COPY is the fix here: three earlier versions of this command
 * asserted a containment they had not established, and a string buried in a nested ternary
 * inside main() is a string no test can reach. Every line below is covered.
 */
export function logoutMessage(
  outcome: LogoutOutcome,
  allDevices: boolean,
): string {
  switch (outcome) {
    case "already-logged-out":
      return "Already logged out.\n";
    case "cleared-unverified":
      return "Cleared this device. The server was not contacted, so any session it still " +
        "holds is unchanged — sign in and run cswarm logout --all-devices if you need it revoked.\n";
    case "local-only":
      // States the OBSERVATION, not a cause. This fires for all four terminal codes, and
      // only session_expired is expiry; after refresh_token_already_used a live session may
      // exist elsewhere, so "nothing to revoke" is true of THIS handle and not the identity.
      return "Signed out on this device. The server no longer accepts this credential, so " +
        "there was nothing this device could revoke; other devices are unaffected.\n";
    case "revoked":
      return allDevices
        // NOT "Signed out on all devices" (Plumb). That is the same account-wide completion
        // claim in different words: the endpoint revokes refresh tokens, and already-issued
        // access JWTs can still authorize a device until they expire. What is true is that
        // THIS device is signed out and the account-wide request was accepted.
        ? "Signed out on this device. The server confirmed the account-wide sign-out.\n"
        : "Signed out on this device. The server confirmed it; other machines stay signed " +
          "in so collaborators are not disrupted.\n";
  }
}

/** Auth codes that mean this refresh token can never work again.
 *
 * CLOSED allowlist on purpose: anything not listed -- transient, rate-limited, or simply
 * unrecognised -- RETAINS the credential. Deleting is irreversible, so the default has to be
 * the reversible side. Measured shapes: a modern `400 refresh_token_not_found` carries
 * `code`, while a legacy `400 invalid_grant` carries none, which is why the escape hatch
 * below exists rather than a looser rule here. */
const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
]);

/** True only when the server answered AND named a condition that can never recover. */
function isTerminalRefreshFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const named = error as { name?: unknown; code?: unknown };
  // A missing session is terminal by TYPE: there is nothing left to revoke.
  if (named.name === "AuthSessionMissingError") return true;
  return typeof named.code === "string" && TERMINAL_REFRESH_CODES.has(named.code);
}

export async function logout(
  target: CloudTarget,
  store: CredentialStore,
  scope: "local" | "global" = "local",
  options: { localOnly?: boolean } = {},
): Promise<LogoutOutcome> {
  return await store.withLock(async () => {
    const record = await store.read();
    if (!record) return "already-logged-out";
    // The escape hatch. Asked for explicitly, so it needs no guess about the token's state:
    // a user whose failure we cannot classify gets an explicit server-free deletion path.
    // NOT "always has a way to a clean local state" -- the delete below can itself throw
    // (storage.ts raises on a non-zero, non-44 Keychain code), so that holds only where
    // local storage can be changed.
    if (options.localOnly) {
      await store.delete();
      return "cleared-unverified";
    }
    const memory = new MemoryStorage();
    const client = authClient(target, memory);
    const refreshed = await client.auth.refreshSession({
      refresh_token: record.refreshToken,
    });
    if (refreshed.error) {
      // RETAIN BY DEFAULT. Delete only for a positively recognised terminal condition.
      // Everything else keeps the credential, because a failed refresh does NOT imply a
      // dead token. Measured: a closed port yields AuthRetryableFetchError (status 0), and
      // a 429 rate limit yields AuthApiError -- transient, server-answered, and previously
      // deleted by this function. A rotated-but-lost response is also recoverable from the
      // retained parent token, and deleting would destroy that handle.
      if (!isTerminalRefreshFailure(refreshed.error)) {
        throw new Error(
          "could not confirm the session with the server, so your credential was kept; " +
            "check your connection and run cswarm logout again, " +
            "or run cswarm logout --local to clear this device without contacting the server",
        );
      }
      await store.delete();
      return "local-only";
    }
    // USE THE LOW-LEVEL CALL ON PURPOSE. The high-level `client.auth.signOut()` deliberately
    // SWALLOWS 401/403/404 from /logout and returns error:null, so it can still clear local
    // browser state -- measured: refresh 200 then logout 403 arrives here with no error at
    // all. `admin.signOut` is the same request the wrapper makes, minus the swallowing, so
    // this is using a lower layer of the SDK rather than reaching around it. Without this we
    // cannot tell "the server revoked it" from "the server refused and we were not told",
    // and the CLI would assert containment it never observed.
    // PERSIST THE ROTATED TOKEN BEFORE ATTEMPTING THE REVOKE. The refresh above CONSUMED the
    // stored token, so every failure path below tells the user to "run cswarm logout again"
    // with a spent credential -- the retry would then depend on GoTrue's parent-token grace
    // rather than on a token we hold.
    //
    // THE `generation` BUMP IS NOT BOOKKEEPING AND MUST NOT BE DROPPED (Verity).
    // `generation` is a CONCURRENCY TOKEN: `refreshedCredential` above guards its retry loop
    // on it (`current.generation !== before.generation` -> continue) and throws on a lost
    // race. Writing the rotated refreshToken WITHOUT bumping it would let a concurrent
    // refresher see an unchanged generation, conclude nothing had happened, and proceed
    // against a token that had silently rotated underneath it -- a lost update, which is the
    // exact class of defect this lane has produced three times. The bump is what makes this
    // write participate in the protocol that already exists rather than race it.
    const session = requireSession(refreshed.data.session);
    await store.write({
      ...record,
      refreshToken: session.refresh_token,
      generation: record.generation + 1,
      userId: session.user.id,
    });
    const signedOut = await client.auth.admin.signOut(session.access_token, scope);
    if (signedOut.error) {
      // ONE MESSAGE FOR EVERY FAILURE, ON PURPOSE. The previous version split on
      // isAuthApiError and named a cause -- "refused" vs "could not reach" -- and Plumb's
      // non-author control showed that split is WRONG: a 500, where the server plainly
      // ANSWERED, arrives as AuthRetryableFetchError and would have been reported as
      // unreachable. That is this lane's own defect, committed inside the fix for it:
      // asserting a cause the code did not establish. What we actually know is the same in
      // every branch -- the sign-out was not confirmed -- so that is all this says.
      //
      // AND THE CREDENTIAL IS KEPT, whatever the reason. Retaining is the safe side: it
      // preserves the retry handle, and a success or a later TERMINAL refresh resolves it
      // automatically. NOT "self-clears" -- this suite itself proves that wrong, since a
      // repeatable 429 or a code-less legacy invalid_grant is non-terminal and can recur
      // indefinitely, so the refresh may never reach the local-only delete. `--local` is the
      // explicit escape where storage can be changed. Classifying this response is the trap -- a 404 from /logout says
      // nothing about the REFRESH token; it says this sign-out found no session to end, so
      // deleting on it would infer one credential's state from a response about a different
      // object.
      throw new Error(
        "signed in, but the server did not confirm the session ended; your credential was " +
          "kept — run cswarm logout again, or run cswarm logout --local to clear this device " +
          "without contacting the server",
      );
    }
    await store.delete();
    // Earned: admin.signOut bypasses the wrapper's 401/403/404 swallowing, so no error means
    // the server answered and accepted. Note the SCOPE of what that establishes -- the
    // endpoint revokes refresh tokens; already-issued access JWTs stay valid until they
    // expire. The copy says "confirmed the sign-out", not "every session is ended".
    return "revoked";
  });
}
