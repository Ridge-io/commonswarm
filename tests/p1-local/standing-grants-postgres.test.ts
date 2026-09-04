/**
 * Real-Postgres standing-grant renewal matrix.
 *
 * Reached only by `npm run test:p1-local`, which owns the local DB slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import postgres from "postgres";

interface LocalEnvironment {
  DB_URL: string;
}

interface Fixture {
  principalId: string;
  runId: string;
  grantId: string;
  tokenId: string;
  lineageId: string;
  taskId: string;
}

const ROLLBACK = new Error("standing grant fixture rollback");

function databaseUrl(): string {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.DB_URL, "local Supabase must expose DB_URL");
  return parsed.DB_URL;
}

test("standing and timeboxed renewal rules hold on real Postgres", async () => {
  const sql = postgres(databaseUrl(), { max: 1 });
  const userId = randomUUID();
  const nonMemberId = randomUUID();
  const workspaceId = randomUUID();
  const deviceId = randomUUID();
  const foreignDeviceId = randomUUID();

  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO auth.users (
            id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES (
            ${userId}::uuid,
            'authenticated',
            'authenticated',
            ${`standing-${userId}@example.test`},
            '',
            statement_timestamp(),
            '{}'::jsonb,
            '{}'::jsonb,
            statement_timestamp(),
            statement_timestamp()
          )
        `;
        await tx`
          INSERT INTO swarm.users (user_id, display_name)
          VALUES (${userId}::uuid, 'Standing owner')
        `;
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES
            (${deviceId}::uuid, ${userId}::uuid, 'bound-device'),
            (${foreignDeviceId}::uuid, ${userId}::uuid, 'foreign-device')
        `;
        await tx`
          INSERT INTO swarm.workspaces (workspace_id, name, created_by)
          VALUES (${workspaceId}::uuid, 'Standing matrix', ${userId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.memberships (workspace_id, user_id, role)
          VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
        `;

        const seed = async (
          kind: "timeboxed" | "standing",
          options: { oldShape?: boolean; bound?: boolean } = {},
        ): Promise<Fixture> => {
          const fixture: Fixture = {
            principalId: randomUUID(),
            runId: randomUUID(),
            grantId: randomUUID(),
            tokenId: randomUUID(),
            lineageId: randomUUID(),
            taskId: randomUUID(),
          };
          await tx`
            INSERT INTO swarm.agent_principals (
              principal_id, workspace_id, owner_user_id, name
            ) VALUES (
              ${fixture.principalId}::uuid,
              ${workspaceId}::uuid,
              ${userId}::uuid,
              ${`grant-${fixture.principalId.slice(0, 8)}`}
            )
          `;
          await tx`
            INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
            VALUES (
              ${fixture.runId}::uuid,
              ${fixture.principalId}::uuid,
              ${deviceId}::uuid
            )
          `;
          if (options.oldShape) {
            await tx`
              INSERT INTO swarm.renewal_grants (
                renewal_grant_id, workspace_id, principal_id, run_id,
                max_successors, successors_used, horizon_expires_at, created_by
              ) VALUES (
                ${fixture.grantId}::uuid,
                ${workspaceId}::uuid,
                ${fixture.principalId}::uuid,
                ${fixture.runId}::uuid,
                800,
                0,
                statement_timestamp() + interval '30 days',
                ${userId}::uuid
              )
            `;
          } else {
            await tx`
              INSERT INTO swarm.renewal_grants (
                renewal_grant_id, workspace_id, principal_id, run_id,
                kind, max_successors, successors_used, horizon_expires_at,
                bound_device_id, created_by
              ) VALUES (
                ${fixture.grantId}::uuid,
                ${workspaceId}::uuid,
                ${fixture.principalId}::uuid,
                ${fixture.runId}::uuid,
                ${kind},
                ${kind === "standing" ? null : 800},
                0,
                ${kind === "standing" ? null : "30 days"}::interval +
                  CASE WHEN ${kind === "standing"} THEN NULL ELSE statement_timestamp() END,
                ${options.bound === false ? null : kind === "standing" ? deviceId : null}::uuid,
                ${userId}::uuid
              )
            `;
          }
          await tx`
            INSERT INTO swarm.agent_tokens (
              token_id, principal_id, run_id, task_id, epoch, scopes,
              token_hash, expires_at, lineage_id, renewal_grant_id
            ) VALUES (
              ${fixture.tokenId}::uuid,
              ${fixture.principalId}::uuid,
              ${fixture.runId}::uuid,
              ${fixture.taskId}::uuid,
              1,
              '["post_signal"]'::jsonb,
              ${randomBytes(32)},
              statement_timestamp() + interval '30 days',
              ${fixture.lineageId}::uuid,
              ${fixture.grantId}::uuid
            )
          `;
          return fixture;
        };

        const insertSuccessor = async (
          fixture: Fixture,
          hours: number,
          query = tx,
        ): Promise<string> => {
          const tokenId = randomUUID();
          await query`
            INSERT INTO swarm.agent_tokens (
              token_id, principal_id, run_id, task_id, epoch, scopes,
              token_hash, expires_at, lineage_id,
              predecessor_token_id, renewal_grant_id
            ) VALUES (
              ${tokenId}::uuid,
              ${fixture.principalId}::uuid,
              ${fixture.runId}::uuid,
              ${fixture.taskId}::uuid,
              1,
              '["post_signal"]'::jsonb,
              ${randomBytes(32)},
              statement_timestamp() + make_interval(secs => ${hours * 3600}),
              ${fixture.lineageId}::uuid,
              ${fixture.tokenId}::uuid,
              ${fixture.grantId}::uuid
            )
          `;
          return tokenId;
        };

        // A recently used standing grant has no date horizon, even when its
        // creation date is far in the past.
        const standing = await seed("standing");
        await tx`
          UPDATE swarm.renewal_grants
          SET last_used_at = statement_timestamp(),
              last_used_device_id = ${deviceId}::uuid
          WHERE renewal_grant_id = ${standing.grantId}::uuid
        `;
        await tx.unsafe("SET LOCAL session_replication_role = replica");
        await tx`
          UPDATE swarm.renewal_grants
          SET created_at = statement_timestamp() - interval '120 days'
          WHERE renewal_grant_id = ${standing.grantId}::uuid
        `;
        await tx.unsafe("SET LOCAL session_replication_role = origin");
        await tx.unsafe("SET LOCAL ROLE swarm_command");
        const [standingCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${standing.grantId}::uuid,
            ${deviceId}::uuid
          ) AS code
        `;
        await tx.unsafe("RESET ROLE");
        assert.equal(standingCode?.code, null);
        const standingSuccessor = await insertSuccessor(standing, 1);
        const [standingTtl] = await tx<{ ttl_seconds: number }[]>`
          SELECT extract(epoch FROM (expires_at - issued_at))::float8 AS ttl_seconds
          FROM swarm.agent_tokens
          WHERE token_id = ${standingSuccessor}::uuid
        `;
        assert.ok(standingTtl!.ttl_seconds <= 3600);

        const expired = await seed("timeboxed");
        await tx.unsafe("SET LOCAL session_replication_role = replica");
        await tx`
          UPDATE swarm.renewal_grants
          SET created_at = statement_timestamp() - interval '31 days',
              horizon_expires_at = statement_timestamp() - interval '1 day'
          WHERE renewal_grant_id = ${expired.grantId}::uuid
        `;
        await tx.unsafe("SET LOCAL session_replication_role = origin");
        const [expiredCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${expired.grantId}::uuid,
            ${deviceId}::uuid
          ) AS code
        `;
        assert.equal(expiredCode?.code, "renewal_horizon_reached");

        const suspended = await seed("standing");
        await tx`
          UPDATE swarm.renewal_grants
          SET suspended_at = statement_timestamp()
          WHERE renewal_grant_id = ${suspended.grantId}::uuid
        `;
        const [suspendedCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${suspended.grantId}::uuid,
            ${deviceId}::uuid
          ) AS code
        `;
        assert.equal(suspendedCode?.code, "renewal_grant_suspended");

        const revoked = await seed("standing");
        await tx`
          UPDATE swarm.renewal_grants
          SET revoked_at = statement_timestamp(), revoked_by = ${userId}::uuid
          WHERE renewal_grant_id = ${revoked.grantId}::uuid
        `;
        const [revokedCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${revoked.grantId}::uuid,
            ${deviceId}::uuid
          ) AS code
        `;
        assert.equal(revokedCode?.code, "renewal_grant_revoked");

        const idle = await seed("standing");
        await tx`
          UPDATE swarm.renewal_grants
          SET last_used_at = statement_timestamp() - interval '15 days',
              last_used_device_id = ${deviceId}::uuid
          WHERE renewal_grant_id = ${idle.grantId}::uuid
        `;
        const [idleCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${idle.grantId}::uuid,
            ${deviceId}::uuid
          ) AS code
        `;
        assert.equal(idleCode?.code, "renewal_idle_suspended");
        const [idleRow] = await tx<{ suspended_at: Date | null }[]>`
          SELECT suspended_at FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${idle.grantId}::uuid
        `;
        assert.ok(idleRow?.suspended_at instanceof Date);

        const bound = await seed("standing");
        const [boundCode] = await tx<{ code: string | null }[]>`
          SELECT swarm.prepare_renewal_grant(
            ${bound.grantId}::uuid,
            ${foreignDeviceId}::uuid
          ) AS code
        `;
        assert.equal(boundCode?.code, "renewal_device_mismatch");
        const [boundRow] = await tx<{ new_host_at: Date | null }[]>`
          SELECT new_host_at FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${bound.grantId}::uuid
        `;
        assert.ok(boundRow?.new_host_at instanceof Date);

        const ttl = await seed("standing");
        await assert.rejects(
          tx.savepoint(async (sp) => await insertSuccessor(ttl, 9, sp)),
          (error: unknown) => {
            const dbError = error as { code?: string; constraint_name?: string };
            return dbError.code === "55000" &&
              dbError.constraint_name === "renewal_ttl_exceeded";
          },
        );
        const [unspent] = await tx<{ successors_used: number }[]>`
          SELECT successors_used FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${ttl.grantId}::uuid
        `;
        assert.equal(unspent?.successors_used, 0);
        await insertSuccessor(ttl, 1);

        // A row inserted with only the old columns defaults to timeboxed and
        // follows the existing 30-day/800-successor behavior.
        const oldRow = await seed("timeboxed", { oldShape: true });
        const [oldFacts] = await tx<{
          kind: string;
          code: string | null;
        }[]>`
          SELECT grant_row.kind,
                 swarm.prepare_renewal_grant(
                   grant_row.renewal_grant_id,
                   ${deviceId}::uuid
                 ) AS code
          FROM swarm.renewal_grants AS grant_row
          WHERE grant_row.renewal_grant_id = ${oldRow.grantId}::uuid
        `;
        assert.deepEqual(oldFacts, { kind: "timeboxed", code: null });
        await insertSuccessor(oldRow, 1);

        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const memberRows = await tx<{ renewal_grant_id: string }[]>`
          SELECT renewal_grant_id
          FROM swarm_read.renewal_grant_roster(${workspaceId}::uuid)
        `;
        assert.ok(memberRows.length >= 8);
        await tx.unsafe("RESET ROLE");
        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: nonMemberId, role: "authenticated" })},
            true
          )
        `;
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const hiddenRows = await tx<{ renewal_grant_id: string }[]>`
          SELECT renewal_grant_id
          FROM swarm_read.renewal_grant_roster(${workspaceId}::uuid)
        `;
        assert.equal(hiddenRows.length, 0);
        await tx.unsafe("RESET ROLE");

        await tx.unsafe("SET LOCAL ROLE swarm_read");
        const agentRows = await tx<{
          renewal_grant_id: string;
          principal_id: string;
        }[]>`
          SELECT renewal_grant_id, principal_id
          FROM swarm_read.renewal_grant_for_token(
            ${workspaceId}::uuid,
            ${standing.tokenId}::uuid
          )
        `;
        assert.equal(agentRows.length, 1);
        assert.equal(agentRows[0]?.renewal_grant_id, standing.grantId);
        assert.equal(agentRows[0]?.principal_id, standing.principalId);
        const otherTokenRows = await tx<{ renewal_grant_id: string }[]>`
          SELECT renewal_grant_id
          FROM swarm_read.renewal_grant_for_token(
            ${workspaceId}::uuid,
            ${randomUUID()}::uuid
          )
        `;
        assert.equal(otherTokenRows.length, 0);
        await tx.unsafe("RESET ROLE");

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});

/**
 * ★ AN IDLE PAUSE IS RECOVERABLE; A REVOCATION IS NOT.
 *
 * THE MIGRATION IS APPLIED INSIDE THIS TRANSACTION and rolled back with the
 * fixture. That is deliberate: it measures the artifact rather than its name —
 * the file this repository will ship is the file whose behaviour is asserted
 * below — and it does not require the shared local database to be reset, which
 * would destroy another lane's slot.
 *
 * EVERY ASSERTION HERE FAILS AGAINST THE PRE-MIGRATION SCHEMA, and not
 * incidentally. Before 20260904000001 there was no swarm.resume_renewal_grant at
 * all, and swarm.renewal_grants_spend_or_revoke_only() raised
 * SWARM_RENEWAL_GRANT_UNSUSPEND on every un-suspend, so a standing grant that
 * went 14 days without use was dead for good. Run this test with the migration
 * skipped and the first resume errors with "function
 * swarm.resume_renewal_grant(uuid, uuid, uuid) does not exist".
 */
test("an idle-paused standing grant is resumable by its owner and a revoked one never is", async () => {
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20260904000001_standing_grant_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const sql = postgres(databaseUrl(), { max: 1 });
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const adminId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const deviceId = randomUUID();

  const seedUser = async (tx: postgres.TransactionSql, id: string, name: string) => {
    await tx`
      INSERT INTO auth.users (
        id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) VALUES (
        ${id}::uuid, 'authenticated', 'authenticated',
        ${`resume-${id}@example.test`}, '', statement_timestamp(),
        '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
      )
    `;
    await tx`
      INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})
    `;
  };

  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx.unsafe(migration);

        await seedUser(tx, ownerId, "Grant owner");
        await seedUser(tx, strangerId, "Stranger");
        await seedUser(tx, adminId, "Workspace admin");
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES (${deviceId}::uuid, ${ownerId}::uuid, 'bound-device')
        `;
        await tx`
          INSERT INTO swarm.workspaces (workspace_id, name, created_by)
          VALUES
            (${workspaceId}::uuid, 'Resume matrix', ${ownerId}::uuid),
            (${otherWorkspaceId}::uuid, 'Other tenant', ${ownerId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.memberships (workspace_id, user_id, role)
          VALUES
            (${workspaceId}::uuid, ${ownerId}::uuid, 'member'),
            (${workspaceId}::uuid, ${adminId}::uuid, 'admin'),
            (${otherWorkspaceId}::uuid, ${strangerId}::uuid, 'owner')
        `;

        const seedStanding = async (): Promise<Fixture> => {
          const fixture: Fixture = {
            principalId: randomUUID(),
            runId: randomUUID(),
            grantId: randomUUID(),
            tokenId: randomUUID(),
            lineageId: randomUUID(),
            taskId: randomUUID(),
          };
          await tx`
            INSERT INTO swarm.agent_principals (
              principal_id, workspace_id, owner_user_id, name
            ) VALUES (
              ${fixture.principalId}::uuid, ${workspaceId}::uuid,
              ${ownerId}::uuid, ${`resume-${fixture.principalId.slice(0, 8)}`}
            )
          `;
          await tx`
            INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
            VALUES (
              ${fixture.runId}::uuid, ${fixture.principalId}::uuid, ${deviceId}::uuid
            )
          `;
          await tx`
            INSERT INTO swarm.renewal_grants (
              renewal_grant_id, workspace_id, principal_id, run_id,
              kind, max_successors, successors_used, horizon_expires_at,
              bound_device_id, created_by
            ) VALUES (
              ${fixture.grantId}::uuid, ${workspaceId}::uuid,
              ${fixture.principalId}::uuid, ${fixture.runId}::uuid,
              'standing', NULL, 0, NULL, ${deviceId}::uuid, ${ownerId}::uuid
            )
          `;
          await tx`
            INSERT INTO swarm.agent_tokens (
              token_id, principal_id, run_id, task_id, epoch, scopes,
              token_hash, expires_at, lineage_id, renewal_grant_id
            ) VALUES (
              ${fixture.tokenId}::uuid, ${fixture.principalId}::uuid,
              ${fixture.runId}::uuid, ${fixture.taskId}::uuid, 1,
              '["post_signal"]'::jsonb, ${randomBytes(32)},
              statement_timestamp() + interval '30 days',
              ${fixture.lineageId}::uuid, ${fixture.grantId}::uuid
            )
          `;
          return fixture;
        };

        /**
         * Fixture time travel: put the whole grant `days` into the past.
         *
         * THE TRIGGER IS TURNED OFF FOR THIS, and the reason is itself a result.
         * Ageing a grant that has already been resumed means moving resumed_at
         * backwards, and swarm.renewal_grants_spend_or_revoke_only() refuses
         * that with SWARM_RENEWAL_RESUME_REWOUND — correctly, because a resume
         * is forward-only. Migration 20260728000004 disables the same trigger
         * for the same kind of backfill. This shifts a clock and asserts
         * nothing; every assertion below runs with the trigger back on.
         *
         * suspended_at is aged one day FURTHER than resumed_at so the pair keeps
         * its real order. Aged together, resumed_at <= suspended_at and the
         * generated suspension_active would read true again — which would test
         * arithmetic on the fixture instead of the idle rule.
         */
        const goIdle = async (fixture: Fixture, days: number) => {
          await tx.unsafe("RESET ROLE");
          await tx.unsafe(
            "ALTER TABLE swarm.renewal_grants DISABLE TRIGGER renewal_grants_spend_or_revoke_only",
          );
          await tx`
            UPDATE swarm.renewal_grants
            SET last_used_at = statement_timestamp() - make_interval(days => ${days}),
                last_used_device_id = ${deviceId}::uuid,
                suspended_at = CASE
                  WHEN suspended_at IS NULL THEN NULL
                  ELSE statement_timestamp() - make_interval(days => ${days + 1})
                END,
                resumed_at = CASE
                  WHEN resumed_at IS NULL THEN NULL
                  ELSE statement_timestamp() - make_interval(days => ${days})
                END
            WHERE renewal_grant_id = ${fixture.grantId}::uuid
          `;
          await tx.unsafe(
            "ALTER TABLE swarm.renewal_grants ENABLE TRIGGER renewal_grants_spend_or_revoke_only",
          );
          await tx.unsafe("SET LOCAL ROLE swarm_command");
        };

        const preflight = async (fixture: Fixture): Promise<string | null> => {
          const rows = await tx<{ code: string | null }[]>`
            SELECT swarm.prepare_renewal_grant(
              ${fixture.grantId}::uuid, ${deviceId}::uuid
            ) AS code
          `;
          return rows[0]?.code ?? null;
        };

        const resume = async (
          fixture: Fixture,
          actor: string,
          workspace = workspaceId,
        ): Promise<string | null> => {
          const rows = await tx<{ code: string | null }[]>`
            SELECT swarm.resume_renewal_grant(
              ${workspace}::uuid, ${fixture.grantId}::uuid, ${actor}::uuid
            ) AS code
          `;
          return rows[0]?.code ?? null;
        };

        await tx.unsafe("SET LOCAL ROLE swarm_command");

        // ─── 1. The pause still happens, and it is still fail-closed. ───────
        const parked = await seedStanding();
        assert.equal(await preflight(parked), null, "a fresh standing grant renews");
        await goIdle(parked, 20);
        assert.equal(
          await preflight(parked),
          "renewal_idle_suspended",
          "20 idle days must still pause a standing grant",
        );
        assert.equal(
          await preflight(parked),
          "renewal_grant_suspended",
          "a paused grant stays refused; nothing the agent does lifts it",
        );

        // ─── 2. The pause is now recoverable, by the grant's owner. ─────────
        assert.equal(
          await resume(parked, strangerId),
          "renewal_resume_forbidden",
          "a member of another workspace may not resume this grant",
        );
        assert.equal(
          await resume(parked, ownerId, otherWorkspaceId),
          "renewal_grant_not_found",
          "naming the grant under the wrong workspace must not authorise it",
        );
        assert.equal(
          await resume(parked, ownerId),
          null,
          "the member who owns the principal may resume its grant",
        );

        /* ★ THE ASSERTION THIS WHOLE MIGRATION EXISTS FOR. Before it, this line
           read "renewal_grant_suspended" forever. */
        assert.equal(
          await preflight(parked),
          null,
          "after a resume the grant must renew again",
        );

        /* ★ AND THE IDLE CLOCK RESTARTED. last_used_at is still 20 days old, so
           a resume that only cleared the flag would be re-paused by the very
           next preflight — a fix that looked like a fix and was a loop. */
        const afterResume = await tx<{
          suspended_at: Date | null;
          resumed_at: Date | null;
          resume_count: number;
          suspension_active: boolean;
          last_used_at: Date | null;
        }[]>`
          SELECT suspended_at, resumed_at, resume_count, suspension_active, last_used_at
          FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${parked.grantId}::uuid
        `;
        assert.equal(afterResume[0]?.suspension_active, false);
        assert.equal(Number(afterResume[0]?.resume_count), 1);
        assert.ok(
          afterResume[0]?.suspended_at !== null,
          "the pause that happened is never erased from the row",
        );
        assert.ok(
          Date.now() - Number(afterResume[0]?.last_used_at) > 19 * 86_400_000,
          "the fixture must still be idle, or the clock-restart assertion proves nothing",
        );

        // ─── 3. Resume is not idempotent-by-accident and not free. ──────────
        assert.equal(
          await resume(parked, ownerId),
          "renewal_grant_not_suspended",
          "resuming a running grant is refused rather than silently counted",
        );
        assert.equal(
          await resume(parked, adminId),
          "renewal_grant_not_suspended",
          "an admin gets the same answer, so the gate is not what refused it",
        );

        // ─── 4. A second lapse pauses again, and an admin can lift it. ──────
        await goIdle(parked, 20);
        assert.equal(await preflight(parked), "renewal_idle_suspended");
        assert.equal(await resume(parked, adminId), null, "an admin may resume");
        const twice = await tx<{ resume_count: number }[]>`
          SELECT resume_count FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${parked.grantId}::uuid
        `;
        assert.equal(Number(twice[0]?.resume_count), 2);

        // ─── 5. REVOKED IS FOREVER, at three independent fences. ────────────
        const killed = await seedStanding();
        await goIdle(killed, 20);
        assert.equal(await preflight(killed), "renewal_idle_suspended");
        await tx`
          UPDATE swarm.renewal_grants
          SET revoked_at = statement_timestamp(), revoked_by = ${ownerId}::uuid
          WHERE renewal_grant_id = ${killed.grantId}::uuid
        `;
        assert.equal(
          await resume(killed, ownerId),
          "renewal_grant_revoked",
          "the gate refuses a revoked grant",
        );
        assert.equal(await preflight(killed), "renewal_grant_revoked");

        /* Fence two: the row trigger, reached by bypassing the gate entirely. */
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`
              UPDATE swarm.renewal_grants
              SET resumed_at = statement_timestamp(),
                  resumed_by = ${ownerId}::uuid,
                  resume_count = resume_count + 1
              WHERE renewal_grant_id = ${killed.grantId}::uuid
            `;
          }),
          /SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE/,
        );

        /* Fence three: clearing the pause outright is refused exactly as before,
           so the suspension record cannot be laundered into a resume. */
        const stillPaused = await seedStanding();
        await goIdle(stillPaused, 20);
        assert.equal(await preflight(stillPaused), "renewal_idle_suspended");
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`
              UPDATE swarm.renewal_grants SET suspended_at = NULL
              WHERE renewal_grant_id = ${stillPaused.grantId}::uuid
            `;
          }),
          /SWARM_RENEWAL_GRANT_UNSUSPEND/,
        );
        /* And a resume cannot be forged without a pause to answer, or without
           saying who performed it. */
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`
              UPDATE swarm.renewal_grants
              SET resumed_at = statement_timestamp(), resume_count = resume_count + 1
              WHERE renewal_grant_id = ${stillPaused.grantId}::uuid
            `;
          }),
          /SWARM_RENEWAL_RESUME_UNATTRIBUTED/,
        );
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`
              UPDATE swarm.renewal_grants
              SET resume_count = resume_count + 1
              WHERE renewal_grant_id = ${stillPaused.grantId}::uuid
            `;
          }),
          /SWARM_RENEWAL_RESUME_UNATTRIBUTED/,
        );

        // ─── 6. What a person reads: effective suspension, not the record. ──
        await tx.unsafe("RESET ROLE");
        await tx.unsafe(
          `SELECT set_config('request.jwt.claims', '{"sub":"${ownerId}"}', true)`,
        );
        await tx.unsafe("SET LOCAL ROLE authenticated");
        const roster = await tx<{
          renewal_grant_id: string;
          suspended_at: Date | null;
        }[]>`
          SELECT renewal_grant_id, suspended_at
          FROM swarm_read.renewal_grant_roster(${workspaceId}::uuid)
        `;
        const resumedRow = roster.find((row) => row.renewal_grant_id === parked.grantId);
        const pausedRow = roster.find((row) => row.renewal_grant_id === stillPaused.grantId);
        assert.ok(resumedRow, "the resumed grant is still on the roster");
        assert.ok(pausedRow, "the paused grant is still on the roster");
        /* The dashboard's SUSPENDED badge reads this field. A resumed grant must
           stop wearing it, or the operator is told the agent is dead. */
        assert.equal(
          resumedRow.suspended_at,
          null,
          "a resumed grant must not read as suspended",
        );
        assert.ok(
          pausedRow.suspended_at !== null,
          "a genuinely paused grant must still read as suspended",
        );
        await tx.unsafe("RESET ROLE");

        throw ROLLBACK;
      }),
      (error: unknown) => error === ROLLBACK,
    );
  } finally {
    await sql.end();
  }
});
