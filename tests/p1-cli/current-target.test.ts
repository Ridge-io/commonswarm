import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  clearCurrentTarget,
  currentTargetPath,
  readCurrentTarget,
  resolveCloudTarget,
  writeCurrentTarget,
} from "../../src/cloud/current-target.js";

test("current target persists atomically below 0700/0600 state", async () => {
  const parent = await mkdtemp(join(tmpdir(), "coswarm-current-target-"));
  const stateDirectory = join(parent, "state");
  const target = cloudTarget(
    "https://current.example.test/",
    "anon-current-value",
  );
  try {
    await writeCurrentTarget(target, { stateDirectory });
    const path = currentTargetPath({ stateDirectory });
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readCurrentTarget({ stateDirectory }), target);
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")),
      {
        version: 1,
        url: "https://current.example.test",
        anonKey: "anon-current-value",
      },
    );

    assert.equal(await clearCurrentTarget({ stateDirectory }), true);
    assert.equal(await readCurrentTarget({ stateDirectory }), null);
    assert.equal(await clearCurrentTarget({ stateDirectory }), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("target resolution is flag then environment then matching stored target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "coswarm-target-order-"));
  const stateDirectory = join(parent, "state");
  const stored = cloudTarget(
    "https://stored.example.test",
    "stored-anon-key",
  );
  try {
    await writeCurrentTarget(stored, { stateDirectory });

    assert.deepEqual(
      await resolveCloudTarget({ stateDirectory }),
      stored,
    );
    assert.deepEqual(
      await resolveCloudTarget({
        stateDirectory,
        explicitUrl: "https://stored.example.test/",
      }),
      stored,
      "a normalized matching URL may use the stored key",
    );

    const environmental = await resolveCloudTarget({
      stateDirectory,
      environmentalUrl: "https://environment.example.test",
      environmentalAnonKey: "environment-anon-key",
    });
    assert.equal(environmental.url, "https://environment.example.test");
    assert.equal(environmental.anonKey, "environment-anon-key");

    const explicit = await resolveCloudTarget({
      stateDirectory,
      explicitUrl: "https://flag.example.test",
      explicitAnonKey: "flag-anon-key",
      environmentalUrl: "https://environment.example.test",
      environmentalAnonKey: "environment-anon-key",
    });
    assert.equal(explicit.url, "https://flag.example.test");
    assert.equal(explicit.anonKey, "flag-anon-key");

    await assert.rejects(
      resolveCloudTarget({
        stateDirectory,
        explicitUrl: "https://other.example.test",
      }),
      /differs from the stored current target/,
      "a partial override must not pair a new URL with another target's key",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("agent mode never reads a human current target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "coswarm-agent-target-"));
  const stateDirectory = join(parent, "state");
  try {
    await writeCurrentTarget(
      cloudTarget("https://human.example.test", "human-anon-key"),
      { stateDirectory },
    );
    await assert.rejects(
      resolveCloudTarget({ stateDirectory, mode: "agent" }),
      /agent credentials never inherit a human's saved Cloud target/,
    );
    const explicit = await resolveCloudTarget({
      stateDirectory,
      mode: "agent",
      environmentalUrl: "https://agent.example.test",
      environmentalAnonKey: "agent-anon-key",
    });
    assert.equal(explicit.url, "https://agent.example.test");
    assert.equal(explicit.anonKey, "agent-anon-key");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("malformed, traversable, and symlinked current-target state hard-fails safely", async () => {
  const parent = await mkdtemp(join(tmpdir(), "coswarm-bad-target-"));
  const stateDirectory = join(parent, "state");
  const path = currentTargetPath({ stateDirectory });
  const secret = "must-never-appear";
  try {
    await writeCurrentTarget(
      cloudTarget("https://safe.example.test", "safe-anon-key"),
      { stateDirectory },
    );
    await writeFile(
      path,
      `{"version":1,"url":"https://safe.example.test","anonKey":"${secret}"`,
      { mode: 0o600 },
    );
    const malformed = await readCurrentTarget({ stateDirectory }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    assert.ok(malformed);
    assert.equal(malformed.message, "stored current target is malformed");
    assert.equal(malformed.message.includes(secret), false);

    await chmod(path, 0o644);
    await assert.rejects(
      readCurrentTarget({ stateDirectory }),
      /file must be mode 0600/,
    );
    await chmod(path, 0o600);
    await chmod(stateDirectory, 0o755);
    await assert.rejects(
      readCurrentTarget({ stateDirectory }),
      /directory must be mode 0700/,
    );
    await chmod(stateDirectory, 0o700);

    await rm(path);
    const external = join(parent, "external.json");
    await writeFile(
      external,
      JSON.stringify({
        version: 1,
        url: "https://safe.example.test",
        anonKey: secret,
      }),
      { mode: 0o600 },
    );
    await symlink(external, path);
    await assert.rejects(
      readCurrentTarget({ stateDirectory }),
      /not a regular file/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function cli(
  home: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SWARM_ALLOW_INSECURE_STORE: "1",
  };
  delete environment.SWARM_CLOUD_URL;
  delete environment.SWARM_CLOUD_ANON_KEY;
  delete environment.SWARM_CLOUD_WORKSPACE_ID;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("target set/show/clear is explicit and bare human commands use it", async () => {
  const home = await mkdtemp(join(tmpdir(), "coswarm-target-cli-"));
  const anonKey = "cli-anon-key-must-not-be-printed";
  try {
    const set = await cli(home, [
      "target",
      "set",
      "--url",
      "https://cli.example.test",
      "--anon-key",
      anonKey,
      "--json",
    ]);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /current_target_set/);
    assert.equal(set.stdout.includes(anonKey), false);

    const show = await cli(home, ["target", "--json"]);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /https:\/\/cli\.example\.test/);
    assert.match(show.stdout, /anon_key_fingerprint/);
    assert.equal(show.stdout.includes(anonKey), false);

    const status = await cli(home, ["status", "--force-file-store"]);
    assert.equal(status.code, 1);
    assert.match(status.stderr, /not logged in/);
    assert.doesNotMatch(status.stderr, /no Cloud target is selected/);

    const agent = await cli(home, [
      "command",
      "create",
      "--agent-token-stdin",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
    ]);
    assert.equal(agent.code, 1);
    assert.match(
      agent.stderr,
      /agent credentials never inherit a human's saved Cloud target/,
    );

    const clear = await cli(home, ["target", "clear", "--json"]);
    assert.equal(clear.code, 0, clear.stderr);
    assert.match(clear.stdout, /current_target_cleared/);
    const missing = await cli(home, ["target", "show", "--json"]);
    assert.equal(missing.code, 0, missing.stderr);
    assert.match(missing.stdout, /\"current_target\": null/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
