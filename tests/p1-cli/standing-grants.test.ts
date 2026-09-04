/**
 * CLI standing-grant controls and wire contract.
 *
 * Reached by both `npm test` (literal entry) and `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  describeRenewalGrant,
  STANDING_GRANT_RULES,
  STANDING_IDLE_PAUSE_DAYS,
  STANDING_RESUME_ACTORS,
  type RenewalGrantStatus,
  STANDING_RESUME_ACTORS_SENTENCE,
  standingPausedRenewalMessage,
} from "../../src/cloud/renewal-grants.js";
import { credentialStore } from "../../src/cloud/storage.js";
import { RENEWAL_IDLE_PAUSE_DAYS } from "../../src/protocol/workspace-commands.js";

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
    /* The narration carries the SAME rules list the connect page and the grant
       status line carry. The retired assertion pinned the literal "This does not
       expire. Revoke is the only kill switch." — a sentence that omitted the
       14-day pause and named a kill switch that was not the only one. */
    assert.ok(
      standing.stderr.includes(STANDING_GRANT_RULES.join(" ")),
      `mint narration does not carry the standing rules; got: ${standing.stderr}`,
    );
    assert.doesNotMatch(standing.stderr, /Revoke is the only kill switch/);
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
  const lines = describeRenewalGrant(grant);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `Grant: standing — ${STANDING_GRANT_RULES.join(" ")}`);
  /* ★ THE REMEDY IS THE POINT. The retired line said "Next step: ask a workspace
     owner to revoke this grant and mint a new credential" — it offered the
     PERMANENT kill as the cure for the RECOVERABLE pause. That was the only
     honest advice while suspension was one-way, and it is wrong now that it is
     not: a reader who followed it destroyed the lineage to fix a fortnight of
     silence. */
  assert.match(lines[1], /^PAUSED since 2026-08-31T13:00:00Z after 14 days with no use\./);
  assert.match(lines[1], /This is not revoked and the agent is not gone\./);
  assert.match(
    lines[1],
    /cswarm grant resume --renewal-grant-id 00000000-0000-4000-8000-000000000010/,
  );
  assert.doesNotMatch(
    lines[1],
    /revoke this grant and mint a new credential/,
    "the paused remedy must not tell the reader to perform the permanent kill",
  );

  /* ★ THE SECOND SURFACE, SWEPT 2026-09-04. `cswarm whoami` was corrected above while
     src/cloud/renewal.ts still told the reader to "revoke this grant and mint a new
     credential" — and that is the message an operator actually meets, because it is what the
     listener prints when renewal is refused. One claim, two surfaces; a sweep that stops at
     the first one leaves the retired remedy on the louder of the two. Both now read the same
     generated sentence, so neither can drift from swarm.resume_renewal_grant's gate. */
  for (const idle of [true, false]) {
    const message = standingPausedRenewalMessage(idle);
    assert.match(message, /cswarm grant resume/);
    assert.match(message, /It is not revoked and this agent is not gone\./);
    assert.doesNotMatch(
      message,
      /revoke this grant and mint a new credential/,
      "the listener's paused message must not name the permanent kill either",
    );
    assert.ok(
      message.includes(STANDING_RESUME_ACTORS_SENTENCE),
      "the actors come from the shared constant, never retyped",
    );
  }
  assert.match(
    standingPausedRenewalMessage(true),
    new RegExp(`went ${STANDING_IDLE_PAUSE_DAYS} days with no use`),
    "the idle count is generated from the constant the migration is pinned against",
  );
  assert.doesNotMatch(
    standingPausedRenewalMessage(false),
    /days with no use/,
    "a grant paused for another reason must not claim an idle count",
  );

  /* Revoked keeps the opposite advice and says the word that separates the two
     states. Paused and revoked must never read as interchangeable. */
  const revoked = describeRenewalGrant({
    ...grant,
    suspended_at: null,
    revoked_at: "2026-09-01T13:00:00Z",
  });
  assert.match(revoked[1], /REVOKED since 2026-09-01T13:00:00Z\./);
  assert.match(revoked[1], /permanent and cannot be resumed/);
  assert.doesNotMatch(revoked[1], /grant resume/);
});

/**
 * ★ ONE NUMBER, THREE FILES, NO IMPORT BETWEEN THEM.
 *
 * The idle window is enforced by `interval '14 days'` inside
 * swarm.prepare_renewal_grant. The CLI prints it, the connect page prints it,
 * and neither can import PL/pgSQL. AGENTS.md is explicit that a user-facing
 * sentence listing what the code enforces must come from the same constant the
 * enforcement reads, and it records four shipped defects from hand-typed lists
 * that two review arms each passed. Where an import is impossible, this test IS
 * the shared constant: change the interval in SQL without changing both mirrors
 * and it fails here.
 */
test("the idle window and the resume gate agree across SQL, the CLI, and the site", async () => {
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20260904000001_standing_grant_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const site = await readFile(
    new URL("../../site/src/lib/standing-grants.ts", import.meta.url),
    "utf8",
  );

  /* POSITIVE CONTROL FIRST: this regex has to find the interval the migration
     actually installs. Without it a renamed variable would make the assertion
     below vacuous instead of failing. */
  const interval = /idle_since < statement_timestamp\(\) - interval '(\d+) days'/
    .exec(migration);
  assert.ok(
    interval,
    "the migration no longer measures idleness with a days interval; this test cannot see the enforced number",
  );
  assert.equal(Number(interval[1]), STANDING_IDLE_PAUSE_DAYS);

  const siteDays = /STANDING_IDLE_PAUSE_DAYS = (\d+)/.exec(site);
  assert.ok(siteDays, "the site no longer exports STANDING_IDLE_PAUSE_DAYS");
  assert.equal(Number(siteDays[1]), STANDING_IDLE_PAUSE_DAYS);

  /* The reducer is the THIRD copy: it builds the renewal_idle_suspended detail
     an agent is handed, and it is imported here rather than read as text
     because it can be. All three, and the SQL, are one number. */
  assert.equal(RENEWAL_IDLE_PAUSE_DAYS, STANDING_IDLE_PAUSE_DAYS);

  /* The rules paragraph is the same on both sides, so an agent reading the
     pasted prompt and an operator reading `cswarm whoami` are told one thing. */
  assert.match(site, /export const STANDING_GRANT_RULES/);
  for (const actor of STANDING_RESUME_ACTORS) {
    assert.ok(
      site.includes(actor),
      `the site copy drops "${actor}" from the resume gate`,
    );
  }

  /* And the gate the sentence describes is the gate the function applies. */
  assert.match(migration, /actor_role NOT IN \('owner', 'admin'\)/);
  assert.match(migration, /principal_owner <> p_user_id/);
  /* The gate is complete on its own, not completed by the caller: a closed
     workspace and a revoked membership are refused inside the function. */
  assert.match(migration, /w\.archived_at IS NULL/);
  assert.match(migration, /m\.revoked_at IS NULL/);
});

/**
 * ★ THE WEB DEFAULT. An agent added through /app must get a grant that does not
 * expire, and the ONLY thing that makes that true is the field below: the
 * command function defaults an absent renewal_kind to "timeboxed", so omitting
 * it chooses a 30-day expiry by accident.
 */
test("the web add-agent flow asks for a standing grant", async () => {
  const connect = await readFile(
    new URL("../../site/src/lib/agent-connect.ts", import.meta.url),
    "utf8",
  );
  const mint = /export async function mintAgentCredential[\s\S]*?\n}\n/.exec(connect);
  assert.ok(mint, "mintAgentCredential is no longer where this test can read it");
  assert.match(mint[0], /kind: "mint_agent_token"/);
  assert.match(mint[0], /renewal_kind: "standing"/);
  /* A standing grant has no horizon, so the artifact must not carry one. The prompt builder
     prints "the CLI can rotate it until <date>" from this field, and a date this page computed
     for itself would be a deadline nobody measured.

     STRENGTHENED 2026-09-04. This asserted `grantKind === "standing" ? null`, which pinned the
     fix for the STANDING case and left the invention in place for the other one: a timeboxed
     grant still got `times.issuedAt + RENEWAL_HORIZON_DEFAULT_MS`, right only while the
     server's default happened to agree. The horizon is now read off the response for BOTH
     kinds, so what this pins is that the page owns no horizon at all. */
  assert.match(mint[0], /horizonExpiresAt: mintedHorizon\(body\)/);
  assert.doesNotMatch(
    connect,
    /export const RENEWAL_HORIZON_DEFAULT_MS/,
    "the connect page may not own a renewal horizon again; the server names it",
  );

  /* The CLI's own default is UNCHANGED and must stay that way: standing there
     still costs two flags, so a scripted `cswarm token mint` is not silently
     promoted by this lane. */
  const cli = await readFile(
    new URL("../../src/cli.ts", import.meta.url),
    "utf8",
  );
  assert.match(cli, /renewal_kind: standing \? "standing" : "timeboxed"/);
  assert.match(cli, /--standing requires --confirm-standing/);
});

/**
 * ★ THE EXIT EXISTS AND IS REACHABLE. A resume no human can call is the same bug
 * as no resume at all.
 */
test("cswarm grant resume reaches the wire and says what is still to be done", async () => {
  const home = await mkdtemp(join(tmpdir(), "cswarm-grant-resume-"));
  const captured: Array<Record<string, unknown>> = [];
  const grantId = "00000000-0000-4000-8000-000000000020";
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        renewal_grant_id: grantId,
        resumed_at: "2026-09-04T10:00:00.000Z",
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
    const store = await credentialStore({
      target: cloudTarget(url, "anon"),
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
    const resumed = await cli([
      "grant",
      "resume",
      "--workspace-id",
      WORKSPACE,
      "--renewal-grant-id",
      grantId,
      "--url",
      url,
      "--anon-key",
      "anon",
      "--force-file-store",
    ], { HOME: home });
    assert.equal(resumed.code, 0, resumed.stderr);
    const command = captured.at(-1)!.command as Record<string, unknown>;
    assert.equal(command.kind, "resume_renewal_grant");
    assert.equal(command.renewal_grant_id, grantId);
    /* No target fields beyond the grant id: the caller does not name the
       principal, the run, or a role, so a wiring mistake here cannot widen
       what the server's own gate is asked to decide. */
    assert.deepEqual(Object.keys(command).sort(), ["kind", "renewal_grant_id"]);
    /* ★ THE ENVELOPE KEY SET IS PART OF THE CONTRACT, not decoration. The edge
       handler validates it with exactKeys(body, [...]), so one extra or missing
       key here is a 400 in production that a fake server can never show —
       fakes accept anything. This asserts the two lists against each other. */
    assert.deepEqual(
      Object.keys(captured.at(-1)!).sort(),
      ["client_version", "command", "command_id", "stream", "workspace_id"],
    );
    assert.deepEqual(captured.at(-1)!.stream, { kind: "workspace" });
    const edge = await readFile(
      new URL("../../supabase/functions/command/index.ts", import.meta.url),
      "utf8",
    );
    const handler = /async function resumeRenewalGrant[\s\S]*?const shapeOk = exactKeys\(body, \[([\s\S]*?)\]\)/
      .exec(edge);
    assert.ok(handler, "the resume handler no longer validates its envelope with exactKeys");
    assert.deepEqual(
      [...handler[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort(),
      ["client_version", "command", "command_id", "stream", "workspace_id"],
      "the CLI envelope and the edge's accepted key set have drifted apart",
    );

    assert.match(resumed.stdout, /Grant resumed at 2026-09-04T10:00:00\.000Z\./);
    /* HONESTY IS NOT SUFFICIENT. Exit 0 here does not mean the agent is working
       — nothing has contacted it — so the output has to say what is left. */
    assert.match(resumed.stdout, /Nothing has reached the agent yet/);
    assert.match(
      resumed.stdout,
      new RegExp(`another ${STANDING_IDLE_PAUSE_DAYS} days`),
    );
    assert.match(resumed.stdout, /Confirm with: cswarm whoami/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("grant resume refuses an unknown subcommand and a missing grant id before any I/O", async () => {
  const unknown = await cli(["grant", "pause"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown grant command: pause/);

  const missing = await cli(["grant", "resume"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /renewal-grant-id/);
});
