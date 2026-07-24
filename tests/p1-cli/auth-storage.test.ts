import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  login,
  logout,
  refreshedCredential,
  validateCallbackUrl,
} from "../../src/cloud/auth.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  credentialStore,
  type CredentialRecord,
  type CredentialStore,
} from "../../src/cloud/storage.js";

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "test memory";
  record: CredentialRecord | null = null;

  async read(): Promise<CredentialRecord | null> {
    return this.record ? { ...this.record } : null;
  }

  async write(record: CredentialRecord): Promise<void> {
    this.record = { ...record };
  }

  async delete(): Promise<void> {
    this.record = null;
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

function sink(): { output: Writable; text(): string } {
  let value = "";
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

async function authServer(): Promise<{
  url: string;
  close(): Promise<void>;
  setChallenge(value: string): void;
}> {
  let expectedChallenge: string | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/auth/v1/token") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      auth_code?: string;
      code_verifier?: string;
    };
    assert.equal(body.auth_code, "test-auth-code");
    assert.ok(body.code_verifier);
    assert.equal(
      createHash("sha256").update(body.code_verifier).digest("base64url"),
      expectedChallenge,
      "the verifier held by the CLI must match the browser challenge",
    );
    const now = new Date().toISOString();
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      access_token: "test-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test-rotating-refresh-token",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        aud: "authenticated",
        role: "authenticated",
        email: "dogfood@example.test",
        email_confirmed_at: now,
        phone: "",
        confirmed_at: now,
        last_sign_in_at: now,
        app_metadata: { provider: "github", providers: ["github"] },
        user_metadata: {},
        identities: [],
        created_at: now,
        updated_at: now,
        is_anonymous: false,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      ),
    setChallenge(value: string) {
      expectedChallenge = value;
    },
  };
}

async function refreshServer(): Promise<{
  url: string;
  close(): Promise<void>;
  refreshes(): number;
  logouts(): number;
}> {
  let refreshCount = 0;
  let logoutCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        refresh_token?: string;
      };
      assert.equal(body.refresh_token, `refresh-${refreshCount}`);
      refreshCount += 1;
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: `access-${refreshCount}`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `refresh-${refreshCount}`,
        user: {
          id: "22222222-2222-4222-8222-222222222222",
          aud: "authenticated",
          role: "authenticated",
          email: "refresh@example.test",
          app_metadata: { provider: "github", providers: ["github"] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
      logoutCount += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      ),
    refreshes: () => refreshCount,
    logouts: () => logoutCount,
  };
}

test("state mismatch is rejected for callback and copy/paste paths", () => {
  const origin = "http://127.0.0.1:54321";
  assert.throws(
    () =>
      validateCallbackUrl(
        `${origin}/callback?state=attacker&code=injected`,
        origin,
        "expected-state",
      ),
    /state mismatch/,
  );
  assert.equal(
    validateCallbackUrl(
      `${origin}/callback?state=expected-state&code=good-code`,
      origin,
      "expected-state",
    ),
    "good-code",
  );
});

test("PKCE loopback holds verifier client-side and stores only the refresh record", async () => {
  const server = await authServer();
  const credentials = new MemoryCredentialStore();
  const output = sink();
  try {
    const result = await login({
      target: cloudTarget(server.url, "test-anon-key"),
      store: credentials,
      output: output.output,
      openBrowser: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl);
        server.setChallenge(authorize.searchParams.get("code_challenge")!);
        const callback = new URL(authorize.searchParams.get("redirect_to")!);
        assert.ok(callback.searchParams.get("state"));
        callback.searchParams.set("code", "test-auth-code");
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        return true;
      },
      timeoutMs: 2_000,
    });
    assert.equal(result.userId, "11111111-1111-4111-8111-111111111111");
    assert.equal(credentials.record?.refreshToken, "test-rotating-refresh-token");
    assert.equal(credentials.record?.generation, 0);
    assert.ok(credentials.record?.deviceId);
    assert.equal(
      JSON.stringify(credentials.record).includes("test-access-token"),
      false,
      "access token must never enter persistent credential storage",
    );
  } finally {
    await server.close();
  }
});

test("copy/paste fallback verifies the same state before exchange", async () => {
  const server = await authServer();
  const credentials = new MemoryCredentialStore();
  const input = new PassThrough();
  const output = sink();
  try {
    const result = await login({
      target: cloudTarget(server.url, "test-anon-key"),
      store: credentials,
      input,
      output: output.output,
      openBrowser: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl);
        server.setChallenge(authorize.searchParams.get("code_challenge")!);
        const callback = new URL(authorize.searchParams.get("redirect_to")!);
        callback.searchParams.set("code", "test-auth-code");
        setTimeout(() => input.write(`${callback}\n`), 10);
        return false;
      },
      timeoutMs: 2_000,
    });
    assert.equal(result.userId, "11111111-1111-4111-8111-111111111111");
    assert.match(output.text(), /Open this URL/);
  } finally {
    input.end();
    await server.close();
  }
});

test("refresh rotates under generation control and logout revokes then wipes", async () => {
  const server = await refreshServer();
  const credentials = new MemoryCredentialStore();
  credentials.record = {
    version: 1,
    refreshToken: "refresh-0",
    generation: 4,
    deviceId: randomUUID(),
    userId: "22222222-2222-4222-8222-222222222222",
  };
  const target = cloudTarget(server.url, "test-anon-key");
  try {
    const refreshed = await refreshedCredential(target, credentials);
    assert.equal(refreshed.accessToken, "access-1");
    assert.equal(credentials.record?.refreshToken, "refresh-1");
    assert.equal(credentials.record?.generation, 5);
    assert.equal(server.refreshes(), 1);
    assert.equal(await logout(target, credentials), true);
    assert.equal(server.refreshes(), 2);
    assert.equal(server.logouts(), 1);
    assert.equal(credentials.record, null);
  } finally {
    await server.close();
  }
});

test("headless file fallback warns and enforces 0700/0600", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-cloud-store-"));
  const directory = join(parent, "credentials");
  const warnings: string[] = [];
  const target = cloudTarget("http://127.0.0.1:54321", "anon");
  try {
    const store = await credentialStore({
      target,
      stateDirectory: directory,
      forceFile: true,
      platform: "linux",
      warn: (message) => warnings.push(message),
    });
    const record: CredentialRecord = {
      version: 1,
      refreshToken: "refresh-token-long-enough",
      generation: 0,
      deviceId: randomUUID(),
      userId: randomUUID(),
    };
    await store.write(record);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.location)).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(), record);
    assert.ok(warnings.some((warning) => warning.startsWith("⚠")));

    await chmod(store.location, 0o644);
    await assert.rejects(store.read(), /must be mode 0600/);

    await chmod(store.location, 0o600);
    await chmod(directory, 0o755);
    await assert.rejects(
      store.write(record),
      /directory must be mode 0700/,
      "a credential must never be written below a traversable directory",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("keychain writer keeps the credential off argv and answers both secure prompts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-fake-keychain-"));
  const securityPath = join(parent, "security");
  const stateDirectory = join(parent, "state");
  const fakeSecurity = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const action = args[0];
const vault = process.argv[1] + ".secret";
if (args.join("\\0").includes("refresh-token-long-enough")) process.exit(9);
if (action === "add-generic-password") {
  const lines = fs.readFileSync(0, "utf8").trimEnd().split("\\n");
  if (lines.length !== 2 || lines[0] !== lines[1]) process.exit(8);
  fs.writeFileSync(vault, lines[0], { mode: 0o600 });
  process.exit(0);
}
if (action === "find-generic-password") {
  if (!fs.existsSync(vault)) process.exit(44);
  process.stdout.write(fs.readFileSync(vault));
  process.exit(0);
}
if (action === "delete-generic-password") {
  if (!fs.existsSync(vault)) process.exit(44);
  fs.unlinkSync(vault);
  process.exit(0);
}
process.exit(2);
`;
  try {
    await writeFile(securityPath, fakeSecurity, { mode: 0o700 });
    await chmod(securityPath, 0o700);
    const store = await credentialStore({
      target: cloudTarget(
        `https://${randomUUID()}.example.test`,
        "test-anon-key",
      ),
      stateDirectory,
      platform: "darwin",
      securityPath,
    });
    const record: CredentialRecord = {
      version: 1,
      refreshToken: "refresh-token-long-enough",
      generation: 7,
      deviceId: randomUUID(),
      userId: randomUUID(),
    };
    assert.equal(store.kind, "keychain");
    await store.write(record);
    assert.deepEqual(await store.read(), record);
    await store.delete();
    assert.equal(await store.read(), null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("file fallback hard-refuses when disabled", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon");
  await assert.rejects(
    credentialStore({
      target,
      forceFile: true,
      platform: "linux",
      allowFileFallback: false,
    }),
    /fallback is disabled/,
  );
});
