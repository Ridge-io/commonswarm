import postgres from "npm:postgres@3.4.9";
import { redactCredentialText } from "../../../src/host/credential-redaction.ts";
import {
  agentCredentialRevoked,
  loadAgentCredential,
} from "../_shared/agent-auth.ts";
import {
  ACTIVITY_EVENT,
  ACTIVITY_REQUEST_MAX_BYTES,
  activityTopic,
  parseActivityRequest,
} from "./core.ts";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer +([^\s]+)$/i;
const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) {
  throw new Error("activity function requires SWARM_DATABASE_URL/SUPABASE_DB_URL");
}

const db = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 10,
});

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? BEARER_RE.exec(header) : null;
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ACTIVITY_REQUEST_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const token = bearer(request);
  if (token === null || !AGENT_TOKEN_RE.test(token)) {
    return json(401, { error: "unauthenticated" });
  }
  const frame = parseActivityRequest(await boundedJson(request));
  if (frame === null) return json(400, { error: "invalid_request" });
  const tokenHash = await sha256(token);

  return await db.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");

    const agent = await loadAgentCredential(tx, tokenHash);
    if (agent === null) return json(401, { error: "unauthenticated" });
    const memberships = await tx<{
      membership_revoked_at: Date | null;
      workspace_archived_at: Date | null;
    }[]>`
      SELECT
        m.revoked_at AS membership_revoked_at,
        w.archived_at AS workspace_archived_at
      FROM swarm.memberships AS m
      JOIN swarm.workspaces AS w ON w.workspace_id = m.workspace_id
      WHERE m.workspace_id = ${agent.principal_workspace_id}::uuid
        AND m.user_id = ${agent.owner_user_id}::uuid
    `;
    const membership = memberships[0];
    if (
      membership === undefined ||
      membership.workspace_archived_at !== null ||
      frame.workspaceId !== agent.principal_workspace_id ||
      await agentCredentialRevoked(
        tx,
        agent,
        membership.membership_revoked_at,
      )
    ) {
      return json(403, { error: "forbidden" });
    }

    const payload = {
      version: 1,
      workspaceId: agent.principal_workspace_id,
      principalId: agent.principal_id,
      streamId: frame.streamId,
      sequence: frame.sequence,
      phase: frame.phase,
      signalId: frame.signalId,
      toolTitle: frame.toolTitle === null
        ? null
        : redactCredentialText(frame.toolTitle).slice(0, 160) || "Tool",
      elapsedMs: frame.elapsedMs,
      emittedAt: new Date().toISOString(),
    };
    // The built-in realtime.send function is not executable by swarm_command.
    // Restore the connection role only after every caller-controlled value has
    // passed the closed parser and agent/workspace authorization above. The
    // one privileged statement receives a derived topic and bound parameters.
    await tx.unsafe("RESET ROLE");
    await tx.unsafe("SET LOCAL search_path = pg_catalog");
    await tx`
      SELECT realtime.send(
        ${tx.json(payload)}::jsonb,
        ${ACTIVITY_EVENT},
        ${activityTopic(agent.principal_workspace_id)},
        true
      )
    `;
    return json(202, { status: "accepted" });
  });
}

Deno.serve((request) =>
  handle(request).catch(() => {
    console.error("activity publish failed");
    return json(500, { error: "internal_error" });
  })
);
