import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/* The agent path is stateless, and nothing was protecting that.
 *
 * Found by Wren on 2026-08-08 with an instrument better than the one it was asked for: rather
 * than logging out (irreversible, and its browser automation was down so it could not verify
 * which identity a re-login would take), it pointed HOME at an empty directory. cswarm keeps all
 * its state under HOME, so a pristine HOME is a pristine machine — repeatable, risk-free, and
 * strictly more controlled than a logout.
 *
 * What it measured on production: an agent given only a credential and the four flags can read
 * and write signals having never logged in, with no saved target and no prior setup, and leaves
 * NO FILES behind.
 *
 * Why this needs a gate rather than a note. The invariant is invisible — it would break silently
 * and no existing test would notice. Wren named the exact way it dies, and it is a plausible,
 * well-intentioned change: someone "fixes" the four-flag verbosity by requiring a saved target.
 * That would break the only path that works from nothing, which is the thing that makes the
 * verbosity tolerable in the first place.
 *
 * REFINEMENT, measured here rather than taken on report: files are zero, but TWO DIRECTORIES are
 * created (`.cswarm` and `.cswarm/agent-credentials`), identically for a full artifact, one
 * without `expires_at`, and a bare token. Wren's claim was about files and is exact. "Leaves
 * nothing behind" would have been slightly overstated, so this asserts on files — which is the
 * invariant with meaning, since an empty directory holds no state. */

const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

function credentialArtifact(): string {
  return JSON.stringify({
    agent_token: `swm_agt_${randomBytes(32).toString("base64url")}`,
    message: AGENT_CREDENTIAL_MESSAGE,
    principal_id: "00000000-0000-4000-8000-000000000002",
    run_id: "00000000-0000-4000-8000-000000000003",
    status: "accepted",
    token_id: "00000000-0000-4000-8000-000000000004",
    expires_at: "2099-01-01T00:00:00.000Z",
  });
}

/** Every regular file under `dir`, recursively, as paths relative to it. */
function filesUnder(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) found.push(...filesUnder(full, rel));
    else found.push(rel);
  }
  return found;
}

async function runInFreshHome(
  args: string[],
  stdin: string,
): Promise<{ stderr: string; files: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "cswarm-fresh-home-"));
  try {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(stdin);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    child.stdout.resume();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    return { stderr, files: filesUnder(home) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Unroutable by design: the point is to get PAST credential and target handling and fail at the
// network, which proves the earlier stages ran without needing anything on disk.
const UNREACHABLE = ["--url", "https://127.0.0.1:9", "--anon-key", "anon"];
const WORKSPACE = ["--workspace-id", "00000000-0000-4000-8000-000000000001"];

test("an agent verb writes no files into a pristine HOME", async () => {
  const result = await runInFreshHome(
    ["feed", ...UNREACHABLE, ...WORKSPACE, "--agent-token-stdin"],
    credentialArtifact(),
  );

  assert.deepEqual(
    result.files,
    [],
    `the agent path persisted state to HOME: ${result.files.join(", ")}`,
  );
});

test("an agent verb needs no saved target — it fails at the network, not at configuration", async () => {
  const result = await runInFreshHome(
    ["feed", ...UNREACHABLE, ...WORKSPACE, "--agent-token-stdin"],
    credentialArtifact(),
  );

  // The specific regression Wren predicted: requiring a saved target to shorten the flag list.
  // That change would surface HERE, as a configuration refusal before any request is attempted.
  assert.doesNotMatch(
    result.stderr,
    /no Cloud target is selected/,
    "the agent path now demands saved state, which breaks the only path that works from nothing",
  );
  // It must have got as far as trying: an empty stderr would mean the command never ran and
  // the file assertion above would be passing for the wrong reason.
  assert.match(result.stderr, /could not reach|failed/i);
});

test("CONTROL: a human verb DOES write to HOME, so the probe can see writes at all", async () => {
  // Without this, `files === []` is equally consistent with a broken harness — a HOME override
  // that does not take, or a child that never started. A negative result is evidence only if
  // the path it was meant to exercise was reached.
  const result = await runInFreshHome(
    ["target", "set", "--url", "https://example.supabase.co", "--anon-key", "anon"],
    "",
  );

  assert.ok(
    result.files.length > 0,
    "the human path wrote nothing either — HOME is not being observed",
  );
  assert.ok(
    result.files.some((file) => file.includes("current-target")),
    `expected a saved target among: ${result.files.join(", ")}`,
  );
});
