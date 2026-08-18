import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
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

test("missing cloud URL names invite acceptance as the real front door", async () => {
  const result = await cli(["login"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Supabase project base URL/);
  assert.match(result.stderr, /https:\/\/<ref>\.supabase\.co/);
  /* D-067. This required the literal "deployment operator who invited you", so the gate was
   * actively holding a sentence that assumed a person who may not exist: self-serve signup is
   * live, and a reader who created their own workspace has no inviter. The message sent them
   * to nobody, and the test made sure it kept doing so.
   *
   * Replaced with what the message must now DO rather than the words it used to use: name a
   * route for both readers, and assume neither. */
  /* 2026-08-18: the hosted service moved to api.commonswarm.com, so the message must now name
   * a working URL for the hosted reader too — a third reader the D-067 pair did not cover.
   * "whoever runs this deployment" became "whoever runs it" in the same edit; the pin follows
   * the claim (name a route for every reader), not the old words. */
  assert.match(result.stderr, /https:\/\/api\.commonswarm\.com/);
  assert.match(result.stderr, /whoever runs it/);
  assert.match(result.stderr, /if you created it/);
  assert.doesNotMatch(
    result.stderr,
    /who invited you/,
    "the no-target message assumes an inviter again; self-serve users have none",
  );
  assert.match(result.stderr, /invite/);
  assert.match(result.stderr, /cswarm accept --link-stdin/);
  assert.match(result.stderr, /invite links carry the Cloud target/);
  assert.match(result.stderr, /SWARM_CLOUD_URL/);
  assert.match(result.stderr, /SWARM_CLOUD_ANON_KEY/);
  assert.doesNotMatch(result.stderr, /Project Settings/);
  /* The route must be COMPLETABLE: the hosted command names its key source (the public meta
   * tags on /start), and the discovery path is named first because reaching this message
   * usually means discovery failed. Found by the inversion arm on the api.commonswarm.com
   * change: the URL pin alone stayed green while <key> had no source. */
  assert.match(result.stderr, /meta tags at https:\/\/commonswarm\.com\/start/);
  assert.match(result.stderr, /discover/);
  assert.deepEqual(
    result.stderr.match(/https?:\/\/[^\s),]+/g),
    [
      "https://commonswarm.com",
      "https://api.commonswarm.com",
      "https://commonswarm.com/start",
      "https://<ref>.supabase.co",
    ],
  );
});

test("shared positional-count errors distinguish too few, too many, and exact", async () => {
  const target = ["--url", "http://127.0.0.1:9", "--anon-key", "anon"];
  const tooFew = await cli(["working-on", ...target]);
  assert.equal(tooFew.code, 1);
  assert.match(
    tooFew.stderr,
    /too few positional arguments: expected 2, received 1/,
  );

  const tooMany = await cli(["workspaces", "extra", ...target]);
  assert.equal(tooMany.code, 1);
  assert.match(
    tooMany.stderr,
    /too many positional arguments: expected 1, received 2/,
  );

  const exact = await cli(["help"]);
  assert.equal(exact.code, 0);
  assert.match(exact.stdout, /^cswarm /);
  assert.equal(exact.stderr, "");
});
