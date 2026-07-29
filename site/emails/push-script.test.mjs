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
    const childEnv = { ...process.env };
    for (const environmentName of [
      "COMMONSWARM_SMTP_ADMIN_EMAIL",
      "COMMONSWARM_SMTP_HOST",
      "COMMONSWARM_SMTP_PORT",
      "COMMONSWARM_SMTP_USER",
      "COMMONSWARM_SMTP_PASS",
      "COMMONSWARM_SMTP_SENDER_NAME",
    ]) {
      delete childEnv[environmentName];
    }
    Object.assign(childEnv, env);
    const child = spawn(script, args, {
      cwd: repoRoot,
      env: childEnv,
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
    SUPABASE_ACCESS_TOKEN: "fixture-token",
    SUPABASE_MANAGEMENT_API_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_PROJECT_REF: "fixture-project",
  };

  const dryRun = await runScript([], env);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /26 field\(s\) would change/);
  assert.match(dryRun.stdout, /Dry run only/);
  assert.deepEqual(methods, ["GET"], "dry-run must not send PATCH");

  const apply = await runScript(["--apply"], env);
  assert.equal(apply.code, 0, apply.stderr);
  assert.match(apply.stdout, /26 field\(s\) would change/);
  assert.match(apply.stdout, /Applied 26/);
  assert.deepEqual(methods, ["GET", "GET", "PATCH"], "apply must GET, print diff, then PATCH");
  assert.equal(Object.keys(currentConfig).length, 26);
  assert.deepEqual(
    Object.keys(currentConfig).filter((field) => field.startsWith("smtp_")),
    [],
    "template-only apply must not send any smtp_* field",
  );
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

test("push script sends sender fields only with the complete SMTP block", async (t) => {
  let patchedConfig = null;
  const methods = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method);
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
      return;
    }
    if (request.method === "PATCH") {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
      }
      patchedConfig = JSON.parse(body);
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
  const baseEnv = {
    SUPABASE_ACCESS_TOKEN: "fixture-token",
    SUPABASE_MANAGEMENT_API_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_PROJECT_REF: "fixture-project",
  };

  const emptyBlock = await runScript(["--apply"], {
    ...baseEnv,
    COMMONSWARM_SMTP_ADMIN_EMAIL: "",
    COMMONSWARM_SMTP_HOST: "",
    COMMONSWARM_SMTP_PORT: "",
    COMMONSWARM_SMTP_USER: "",
    COMMONSWARM_SMTP_PASS: "",
    COMMONSWARM_SMTP_SENDER_NAME: "",
  });
  assert.notEqual(emptyBlock.code, 0);
  assert.match(emptyBlock.stderr, /Custom SMTP is all-or-none/);
  assert.deepEqual(methods, [], "an exported-but-empty SMTP block must fail before HTTP");

  const partial = await runScript(["--apply"], {
    ...baseEnv,
    COMMONSWARM_SMTP_ADMIN_EMAIL: "mail@example.test",
    COMMONSWARM_SMTP_SENDER_NAME: "CommonSwarm Team",
  });
  assert.notEqual(partial.code, 0);
  assert.match(partial.stderr, /Custom SMTP is all-or-none/);
  assert.match(partial.stderr, /COMMONSWARM_SMTP_HOST/);
  assert.match(partial.stderr, /COMMONSWARM_SMTP_PORT/);
  assert.match(partial.stderr, /COMMONSWARM_SMTP_USER/);
  assert.match(partial.stderr, /COMMONSWARM_SMTP_PASS/);
  assert.deepEqual(methods, [], "partial SMTP must fail before any Management API request");

  const complete = await runScript(["--apply"], {
    ...baseEnv,
    COMMONSWARM_SMTP_ADMIN_EMAIL: "mail@example.test",
    COMMONSWARM_SMTP_HOST: "smtp.example.test",
    COMMONSWARM_SMTP_PORT: "587",
    COMMONSWARM_SMTP_USER: "smtp-user",
    COMMONSWARM_SMTP_PASS: "smtp-pass",
    COMMONSWARM_SMTP_SENDER_NAME: "CommonSwarm Team",
  });
  assert.equal(complete.code, 0, complete.stderr);
  assert.match(complete.stdout, /32 field\(s\) would change/);
  assert.match(complete.stdout, /desired\/smtp_pass/);
  assert.match(complete.stdout, /contents redacted/);
  assert.match(complete.stdout, /smtp\.example\.test/);
  assert.match(complete.stdout, /smtp-user/);
  assert.doesNotMatch(complete.stdout, /smtp-pass/);
  assert.doesNotMatch(complete.stderr, /smtp-pass/);
  assert.deepEqual(methods, ["GET", "PATCH"]);
  assert.ok(patchedConfig);
  assert.equal(Object.keys(patchedConfig).length, 32);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(patchedConfig)
        .filter(([field]) => field.startsWith("smtp_"))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    {
      smtp_admin_email: "mail@example.test",
      smtp_host: "smtp.example.test",
      smtp_pass: "smtp-pass",
      smtp_port: "587",
      smtp_sender_name: "CommonSwarm Team",
      smtp_user: "smtp-user",
    },
  );

  const defaultSender = await runScript(["--apply"], {
    ...baseEnv,
    COMMONSWARM_SMTP_ADMIN_EMAIL: "mail@example.test",
    COMMONSWARM_SMTP_HOST: "smtp.example.test",
    COMMONSWARM_SMTP_PORT: "587",
    COMMONSWARM_SMTP_USER: "smtp-user",
    COMMONSWARM_SMTP_PASS: "smtp-pass",
  });
  assert.equal(defaultSender.code, 0, defaultSender.stderr);
  assert.deepEqual(methods, ["GET", "PATCH", "GET", "PATCH"]);
  assert.equal(patchedConfig.smtp_sender_name, "CommonSwarm");
  assert.doesNotMatch(defaultSender.stdout, /smtp-pass/);
  assert.doesNotMatch(defaultSender.stderr, /smtp-pass/);
});

test("push script surfaces Supabase's HTTP 401 validation body", async (t) => {
  const methods = [];
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      response.end("{}");
      return;
    }
    if (request.method === "PATCH") {
      response.statusCode = 401;
      response.end(
        JSON.stringify({
          message:
            "Custom SMTP required to configure SMTP_SENDER_NAME. Missing SMTP_HOST field.",
          submitted_password: "smtp-pass",
        }),
      );
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const result = await runScript(["--apply"], {
    SUPABASE_ACCESS_TOKEN: "fixture-token",
    SUPABASE_MANAGEMENT_API_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_PROJECT_REF: "fixture-project",
    COMMONSWARM_SMTP_ADMIN_EMAIL: "mail@example.test",
    COMMONSWARM_SMTP_HOST: "smtp.example.test",
    COMMONSWARM_SMTP_PORT: "587",
    COMMONSWARM_SMTP_USER: "smtp-user",
    COMMONSWARM_SMTP_PASS: "smtp-pass",
  });

  assert.notEqual(result.code, 0);
  assert.deepEqual(methods, ["GET", "PATCH"]);
  assert.match(result.stderr, /HTTP 401 may be validation, not bad authentication/);
  assert.match(result.stderr, /Custom SMTP required to configure SMTP_SENDER_NAME/);
  assert.match(result.stderr, /\[redacted\]/);
  assert.doesNotMatch(result.stderr, /smtp-pass/);
  assert.doesNotMatch(result.stdout, /Applied/);
  assert.doesNotMatch(result.stdout, /smtp-pass/);
});

test("push script rejects a multi-document auth response before PATCH", async (t) => {
  const methods = [];
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.setHeader("Content-Type", "application/json");
    response.end("{}\n{}\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const result = await runScript(["--apply"], {
    SUPABASE_ACCESS_TOKEN: "fixture-token",
    SUPABASE_MANAGEMENT_API_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_PROJECT_REF: "fixture-project",
  });

  assert.notEqual(result.code, 0);
  assert.deepEqual(methods, ["GET"]);
  assert.match(result.stderr, /not an auth configuration object/);
  assert.doesNotMatch(result.stdout, /No changes/);
  assert.doesNotMatch(result.stdout, /Applied/);
});
