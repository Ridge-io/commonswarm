import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const emailDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(emailDir, "../..");
const script = join(repoRoot, "scripts/push-email-templates.sh");

function runScript(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(script, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("push script diffs before PATCH, defaults dry, and becomes a no-op when current", async (t) => {
  let currentConfig = {};
  const methods = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method);
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(currentConfig));
      return;
    }
    if (request.method === "PATCH") {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
      }
      currentConfig = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const env = {
    COMMONSWARM_SMTP_ADMIN_EMAIL: "mail@example.test",
    COMMONSWARM_SMTP_SENDER_NAME: "CommonSwarm Team",
    SUPABASE_ACCESS_TOKEN: "fixture-token",
    SUPABASE_MANAGEMENT_API_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_PROJECT_REF: "fixture-project",
  };

  const dryRun = await runScript([], env);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /28 field\(s\) would change/);
  assert.match(dryRun.stdout, /Dry run only/);
  assert.deepEqual(methods, ["GET"], "dry-run must not send PATCH");

  const apply = await runScript(["--apply"], env);
  assert.equal(apply.code, 0, apply.stderr);
  assert.match(apply.stdout, /28 field\(s\) would change/);
  assert.match(apply.stdout, /Applied 28/);
  assert.deepEqual(methods, ["GET", "GET", "PATCH"], "apply must GET, print diff, then PATCH");
  assert.equal(Object.keys(currentConfig).length, 28);
  assert.equal(currentConfig.smtp_sender_name, "CommonSwarm Team");
  assert.equal(currentConfig.smtp_admin_email, "mail@example.test");
  assert.match(currentConfig.mailer_templates_magic_link_content, /CommonSwarm/);

  const idempotent = await runScript(["--apply"], env);
  assert.equal(idempotent.code, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /No changes/);
  assert.deepEqual(
    methods,
    ["GET", "GET", "PATCH", "GET"],
    "an already-current apply must not send another PATCH",
  );
});
