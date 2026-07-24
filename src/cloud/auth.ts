import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
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
      response.end("Coswarm login complete. You can return to the terminal.\n");
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
        label: "coswarm-cli",
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
      if (!before) throw new Error("not logged in; run coswarm login");
      const memory = new MemoryStorage();
      const client = authClient(target, memory);
      const refreshed = await client.auth.refreshSession({
        refresh_token: before.refreshToken,
      });
      if (refreshed.error) {
        const afterFailure = await store.read();
        if (afterFailure && afterFailure.generation !== before.generation) continue;
        throw new Error(`session refresh failed: ${refreshed.error.message}`);
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

export async function logout(
  target: CloudTarget,
  store: CredentialStore,
  scope: "local" | "global" = "local",
): Promise<boolean> {
  return await store.withLock(async () => {
    const record = await store.read();
    if (!record) return false;
    const memory = new MemoryStorage();
    const client = authClient(target, memory);
    const refreshed = await client.auth.refreshSession({
      refresh_token: record.refreshToken,
    });
    if (refreshed.error) {
      throw new Error(`cannot revoke the GoTrue session: ${refreshed.error.message}`);
    }
    const signedOut = await client.auth.signOut({ scope });
    if (signedOut.error) {
      throw new Error(`GoTrue logout failed: ${signedOut.error.message}`);
    }
    await store.delete();
    return true;
  });
}
