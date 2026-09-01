import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

/* Wren, 2026-08-10. Every unknown flag reported "--X requires a value", because anything outside
 * BOOLEAN_FLAGS is assumed to take one. A flag that DOES NOT EXIST was reported as a flag used
 * wrongly. Found when someone on 0.1.11 tried `--reveal-anon-key`, which only exists on a later
 * build, and was told it "requires a value" — the error blamed the reader for the version.
 *
 * AGENTS.md records the other cost: a control written with a bare `--not-a-real-flag` died in the
 * parser before reaching the gate it was meant to exercise, and passed for the wrong reason. */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = resolve(root, "dist", "cli.js");

function run(args: string[]): string {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

async function runAsync(
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string; pid: number }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined);
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveCode(status ?? 1));
  });
  return { code, stdout, stderr, pid: child.pid };
}

test("a flag that does not exist is reported as unknown, not as misused", () => {
  const out = run(["target", "show", "--not-a-real-flag"]);

  assert.match(out, /unknown option --not-a-real-flag/);
  assert.doesNotMatch(out, /requires a value/, "it still blames the user for the value");
});

test("a real flag missing its value still says so — the two must stay distinguishable", () => {
  /* CONTROL. Reporting everything as "unknown option" would satisfy the test above while
   * destroying the message that is correct far more often. */
  const out = run(["members", "--workspace-id"]);

  assert.match(out, /--workspace-id requires a value/);
  assert.doesNotMatch(out, /unknown option/);
});

test("KNOWN_FLAGS covers every flag the usage text advertises", () => {
  /* The list is for wording only, never for acceptance, so a stale entry cannot break a command
   * — but it CAN word an error badly, telling someone a real flag does not exist. This derives
   * the expectation from the help text itself, so adding a documented flag without listing it
   * fails here rather than surfacing to a user as "unknown option --your-new-flag". */
  const help = run(["--help"]);
  const advertised = [...new Set(
    (help.match(/--[a-z][a-z0-9-]*/g) ?? []).map((f) => f.slice(2)),
  )];
  assert.ok(advertised.length > 40, `usage parse looks wrong: ${advertised.length} flags`);

  const source = execFileSync("node", [
    "-e",
    `const s=require("fs").readFileSync(${JSON.stringify(resolve(root, "src", "cli.ts"))},"utf8");
     const m=s.match(/const KNOWN_FLAGS = new Set\\(\\[([\\s\\S]*?)\\]\\)/);
     process.stdout.write(m ? m[1] : "");`,
  ], { encoding: "utf8" });
  const known = new Set(
    (source.match(/"[a-z0-9-]+"/g) ?? []).map((q) => q.slice(1, -1)),
  );

  const missing = advertised.filter((f) => !known.has(f));
  assert.deepEqual(missing, [], `documented but not in KNOWN_FLAGS: ${missing.join(", ")}`);
});

test("--help states the credential contract as a PROPERTY, and names both strict cases", () => {
  /* Wren swept the flag across every subcommand that takes it and refuted the first version of
   * this fix. There are THREE contracts, not two, and the two refusals cite DIFFERENT missing
   * fields — `listen start` needs expires_at, `token revoke` needs token_id. They are two
   * independent requirements that happen to be satisfied by the same artifact, not one strict
   * mode with one reason.
   *
   * ~~The first fix said "listen start is the exception" and THIS TEST REQUIRED THAT STRING.~~
   * Dead. That shape only holds if there is one exception, so the gate would have stayed green
   * while `token revoke` remained undocumented — and worse, the wording newly implied the
   * difference had been enumerated. Wren: "the original defect was documentation silent on a
   * difference; the risk in the fix is documentation that appears to have enumerated the
   * difference and has not."
   *
   * That is a control discriminating toward a false claim, which AGENTS.md documents and which I
   * wrote hours after quoting it. The fix is to pin the PROPERTY — what the subcommand does with
   * the credential — because that survives the next subcommand; an enumeration does not. */
  const help = run(["--help"]);

  assert.match(help, /DEPENDS ON WHAT THE SUBCOMMAND DOES/);
  assert.match(help, /listen start[^\n]*expires_at/, "listen start's requirement is unstated");
  assert.match(help, /token revoke[^\n]*token_id/, "token revoke's requirement is unstated");
  assert.doesNotMatch(
    help,
    /is the exception/,
    "it claims a single exception again, which is the refuted shape",
  );
  /* CONTROL: the permissive general case must survive. Documenting only the strict subcommands
   * would satisfy everything above while making the flag look unusable for `members`. */
  assert.match(help, /bare swm_agt_ token/);
});

test("every subcommand taking --agent-token-stdin is accounted for in its description", () => {
  /* The safety net for the enumeration above. Wren's scope note is explicit that its sweep covered
   * the three subcommands documented TODAY; a fourth added later would inherit whichever contract
   * its implementation happens to have, and the description would silently stop being complete.
   *
   * Derived from the usage text rather than a hand-written list, so this fails when someone adds
   * the flag to a subcommand without saying which form it takes. */
  const help = run(["--help"]);
  const takers = [...new Set(
    help.split("\n")
      .filter((line) => /^\s{2}cswarm /.test(line) && line.includes("--agent-token-stdin"))
      /* Words after `cswarm` up to the first option/placeholder. Taking a fixed two tokens
       * yielded "members [--url", because `members` is a one-word subcommand and `token revoke`
       * is two — the shape differs per line and a fixed slice cannot see that. */
      .map((line) => {
        const words = line.trim().split(/\s+/).slice(1);
        const name: string[] = [];
        for (const word of words) {
          if (!/^[a-z][a-z-]*$/.test(word)) break;
          name.push(word);
        }
        return name.join(" ");
      })
      .filter((name) => name.length > 0),
  )];

  assert.ok(takers.length >= 3, `usage parse looks wrong: found ${takers.length}`);

  const description = help.slice(help.indexOf("--agent-token-stdin  "));
  /* The FULL subcommand, never a fallback to its first word. A verb-level fallback was tried and
   * measured useless: deleting `token revoke`'s whole line left this green, because "token"
   * appears in the description's own prose ("bare swm_agt_ token"). A control matching a word
   * that the surrounding sentence already contains cannot fail. */
  const undocumented = takers.filter((sub) => !description.includes(sub));

  assert.deepEqual(
    undocumented,
    [],
    `these take --agent-token-stdin but the description does not say which form: ${
      undocumented.join(", ")
    }`,
  );
});

test("every advertised stdin credential site also advertises the file form", () => {
  const help = run(["--help"]);
  const commandNames = (flag: string): string[] => [...new Set(
    help.split("\n")
      .filter((line) => /^\s{2}cswarm /.test(line) && line.includes(flag))
      .map((line) => {
        const words = line.trim().split(/\s+/).slice(1);
        const name: string[] = [];
        for (const word of words) {
          if (!/^[a-z][a-z-]*$/.test(word)) break;
          name.push(word);
        }
        return name.join(" ");
      })
      .filter(Boolean),
  )].sort();

  const stdinSites = commandNames("--agent-token-stdin");
  const fileSites = commandNames("--agent-token-file");
  assert.ok(stdinSites.length >= 18, `usage enumeration found only ${stdinSites.length} sites`);
  assert.deepEqual(
    stdinSites.filter((site) => !fileSites.includes(site)),
    [],
    "a stdin credential site omitted the safer file channel",
  );
  /* `resume` must retain the path because it finds surviving watchers by that
   * argv path as well as by the authenticated principal. It is the deliberate
   * file-only site; this does not weaken the one-way property named above. */
  assert.deepEqual(
    fileSites.filter((site) => !stdinSites.includes(site)),
    ["resume"],
  );

  const source = execFileSync("node", [
    "-e",
    `process.stdout.write(require("fs").readFileSync(${JSON.stringify(resolve(root, "src", "cli.ts"))}, "utf8"))`,
  ], { encoding: "utf8" });
  assert.match(
    source,
    /const CREDENTIAL_FLAGS = \["agent-token-file", "agent-token-stdin"\]/,
    "shared credential-shape gates no longer carry both sources",
  );
  const supervisor = source.slice(
    source.indexOf("async function runListenSupervisor"),
    source.indexOf("async function runListenStatusOrStop"),
  );
  assert.match(supervisor, /\.\.\.CREDENTIAL_FLAGS/);
  assert.match(supervisor, /agentCredential\(args, \{ implicitStdin: true \}\)/);
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const EXPECTED_PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const AUTHENTICATED_PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_TOKEN = `swm_agt_${"a".repeat(43)}`;
const ARTIFACT = JSON.stringify({
  agent_token: AGENT_TOKEN,
  message:
    "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
  principal_id: EXPECTED_PRINCIPAL,
  run_id: RUN_ID,
  status: "accepted",
  token_id: TOKEN_ID,
  expires_at: "2099-01-01T00:00:00.000Z",
});

test("whoami trusts the live credential identity and file input keeps the token out of ps", async () => {
  let releaseResponse: (() => void) | undefined;
  let requestReached: (() => void) | undefined;
  let requestCount = 0;
  const reached = new Promise<void>((resolveReached) => requestReached = resolveReached);
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${AGENT_TOKEN}`);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    requestCount += 1;
    if (requestCount > 1) {
      response.end(JSON.stringify({ grants: [] }));
      return;
    }
    requestReached?.();
    await new Promise<void>((resolveRelease) => releaseResponse = resolveRelease);
    response.end(JSON.stringify({
      members: [{ user_id: OWNER, display_name: "Operator" }],
      agents: [{
        principal_id: AUTHENTICATED_PRINCIPAL,
        name: "MrSentry",
        owner_user_id: OWNER,
      }],
      identity: {
        credential_valid: true,
        principal_id: AUTHENTICATED_PRINCIPAL,
        owner_user_id: OWNER,
        workspace_id: WORKSPACE,
      },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-token-file-"));
  const credentialPath = resolve(directory, "quill-credential.json");
  await writeFile(credentialPath, ARTIFACT, { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  const args = [
    "whoami",
    "--agent-token-file",
    credentialPath,
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    WORKSPACE,
    "--json",
  ];
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  try {
    await reached;
    const processListing = execFileSync("ps", ["-p", String(child.pid), "-o", "command="], {
      encoding: "utf8",
    });
    assert.match(processListing, /--agent-token-file/);
    assert.doesNotMatch(processListing, new RegExp(AGENT_TOKEN));
    releaseResponse?.();
    const code = await new Promise<number>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolveCode(status ?? 1));
    });
    assert.equal(code, 0, stderr);
    const identity = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(identity.principal_id, AUTHENTICATED_PRINCIPAL);
    assert.equal(identity.display_name, "MrSentry");
    assert.equal(identity.owner_user_id, OWNER);
    assert.equal(identity.owner_display_name, "Operator");
    assert.equal(identity.workspace_id, WORKSPACE);
    assert.equal(identity.credential_valid, true);
    assert.equal(identity.credential_metadata_match, false);
    assert.match(stderr, /WARNING: the credential authenticated as MrSentry/);
    assert.match(stderr, new RegExp(AUTHENTICATED_PRINCIPAL));
  } finally {
    releaseResponse?.();
    child.kill();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent token file accepts 0600, refuses 0644, and missing has a distinct code", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-token-mode-"));
  const credentialPath = resolve(directory, "credential.json");
  try {
    await writeFile(credentialPath, ARTIFACT, { mode: 0o600 });
    await chmod(credentialPath, 0o644);
    const common = [
      "members",
      "--agent-token-file",
      credentialPath,
      "--url",
      "http://127.0.0.1:1",
      "--anon-key",
      "public-anon",
      "--workspace-id",
      WORKSPACE,
    ];
    const insecure = await runAsync(common);
    assert.equal(insecure.code, 1);
    assert.match(insecure.stderr, /agent_token_file_unreadable/);
    assert.match(insecure.stderr, /must be mode 0600 \(found 644\)/);

    await rm(credentialPath);
    const missing = await runAsync(common);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /agent_token_file_missing/);
    assert.doesNotMatch(missing.stderr, /ECONNREFUSED/, "a missing secret reached the network");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--agent-token-stdin still authenticates the same whoami path", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${AGENT_TOKEN}`);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    requestCount += 1;
    if (requestCount > 1) {
      response.end(JSON.stringify({ grants: [] }));
      return;
    }
    response.end(JSON.stringify({
      members: [{ user_id: OWNER, display_name: "Operator" }],
      agents: [{
        principal_id: AUTHENTICATED_PRINCIPAL,
        name: "MrSentry",
        owner_user_id: OWNER,
      }],
      identity: {
        credential_valid: true,
        principal_id: AUTHENTICATED_PRINCIPAL,
        owner_user_id: OWNER,
        workspace_id: WORKSPACE,
      },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runAsync([
      "whoami",
      "--agent-token-stdin",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "public-anon",
      "--workspace-id",
      WORKSPACE,
      "--json",
    ], ARTIFACT);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      (JSON.parse(result.stdout) as Record<string, unknown>).principal_id,
      AUTHENTICATED_PRINCIPAL,
    );
  } finally {
    server.close();
  }
});
