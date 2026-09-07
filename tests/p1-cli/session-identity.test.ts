import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { commandEndpoint } from "../../src/cloud/config.js";
import {
  openBoundAgentCredential,
  startManagedSession,
} from "../../src/cloud/session-cli.js";
import {
  SESSION_ACQUIRE_BINDING_FIELDS,
  SessionContextError,
  newSessionBinding,
  readSessionContext,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { AgentSessionError } from "../../src/cloud/session-errors.js";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  ACQUIRE_AGENT_SESSION_KIND,
} from "../../src/cloud/session-contract.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PRINCIPAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TOKEN = `swm_agt_${"S".repeat(43)}`;

async function tokenPath(): Promise<{ root: string; tokenFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "cswarm-id-"));
  await chmod(root, 0o700);
  const credDir = join(root, "cred");
  await mkdir(credDir, { mode: 0o700 });
  await chmod(credDir, 0o700);
  const tokenFile = join(credDir, "token.json");
  await writeFile(tokenFile, "{}\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return { root, tokenFile };
}

test("mismatched principal refuses before any command write", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    const writes: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/functions/v1/command")) {
        writes.push(url);
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => startManagedSession({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        credential: TOKEN,
        tokenFile,
        tokenPrincipalId: OTHER_PRINCIPAL,
        mode: "interactive",
        provider: "codex",
        hostSessionId: "thread-1",
        contextPath: join(root, "session.json"),
        fetcher,
        readIdentity: async () => ({
          principal_id: PRINCIPAL,
          workspace_id: WORKSPACE,
        }),
        runReceiver: false,
      }),
      /token artifact principal/,
    );
    assert.equal(writes.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mismatched workspace refuses before acquire", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    let acquire = 0;
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes(ACQUIRE_AGENT_SESSION_KIND)) acquire += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => startManagedSession({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        credential: TOKEN,
        tokenFile,
        mode: "interactive",
        provider: "codex",
        hostSessionId: "thread-1",
        contextPath: join(root, "session.json"),
        fetcher,
        readIdentity: async () => ({
          principal_id: PRINCIPAL,
          workspace_id: OTHER_WORKSPACE,
        }),
        runReceiver: false,
      }),
      /authenticated workspace/,
    );
    assert.equal(acquire, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same identity acquire writes one command and retries with the same proof", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    const bodies: string[] = [];
    const headerSets: Headers[] = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      headerSets.push(new Headers(init?.headers));
      return new Response(JSON.stringify({
        ok: true,
        status: "accepted",
        generation: 3,
      }), { status: 200 });
    }) as typeof fetch;
    const first = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "codex",
      hostSessionId: "thread-1",
      contextPath: join(root, "session.json"),
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    assert.equal(first.context.generation, 3);
    assert.equal(first.retried, false);
    const commandId = first.context.acquire_command_id;
    const sessionId = first.context.session_id;
    const key = first.context.session_key;
    const stored = await readSessionContext(join(root, "session.json"));
    await writeSessionContext(join(root, "session.json"), {
      ...stored,
      generation: 0,
    });
    const second = await startManagedSession({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      credential: TOKEN,
      tokenFile,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "codex",
      hostSessionId: "thread-1",
      contextPath: join(root, "session.json"),
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    assert.equal(second.retried, true);
    assert.equal(second.context.session_id, sessionId);
    assert.equal(second.context.session_key, key);
    assert.equal(second.context.acquire_command_id, commandId);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.match(bodies[0]!, new RegExp(ACQUIRE_AGENT_SESSION_KIND));
    assert.doesNotMatch(bodies[0]!, /session_key|key_hash/);
    /* The wire contract: the acquire carries the session id and the private
       key as headers (the server stores the digest); the body never does. */
    assert.equal(headerSets.length, 2);
    for (const headers of headerSets) {
      assert.equal(headers.get(AGENT_SESSION_ID_HEADER), sessionId);
      assert.equal(headers.get(AGENT_SESSION_KEY_HEADER), key);
      assert.equal(headers.get(AGENT_SESSION_GENERATION_HEADER), null);
    }
    void commandEndpoint;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed session_not_managed does not claim enforcement is active", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "session_not_managed" }), {
        status: 403,
      })) as typeof fetch;
    await assert.rejects(
      () => startManagedSession({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        credential: TOKEN,
        tokenFile,
        tokenPrincipalId: PRINCIPAL,
        mode: "interactive",
        provider: "grok",
        hostSessionId: "thread-1",
        contextPath: join(root, "session.json"),
        fetcher,
        readIdentity: async () => ({
          principal_id: PRINCIPAL,
          workspace_id: WORKSPACE,
        }),
        runReceiver: false,
      }),
      (error: unknown) =>
        error instanceof AgentSessionError && error.code === "session_not_managed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionContextError stays a named class, not message matching", () => {
  const error = new SessionContextError(
    "session_identity_mismatch",
    "authenticated principal does not match the session context",
  );
  assert.equal(error.code, "session_identity_mismatch");
  assert.equal(error.name, "SessionContextError");
});

test("acquire retry refuses a changed provider binding before acquire", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    const contextPath = join(root, "session.json");
    let acquire = 0;
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes(ACQUIRE_AGENT_SESSION_KIND)) acquire += 1;
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
      tokenFile,
      tokenPrincipalId: PRINCIPAL,
      mode: "interactive",
      provider: "grok",
      hostSessionId: "thread-1",
      hostLabel: "desk",
      contextPath,
      fetcher,
      readIdentity: async () => ({
        principal_id: PRINCIPAL,
        workspace_id: WORKSPACE,
      }),
      runReceiver: false,
    });
    const stored = await readSessionContext(contextPath);
    await writeSessionContext(contextPath, { ...stored, generation: 0 });
    const acquireBeforeRetry = acquire;
    await assert.rejects(
      () => startManagedSession({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        credential: TOKEN,
        tokenFile,
        tokenPrincipalId: PRINCIPAL,
        mode: "interactive",
        provider: "codex",
        hostSessionId: "thread-1",
        hostLabel: "desk",
        contextPath,
        fetcher,
        readIdentity: async () => ({
          principal_id: PRINCIPAL,
          workspace_id: WORKSPACE,
        }),
        runReceiver: false,
      }),
      (error: unknown) => {
        if (
          !(error instanceof SessionContextError) ||
          error.code !== "session_binding_mismatch"
        ) {
          return false;
        }
        for (const field of SESSION_ACQUIRE_BINDING_FIELDS) {
          assert.match(error.message, new RegExp(field));
        }
        return true;
      },
    );
    assert.equal(acquire, acquireBeforeRetry);
    assert.equal(first.retried, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bound command mismatch refuses before any fetch", async () => {
  const { root, tokenFile } = await tokenPath();
  try {
    const otherDir = join(root, "other");
    await mkdir(otherDir, { mode: 0o700 });
    await chmod(otherDir, 0o700);
    const otherToken = join(otherDir, "token.json");
    await writeFile(otherToken, "{}\n", { mode: 0o600 });
    await chmod(otherToken, 0o600);
    const context = {
      ...newSessionBinding({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        principalId: PRINCIPAL,
        provider: "codex",
        mode: "interactive",
        hostSessionId: "thread-1",
        tokenFile,
      }),
      generation: 1,
    };
    await writeSessionContext(join(root, "session.json"), context);
    let fetches = 0;
    let opened = 0;
    const fetcher = (async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => openBoundAgentCredential({
        context,
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        workspaceId: WORKSPACE,
        tokenPrincipalId: PRINCIPAL,
        tokenFile: otherToken,
        fetcher,
        openSession: async () => {
          opened += 1;
          fetches += 1;
          return { bearer: async () => TOKEN };
        },
      }),
      (error: unknown) =>
        error instanceof SessionContextError &&
        error.code === "session_identity_mismatch",
    );
    assert.equal(fetches, 0);
    assert.equal(opened, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
