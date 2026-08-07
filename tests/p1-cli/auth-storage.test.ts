import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  login,
  logout,
  logoutMessage,
  refreshedCredential,
  validateCallbackUrl,
} from "../../src/cloud/auth.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  readCurrentTarget,
  writeCurrentTarget,
} from "../../src/cloud/current-target.js";
import {
  type CredentialProfile,
  credentialStore,
  type CredentialRecord,
  type CredentialStore,
  defaultCredentialStateDirectory,
} from "../../src/cloud/storage.js";

// The config directory moved from ~/.coswarm to ~/.cswarm with the CommonSwarm rename,
// and nothing else in the suite pins it. A half-reverted rename would otherwise only
// show up as an install that has silently forgotten its login.
test("default credential state is ~/.cswarm/credentials.d, not the pre-rename path", () => {
  assert.equal(
    defaultCredentialStateDirectory(),
    join(homedir(), ".cswarm", "credentials.d"),
  );
});

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "test memory";
  record: CredentialRecord | null = null;
  profile: CredentialProfile = {
    version: 1,
    userId: null,
    workspaceId: null,
    pendingCommands: {},
  };

  async read(): Promise<CredentialRecord | null> {
    return this.record ? { ...this.record } : null;
  }

  async write(record: CredentialRecord): Promise<void> {
    this.record = { ...record };
  }

  async delete(): Promise<void> {
    this.record = null;
  }

  async readProfile(): Promise<CredentialProfile> {
    return structuredClone(this.profile);
  }

  async writeProfile(profile: CredentialProfile): Promise<void> {
    this.profile = structuredClone(profile);
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
  workspaceId: string;
  registrations(): number;
}> {
  let expectedChallenge: string | null = null;
  let registrationCount = 0;
  const workspaceId = randomUUID();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "POST" &&
      url.pathname === "/functions/v1/command"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        command?: { kind?: string; device_id?: string };
      };
      assert.equal(request.headers.authorization, "Bearer test-access-token");
      assert.equal(body.command?.kind, "register_device");
      assert.match(String(body.command?.device_id), /^[0-9a-f-]{36}$/i);
      registrationCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        device_id: body.command?.device_id,
      }));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/rest/v1/memberships"
    ) {
      assert.equal(request.headers.authorization, "Bearer test-access-token");
      assert.equal(request.headers["accept-profile"], "swarm_read");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ workspace_id: workspaceId }]));
      return;
    }
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
    workspaceId,
    registrations: () => registrationCount,
  };
}

async function refreshServer(): Promise<{
  url: string;
  close(): Promise<void>;
  refreshes(): number;
  logouts(): number;
  logoutScopes(): string[];
}> {
  let refreshCount = 0;
  let logoutCount = 0;
  const logoutScopes: string[] = [];
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
      logoutScopes.push(url.searchParams.get("scope") ?? "global");
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
    logoutScopes: () => [...logoutScopes],
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
  const input = new PassThrough();
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
        assert.ok(callback.searchParams.get("state"));
        callback.searchParams.set("code", "test-auth-code");
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        return true;
      },
      timeoutMs: 2_000,
      pasteFallbackDelayMs: 1_000,
    });
    assert.equal(result.userId, "11111111-1111-4111-8111-111111111111");
    assert.equal(credentials.record?.refreshToken, "test-rotating-refresh-token");
    assert.equal(credentials.record?.generation, 0);
    assert.ok(credentials.record?.deviceId);
    assert.equal(result.workspaceId, server.workspaceId);
    assert.equal(credentials.profile.workspaceId, server.workspaceId);
    assert.equal(credentials.profile.userId, result.userId);
    assert.equal(result.email, "dogfood@example.test");
    assert.equal(credentials.profile.email, "dogfood@example.test");
    assert.equal(server.registrations(), 1);
    assert.doesNotMatch(output.text(), /paste the complete callback/i);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(
      JSON.stringify(credentials.record).includes("test-access-token"),
      false,
      "access token must never enter persistent credential storage",
    );
  } finally {
    input.end();
    await server.close();
  }
});

test("no-browser path prints the OAuth URL and verifies pasted callback state", async () => {
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
    assert.match(output.text(), /paste the complete callback/i);
  } finally {
    input.end();
    await server.close();
  }
});

test("refresh rotates under generation control and logout revokes then wipes", async () => {
  const server = await refreshServer();
  const targetStateDirectory = await mkdtemp(
    join(tmpdir(), "cswarm-logout-target-"),
  );
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
    await writeCurrentTarget(target, {
      stateDirectory: targetStateDirectory,
    });
    const refreshed = await refreshedCredential(target, credentials);
    assert.equal(refreshed.accessToken, "access-1");
    assert.equal(credentials.record?.refreshToken, "refresh-1");
    assert.equal(credentials.record?.generation, 5);
    assert.equal(server.refreshes(), 1);
    assert.equal(await logout(target, credentials), "revoked");
    assert.equal(server.refreshes(), 2);
    assert.equal(server.logouts(), 1);
    assert.deepEqual(server.logoutScopes(), ["local"]);
    assert.equal(credentials.record, null);
    assert.deepEqual(
      await readCurrentTarget({ stateDirectory: targetStateDirectory }),
      target,
      "local logout removes auth but keeps the non-secret target pointer",
    );

    credentials.record = {
      version: 1,
      refreshToken: "refresh-2",
      generation: 7,
      deviceId: randomUUID(),
      userId: "22222222-2222-4222-8222-222222222222",
    };
    assert.equal(await logout(target, credentials, "global"), "revoked");
    assert.equal(server.refreshes(), 3);
    assert.equal(server.logouts(), 2);
    assert.deepEqual(server.logoutScopes(), ["local", "global"]);
    assert.deepEqual(
      await readCurrentTarget({ stateDirectory: targetStateDirectory }),
      target,
      "global logout revokes sessions but does not forget which host to re-login to",
    );
  } finally {
    await server.close();
    await rm(targetStateDirectory, { recursive: true, force: true });
  }
});

// One server, many response shapes: the point of these cases is CONTRAST. The earlier
// regression tested a single terminal shape and passed while the code deleted credentials on
// transient errors too -- it could not tell the fix from the bug.
async function refreshFailureServer(status: number, body: unknown): Promise<{
  target: ReturnType<typeof cloudTarget>;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return {
    target: cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function storeWith(token: string): { store: MemoryCredentialStore; record: CredentialRecord } {
  const record: CredentialRecord = {
    version: 1,
    refreshToken: token,
    generation: 1,
    deviceId: randomUUID(),
    userId: "33333333-3333-4333-8333-333333333333",
  };
  const store = new MemoryCredentialStore();
  store.record = { ...record };
  return { store, record };
}

test("logout RETAINS the credential for every non-terminal refresh failure", async () => {
  // Each of these was previously deleted. A 429 is the sharpest: it is server-answered, so
  // the transport check does not catch it, yet it is explicitly a "try again later"
  // condition and the token is untouched.
  const transient: Array<[string, number, unknown]> = [
    ["429 rate limit", 429, { code: "over_request_rate_limit", msg: "Request rate limit reached" }],
    // (a server-answered 5xx is the same AuthRetryableFetchError class as the closed-port
    //  case below, which covers it for a fraction of the retry-backoff cost)
    ["400 legacy invalid_grant with no code", 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" }],
    ["418 unrecognised", 418, { code: "some_future_code", msg: "unknown" }],
  ];
  for (const [label, status, body] of transient) {
    const server = await refreshFailureServer(status, body);
    const { store, record } = storeWith("possibly-still-valid");
    try {
      await assert.rejects(
        () => logout(server.target, store),
        /credential was kept/,
        `${label}: must not be reported as an expired session`,
      );
      assert.deepEqual(
        store.record,
        record,
        `${label}: the credential must survive, because a failed refresh does not imply a dead token`,
      );
    } finally {
      await server.close();
    }
  }

  // Pure transport failure: nothing answers at all. Port 1 is closed.
  const { store, record } = storeWith("possibly-still-valid");
  await assert.rejects(
    () => logout(cloudTarget("http://127.0.0.1:1", "test-anon-key"), store),
    /credential was kept/,
    "unreachable server: must not be reported as an expired session",
  );
  assert.deepEqual(store.record, record, "unreachable server: the credential survives");
});

test("logout --local always reaches a clean state without contacting the server", async () => {
  // The escape hatch that makes retain-by-default safe: an unclassifiable failure must never
  // leave a user stuck between a failing status and a failing logout.
  const server = await refreshFailureServer(429, { code: "over_request_rate_limit" });
  const { store } = storeWith("unknown-state");
  try {
    assert.equal(await logout(server.target, store, "local", { localOnly: true }), "cleared-unverified");
    assert.equal(store.record, null, "the device is clean");
  } finally {
    await server.close();
  }
});

test("logout copy claims a revocation ONLY when the server confirmed one", async () => {
  // The copy IS the fix on this lane. Three earlier versions asserted a containment they had
  // not established, and the worst of them printed "Every refresh session for this identity
  // was revoked" after a no-op. So every line is asserted here, not just the happy one.
  const claims = (outcome: Parameters<typeof logoutMessage>[0], all: boolean) =>
    logoutMessage(outcome, all);

  // ONLY the confirmed path may say the server confirmed it.
  assert.match(claims("revoked", true), /server confirmed/);
  assert.match(claims("revoked", true), /confirmed the account-wide sign-out/);
  // AND MUST NOT claim more than a 200 establishes: the endpoint revokes refresh tokens;
  // already-issued access JWTs live until they expire. The previous version of this
  // assertion REQUIRED /every session/, so the test was enforcing the overclaim.
  assert.doesNotMatch(claims("revoked", true), /every session/);
  assert.match(claims("revoked", false), /server confirmed it/);
  assert.match(claims("revoked", false), /other machines stay signed in/);

  // THE CONTROL, and it is the whole point: no other outcome may claim confirmation or
  // account-wide containment, on EITHER flag setting.
  for (const outcome of ["already-logged-out", "local-only", "cleared-unverified"] as const) {
    for (const all of [true, false]) {
      const line = claims(outcome, all);
      assert.doesNotMatch(line, /confirmed/, `${outcome}/${all} must not claim confirmation`);
      assert.doesNotMatch(line, /account-wide/, `${outcome}/${all} must not claim containment`);
      assert.doesNotMatch(line, /revoked for/, `${outcome}/${all} must not claim revocation`);
    }
  }

  // The unconfirmed paths must route the user somewhere, not just report failure.
  assert.match(claims("cleared-unverified", false), /--all-devices/);
  assert.match(claims("local-only", false), /other devices are unaffected/);

  // No provider internals leak into user-facing copy (GoTrue shipped in these strings once).
  for (const outcome of ["already-logged-out", "revoked", "local-only", "cleared-unverified"] as const) {
    assert.doesNotMatch(claims(outcome, true), /GoTrue|Supabase/i);
  }
});

test("logout REFUSES to clear or claim anything when the server rejects the sign-out", async () => {
  // auth-js's signOut swallows 401/403/404 from /logout and returns error:null. The outcome
  // must not be a word that asserts the server agreed.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/auth/v1/token") {
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "a", token_type: "bearer", expires_in: 3600, refresh_token: "r2",
        user: { id: "55555555-5555-4555-8555-555555555555", aud: "authenticated", role: "authenticated",
          app_metadata: {}, user_metadata: {}, created_at: now, updated_at: now },
      }));
      return;
    }
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "forbidden", msg: "nope" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  const { store } = storeWith("live-token");
  const before = { ...store.record! };
  try {
    // The high-level SDK call swallows this 403 and returns error:null. Using it would make
    // the CLI print "the server confirmed it" about a request the server REFUSED.
    await assert.rejects(
      () => logout(cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"), store, "global"),
      /did not confirm the session ended/,
      "a refused sign-out must not be reported as success",
    );
    // The credential must SURVIVE -- the session is live and unrevoked, so this is the only
    // handle for retrying. It is expected to be ROTATED rather than identical: the refresh
    // consumed the old token, and persisting the new one is what makes "run cswarm logout
    // again" work on a token we actually hold instead of on GoTrue's parent-token grace.
    assert.notEqual(store.record, null, "the retry handle must not be destroyed");
    // deviceId is ours and must be stable; userId is the SERVER's and is refreshed from the
    // session, matching what refreshedCredential already does.
    assert.equal(store.record!.deviceId, before.deviceId);
    assert.notEqual(
      store.record!.refreshToken,
      before.refreshToken,
      "the rotated token must be persisted, or the retry uses a spent credential",
    );
    assert.equal(store.record!.generation, before.generation + 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("logout non-author control: 404 and 500 retain the rotated credential without inventing a refusal", async () => {
  // A non-2xx response establishes that the sign-out was not confirmed. It does not
  // establish why: 404 can be a missing route or version skew, and 500 is a server
  // failure rather than an intentional refusal. Both must retain the only retry handle,
  // and both need observation-only copy.
  const copyObservations: Array<{
    status: number;
    reportsObservation: boolean;
    inventsRefusal: boolean;
    inventsNoAnswer: boolean;
  }> = [];
  for (const status of [404, 500]) {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/auth/v1/token") {
        const now = new Date().toISOString();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          access_token: `access-${status}`,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: `rotated-${status}`,
          user: {
            id: "66666666-6666-4666-8666-666666666666",
            aud: "authenticated",
            role: "authenticated",
            app_metadata: {},
            user_metadata: {},
            created_at: now,
            updated_at: now,
          },
        }));
        return;
      }
      if (url.pathname === "/auth/v1/logout") {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: `logout_${status}`, msg: "not confirmed" }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const { store, record } = storeWith(`original-${status}`);
    let failure: unknown;
    try {
      await logout(
        cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"),
        store,
        "global",
      );
    } catch (error) {
      failure = error;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    assert.ok(failure instanceof Error, `HTTP ${status}: logout must fail`);
    copyObservations.push({
      status,
      reportsObservation: /server did not confirm/i.test(failure.message),
      inventsRefusal: /server refused/i.test(failure.message),
      inventsNoAnswer: /could not reach the server/i.test(failure.message),
    });
    assert.notEqual(store.record, null, `HTTP ${status}: retain the retry handle`);
    assert.equal(store.record!.refreshToken, `rotated-${status}`);
    assert.equal(store.record!.generation, record.generation + 1);
    assert.equal(store.record!.deviceId, record.deviceId);
  }
  assert.deepEqual(
    copyObservations,
    [
      {
        status: 404,
        reportsObservation: true,
        inventsRefusal: false,
        inventsNoAnswer: false,
      },
      {
        status: 500,
        reportsObservation: true,
        inventsRefusal: false,
        inventsNoAnswer: false,
      },
    ],
    "both HTTP failures must report only that sign-out was not confirmed",
  );
});

test("logout with an unusable refresh token clears the credential instead of wedging", async () => {
  // Regression: logout used to throw when refreshSession failed, which meant it never
  // reached store.delete(). A user whose session had expired was told by `status` to log
  // in, but `logout` -- the obvious way to reset -- failed and left the credential on
  // disk. There was no way out of that state from the CLI.
  const server = await createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/auth/v1/token") {
      // A NAMED terminal condition. The legacy `invalid_grant` shape carries no code, so it
      // is deliberately NOT terminal any more -- it retains and routes the user to
      // `--local` instead. That case is covered in the retain test above.
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "refresh_token_not_found",
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token: Refresh Token Not Found",
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  const target = cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key");
  const credentials = new MemoryCredentialStore();
  credentials.record = {
    version: 1,
    refreshToken: "expired-token",
    generation: 1,
    deviceId: randomUUID(),
    userId: "33333333-3333-4333-8333-333333333333",
  };
  try {
    assert.equal(
      await logout(target, credentials),
      "local-only",
      "an unrevokable session reports local-only, so the caller never claims a revocation",
    );
    assert.equal(
      credentials.record,
      null,
      "the credential is removed, so the user is not stuck between a failing status and a failing logout",
    );
    assert.equal(
      await logout(target, credentials),
      "already-logged-out",
      "and logout stays idempotent afterwards",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const workspaceId = randomUUID();
    await store.writeProfile({
      version: 1,
      userId: record.userId,
      workspaceId,
      pendingCommands: {
        ["a".repeat(64)]: {
          commandId: "cmd_pending123",
          kind: "invite_member",
          createdAt: 1,
        },
      },
    });
    assert.deepEqual(await store.readProfile(), {
      version: 1,
      userId: record.userId,
      workspaceId,
      pendingCommands: {
        ["a".repeat(64)]: {
          commandId: "cmd_pending123",
          kind: "invite_member",
          createdAt: 1,
        },
      },
    });
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
if (args.join("\\0").includes("rrrrrrrr")) process.exit(9);
if (action === "add-generic-password") {
  const lines = fs.readFileSync(0, "utf8").trimEnd().split("\\n");
  if (lines.length !== 2 || lines[0] !== lines[1]) process.exit(8);
  if (Buffer.byteLength(lines[0], "utf8") > 126) process.exit(7);
  if (lines[0].startsWith("{")) process.exit(6);
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
      refreshToken: "r".repeat(43),
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

test("malformed credential errors never echo stored secret material", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-malformed-store-"));
  const directory = join(parent, "credentials");
  try {
    const store = await credentialStore({
      target: cloudTarget("https://malformed.example.test", "anon"),
      stateDirectory: directory,
      forceFile: true,
      platform: "linux",
      warn: () => undefined,
    });
    await store.write({
      version: 1,
      refreshToken: "refresh-token-long-enough",
      generation: 0,
      deviceId: randomUUID(),
      userId: randomUUID(),
    });
    await writeFile(
      store.location,
      '{"version":1,"refreshToken":"must-never-appear',
      { mode: 0o600 },
    );
    const error = await store.read().then(
      () => null,
      (failure: unknown) => failure as Error,
    );
    assert.ok(error);
    assert.equal(error.message, "stored credential record is malformed");
    assert.equal(error.message.includes("must-never-appear"), false);
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
