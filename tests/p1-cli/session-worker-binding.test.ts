import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { SESSION_CONTEXT_ENV } from "../../src/cloud/session-contract.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { buildListenerPrompt } from "../../src/listener/engine.js";
import {
  boundAdapterEnv,
  envHasSessionBinding,
  listenerSessionIdentity,
  reviewChildEnv,
  workerToolEnv,
  type ManagedSessionBinding,
} from "../../src/listener/session-binding.js";
import { SESSION_PROVIDERS } from "../../src/cloud/session-contract.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitizeChildEnv } from "../../src/host/env.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function binding(): Promise<{ root: string; binding: ManagedSessionBinding }> {
  const root = await mkdtemp(join(tmpdir(), "cswarm-bind-"));
  await chmod(root, 0o700);
  const credDir = join(root, "cred");
  await mkdir(credDir, { mode: 0o700 });
  await chmod(credDir, 0o700);
  const tokenFile = join(credDir, "token.json");
  await writeFile(tokenFile, "{}\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const context = {
    ...newSessionBinding({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      provider: "grok",
      mode: "worker",
      hostSessionId: "thread-worker",
      tokenFile,
    }),
    generation: 2,
  };
  const contextPath = join(root, "session.json");
  await writeSessionContext(contextPath, context);
  return { root, binding: { contextPath, context } };
}

test("worker prompt carries trusted principal and execution identity", async () => {
  const { root, binding: bound } = await binding();
  try {
    const identity = listenerSessionIdentity(bound);
    const prompt = buildListenerPrompt(
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        workspace_id: WORKSPACE,
        from: "11111111-1111-4111-8111-111111111111",
        from_kind: "user",
        to: null,
        to_agent: PRINCIPAL,
        in_reply_to: null,
        about: null,
        kind: "ask",
        body: "hello",
        until: "2099-01-01T00:00:00.000Z",
        created_at: "2026-09-06T00:00:00.000Z",
      },
      "worker",
      {
        senderName: null,
        operatorId: "11111111-1111-4111-8111-111111111111",
        operatorName: null,
        sessionIdentity: identity,
      },
    );
    assert.match(prompt, new RegExp(PRINCIPAL));
    assert.match(prompt, new RegExp(bound.context.session_id));
    assert.match(prompt, /generation 2/);
    assert.match(prompt, /--session-context/);
    assert.doesNotMatch(prompt, new RegExp(bound.context.session_key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review children do not inherit the session binding", async () => {
  const { root, binding: bound } = await binding();
  try {
    const parent = {
      ...process.env,
      [SESSION_CONTEXT_ENV]: bound.contextPath,
      CSWARM_SESSION_KEY: bound.context.session_key,
    };
    const worker = workerToolEnv(parent, bound.contextPath);
    assert.equal(worker[SESSION_CONTEXT_ENV], bound.contextPath);
    assert.equal(worker.CSWARM_SESSION_KEY, undefined);
    const review = reviewChildEnv(parent);
    assert.equal(review[SESSION_CONTEXT_ENV], undefined);
    assert.equal(envHasSessionBinding(review), false);
    const acp = sanitizeChildEnv(parent);
    assert.equal(acp[SESSION_CONTEXT_ENV], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all four adapters share the same binding helper", async () => {
  const { root, binding: bound } = await binding();
  try {
    const cliSource = readFileSync(
      fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(SESSION_PROVIDERS.length, 4);
    assert.equal((cliSource.match(/\.\.\.adapterEnv/g) ?? []).length, 4);
    for (const file of [
      "grok-model.js",
      "opencode-model.js",
      "claude-model.js",
      "codex-model.js",
    ]) {
      assert.match(
        cliSource,
        new RegExp(`await import\\("./listener/${file.replace(".", "\\.")}"\\)`),
      );
    }
    const env = boundAdapterEnv(process.env, bound);
    assert.equal(env.env?.[SESSION_CONTEXT_ENV], bound.contextPath);
    assert.equal("CSWARM_SESSION_KEY" in (env.env ?? {}), false);
    assert.doesNotMatch(JSON.stringify(env), new RegExp(bound.context.session_key));
    const review = reviewChildEnv({
      ...process.env,
      [SESSION_CONTEXT_ENV]: bound.contextPath,
    });
    assert.equal(review[SESSION_CONTEXT_ENV], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
