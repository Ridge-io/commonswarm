import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
    const human1Cwd = join(mini, "human1", "r1");
    const logDirectory = join(mini, "logs", "r1");
    mkdirSync(human1Cwd, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });

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
    }));
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
