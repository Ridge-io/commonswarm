/**
 * CLI standing-grant controls and wire contract.
 *
 * Reached by both `npm test` (literal entry) and `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  describeRenewalGrant,
  type RenewalGrantStatus,
} from "../../src/cloud/renewal-grants.js";
import { credentialStore } from "../../src/cloud/storage.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const TASK = "00000000-0000-4000-8000-000000000004";
const USER = "00000000-0000-4000-8000-000000000005";
const DEVICE = "00000000-0000-4000-8000-000000000006";

async function cli(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
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
      ...environment,
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

function mintArgs(extra: string[] = []): string[] {
  return [
    "token",
    "mint",
    "--workspace-id",
    WORKSPACE,
    "--principal-id",
    PRINCIPAL,
    "--run-id",
    RUN,
    "--task-id",
    TASK,
    "--epoch",
    "1",
    ...extra,
  ];
}

test("standing mint refuses missing confirmation and a horizon contradiction before I/O", async () => {
  const missing = await cli(mintArgs(["--standing"]));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--standing requires --confirm-standing/);
  assert.match(missing.stderr, /must be revoked to stop renewal/);

  const contradiction = await cli(mintArgs([
    "--standing",
    "--confirm-standing",
    "--renewal-horizon-days",
    "7",
  ]));
  assert.equal(contradiction.code, 1);
  assert.match(contradiction.stderr, /conflict/);
  assert.match(contradiction.stderr, /standing grant has no renewal horizon/);
});

test("confirmed standing mint and timeboxed horizon reach the command wire", async () => {
  const home = await mkdtemp(join(tmpdir(), "cswarm-standing-cli-"));
  const captured: Array<Record<string, unknown>> = [];
  let refresh = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (url.pathname === "/auth/v1/token") {
      refresh += 1;
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: `access-${refresh}`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `refresh-token-${refresh}`,
        user: {
          id: USER,
          aud: "authenticated",
          role: "authenticated",
          email: "standing@example.test",
          email_confirmed_at: now,
          phone: "",
          confirmed_at: now,
          last_sign_in_at: now,
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (url.pathname === "/functions/v1/command") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      captured.push(body);
      const command = body.command as Record<string, unknown>;
      const standing = command.renewal_kind === "standing";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        events: [],
        token_id: randomUUID(),
        principal_id: PRINCIPAL,
        run_id: RUN,
        agent_token: `swm_agt_${randomBytes(32).toString("base64url")}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        grant_kind: standing ? "standing" : "timeboxed",
        horizon_expires_at: standing
          ? null
          : new Date(Date.now() + Number(command.renewal_horizon_ms)).toISOString(),
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const target = cloudTarget(url, "anon");
    const store = await credentialStore({
      target,
      stateDirectory: join(home, ".cswarm", "credentials.d"),
      forceFile: true,
      platform: "linux",
      warn: () => undefined,
    });
    await store.write({
      version: 1,
      refreshToken: "refresh-token-seed",
      generation: 0,
      deviceId: DEVICE,
      userId: USER,
    });
    const targetArgs = [
      "--url",
      url,
      "--anon-key",
      "anon",
      "--force-file-store",
    ];
    const standing = await cli(
      mintArgs(["--standing", "--confirm-standing", ...targetArgs]),
      { HOME: home },
    );
    assert.equal(standing.code, 0, standing.stderr);
    assert.match(standing.stderr, /Standing grant created/);
    assert.match(standing.stderr, /This does not expire\. Revoke is the only kill switch\./);
    const standingCommand = captured[0]!.command as Record<string, unknown>;
    assert.equal(standingCommand.renewal_kind, "standing");
    assert.equal(Object.hasOwn(standingCommand, "renewal_horizon_ms"), false);

    const timeboxed = await cli(
      mintArgs(["--renewal-horizon-days", "7", ...targetArgs]),
      { HOME: home },
    );
    assert.equal(timeboxed.code, 0, timeboxed.stderr);
    assert.match(timeboxed.stderr, /authorise it again in 7 days/);
    const timeboxedCommand = captured[1]!.command as Record<string, unknown>;
    assert.equal(timeboxedCommand.renewal_kind, "timeboxed");
    assert.equal(timeboxedCommand.renewal_horizon_ms, 7 * 24 * 60 * 60_000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("status wording follows the server grant shape and gives suspended next step", () => {
  const grant: RenewalGrantStatus = {
    renewal_grant_id: "00000000-0000-4000-8000-000000000010",
    principal_id: PRINCIPAL,
    kind: "standing",
    horizon_expires_at: null,
    bound_device_id: DEVICE,
    last_used_at: "2026-08-31T12:00:00Z",
    last_used_device_id: DEVICE,
    last_used_from: null,
    new_host_at: null,
    suspended_at: "2026-08-31T13:00:00Z",
    revoked_at: null,
    token_id: "00000000-0000-4000-8000-000000000011",
    issued_at: "2026-08-31T11:00:00Z",
    token_expires_at: "2026-08-31T14:00:00Z",
    token_revoked_at: null,
  };
  assert.deepEqual(describeRenewalGrant(grant), [
    "Grant: standing — does not expire; revoke is the only kill switch.",
    "SUSPENDED since 2026-08-31T13:00:00Z. Next step: ask a workspace owner to revoke this grant and mint a new credential.",
  ]);
});
