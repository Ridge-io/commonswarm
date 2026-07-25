import postgres from "npm:postgres@3.4.9";
import {
  agentCredentialRevoked,
  loadAgentCredential,
} from "../_shared/agent-auth.ts";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNAL_KINDS = new Set(["working-on", "note", "ask"]);
const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) {
  throw new Error("read function requires SWARM_DATABASE_URL/SUPABASE_DB_URL");
}

const db = postgres(databaseUrl, {
  max: 4,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});

interface SignalReadRequest {
  resource: "signals";
  workspace_id: string;
  inbox: boolean;
  about: string | null;
  kind: string | null;
  since: string | null;
  limit: number;
  include_stale: boolean;
}

interface MemberReadRequest {
  resource: "members";
  workspace_id: string;
}

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
  const match = header ? /^Bearer ([^\s]+)$/.exec(header) : null;
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

function parseBody(
  value: unknown,
): SignalReadRequest | MemberReadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    body.resource === "members" &&
    exactKeys(body, ["resource", "workspace_id"]) &&
    typeof body.workspace_id === "string" &&
    UUID_RE.test(body.workspace_id)
  ) {
    return {
      resource: "members",
      workspace_id: body.workspace_id.toLowerCase(),
    };
  }
  if (
    !exactKeys(body, [
      "resource",
      "workspace_id",
      "inbox",
      "about",
      "kind",
      "since",
      "limit",
      "include_stale",
    ]) ||
    body.resource !== "signals" ||
    typeof body.workspace_id !== "string" ||
    !UUID_RE.test(body.workspace_id) ||
    typeof body.inbox !== "boolean" ||
    !(body.about === null ||
      (typeof body.about === "string" && body.about.length <= 500)) ||
    !(body.kind === null ||
      (typeof body.kind === "string" && SIGNAL_KINDS.has(body.kind))) ||
    !(body.since === null ||
      (typeof body.since === "string" &&
        Number.isFinite(Date.parse(body.since)))) ||
    !Number.isSafeInteger(body.limit) ||
    (body.limit as number) < 1 ||
    (body.limit as number) > 100 ||
    typeof body.include_stale !== "boolean"
  ) {
    return null;
  }
  return {
    ...(body as unknown as SignalReadRequest),
    workspace_id: body.workspace_id.toLowerCase(),
  };
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const token = bearer(request);
  if (token === null || !AGENT_TOKEN_RE.test(token)) {
    return json(401, { error: "unauthenticated" });
  }
  const parsed = await request.json().catch(() => null);
  const body = parseBody(parsed);
  if (body === null) return json(400, { error: "invalid_request" });
  const tokenHash = await sha256(token);

  return await db.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");

    const agent = await loadAgentCredential(tx, tokenHash);
    if (agent === null) return json(401, { error: "unauthenticated" });
    const membershipRows = await tx<{ revoked_at: Date | null }[]>`
      SELECT revoked_at
      FROM swarm.memberships
      WHERE workspace_id = ${agent.principal_workspace_id}::uuid
        AND user_id = ${agent.owner_user_id}::uuid
      LIMIT 1
    `;
    const membership = membershipRows[0];
    if (
      membership === undefined ||
      await agentCredentialRevoked(tx, agent, membership.revoked_at)
    ) {
      return json(403, { error: "forbidden" });
    }

    if (body.workspace_id !== agent.principal_workspace_id) {
      return body.resource === "members"
        ? json(200, { members: [] })
        : json(200, { signals: [] });
    }

    await tx`
      SELECT set_config(
        'request.jwt.claims',
        ${JSON.stringify({
          sub: agent.owner_user_id,
          role: "authenticated",
        })},
        true
      )
    `;
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    await tx.unsafe("SET LOCAL search_path = swarm_read, auth, pg_catalog");
    if (body.resource === "members") {
      const members = await tx<Record<string, unknown>[]>`
        SELECT user_id, display_name
        FROM swarm_read.member_profiles
        WHERE workspace_id = ${body.workspace_id}::uuid
        ORDER BY user_id ASC
      `;
      return json(200, { members });
    }
    const rows = await tx<Record<string, unknown>[]>`
      SELECT
        id, workspace_id, "from", from_kind, "to",
        about, kind, body, until, created_at
      FROM swarm_read.signals
      WHERE workspace_id = ${body.workspace_id}::uuid
        AND (${body.inbox} = false OR "to" = ${agent.owner_user_id}::uuid)
        AND (${body.include_stale} = true OR until > statement_timestamp())
        AND (${body.about}::text IS NULL OR about = ${body.about})
        AND (${body.kind}::text IS NULL OR kind = ${body.kind})
        AND (
          ${body.since}::timestamptz IS NULL OR
          created_at >= ${body.since}::timestamptz
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ${body.limit}
    `;
    return json(200, { signals: rows });
  });
}

Deno.serve((request) =>
  handle(request).catch((error) => {
    console.error(
      "read function failure",
      error instanceof Error ? error.name : "unknown",
    );
    return json(500, { error: "internal_error" });
  })
);
