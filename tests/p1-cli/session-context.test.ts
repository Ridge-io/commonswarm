import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile, lstat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { access } from "node:fs/promises";
import {
  SessionContextError,
  defaultSessionRootDirectory,
  holdSessionReceiverLock,
  newSessionBinding,
  parseSessionContext,
  publicSessionStatus,
  readSessionContext,
  releaseSessionReceiverLock,
  sessionReceiverLockPath,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { generateSessionKey } from "../../src/cloud/session-proof.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOST = "thread-synthetic-host-1";

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cswarm-session-"));
  await chmod(root, 0o700);
  return root;
}

async function tokenFile(root: string): Promise<string> {
  const dir = join(root, "cred");
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, "synthetic-token.json");
  await writeFile(path, '{"synthetic":true}\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function document(root: string, tokenPath: string) {
  return newSessionBinding({
    target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    provider: "codex",
    mode: "interactive",
    hostSessionId: HOST,
    tokenFile: tokenPath,
  });
}

test("successful write uses 0600 file in 0700 directory and never copies the token", async () => {
  const root = await tempRoot();
  try {
    const tokenPath = await tokenFile(root);
    const contextPath = join(root, "session.json");
    const written = await writeSessionContext(contextPath, document(root, tokenPath));
    const info = await lstat(contextPath);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.mode & 0o777, 0o600);
    const dir = await lstat(root);
    assert.equal(dir.mode & 0o777, 0o700);
    const raw = JSON.stringify(written);
    assert.doesNotMatch(raw, /swm_agt_/);
    assert.equal(written.token_file, tokenPath);
    const status = publicSessionStatus(written);
    assert.equal("session_key" in status, false);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(written.session_key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second receiver lock is refused and a dead pid is reclaimable", async () => {
  const root = await tempRoot();
  try {
    const tokenPath = await tokenFile(root);
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, document(root, tokenPath));
    const first = await holdSessionReceiverLock(contextPath, "foreground");
    assert.equal(first.kind, "foreground");
    assert.equal(first.pid, process.pid);
    await assert.rejects(
      () => holdSessionReceiverLock(contextPath, "listen"),
      (error: unknown) =>
        error instanceof SessionContextError &&
        error.code === "session_receiver_busy",
    );
    await releaseSessionReceiverLock(contextPath);
    const deadPath = sessionReceiverLockPath(contextPath);
    await writeFile(
      deadPath,
      `${JSON.stringify({ version: 1, kind: "listen", pid: 999_999_999 })}\n`,
      { mode: 0o600 },
    );
    await chmod(deadPath, 0o600);
    const reclaimed = await holdSessionReceiverLock(contextPath, "foreground");
    assert.equal(reclaimed.kind, "foreground");
    assert.equal(reclaimed.pid, process.pid);
    await releaseSessionReceiverLock(contextPath);
    await assert.rejects(() => access(deadPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink context is rejected", async () => {
  const root = await tempRoot();
  try {
    const tokenPath = await tokenFile(root);
    const real = join(root, "real.json");
    await writeSessionContext(real, document(root, tokenPath));
    const link = join(root, "link.json");
    await symlink(real, link);
    await assert.rejects(
      () => readSessionContext(link),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "session_context_symlink",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("insecure mode is rejected", async () => {
  const root = await tempRoot();
  try {
    const tokenPath = await tokenFile(root);
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, document(root, tokenPath));
    await chmod(contextPath, 0o644);
    await assert.rejects(
      () => readSessionContext(contextPath),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "session_context_insecure_mode",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt context is rejected closed", async () => {
  const root = await tempRoot();
  try {
    const contextPath = join(root, "session.json");
    await writeFile(contextPath, "{not-json", { mode: 0o600 });
    await chmod(contextPath, 0o600);
    await assert.rejects(
      () => readSessionContext(contextPath),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "session_context_corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relative path is rejected before any write", async () => {
  await assert.rejects(
    () => writeSessionContext("relative.json", document("/tmp", "/tmp/x")),
    (error: unknown) =>
      error instanceof SessionContextError &&
      error.code === "session_context_path_not_absolute",
  );
});

test("context inside a git repository is rejected", async () => {
  const repoFile = join(process.cwd(), "scratch-session-must-not-write.json");
  await assert.rejects(
    () => writeSessionContext(repoFile, document(process.cwd(), repoFile)),
    (error: unknown) =>
      error instanceof SessionContextError &&
      (error.code === "session_context_inside_repository" ||
        error.code === "session_context_token_file_invalid"),
  );
});

test("parseSessionContext refuses a short key and a token copy field", () => {
  assert.throws(
    () => parseSessionContext(JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:9",
      profile_id: "a".repeat(24),
      workspace_id: WORKSPACE,
      principal_id: PRINCIPAL,
      session_id: WORKSPACE,
      generation: 1,
      session_key: "short",
      provider: "codex",
      mode: "interactive",
      host_session_id: HOST,
      token_file: "/tmp/token",
      acquire_command_id: "cmd_aaaaaaaa",
      host_label: null,
    })),
    (error: unknown) =>
      error instanceof SessionContextError && error.code === "session_context_corrupt",
  );
  assert.equal(generateSessionKey().length, 43);
});

test("default session root is under config, not a repo", () => {
  assert.match(defaultSessionRootDirectory(), /cswarm\/sessions$/);
});
