import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const P0_SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
] as const;

export interface SeedDogfoodOptions {
  databaseUrl: string;
  userId: string;
  deviceId?: string;
  workspaceId?: string;
  displayName?: string;
  workspaceName?: string;
  agentName?: string;
}

export interface SeedDogfoodResult {
  userId: string;
  membershipRole: "owner";
  deviceId: string;
  workspaceId: string;
  workspaceName: string;
  streamId: string;
  principalId: string;
  runId: string;
  tokenId: string;
  /** Present exactly once, when this invocation minted a new live token. */
  agentToken: string | null;
  tokenExpiresAt: string;
}

function deterministicUuid(label: string): string {
  const bytes = createHash("sha256").update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function uuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

export async function seedDogfood(
  options: SeedDogfoodOptions,
): Promise<SeedDogfoodResult> {
  if (!options.databaseUrl) throw new Error("DATABASE_URL is required");
  const userId = uuid(options.userId, "uid");
  const deviceId = options.deviceId
    ? uuid(options.deviceId, "device id")
    : deterministicUuid(`cloud-swarm:device:${userId}`);
  const workspaceId = options.workspaceId
    ? uuid(options.workspaceId, "workspace id")
    : deterministicUuid(`cloud-swarm:workspace:${userId}`);
  const requestedStreamId = deterministicUuid(
    `cloud-swarm:workspace-stream:${workspaceId}`,
  );
  const requestedPrincipalId = deterministicUuid(
    `cloud-swarm:principal:${workspaceId}:${options.agentName ?? "dogfood-agent"}`,
  );
  const displayName = (options.displayName ?? "Dogfood Operator").slice(0, 120);
  const requestedWorkspaceName =
    (options.workspaceName ?? "Dogfood Workspace").slice(0, 120);
  const agentName = (options.agentName ?? "dogfood-agent").slice(0, 80);
  const sql = postgres(options.databaseUrl, {
    prepare: false,
    max: 1,
    connect_timeout: 10,
  });

  try {
    return await sql.begin(async (tx) => {
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES (${userId}::uuid, ${displayName})
        ON CONFLICT (user_id) DO NOTHING
      `;
      await tx`
        SELECT user_id
        FROM swarm.users
        WHERE user_id = ${userId}::uuid
        FOR UPDATE
      `;
      await tx`
        INSERT INTO swarm.devices AS existing (device_id, user_id, label)
        VALUES (${deviceId}::uuid, ${userId}::uuid, 'slice-3-dogfood')
        ON CONFLICT (device_id) DO UPDATE SET
          label = EXCLUDED.label,
          revoked_at = NULL
        WHERE existing.user_id = EXCLUDED.user_id
      `;
      const devices = await tx<{ user_id: string }[]>`
        SELECT user_id FROM swarm.devices WHERE device_id = ${deviceId}::uuid
      `;
      if (devices[0]?.user_id !== userId) {
        throw new Error("device id is already owned by another user");
      }

      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${workspaceId}::uuid, ${requestedWorkspaceName}, ${userId}::uuid)
        ON CONFLICT (workspace_id) DO NOTHING
      `;
      const workspaces = await tx<{ created_by: string; name: string }[]>`
        SELECT created_by, name
        FROM swarm.workspaces
        WHERE workspace_id = ${workspaceId}::uuid
      `;
      if (workspaces[0]?.created_by !== userId) {
        throw new Error("workspace id is already owned by another user");
      }
      const workspaceName = workspaces[0].name;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role, revoked_at)
        VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner', NULL)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
          role = 'owner',
          revoked_at = NULL
      `;
      await tx`
        INSERT INTO swarm.streams (
          stream_id, workspace_id, kind, repo_mapping_id
        ) VALUES (
          ${requestedStreamId}::uuid, ${workspaceId}::uuid, 'workspace', NULL
        )
        ON CONFLICT DO NOTHING
      `;
      const streams = await tx<{ stream_id: string }[]>`
        SELECT stream_id
        FROM swarm.streams
        WHERE workspace_id = ${workspaceId}::uuid
          AND kind = 'workspace'
        LIMIT 1
      `;
      const streamId = streams[0]?.stream_id;
      if (!streamId) throw new Error("workspace stream seed failed");

      await tx`
        INSERT INTO swarm.agent_principals AS existing (
          principal_id, workspace_id, owner_user_id, name
        ) VALUES (
          ${requestedPrincipalId}::uuid,
          ${workspaceId}::uuid,
          ${userId}::uuid,
          ${agentName}
        )
        ON CONFLICT (principal_id) DO UPDATE SET
          revoked_at = NULL
        WHERE existing.workspace_id = EXCLUDED.workspace_id
          AND existing.owner_user_id = EXCLUDED.owner_user_id
      `;
      const principals = await tx<{ principal_id: string; owner_user_id: string }[]>`
        SELECT principal_id, owner_user_id
        FROM swarm.agent_principals
        WHERE workspace_id = ${workspaceId}::uuid
          AND name = ${agentName}
        LIMIT 1
      `;
      const principal = principals[0];
      if (!principal || principal.owner_user_id !== userId) {
        throw new Error("agent principal name is already owned by another user");
      }
      const principalId = principal.principal_id;
      const runId = deterministicUuid(
        `cloud-swarm:run:${principalId}:${deviceId}`,
      );
      await tx`
        INSERT INTO swarm.agent_runs AS existing (
          run_id, principal_id, device_id
        )
        VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
        ON CONFLICT (run_id) DO UPDATE SET
          ended_at = NULL
        WHERE existing.principal_id = EXCLUDED.principal_id
          AND existing.device_id = EXCLUDED.device_id
      `;
      const runs = await tx<{ principal_id: string; device_id: string }[]>`
        SELECT principal_id, device_id
        FROM swarm.agent_runs
        WHERE run_id = ${runId}::uuid
      `;
      if (
        runs[0]?.principal_id !== principalId ||
        runs[0]?.device_id !== deviceId
      ) {
        throw new Error("agent run id is already bound to another principal or device");
      }

      const existing = await tx<{ token_id: string; expires_at: Date }[]>`
        SELECT token_id, expires_at
        FROM swarm.agent_tokens
        WHERE principal_id = ${principalId}::uuid
          AND run_id = ${runId}::uuid
          AND revoked_at IS NULL
          AND expires_at > statement_timestamp() + interval '1 minute'
          AND scopes = ${tx.json([...P0_SCOPES])}::jsonb
        ORDER BY expires_at DESC
        LIMIT 1
      `;
      if (existing[0]) {
        return {
          userId,
          membershipRole: "owner",
          deviceId,
          workspaceId,
          workspaceName,
          streamId,
          principalId,
          runId,
          tokenId: existing[0].token_id,
          agentToken: null,
          tokenExpiresAt: existing[0].expires_at.toISOString(),
        };
      }

      const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(agentToken).digest();
      const tokenId = randomUUID();
      const lineageId = randomUUID();
      const inserted = await tx<{ expires_at: Date }[]>`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, task_id, epoch,
          scopes, token_hash, expires_at, lineage_id
        ) VALUES (
          ${tokenId}::uuid,
          ${principalId}::uuid,
          ${runId}::uuid,
          NULL,
          NULL,
          ${tx.json([...P0_SCOPES])}::jsonb,
          ${tokenHash},
          statement_timestamp() + interval '1 hour',
          ${lineageId}::uuid
        )
        RETURNING expires_at
      `;
      const expiresAt = inserted[0]?.expires_at;
      if (!expiresAt) throw new Error("agent token seed failed");
      return {
        userId,
        membershipRole: "owner",
        deviceId,
        workspaceId,
        workspaceName,
        streamId,
        principalId,
        runId,
        tokenId,
        agentToken,
        tokenExpiresAt: expiresAt.toISOString(),
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
