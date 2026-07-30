import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cloudTarget } from "../../src/cloud/config.js";
import type {
  CredentialProfile,
  CredentialRecord,
  CredentialStore,
} from "../../src/cloud/storage.js";
import {
  clearWorkspaceDefault,
  cloudWorkspaceDirectory,
  DEFAULT_MEMBERSHIP_REVOKED,
  relativeAge,
  relativeExpiry,
  renderStatus,
  resolveWorkspaceMember,
  resolveWorkspace,
  selectWorkspace,
  WorkspaceAmbiguousNameError,
  type WorkspaceDirectory,
  WorkspaceResolutionError,
  type WorkspaceSession,
  type WorkspaceSummary,
  WorkspaceUnavailableError,
  workspaceOverride,
} from "../../src/cloud/workspaces.js";

test("member selection is exact and ambiguous names require a UUID", () => {
  const first = {
    user_id: USER_ID,
    name: "Alex",
    role: "owner" as const,
    you: true,
  };
  const second = {
    user_id: DEVICE_ID,
    name: "Alex",
    role: "member" as const,
    you: false,
  };
  assert.equal(resolveWorkspaceMember(USER_ID, [first, second]), first);
  assert.throws(
    () => resolveWorkspaceMember("Alex", [first, second]),
    /ambiguous.*full user id/i,
  );
  assert.throws(
    () => resolveWorkspaceMember("alex", [first, second]),
    /exact name/i,
  );
});

class MemoryStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "workspace test memory";
  record: CredentialRecord | null = null;
  writes = 0;
  profile: CredentialProfile;

  constructor(userId: string, workspaceId: string | null = null) {
    this.profile = {
      version: 1,
      userId,
      workspaceId,
      email: "quill@example.test",
      principalId: workspaceId === null ? null : randomUUID(),
      principalName: workspaceId === null ? null : "quill-agent",
      pendingCommands: {},
    };
  }

  async read(): Promise<CredentialRecord | null> {
    return this.record === null ? null : structuredClone(this.record);
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
    this.writes += 1;
    this.profile = structuredClone(profile);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const session: WorkspaceSession = {
  accessToken: "test-access",
  userId: USER_ID,
  deviceId: DEVICE_ID,
};

function project(
  workspace_id: string,
  name: string,
  role: WorkspaceSummary["role"] = "member",
  archived = false,
): WorkspaceSummary {
  return { workspace_id, name, role, archived };
}

function directory(
  projects: readonly WorkspaceSummary[],
  onList: () => void = () => undefined,
): WorkspaceDirectory {
  return {
    async list(): Promise<WorkspaceSummary[]> {
      onList();
      // structuredClone gives a fresh mutable array; the readonly is on the parameter.
      return structuredClone(projects) as WorkspaceSummary[];
    },
    async status() {
      return { members: [], agents: [], tasks: [] };
    },
  };
}

async function runCli(
  values: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const environment = { ...process.env };
  delete environment.SWARM_CLOUD_WORKSPACE_ID;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...values,
  ], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("workspace override preserves flag then env precedence without a read", async () => {
  assert.equal(workspaceOverride(WORKSPACE_A, WORKSPACE_B), WORKSPACE_A);
  assert.equal(workspaceOverride(undefined, WORKSPACE_B), WORKSPACE_B);
  assert.equal(workspaceOverride(undefined, undefined), null);
  assert.throws(
    () => workspaceOverride("not-a-uuid", WORKSPACE_B),
    /--workspace-id/,
  );

  let reads = 0;
  const selected = await resolveWorkspace({
    explicit: WORKSPACE_A,
    environmental: WORKSPACE_B,
    session,
    store: new MemoryStore(USER_ID),
    directory: directory([], () => reads += 1),
  });
  assert.equal(selected, WORKSPACE_A);
  assert.equal(reads, 0);
});

test("validated human overrides reject foreign and unknown projects uniformly", async () => {
  const store = new MemoryStore(USER_ID);
  assert.equal(
    await resolveWorkspace({
      explicit: WORKSPACE_A,
      session,
      store,
      directory: directory([project(WORKSPACE_A, "Alpha")]),
      validateOverride: true,
    }),
    WORKSPACE_A,
  );

  const failures: WorkspaceUnavailableError[] = [];
  for (const explicit of [WORKSPACE_B, WORKSPACE_C]) {
    await assert.rejects(
      resolveWorkspace({
        explicit,
        session,
        store,
        directory: directory([project(WORKSPACE_A, "Alpha")]),
        validateOverride: true,
      }),
      (error) => {
        assert.ok(error instanceof WorkspaceUnavailableError);
        failures.push(error);
        return true;
      },
    );
  }
  assert.equal(failures[0]!.message, failures[1]!.message);
  assert.deepEqual(failures[0]!.structured(), failures[1]!.structured());
  assert.equal(failures[0]!.code, "project_not_available");
});

test("agent credentials never infer a human project and existing commands reject --json", async () => {
  const base = [
    "command",
    "acquire",
    "--url",
    "http://127.0.0.1:9",
    "--anon-key",
    "test-anon-key",
    "--task-id",
    "44444444-4444-4444-8444-444444444444",
    "--ttl-ms",
    "1000",
    "--agent-token-stdin",
  ];
  const token = `swm_agt_${"A".repeat(43)}`;
  const noOverride = await runCli(base, token);
  assert.equal(noOverride.code, 1);
  assert.equal(noOverride.stdout, "");
  assert.match(noOverride.stderr, /^cswarm: not logged in;/);
  assert.doesNotMatch(noOverride.stderr, /ECONNREFUSED|session refresh/);

  const json = await runCli([...base, "--json"], token);
  assert.equal(json.code, 1);
  assert.equal(json.stdout, "");
  assert.match(json.stderr, /unknown option: --json/);
});

test("resolver uses live default, persists a sole project, then fails closed", async () => {
  const two = [
    project(WORKSPACE_B, "Beta"),
    project(WORKSPACE_A, "Alpha", "owner"),
  ];
  const defaultStore = new MemoryStore(USER_ID, WORKSPACE_B);
  assert.equal(
    await resolveWorkspace({
      session,
      store: defaultStore,
      directory: directory(two),
    }),
    WORKSPACE_B,
  );
  assert.equal(defaultStore.writes, 0);

  const soleStore = new MemoryStore(USER_ID);
  assert.equal(
    await resolveWorkspace({
      session,
      store: soleStore,
      directory: directory([two[1]!]),
    }),
    WORKSPACE_A,
  );
  assert.equal(soleStore.profile.workspaceId, WORKSPACE_A);
  assert.equal(soleStore.writes, 1);

  const multiStore = new MemoryStore(USER_ID);
  await assert.rejects(
    resolveWorkspace({
      session,
      store: multiStore,
      directory: directory(two),
    }),
    (error) => {
      assert.ok(error instanceof WorkspaceResolutionError);
      assert.equal(error.code, "project_selection_required");
      assert.deepEqual(
        error.structured().projects,
        [
          { workspace_id: WORKSPACE_A, name: "Alpha", role: "owner" },
          { workspace_id: WORKSPACE_B, name: "Beta", role: "member" },
        ],
      );
      return true;
    },
  );
  assert.equal(multiStore.writes, 0);
});

test("revoked saved default warns once, clears the agent checkpoint, and falls through", async () => {
  const store = new MemoryStore(USER_ID, WORKSPACE_A);
  const warnings: typeof DEFAULT_MEMBERSHIP_REVOKED[] = [];
  const options = {
    session,
    store,
    directory: directory([project(WORKSPACE_B, "Replacement", "admin")]),
    warn: (warning: typeof DEFAULT_MEMBERSHIP_REVOKED) =>
      warnings.push(warning),
  };
  assert.equal(await resolveWorkspace(options), WORKSPACE_B);
  assert.deepEqual(warnings, [DEFAULT_MEMBERSHIP_REVOKED]);
  assert.equal(store.profile.workspaceId, WORKSPACE_B);
  assert.equal(store.profile.principalId, null);
  assert.equal(store.profile.principalName, null);
  assert.equal(await resolveWorkspace(options), WORKSPACE_B);
  assert.equal(warnings.length, 1);
});

test("selection is exact, collision-safe, and writes only after validation", async () => {
  const projects = [
    project(WORKSPACE_A, "Launch"),
    project(WORKSPACE_B, "Launch"),
    project(WORKSPACE_C, "Other", "owner", true),
  ];
  const byId = new MemoryStore(USER_ID);
  assert.equal(
    (await selectWorkspace(WORKSPACE_A.toUpperCase(), projects, byId, USER_ID))
      .workspace_id,
    WORKSPACE_A,
  );
  assert.equal(byId.writes, 1);

  const byName = new MemoryStore(USER_ID);
  assert.equal(
    (await selectWorkspace("Other", projects, byName, USER_ID)).workspace_id,
    WORKSPACE_C,
  );
  assert.equal(byName.profile.workspaceId, WORKSPACE_C);

  const ambiguous = new MemoryStore(USER_ID, WORKSPACE_C);
  await assert.rejects(
    selectWorkspace("Launch", projects, ambiguous, USER_ID),
    (error) => {
      assert.ok(error instanceof WorkspaceAmbiguousNameError);
      assert.deepEqual(
        error.workspaces.map((workspace) => workspace.workspace_id),
        [WORKSPACE_A, WORKSPACE_B],
      );
      return true;
    },
  );
  assert.equal(ambiguous.writes, 0);
  assert.equal(ambiguous.profile.workspaceId, WORKSPACE_C);

  const noPrefix = new MemoryStore(USER_ID, WORKSPACE_C);
  await assert.rejects(
    selectWorkspace("Lau", projects, noPrefix, USER_ID),
    WorkspaceUnavailableError,
  );
  assert.equal(noPrefix.writes, 0);
});

test("sanitized-name collisions are ambiguous while full ids still work", async () => {
  const projects = [
    project(WORKSPACE_A, "Same"),
    project(WORKSPACE_B, "Same"),
  ];
  const store = new MemoryStore(USER_ID);
  await assert.rejects(
    selectWorkspace("Sa\u202eme", projects, store, USER_ID),
    WorkspaceAmbiguousNameError,
  );
  assert.equal(store.writes, 0);
  assert.equal(
    (await selectWorkspace(WORKSPACE_B, projects, store, USER_ID)).workspace_id,
    WORKSPACE_B,
  );
});

test("foreign and unknown ids produce byte-identical errors and no profile writes", async () => {
  const foreign = new MemoryStore(USER_ID, WORKSPACE_A);
  const unknown = new MemoryStore(USER_ID, WORKSPACE_A);
  let foreignError = "";
  let unknownError = "";
  await assert.rejects(
    selectWorkspace(WORKSPACE_B, [project(WORKSPACE_A, "Mine")], foreign, USER_ID),
    (error) => {
      assert.ok(error instanceof WorkspaceUnavailableError);
      foreignError = JSON.stringify(error.structured());
      return true;
    },
  );
  await assert.rejects(
    selectWorkspace(WORKSPACE_C, [project(WORKSPACE_A, "Mine")], unknown, USER_ID),
    (error) => {
      assert.ok(error instanceof WorkspaceUnavailableError);
      unknownError = JSON.stringify(error.structured());
      return true;
    },
  );
  assert.equal(foreignError, unknownError);
  assert.equal(foreign.writes, 0);
  assert.equal(unknown.writes, 0);
});

test("TTY-marked multi-project resolution fails before a prompt can block", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    const invocation = resolveWorkspace({
      session,
      store: new MemoryStore(USER_ID),
      directory: directory([
        project(WORKSPACE_A, "Alpha"),
        project(WORKSPACE_B, "Beta"),
      ]),
    });
    const outcome = await Promise.race([
      invocation.then(
        () => "resolved",
        (error) =>
          error instanceof WorkspaceResolutionError ? "failed-closed" : "other",
      ),
      delay(250).then(() => "timeout"),
    ]);
    assert.equal(outcome, "failed-closed");
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  }
});

test("cloud directory uses swarm_read and sanitizes attacker-controlled labels", async () => {
  const memberId = USER_ID;
  const principalId = "33333333-3333-4333-8333-333333333333";
  const taskId = "44444444-4444-4444-8444-444444444444";
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input
        : input.url,
    );
    requests.push(url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-access");
    assert.equal(headers.get("apikey"), "anon-test-key");
    assert.equal(headers.get("accept-profile"), "swarm_read");
    const bodies: Record<string, unknown[]> = {
      memberships: [{
        workspace_id: WORKSPACE_A,
        user_id: USER_ID,
        role: "owner",
      }],
      workspaces: [{
        workspace_id: WORKSPACE_A,
        name: "\u001b[31mLaunch\u001b[0m\u202e",
        archived_at: null,
      }],
      member_profiles: [{
        workspace_id: WORKSPACE_A,
        user_id: memberId,
        display_name: "Q\u0000uill",
        role: "owner",
      }],
      agent_principals: [{
        workspace_id: WORKSPACE_A,
        principal_id: principalId,
        owner_user_id: memberId,
        name: "\u001b[31mAgent\u001b[0m",
        revoked_at: null,
      }],
      agent_runs: [{
        principal_id: principalId,
        device_id: DEVICE_ID,
      }],
      tasks: [{
        workspace_id: WORKSPACE_A,
        task_id: taskId,
        slug: "Fix\u202e task",
        lifecycle: "active",
        owner: principalId,
        lease_expiry: "2026-07-24T20:12:00.000Z",
      }],
    };
    return new Response(JSON.stringify(bodies[url.pathname.split("/").pop()!] ?? []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const cloud = cloudWorkspaceDirectory(
    cloudTarget("http://127.0.0.1:54321", "anon-test-key"),
    fetcher,
  );
  const projects = await cloud.list(session);
  assert.equal(projects[0]?.name, "Launch");
  const status = await cloud.status(session, WORKSPACE_A);
  assert.equal(status.members[0]?.name, "Quill");
  assert.equal(status.agents[0]?.name, "Agent");
  assert.equal(status.agents[0]?.this_machine, true);
  assert.equal(status.tasks[0]?.slug, "Fix task");
  assert.equal(status.tasks[0]?.holder?.name, "Agent");
  assert.ok(requests.every((request) => request.pathname.startsWith("/rest/v1/")));
});

test("status rendering gives empty-work guidance and human lease time", () => {
  const selected = project(WORKSPACE_A, "Launch", "owner");
  const empty = renderStatus({
    userId: USER_ID,
    identityLabel: "quill@example.test",
    projectCount: 1,
    selected,
    status: { members: [], agents: [], tasks: [] },
  });
  assert.match(empty, /No work yet — create a task with/);
  assert.doesNotMatch(empty, /lease epoch/i);

  const rendered = renderStatus({
    userId: USER_ID,
    identityLabel: "quill@example.test",
    projectCount: 1,
    selected,
    now: Date.parse("2026-07-24T20:00:00.000Z"),
    status: {
      members: [],
      agents: [],
      tasks: [{
        task_id: "44444444-4444-4444-8444-444444444444",
        slug: "ship",
        state: "active",
        holder: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Quill",
          kind: "agent",
        },
        lease_expiry: "2026-07-24T20:12:00.000Z",
      }],
    },
  });
  assert.match(rendered, /held by Quill .*expires in 12m/);
  assert.equal(
    relativeAge(
      "2026-07-24T19:58:00.000Z",
      Date.parse("2026-07-24T20:00:00.000Z"),
    ),
    "2m ago",
  );
  assert.equal(
    relativeExpiry(
      "2026-07-24T19:58:00.000Z",
      Date.parse("2026-07-24T20:00:00.000Z"),
    ),
    "expired 2m ago",
  );
});

test("clear default is conditional and cannot erase a concurrent selection", async () => {
  const store = new MemoryStore(USER_ID, WORKSPACE_B);
  assert.equal(
    await clearWorkspaceDefault(store, USER_ID, WORKSPACE_A),
    false,
  );
  assert.equal(store.profile.workspaceId, WORKSPACE_B);
  assert.equal(store.writes, 0);
});
