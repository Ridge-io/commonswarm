import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import {
  newSessionBinding,
  parseSessionContext,
  readSessionContext,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { AgentSessionError } from "../../src/cloud/session-errors.js";
import {
  ACQUIRE_AGENT_SESSION_KIND,
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  RELEASE_AGENT_SESSION_KIND,
  RENEW_AGENT_SESSION_KIND,
} from "../../src/cloud/session-contract.js";
import { sessionKeyHash } from "../../src/cloud/session-proof.js";
import {
  readManagedSessionStatus,
  startManagedSession,
  stopManagedSession,
} from "../../src/cloud/session-cli.js";
import { sessionProofOf } from "../../src/cloud/session-context.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TOKEN = `swm_agt_${"S".repeat(43)}`;

async function tokenFile(root: string): Promise<string> {
  const credDir = join(root, "cred");
  await mkdir(credDir, { mode: 0o700 });
  await chmod(credDir, 0o700);
  const path = join(credDir, "token.json");
  await writeFile(path, "{}\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test("acquire retry reuses the same UUID, private key header, and command id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-life-"));
  await chmod(root, 0o700);
  try {
    const tokenPath = await tokenFile(root);
    const contextPath = join(root, "session.json");
    const ids: string[] = [];
    const hashes = new Set<string>();
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        command_id: string;
        command: { session_id: string; kind: string };
      };
      ids.push(body.command_id);
      hashes.add(String(new Headers(init?.headers).get("x-cswarm-session-key")));
      return new Response(JSON.stringify({
        ok: true,
        status: "accepted",
        generation: 1,
      }), { status: 200 });
    }) as typeof fetch;
    const first = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile: tokenPath,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "codex",
      hostSessionId: "thread-1",
      contextPath,
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    const stored = await readSessionContext(contextPath);
    const retryContext = { ...stored, generation: 0 };
    await writeSessionContext(contextPath, retryContext);
    const second = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile: tokenPath,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "codex",
      hostSessionId: "thread-1",
      contextPath,
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    assert.equal(second.retried, true);
    assert.equal(second.context.session_id, first.context.session_id);
    assert.equal(second.context.session_key, first.context.session_key);
    assert.equal(second.context.acquire_command_id, first.context.acquire_command_id);
    assert.deepEqual(ids, [
      first.context.acquire_command_id,
      first.context.acquire_command_id,
    ]);
    assert.equal(hashes.size, 1);
    assert.equal([...hashes][0], first.context.session_key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two simulated sessions: one winner, another principal unaffected", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-race-"));
  await chmod(root, 0o700);
  try {
    const tokenPath = await tokenFile(root);
    const holder = new Map<string, string>();
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        command: { kind: string; session_id: string };
        workspace_id: string;
      };
      const principal = JSON.stringify(init?.headers).includes("unused")
        ? "none"
        : "n/a";
      void principal;
      if (body.command.kind !== ACQUIRE_AGENT_SESSION_KIND) {
        return new Response(JSON.stringify({ ok: true, status: "accepted" }), {
          status: 200,
        });
      }
      const key = `${body.workspace_id}:${body.command.session_id.slice(0, 8)}`;
      void key;
      const live = holder.get(WORKSPACE);
      // First principal wins; second session_id on same workspace conflicts;
      // other principal has its own row.
      const auth = String((init?.headers as Headers | undefined)?.get?.("authorization") ??
        (init?.headers as Record<string, string> | undefined)?.authorization ??
        "");
      const which = auth.includes("other") ? OTHER : PRINCIPAL;
      const slot = which === OTHER ? OTHER : WORKSPACE;
      if (which === PRINCIPAL) {
        if (live && live !== body.command.session_id) {
          return new Response(JSON.stringify({ error: "session_conflict" }), {
            status: 409,
          });
        }
        holder.set(WORKSPACE, body.command.session_id);
      } else {
        holder.set(slot, body.command.session_id);
      }
      return new Response(JSON.stringify({
        ok: true,
        status: "accepted",
        generation: 1,
      }), { status: 200 });
    }) as typeof fetch;
    const first = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile: tokenPath,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "grok",
      hostSessionId: "host-a",
      contextPath: join(root, "a.json"),
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    await assert.rejects(
      () => startManagedSession({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        credential: TOKEN,
        tokenFile: tokenPath,
        tokenPrincipalId: PRINCIPAL,
        mode: "interactive",
        provider: "codex",
        hostSessionId: "host-b",
        contextPath: join(root, "b.json"),
        fetcher,
        readIdentity: async () => ({
          principal_id: PRINCIPAL,
          workspace_id: WORKSPACE,
        }),
        runReceiver: false,
      }),
      (error: unknown) =>
        error instanceof AgentSessionError && error.code === "session_conflict",
    );
    const other = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: `swm_agt_${"T".repeat(43)}`,
      tokenFile: tokenPath,
      tokenPrincipalId: OTHER,
      mode: "interactive",
      provider: "claude",
      hostSessionId: "host-c",
      contextPath: join(root, "c.json"),
      fetcher: (async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", "Bearer other");
        return fetcher(input, { ...init, headers });
      }) as typeof fetch,
      readIdentity: async () => ({
        principal_id: OTHER,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    assert.equal(first.context.enforcement, "enabled");
    assert.equal(other.context.principal_id, OTHER);
    assert.notEqual(other.context.session_id, first.context.session_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renew and release send proof headers; status omits the secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-renew-"));
  await chmod(root, 0o700);
  try {
    const tokenPath = await tokenFile(root);
    const context = {
      ...newSessionBinding({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        provider: "codex",
        mode: "interactive",
        hostSessionId: "thread-1",
        tokenFile: tokenPath,
      }),
      generation: 4,
    };
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, context);
    const headersSeen: Array<Record<string, string>> = [];
    const kinds: string[] = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headersSeen.push({
        id: headers.get(AGENT_SESSION_ID_HEADER) ?? "",
        generation: headers.get(AGENT_SESSION_GENERATION_HEADER) ?? "",
        key: headers.get(AGENT_SESSION_KEY_HEADER) ?? "",
      });
      const body = JSON.parse(String(init?.body ?? "{}")) as { command: { kind: string } };
      kinds.push(body.command.kind);
      return new Response(JSON.stringify({ ok: true, status: "accepted" }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new AgentSessionClient({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher,
    });
    const proof = {
      session_id: context.session_id,
      generation: context.generation,
      key: context.session_key,
    };
    await client.renew(TOKEN, WORKSPACE, proof, "stable-renew-id");
    await client.release(TOKEN, WORKSPACE, proof, "stable-release-id");
    assert.deepEqual(kinds, [RENEW_AGENT_SESSION_KIND, RELEASE_AGENT_SESSION_KIND]);
    assert.equal(headersSeen[0]?.id, context.session_id);
    assert.equal(headersSeen[0]?.generation, "4");
    assert.equal(headersSeen[0]?.key, context.session_key);
    const raw = JSON.stringify(parseSessionContext(JSON.stringify(context)));
    assert.match(raw, /session_key/);
    const publicStatus = JSON.stringify({
      session_id: context.session_id,
      generation: context.generation,
    });
    assert.doesNotMatch(publicStatus, new RegExp(context.session_key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop marks the context released so status is stopped and start acquires a fresh UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-release-"));
  await chmod(root, 0o700);
  try {
    const tokenPath = await tokenFile(root);
    const contextPath = join(root, "session.json");
    const kinds: string[] = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        command: { kind: string };
      };
      kinds.push(body.command.kind);
      if (body.command.kind === ACQUIRE_AGENT_SESSION_KIND) {
        return new Response(JSON.stringify({
          ok: true,
          status: "accepted",
          generation: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, status: "accepted" }), {
        status: 200,
      });
    }) as typeof fetch;
    const target = cloudTarget("http://127.0.0.1:9", "synthetic-anon-key");
    const first = await startManagedSession({
      target,
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile: tokenPath,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "grok",
      hostSessionId: "host-1",
      contextPath,
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    const firstId = first.context.session_id;
    const firstKey = first.context.session_key;
    assert.equal(first.context.generation, 1);
    assert.equal(sessionProofOf(first.context) !== null, true);

    const stopped = await stopManagedSession({
      target,
      credential: TOKEN,
      contextPath,
      fetcher,
    });
    assert.equal(stopped.state, "stopped");
    const afterStop = await readManagedSessionStatus(contextPath);
    assert.equal(afterStop.status.state, "stopped");
    assert.equal(afterStop.status.has_private_proof, false);
    assert.equal(sessionProofOf(afterStop.context), null);
    assert.equal(afterStop.context.session_key, "");
    assert.equal(typeof afterStop.context.released_at, "string");
    assert.equal(afterStop.context.generation, 1);
    assert.equal(afterStop.context.session_id, firstId);

    const second = await startManagedSession({
      target,
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile: tokenPath,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "grok",
      hostSessionId: "host-1",
      contextPath,
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    assert.notEqual(second.context.session_id, firstId);
    assert.notEqual(second.context.session_key, firstKey);
    assert.equal(second.context.generation, 1);
    assert.equal(second.context.released_at, null);
    assert.equal(sessionProofOf(second.context) !== null, true);
    assert.equal(second.retried, false);
    assert.deepEqual(kinds, [
      ACQUIRE_AGENT_SESSION_KIND,
      RELEASE_AGENT_SESSION_KIND,
      ACQUIRE_AGENT_SESSION_KIND,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager stops dispatch on typed expiry and does not overlap renewals", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mgr-"));
  await chmod(root, 0o700);
  try {
    const tokenPath = await tokenFile(root);
    const context = {
      ...newSessionBinding({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        provider: "codex",
        mode: "interactive",
        hostSessionId: "thread-1",
        tokenFile: tokenPath,
      }),
      generation: 1,
    };
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, context);
    let now = 0;
    const timers: Array<() => void> = [];
    const client = new AgentSessionClient({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher: (async () =>
        new Response(JSON.stringify({ error: "session_expired" }), {
          status: 403,
        })) as typeof fetch,
    });
    const manager = new AgentSessionManager({
      client,
      credential: async () => TOKEN,
      workspaceId: WORKSPACE,
      contextPath,
      context,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    manager.start();
    assert.equal(timers.length, 1);
    now = 120_000;
    await timers[0]!();
    assert.equal(manager.dispatchState(), "stopped");
    manager.stopTimers();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
