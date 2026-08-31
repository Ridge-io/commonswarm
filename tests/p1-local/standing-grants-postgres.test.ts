/**
 * Real-Postgres standing-grant renewal matrix.
 *
 * Reached only by `npm run test:p1-local`, which owns the local DB slot.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
