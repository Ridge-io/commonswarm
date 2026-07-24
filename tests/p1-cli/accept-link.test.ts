import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acceptInviteLink,
  deviceStablePrincipalName,
  writeAcceptProgress,
  type AcceptLinkRuntime,
  type AcceptProgress,
  type AcceptSession,
  type PrincipalSummary,
} from "../../src/cloud/accept-link.js";
import {
  decodeInviteLink,
  encodeInviteLink,
  parseAcceptPositional,
  requirePinnedOrigin,
  sanitizeDisplayLabel,
  sanitizePrincipalName,
  validateExplicitPrincipalName,
  type InviteLinkPayload,
} from "../../src/cloud/invite-link.js";
import { cloudTarget } from "../../src/cloud/config.js";
import type {
  CredentialProfile,
  CredentialRecord,
  CredentialStore,
} from "../../src/cloud/storage.js";

class MemoryStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "memory";
  record: CredentialRecord | null = null;
  profile: CredentialProfile;

  constructor(profile: Partial<CredentialProfile> = {}) {
    this.profile = {
      version: 1,
      userId: null,
      workspaceId: null,
      email: null,
      principalId: null,
      principalName: null,
      pendingCommands: {},
      ...profile,
    };
  }

  async read(): Promise<CredentialRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }
  async write(record: CredentialRecord): Promise<void> {
    this.record = structuredClone(record);
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

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

function token(): string {
  return `swm_inv_${randomBytes(32).toString("base64url")}`;
}

function payload(overrides: Partial<InviteLinkPayload> = {}): InviteLinkPayload {
  return {
    v: 1,
    url: "http://127.0.0.1:54321",
    anon_key: "local-anon-key",
    workspace_id: randomUUID(),
    invitation_token: token(),
    workspace_name: "Design swarm",
    inviter_display_name: "Taylor",
    inviter_user_id: randomUUID(),
    ...overrides,
  };
}

class FakeRuntime implements AcceptLinkRuntime {
  readonly progress: AcceptProgress[] = [];
  readonly memberships = new Set<string>();
  readonly principals = new Map<string, PrincipalSummary>();
  readonly takenNames = new Set<string>();
  session: AcceptSession | null = {
    accessToken: "access",
    userId: USER_ID,
    deviceId: DEVICE_ID,
    email: "invitee@example.test",
  };
  acceptStatus: "accepted" | "forbidden" = "accepted";
  acceptedWorkspace: string | null = null;
  pinError: Error | null = null;
  calls = {
    pin: 0,
    current: 0,
    login: 0,
    membership: 0,
    principalById: 0,
    liveByName: 0,
    accept: 0,
    create: 0,
  };

  async pinOrigin(): Promise<void> {
    this.calls.pin += 1;
    if (this.pinError) throw this.pinError;
  }
  async currentSession(): Promise<AcceptSession | null> {
    this.calls.current += 1;
    return this.session ? structuredClone(this.session) : null;
  }
  async loginSession(): Promise<AcceptSession> {
    this.calls.login += 1;
    this.session = {
      accessToken: "new-access",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      email: "invitee@example.test",
    };
    return structuredClone(this.session);
  }
  async membershipExists(
    _session: AcceptSession,
    workspaceId: string,
  ): Promise<boolean> {
    this.calls.membership += 1;
    return this.memberships.has(workspaceId);
  }
  async principalById(
    _session: AcceptSession,
    workspaceId: string,
    principalId: string,
  ): Promise<PrincipalSummary | null> {
    this.calls.principalById += 1;
    const found = this.principals.get(`${workspaceId}:id:${principalId}`);
    return found ? structuredClone(found) : null;
  }
  async livePrincipalByName(
    _session: AcceptSession,
    workspaceId: string,
    name: string,
  ): Promise<PrincipalSummary | null> {
    this.calls.liveByName += 1;
    const found = this.principals.get(`${workspaceId}:name:${name}`);
    return found ? structuredClone(found) : null;
  }
  async acceptInvitation(
    _session: AcceptSession,
    workspaceHint: string,
  ): Promise<
    { status: "accepted"; workspaceId: string } | { status: "forbidden" }
  > {
    this.calls.accept += 1;
    if (this.acceptStatus === "forbidden") return { status: "forbidden" };
    const workspaceId = this.acceptedWorkspace ?? workspaceHint;
    this.memberships.add(workspaceId);
    return { status: "accepted", workspaceId };
  }
  async createPrincipal(
    _session: AcceptSession,
    workspaceId: string,
    name: string,
  ): Promise<
    { status: "accepted"; principalId: string } | { status: "name_taken" }
  > {
    this.calls.create += 1;
    if (this.takenNames.has(`${workspaceId}:${name}`)) {
      return { status: "name_taken" };
    }
    const principal = { principalId: randomUUID(), name };
    this.principals.set(`${workspaceId}:name:${name}`, principal);
    this.principals.set(
      `${workspaceId}:id:${principal.principalId}`,
      principal,
    );
    return { status: "accepted", principalId: principal.principalId };
  }
  emit(progress: AcceptProgress): void {
    this.progress.push(structuredClone(progress));
  }
  autoName(): string {
    return "invitee@machine-22222222";
  }
}

async function run(
  linkPayload: InviteLinkPayload,
  runtime = new FakeRuntime(),
  store = new MemoryStore({
    userId: USER_ID,
    email: "invitee@example.test",
  }),
  explicitName?: string,
) {
  const result = await acceptInviteLink({
    payload: linkPayload,
    target: cloudTarget(linkPayload.url, linkPayload.anon_key),
    store,
    runtime,
    ...(explicitName === undefined ? {} : { explicitName }),
  });
  return { result, runtime, store };
}

test("invite link codec round-trips and positional token precedence is exact", () => {
  const original = payload();
  const link = encodeInviteLink(original);
  assert.match(link, /^coswarm:\/\/accept\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeInviteLink(link), original);
  assert.deepEqual(decodeInviteLink(link.split("/").at(-1)!), original);

  const legacy = token();
  assert.deepEqual(parseAcceptPositional(legacy), {
    mode: "token",
    token: legacy,
  });
  assert.equal(parseAcceptPositional(link).mode, "link");
  assert.throws(
    () => parseAcceptPositional("not-a-token-or-link"),
    /swm_inv_|coswarm:\/\/accept/,
  );
});

test("automatic principal names stay bounded, sanitized, and device-stable", () => {
  const name = deviceStablePrincipalName(
    DEVICE_ID,
    `Usér ${"x".repeat(100)}`,
    `Host Name ${"y".repeat(100)}`,
  );
  assert.match(name, /^[a-z0-9._@-]+$/);
  assert.ok(name.length <= 80);
  assert.match(name, /-22222222$/);
  assert.equal(
    name,
    deviceStablePrincipalName(
      DEVICE_ID,
      `Usér ${"x".repeat(100)}`,
      `Host Name ${"y".repeat(100)}`,
    ),
  );
});

test("invite link grammar rejects bad versions, padding, oversize, and malformed UUIDs", () => {
  const valid = payload();
  const encodeRaw = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  assert.throws(
    () => decodeInviteLink(encodeRaw({ ...valid, v: 2 })),
    /version 1/,
  );
  assert.throws(
    () => decodeInviteLink(`${encodeRaw(valid)}=`),
    /strict unpadded base64url/,
  );
  assert.throws(
    () => decodeInviteLink("a".repeat(16_385)),
    /strict unpadded base64url/,
  );
  assert.throws(
    () => decodeInviteLink(encodeRaw({ ...valid, workspace_id: "nope" })),
    /workspace_id/,
  );
});

test("origin pin refuses non-interactive before login and exact confirmation is required", async () => {
  const unknown = cloudTarget("https://cloud.attacker.example", "anon");
  let output = "";
  await assert.rejects(
    requirePinnedOrigin(unknown, {
      interactive: false,
      output: { write: (value) => output += value },
      devAllowedOrigins: unknown.url,
    }),
    /refuses before login/,
  );
  assert.equal(output, "");
  await assert.rejects(
    requirePinnedOrigin(unknown, {
      interactive: true,
      output: { write: (value) => output += value },
      readConfirmation: async () => "https://other.example",
    }),
    /did not exactly match/,
  );
  assert.match(output, /cloud\.attacker\.example/);

  const runtime = new FakeRuntime();
  runtime.pinError = new Error("origin refused");
  runtime.session = null;
  await assert.rejects(run(payload(), runtime), /origin refused/);
  assert.equal(runtime.calls.login, 0);
  assert.equal(runtime.calls.current, 0);
});

test("labels are sanitized before preview and same identity stops before accept", async () => {
  assert.equal(sanitizeDisplayLabel("\u001b[31m\u202e", "this swarm"), "this swarm");
  const runtime = new FakeRuntime();
  const linkPayload = payload({
    workspace_name: "\u001b[31mSafe\u202e\n swarm",
    inviter_display_name: "\u001b[2JPat\u2066",
    inviter_user_id: USER_ID,
  });
  await assert.rejects(
    run(linkPayload, runtime),
    /person who sent this invitation/,
  );
  const preview = runtime.progress[0]?.message ?? "";
  assert.match(preview, /Safe swarm/);
  assert.match(preview, /Pat/);
  assert.doesNotMatch(preview, /[\u001b\u202e\u2066\n]/);
  assert.equal(runtime.calls.accept, 0);
});

test("login skip uses the stored email label and falls back to a user-id prefix", async () => {
  const runtime = new FakeRuntime();
  runtime.session = { ...runtime.session!, email: null };
  await run(payload(), runtime);
  assert.ok(
    runtime.progress.some((entry) =>
      entry.step === "login" &&
      entry.message === "Already signed in as 11111111."
    ),
  );
});

test("fresh accept trusts the server workspace, switches default, and narrates it", async () => {
  const hint = randomUUID();
  const serverWorkspace = randomUUID();
  const runtime = new FakeRuntime();
  runtime.acceptedWorkspace = serverWorkspace;
  const previous = randomUUID();
  const store = new MemoryStore({
    userId: USER_ID,
    workspaceId: previous,
    email: "invitee@example.test",
  });
  const { result } = await run(
    payload({ workspace_id: hint }),
    runtime,
    store,
  );
  assert.equal(result.workspaceId, serverWorkspace);
  assert.equal(store.profile.workspaceId, serverWorkspace);
  assert.equal(store.profile.principalId, result.principalId);
  const defaults = runtime.progress.filter((entry) => entry.step === "default");
  assert.equal(defaults.length, 1);
  assert.equal(
    defaults[0]!.message,
    'Your default workspace is now "Design swarm" (was another workspace).',
  );
  assert.doesNotMatch(defaults[0]!.message, new RegExp(previous));
});

test("403 plus membership uses non-claiming copy, including forged hints", async () => {
  const hint = randomUUID();
  const runtime = new FakeRuntime();
  runtime.acceptStatus = "forbidden";
  runtime.memberships.add(hint);
  const { result } = await run(payload({ workspace_id: hint }), runtime);
  assert.equal(result.acceptedFresh, false);
  const membership = runtime.progress.find((entry) => entry.step === "membership");
  assert.ok(membership);
  assert.match(membership.message, /already a member/);
  assert.match(membership.message, /can't be used/);
  assert.doesNotMatch(membership.message, /now a member|accepted/i);
  assert.equal(membership.data?.invitation_accepted, false);
});

test("403 without membership preserves one uniform failure", async () => {
  const runtime = new FakeRuntime();
  runtime.acceptStatus = "forbidden";
  await assert.rejects(
    run(payload(), runtime),
    /may have expired, already been used, or been revoked/,
  );
  assert.equal(runtime.calls.create, 0);
});

test("403 recovery from a null default writes a checkpoint and the next run short-circuits", async () => {
  const workspaceId = randomUUID();
  const runtime = new FakeRuntime();
  runtime.acceptStatus = "forbidden";
  runtime.memberships.add(workspaceId);
  const store = new MemoryStore({
    userId: USER_ID,
    workspaceId: null,
    email: "invitee@example.test",
  });
  const linkPayload = payload({ workspace_id: workspaceId });
  const first = await run(linkPayload, runtime, store);
  assert.equal(first.result.checkpointShortCircuit, false);
  assert.equal(store.profile.workspaceId, workspaceId);
  assert.equal(store.profile.principalId, first.result.principalId);
  assert.equal(store.profile.principalName, first.result.principalName);
  assert.equal(runtime.calls.accept, 1);

  const second = await run(linkPayload, runtime, store);
  assert.equal(second.result.checkpointShortCircuit, true);
  assert.equal(second.result.principalId, first.result.principalId);
  assert.equal(runtime.calls.accept, 1);
  assert.equal(runtime.calls.create, 1);
});

test("step-0 checkpoint short-circuits accept and create without changing default", async () => {
  const workspaceId = randomUUID();
  const principal = { principalId: randomUUID(), name: "existing-agent" };
  const runtime = new FakeRuntime();
  runtime.memberships.add(workspaceId);
  runtime.principals.set(`${workspaceId}:id:${principal.principalId}`, principal);
  runtime.principals.set(`${workspaceId}:name:${principal.name}`, principal);
  const store = new MemoryStore({
    userId: USER_ID,
    workspaceId,
    email: "invitee@example.test",
    principalId: principal.principalId,
    principalName: principal.name,
  });
  const { result } = await run(
    payload({ workspace_id: workspaceId }),
    runtime,
    store,
    "different-name",
  );
  assert.equal(result.checkpointShortCircuit, true);
  assert.equal(runtime.calls.accept, 0);
  assert.equal(runtime.calls.create, 0);
  assert.equal(store.profile.workspaceId, workspaceId);
  assert.ok(
    runtime.progress.some((entry) =>
      entry.message === "Already connected as existing-agent; --name ignored."
    ),
  );
});

test("full double-run converges to one accept and one principal", async () => {
  const linkPayload = payload();
  const runtime = new FakeRuntime();
  const store = new MemoryStore({
    userId: USER_ID,
    email: "invitee@example.test",
  });
  const first = await run(linkPayload, runtime, store);
  const second = await run(linkPayload, runtime, store);
  assert.equal(first.result.principalId, second.result.principalId);
  assert.equal(runtime.calls.accept, 1);
  assert.equal(runtime.calls.create, 1);
  assert.equal(second.result.checkpointShortCircuit, true);
});

test("already-connected recovery does not overwrite a deliberately switched default", async () => {
  const linkPayload = payload();
  const runtime = new FakeRuntime();
  const store = new MemoryStore({
    userId: USER_ID,
    email: "invitee@example.test",
  });
  await run(linkPayload, runtime, store);
  const deliberateDefault = randomUUID();
  store.profile.workspaceId = deliberateDefault;
  runtime.acceptStatus = "forbidden";
  const rerun = await run(linkPayload, runtime, store);
  assert.equal(rerun.result.acceptedFresh, false);
  assert.equal(store.profile.workspaceId, deliberateDefault);
  assert.equal(
    runtime.progress.filter((entry) => entry.step === "default").length,
    0,
  );
});

test("live principal is reused and auto-name escapes taken rows with a bounded suffix", async () => {
  const workspaceId = randomUUID();
  const runtime = new FakeRuntime();
  const existing = {
    principalId: randomUUID(),
    name: "invitee@machine-22222222",
  };
  runtime.principals.set(`${workspaceId}:name:${existing.name}`, existing);
  const reused = await run(payload({ workspace_id: workspaceId }), runtime);
  assert.equal(reused.result.principalId, existing.principalId);
  assert.equal(runtime.calls.create, 0);

  const suffixRuntime = new FakeRuntime();
  suffixRuntime.takenNames.add(`${workspaceId}:invitee@machine-22222222`);
  const suffixed = await run(
    payload({ workspace_id: workspaceId }),
    suffixRuntime,
  );
  assert.equal(suffixed.result.principalName, "invitee@machine-22222222-2");
  assert.equal(suffixRuntime.calls.create, 2);
});

test("a revoked checkpoint name is suffixed and its principal id is never reused", async () => {
  const workspaceId = randomUUID();
  const revokedPrincipalId = randomUUID();
  const runtime = new FakeRuntime();
  runtime.acceptStatus = "forbidden";
  runtime.memberships.add(workspaceId);
  runtime.takenNames.add(`${workspaceId}:invitee@machine-22222222`);
  const store = new MemoryStore({
    userId: USER_ID,
    workspaceId,
    principalId: revokedPrincipalId,
    principalName: "invitee@machine-22222222",
  });
  const { result } = await run(
    payload({ workspace_id: workspaceId }),
    runtime,
    store,
  );
  assert.equal(result.principalName, "invitee@machine-22222222-2");
  assert.notEqual(result.principalId, revokedPrincipalId);
  assert.equal(store.profile.principalId, result.principalId);
});

test("explicit names are strict, reuse own live rows, and uniformly refuse taken rows", async () => {
  assert.equal(validateExplicitPrincipalName("laptop-agent"), "laptop-agent");
  for (const invalid of [
    "Laptop-Agent",
    "laptop agent",
    "\u001b[31magent",
    "\u202eagent",
    "x".repeat(81),
  ]) {
    assert.throws(() => validateExplicitPrincipalName(invalid), /--name/);
  }
  const invalidRuntime = new FakeRuntime();
  invalidRuntime.session = null;
  await assert.rejects(
    run(payload(), invalidRuntime, undefined, "\u202e"),
    /--name/,
  );
  assert.equal(invalidRuntime.calls.pin, 0);
  assert.equal(invalidRuntime.calls.current, 0);
  assert.equal(invalidRuntime.calls.login, 0);
  assert.equal(sanitizePrincipalName("USER On HOST", { truncate: true }), "user-on-host");

  const workspaceId = randomUUID();
  const runtime = new FakeRuntime();
  const existing = { principalId: randomUUID(), name: "laptop-agent" };
  runtime.principals.set(`${workspaceId}:name:laptop-agent`, existing);
  const reused = await run(
    payload({ workspace_id: workspaceId }),
    runtime,
    undefined,
    "laptop-agent",
  );
  assert.equal(reused.result.principalId, existing.principalId);
  assert.equal(runtime.calls.create, 0);

  for (const holder of ["revoked row", "another member's live row"]) {
    const takenRuntime = new FakeRuntime();
    takenRuntime.takenNames.add(`${workspaceId}:laptop-agent`);
    await assert.rejects(
      run(
        payload({ workspace_id: workspaceId }),
        takenRuntime,
        undefined,
        "laptop-agent",
      ),
      (error: unknown) => {
        assert.equal(
          (error as Error).message,
          'The name "laptop-agent" is already taken in this workspace. Re-run with a different --name.',
          holder,
        );
        return true;
      },
    );
    assert.equal(takenRuntime.calls.create, 1);
    assert.equal(
      [...takenRuntime.principals.values()].some((entry) =>
        entry.name === "laptop-agent-2"
      ),
      false,
    );
  }
});

test("auto-name suffix cap points to --name", async () => {
  const workspaceId = randomUUID();
  const runtime = new FakeRuntime();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const name = attempt === 1
      ? "invitee@machine-22222222"
      : `invitee@machine-22222222-${attempt}`;
    runtime.takenNames.add(`${workspaceId}:${name}`);
  }
  await assert.rejects(
    run(payload({ workspace_id: workspaceId }), runtime),
    /Re-run with --name <your-choice>/,
  );
  assert.equal(runtime.calls.create, 5);
});

test("JSON progress is machine-readable on stdout with human narration on stderr", () => {
  let stdout = "";
  let stderr = "";
  writeAcceptProgress(
    {
      step: "ready",
      message: "Connected without exposing the invite capability.",
      data: { workspace_id: "11111111-1111-4111-8111-111111111111" },
    },
    {
      json: true,
      stdout: { write: (value) => stdout += value },
      stderr: { write: (value) => stderr += value },
    },
  );
  const machine = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(machine.type, "progress");
  assert.equal(machine.step, "ready");
  assert.match(stderr, /Connected/);
  assert.doesNotMatch(stdout + stderr, /swm_inv_|coswarm:\/\/accept\//);
});

async function cli(
  arguments_: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...arguments_,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ALLOW_INSECURE_STORE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  child.stdin.end(stdin);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("CLI link stdin/mixed target/positional warning and legacy --name grammar", async () => {
  const unknown = payload({ url: "https://unknown.example" });
  const link = encodeInviteLink(unknown);
  const stdinResult = await cli(["accept", "--link-stdin", "--json"], link);
  assert.equal(stdinResult.code, 1);
  assert.match(stdinResult.stderr, /non-interactive mode refuses before login/);
  assert.doesNotMatch(stdinResult.stderr, /swm_inv_|invitation_token/);

  const mixed = await cli([
    "accept",
    link,
    "--url",
    "http://127.0.0.1:54321",
    "--anon-key",
    "anon",
  ]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /do not combine/);

  const positional = await cli(["accept", link]);
  assert.equal(positional.code, 1);
  assert.match(positional.stderr, /shell history/);
  assert.doesNotMatch(positional.stderr, /swm_inv_/);

  const legacyName = await cli([
    "accept",
    token(),
    "--name",
    "agent",
    "--url",
    "http://127.0.0.1:54321",
    "--anon-key",
    "anon",
  ]);
  assert.equal(legacyName.code, 1);
  assert.match(legacyName.stderr, /unknown option: --name/);

  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(
    help.stdout,
    /--link-stdin and --json hard-fail without a prompt/,
  );
});
