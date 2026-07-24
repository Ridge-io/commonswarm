import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const REDACTOR = join(ROOT, "uxtest", "scripts", "redacting-tee.mjs");
const COLLECTOR = join(ROOT, "uxtest", "scripts", "collect-round.mjs");
const VERIFY_WORKSPACE = join(
  ROOT,
  "uxtest",
  "scripts",
  "verify-persona-workspace.sh",
);
const SPAWN_OBSERVED = join(
  ROOT,
  "uxtest",
  "scripts",
  "spawn-observed.sh",
);
const RESET_HUMAN2_GUI = join(
  ROOT,
  "uxtest",
  "scripts",
  "reset-human2-gui.sh",
);
const SERVE_HUMAN2_GUI = join(
  ROOT,
  "uxtest",
  "scripts",
  "serve-human2-gui.sh",
);
const UXTEST_LIB = join(ROOT, "uxtest", "scripts", "_lib.sh");
const PREFLIGHT = join(ROOT, "uxtest", "scripts", "preflight.sh");
const CHANNEL_UP = join(ROOT, "uxtest", "scripts", "channel-up.sh");

function invitation() {
  const token = `swm_inv_${"A".repeat(43)}`;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    url: "https://example.test",
    anon_key: "public-anon",
    workspace_id: "11111111-1111-4111-8111-111111111111",
    invitation_token: token,
    workspace_name: "Synthetic Test",
    inviter_display_name: "Avery",
  })).toString("base64url");
  return { token, payload, uri: `coswarm://accept/${payload}` };
}

test("stream capture redacts URI, bare payload, and token before disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "uxtest-redactor-"));
  try {
    const safePath = join(directory, "safe-output");
    const capability = invitation();
    const raw = [
      capability.uri,
      capability.payload,
      capability.token,
      "",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      [REDACTOR, safePath, "stdout"],
      { input: raw, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, raw);

    const safe = readFileSync(safePath, "utf8");
    assert.equal(
      safe.match(/\[INVITE LINK REDACTED\]/g)?.length,
      2,
      safe,
    );
    assert.equal(
      safe.match(/\[INVITE TOKEN REDACTED\]/g)?.length,
      1,
    );
    assert.equal(safe.includes(capability.uri), false);
    assert.equal(safe.includes(capability.payload), false);
    assert.equal(safe.includes(capability.token), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("synthetic round collection is metrics-authoritative and capability-safe", () => {
  const directory = mkdtempSync(join(tmpdir(), "uxtest-collector-"));
  try {
    const mini = join(directory, "mini");
    const output = join(directory, "output");
    const setupPath = join(directory, "setup.json");
    const human1Cwd = join(mini, "human1", "workspace");
    const logDirectory = join(mini, "logs", "r1");
    mkdirSync(human1Cwd, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    mkdirSync(output, { recursive: true });

    const start = Date.parse("2026-07-24T18:00:00.000Z");
    const capability = invitation();
    writeFileSync(setupPath, JSON.stringify({
      reset_completed_at: new Date(start).toISOString(),
      workspace_id: "11111111-1111-4111-8111-111111111111",
      seed_sha: "seed-sha",
      coswarm_sha_mini: "same-bundle",
      coswarm_sha_laptop: "same-bundle",
      oauth_consent: "first",
      carryover: false,
      human1_join_latency_ms: 12_000,
      human2_join_latency_ms: 18_000,
      human1_join_attempts: 1,
      human2_join_attempts: 2,
    }));
    writeFileSync(
      join(output, "preflight.json"),
      JSON.stringify({
        round: 1,
        measured_at: "2026-07-24T17:59:00.000Z",
        current_live_memberships: 1,
        projected_live_memberships: 2,
        multi_project_path: true,
      }),
    );
    writeFileSync(join(human1Cwd, "FEEDBACK.md"), "The output was clear.");
    writeFileSync(
      join(human1Cwd, "JOURNAL.md"),
      "UNINTERPRETABLE: sample non-secret line",
    );
    writeFileSync(
      join(human1Cwd, "RESULT.md"),
      "Status: ready\nNext: ship",
    );

    const human1Commands = [
      {
        started_at_ms: start + 1_000,
        ended_at_ms: start + 2_000,
        duration_ms: 1_000,
        role: "human1",
        command: "login",
        exit_code: 0,
        help: false,
        accept_attempt: false,
        used_link_stdin: false,
        used_positional_link: false,
        stdout: "Login complete.",
        stderr: "",
      },
      {
        started_at_ms: start + 3_000,
        ended_at_ms: start + 4_000,
        duration_ms: 1_000,
        role: "human1",
        command: "invite",
        exit_code: 0,
        help: false,
        accept_attempt: false,
        used_link_stdin: false,
        used_positional_link: false,
        stdout: "[INVITE LINK REDACTED]",
        stderr: "",
      },
    ];
    writeFileSync(
      join(logDirectory, "human1.jsonl"),
      human1Commands.map((value) => JSON.stringify(value)).join("\n"),
    );

    const remote = {
      messages: [
        {
          id: 1,
          from_agent: "Avery-r1",
          to_agent: "Dana-r1",
          body: `Here you go ${capability.uri}`,
          created_at: new Date(start + 5_000).toISOString(),
        },
        {
          id: 2,
          from_agent: "Dana-r1",
          to_agent: "Avery-r1",
          body: "Connected. Status: ready / Next: ship",
          created_at: new Date(start + 7_000).toISOString(),
        },
      ],
      feedback: "It worked.",
      journal: "expected: connect | happened: ready | feeling: fine",
      result: "Status: ready\nNext: ship",
      isolationVoid: null,
      commands: [{
        started_at_ms: start + 6_000,
        ended_at_ms: start + 6_500,
        duration_ms: 500,
        role: "human2",
        command: "accept",
        exit_code: 0,
        help: false,
        accept_attempt: true,
        used_link_stdin: false,
        used_positional_link: true,
        stdout: "Ready.",
        stderr: "",
      }],
      isolationEvents: [],
    };
    const result = spawnSync(
      process.execPath,
      [
        COLLECTOR,
        "1",
        join(ROOT, "uxtest"),
        mini,
        setupPath,
        output,
        "Avery-r1",
        "Dana-r1",
      ],
      { input: JSON.stringify(remote), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const metrics = JSON.parse(
      readFileSync(join(output, "metrics.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(metrics.task_completed, true);
    assert.equal(metrics.link_pasted_in_chat, true);
    assert.equal(metrics.link_form, "uri");
    assert.equal(metrics.wall_clock_link_to_connected, 1_500);
    assert.equal(metrics.carryover, false);
    assert.equal(metrics.multi_project_path, true);
    assert.equal(metrics.current_live_memberships, 1);
    assert.equal(metrics.projected_live_memberships, 2);
    assert.deepEqual(metrics.join_latency_ms, {
      human1: 12_000,
      human2: 18_000,
    });
    assert.deepEqual(metrics.join_attempts, {
      human1: 1,
      human2: 2,
    });
    assert.match(
      readFileSync(join(output, "REPORT.md"), "utf8"),
      /Membership path: multi-project resolution .*workspaces -> use -> invite/,
    );

    const artifacts: string[] = [];
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        if (statSync(child).isDirectory()) walk(child);
        else artifacts.push(readFileSync(child, "utf8"));
      }
    };
    walk(output);
    const combined = artifacts.join("\n");
    assert.equal(combined.includes(capability.uri), false);
    assert.equal(combined.includes(capability.payload), false);
    assert.equal(combined.includes(capability.token), false);
    assert.match(combined, /\[INVITE LINK REDACTED\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trusted persona workspace sweep fails loudly on prior-round artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "uxtest-workspace-"));
  try {
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "BRIEF.md"), "# Round 3 brief\n");
    const clean = spawnSync(
      "bash",
      [VERIFY_WORKSPACE, "round", workspace, "Synthetic", "3"],
      { encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(join(workspace, "JOURNAL.md"), "prior round");
    const leaked = spawnSync(
      "bash",
      [VERIFY_WORKSPACE, "sweep", workspace, "Synthetic"],
      { encoding: "utf8" },
    );
    assert.equal(leaked.status, 1);
    assert.match(leaked.stderr, /prior-round or stray data/);
    assert.match(leaked.stderr, /JOURNAL\.md/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observed spawn retries the exact surface and records join latency", () => {
  const directory = mkdtempSync(join(tmpdir(), "uxtest-spawn-"));
  try {
    const mini = join(directory, "mini");
    const workspace = join(mini, "human1", "workspace");
    const joined = join(directory, "joined");
    const cmuxLog = join(directory, "cmux.log");
    const swarm = join(directory, "mock-swarm");
    const cmux = join(directory, "mock-cmux");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "BRIEF.md"), "# Round 1 brief\n");
    writeFileSync(
      swarm,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  spawn)
    printf 'Spawned new Claude Code session (new tab: workspace:7, surface:9)\\n'
    ;;
  members)
    if [ -f "\$MOCK_JOINED" ]; then
      printf '  Avery-r1 [cmux/claude-code]\\n'
    fi
    ;;
  *)
    exit 64
    ;;
esac
`,
    );
    writeFileSync(
      cmux,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\$*" >>"\$MOCK_CMUX_LOG"
if [ "\${1:-}" = "send" ]; then
  : >"\$MOCK_JOINED"
fi
`,
    );
    chmodSync(swarm, 0o755);
    chmodSync(cmux, 0o755);

    const result = spawnSync(
      "bash",
      [SPAWN_OBSERVED, "1", "human1"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MOCK_JOINED: joined,
          MOCK_CMUX_LOG: cmuxLog,
          UXTEST_MINI_HOME_ROOT: mini,
          UXTEST_REMOTE_HOME_ROOT: join(directory, "remote"),
          UXTEST_HOME_ROOT: mini,
          UXTEST_SWARM_BIN: swarm,
          UXTEST_CMUX_BIN: cmux,
          UXTEST_SLEEP_BIN: "/usr/bin/true",
          UXTEST_JOIN_TIMEOUT_SECONDS: "1",
          UXTEST_JOIN_ATTEMPTS: "2",
          UXTEST_JOIN_POLL_SECONDS: "1",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /re-sending \/join-swarm to surface:9/);
    const sent = readFileSync(cmuxLog, "utf8");
    assert.match(
      sent,
      /send --workspace workspace:7 --surface surface:9 \/join-swarm Avery-r1 --swarm uxtest-r1/,
    );
    assert.match(
      sent,
      /send-key --workspace workspace:7 --surface surface:9 Enter/,
    );
    const state = JSON.parse(
      readFileSync(
        join(mini, "human1", "spawn-state", "r1.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(state.observed, true);
    assert.equal(state.join_attempts, 2);
    assert.equal(state.surface, "surface:9");
    assert.equal(state.workspace, "workspace:7");
    assert.equal(state.cwd, workspace);
    assert.ok(
      typeof state.join_latency_ms === "number" &&
        state.join_latency_ms >= 0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Human2 GUI reset records success and fails if the keychain stays warm", () => {
  const directory = mkdtempSync(join(tmpdir(), "uxtest-gui-reset-"));
  try {
    const root = join(directory, "uxtest");
    const config = join(root, "config");
    const product = join(root, "product");
    const dist = join(product, "dist");
    const security = join(directory, "mock-security");
    const cloudUrl = "https://gui-reset.example.test";
    const profile = createHash("sha256")
      .update(cloudUrl)
      .digest("hex")
      .slice(0, 24);
    mkdirSync(config, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(config, "cloud.env"),
      [
        `export SWARM_CLOUD_URL=${cloudUrl}`,
        "export SWARM_CLOUD_ANON_KEY=public-test-key",
        "",
      ].join("\n"),
    );
    writeFileSync(join(product, "NODE_BIN"), "/usr/bin/true\n");
    writeFileSync(join(dist, "cli.js"), "// synthetic copied cli\n");
    writeFileSync(security, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(security, 0o755);

    const env = {
      ...process.env,
      UXTEST_HOME_ROOT: root,
      UXTEST_MINI_HOME_ROOT: root,
      UXTEST_REMOTE_HOME_ROOT: root,
      UXTEST_SECURITY_BIN: security,
    };
    const success = spawnSync(
      "bash",
      [RESET_HUMAN2_GUI, "7", profile],
      { encoding: "utf8", env },
    );
    assert.equal(success.status, 0, success.stderr);
    const successState = JSON.parse(
      readFileSync(
        join(root, "human2", "reset-state", "r7.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(successState.status, "succeeded");
    assert.equal(successState.round, 7);
    assert.equal(successState.profile, profile);

    writeFileSync(security, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(security, 0o755);
    const warm = spawnSync(
      "bash",
      [RESET_HUMAN2_GUI, "8", profile],
      { encoding: "utf8", env },
    );
    assert.equal(warm.status, 1);
    assert.match(warm.stderr, /keychain credential survived/);
    const failedState = JSON.parse(
      readFileSync(
        join(root, "human2", "reset-state", "r8.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(failedState.status, "failed");
    assert.match(String(failedState.detail), /keychain credential survived/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GUI-origin guard fails with the exact laptop remedy before a round", () => {
  const remoteRoot = "/synthetic/tom/uxtest";
  const remoteRepo = "/synthetic/tom/cloud-swarm";
  const guarded = spawnSync(
    "bash",
    [
      "-c",
      [
        'source "$1"',
        'a2a_card_name() { printf "%s" "$UXTEST_LAUNCHER_NAME"; }',
        "remote_zsh() { return 1; }",
        "assert_gui_launcher_server",
      ].join("\n"),
      "bash",
      UXTEST_LIB,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        UXTEST_REMOTE_HOME_ROOT: remoteRoot,
        UXTEST_REMOTE_REPO: remoteRepo,
      },
    },
  );
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /accept and queue A2A but cannot push through cmux/);
  assert.match(
    guarded.stderr,
    new RegExp(
      `UXTEST_HOME_ROOT=${remoteRoot} ${remoteRepo}/uxtest/scripts/serve-human2-gui\\.sh launcher`,
    ),
  );

  const preflight = readFileSync(PREFLIGHT, "utf8");
  assert.ok(
    preflight.indexOf("assert_gui_launcher_server") <
      preflight.indexOf('mini_bin="$UXTEST_MINI_HOME_ROOT/bin/coswarm"'),
    "GUI-origin gate must run before product/version round checks",
  );

  const noGui = spawnSync(
    "bash",
    [SERVE_HUMAN2_GUI, "launcher"],
    {
      encoding: "utf8",
      env: { ...process.env, CMUX_SURFACE_ID: "" },
    },
  );
  assert.equal(noGui.status, 1);
  assert.match(noGui.stderr, /must run inside the laptop's GUI cmux session/);

  const channel = readFileSync(CHANNEL_UP, "utf8");
  assert.match(channel, /launcher_send/);
  assert.match(channel, /serve-human2-gui\.sh round \$round/);
  assert.doesNotMatch(
    channel,
    /remote_zsh "[\s\S]*nohup '\$UXTEST_REMOTE_SWARM_BIN' serve/,
  );
});
