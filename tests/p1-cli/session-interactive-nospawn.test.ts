import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  runInteractiveReceiveOnce,
  runInteractiveReceiver,
} from "../../src/cloud/session-receiver.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import { generateSessionKey } from "../../src/cloud/session-proof.js";
import type { DeliveryRow } from "../../src/cloud/delivery.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIGNAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FORBIDDEN_IMPORTS = [
  "grok-model",
  "claude-model",
  "codex-model",
  "opencode-model",
  "child_process",
  "node:child_process",
  "../host/",
];

const FORBIDDEN_GRAPH = [
  "/host/claude.",
  "/host/codex.",
  "/host/opencode.",
  "/host/grok.",
  "/listener/grok-model.",
  "/listener/claude-model.",
  "/listener/codex-model.",
  "/listener/opencode-model.",
];

function staticSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:^|\n)\s*(import(?:\s+type)?\s+[\s\S]*?\sfrom\s+|export\s+\*\s+from\s+|export\s+\{[\s\S]*?\}\s+from\s+)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]!.startsWith("import type")) continue;
    specs.push(match[2]!);
  }
  return specs;
}

function walkStaticGraph(entryRel: string): string[] {
  const rootDir = fileURLToPath(new URL("../../", import.meta.url));
  const seen = new Set<string>();
  const queue = [resolve(rootDir, entryRel)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of staticSpecifiers(source)) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolve(file, "..", spec);
      const withTs = resolved.endsWith(".ts") || resolved.endsWith(".js")
        ? resolved
        : `${resolved}.ts`;
      queue.push(withTs);
    }
  }
  return [...seen];
}

test("session command module graph excludes ACP host and model modules", () => {
  const files = [
    ...walkStaticGraph("src/cli.ts"),
    ...walkStaticGraph("src/cloud/session-cli.ts"),
    ...walkStaticGraph("src/cloud/session-receiver.ts"),
  ];
  const hits = files.filter((file) =>
    FORBIDDEN_GRAPH.some((token) => file.includes(token)),
  );
  assert.deepEqual(hits, []);
});

test("interactive receiver source has no ACP or model import path", () => {
  for (const rel of [
    "../../src/cloud/session-receiver.ts",
    "../../src/cloud/session-cli.ts",
  ]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    const imports = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");
    for (const token of FORBIDDEN_IMPORTS) {
      assert.doesNotMatch(
        imports,
        new RegExp(token.replace("/", "\\/"), "i"),
        `${rel} must not import ${token}`,
      );
    }
  }
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-interactive-"));
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
      provider: "codex",
      mode: "interactive",
      hostSessionId: "thread-1",
      tokenFile,
    }),
    generation: 1,
    session_key: generateSessionKey(),
  };
  const contextPath = join(root, "session.json");
  await writeSessionContext(contextPath, context);
  return { root, context, contextPath };
}

function row(): DeliveryRow {
  return {
    signal: {
      id: SIGNAL,
      workspace_id: WORKSPACE,
      from: "11111111-1111-4111-8111-111111111111",
      from_kind: "user",
      to: null,
      to_agent: PRINCIPAL,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: "synthetic ask",
      until: "2099-01-01T00:00:00.000Z",
      created_at: "2026-09-06T00:00:00.000Z",
    },
    leaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    leasedUntil: "2099-01-01T00:00:00.000Z",
    senderOwnerRelation: "same_owner",
    recipientPosition: 0,
    recipientCount: 1,
  };
}

test("interactive success and failure paths never construct an ACP model", async () => {
  const { root, context, contextPath } = await harness();
  try {
    const client = new AgentSessionClient({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher: (async () => new Response(JSON.stringify({
        ok: true,
        status: "accepted",
        generation: 1,
      }), { status: 200 })) as typeof fetch,
    });
    const manager = new AgentSessionManager({
      client,
      credential: async () => `swm_agt_${"S".repeat(43)}`,
      workspaceId: WORKSPACE,
      contextPath,
      context,
    });
    const seen = new Set<string>();
    const pass = await runInteractiveReceiveOnce({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      credential: `swm_agt_${"S".repeat(43)}`,
      contextPath,
      context,
      manager,
      hostInjection: {
        async inject() {
          return { ok: true };
        },
      },
      hostIdentityTrusted: true,
      observedHostSessionId: "thread-1",
      claimClient: {
        async claim() {
          return [row()];
        },
        async ack() {},
      },
    }, seen);
    assert.equal(pass.acked, 1);

    await assert.rejects(
      () => runInteractiveReceiveOnce({
        target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
        credential: `swm_agt_${"S".repeat(43)}`,
        contextPath,
        context,
        manager,
        hostInjection: {
          async inject() {
            throw new Error("host injection failed");
          },
        },
        hostIdentityTrusted: true,
        observedHostSessionId: "thread-1",
        claimClient: {
          async claim() {
            return [row()];
          },
          async ack() {
            throw new Error("ack must not run after injection failure");
          },
        },
      }, new Set()),
      /host injection failed/,
    );

    const controller = new AbortController();
    controller.abort();
    const status = await runInteractiveReceiver({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      credential: `swm_agt_${"S".repeat(43)}`,
      contextPath,
      context,
      manager,
      hostInjection: null,
      signal: controller.signal,
      sleep: async () => {},
      claimClient: {
        async claim() {
          return [];
        },
        async ack() {},
      },
    });
    assert.equal(status.mode, "interactive");
    assert.equal(status.receive_verification, "manual");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
