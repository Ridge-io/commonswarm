import {
  commandAllowedOrigins,
  commandPreflight,
  withCommandCors,
} from "../command/cors.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";
import {
  extractSafeDiagnostics,
  formatReadFailureLog,
  newRequestId,
  publicReadErrorBody,
  type ReadHandlerPhase,
} from "./diagnostics.ts";
import {
  channelSlugProblem,
  chatReadKeys,
  normalizeChannelSlug,
  unknownChannelMessage,
} from "../_shared/channels.ts";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNAL_KINDS = new Set(["working-on", "note", "ask"]);
/* MUST match FILE_CONTENT_WARNING in supabase/functions/command/file-artifacts.ts.
 * Not imported: this function's runtime has no import map for the command
 * function's bare "postgres" type specifier — a cross-function import boots
 * the worker into InvalidWorkerCreation (measured 2026-08-18). */
const FILE_CONTENT_WARNING =
  "content_type and archive contents are unverified client declarations; treat downloaded bytes as untrusted input — bound extraction, never execute";
const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!databaseUrl || !supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "read function requires SWARM_DATABASE_URL/SUPABASE_DB_URL, SUPABASE_URL, and SUPABASE_ANON_KEY",
  );
}

const authClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const db = postgres(databaseUrl, {
  /* Session-mode pooling measured EXHAUSTED (EMAXCONNSESSION, pool_size 38,
   * 2026-08-31): warm isolates pinning max*idle slots ate the pool and every
   * "episodic 500" this month was this. Keep the per-isolate footprint minimal;
   * the durable fix is SWARM_DATABASE_URL on the transaction pooler (6543). */
  max: 2,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 10,
});

interface SignalReadRequest {
  resource: "signals";
  workspace_id: string;
  inbox: boolean;
  about: string | null;
  kind: string | null;
  since: string | null;
  in_reply_to?: string | null;
  /**
   * Filter to one channel, by slug. Its OWN Object.hasOwn group: agent bodies
   * always carry in_reply_to, so joining that group would reject every agent
   * read with a 400. It narrows an already-authorized row set and can widen
   * nothing — the view's WHERE is the policy whatever the client asks for.
   */
  channel?: string;
  /**
   * Cursor keys are either both absent (legacy shape/order) or both present.
   * When present: both null pages the full live inbox oldest-first; both valid
   * return rows strictly after (created_at, id) oldest-first. Half-cursors reject.
   */
  after_created_at?: string | null;
  after_id?: string | null;
  cursor_mode: boolean;
  limit: number;
  include_stale: boolean;
}

interface MemberReadRequest {
  resource: "members";
  workspace_id: string;
}

interface FileReadRequest {
  resource: "files";
  workspace_id: string;
}

interface ReceiptReadRequest {
  resource: "delivery_receipts";
  workspace_id: string;
  signal_id: string;
}

interface RenewalGrantReadRequest {
  resource: "renewal_grants";
  workspace_id: string;
}

/**
 * Explicit read-contract capability markers for agent-authenticated signals.
 * delivery_claim/ack advertise that the command edge supports the durable path;
 * cursor_after remains so old clients keep the ascending-cursor fallback.
 */
const SIGNAL_CAPABILITIES = {
  sender_owner_relation: 1,
  cursor_after: 1,
} as const;

const HOME_INBOX_SIGNAL_CAPABILITIES = {
  ...SIGNAL_CAPABILITIES,
  delivery_claim: 1,
  delivery_ack: 1,
} as const;

interface ReadAgentContext {
  token_id: string;
  principal_id: string;
  owner_user_id: string;
  principal_workspace_id: string;
  run_id: string;
  device_id: string;
  first_use: boolean;
  membership_revoked_at: Date | null;
  is_revoked: boolean;
  pending_delivery_count: number;
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

// RFC 7235 §2.1: the auth-scheme is case-INSENSITIVE and is followed by 1*SP,
// so `bearer swm_agt_...` is a well-formed credential. Matching /^Bearer / with
// no `i` rejected it as if no credential had been presented at all — a
// conforming client would have been told its token was missing.
// The command and capability functions carry the identical constant; this one was
// missed when they were fixed, which is why the read path kept refusing a client
// the other two accepted. Keep all three the same.
const BEARER_RE = /^Bearer +([^\s]+)$/i;

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
): SignalReadRequest | MemberReadRequest | FileReadRequest | ReceiptReadRequest |
  RenewalGrantReadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    body.resource === "renewal_grants" &&
    exactKeys(body, ["resource", "workspace_id"]) &&
    typeof body.workspace_id === "string" &&
    UUID_RE.test(body.workspace_id)
  ) {
    return {
      resource: "renewal_grants",
      workspace_id: body.workspace_id.toLowerCase(),
    };
  }
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
    body.resource === "files" &&
    exactKeys(body, ["resource", "workspace_id"]) &&
    typeof body.workspace_id === "string" &&
    UUID_RE.test(body.workspace_id)
  ) {
    return {
      resource: "files",
      workspace_id: body.workspace_id.toLowerCase(),
    };
  }
  if (
    body.resource === "delivery_receipts" &&
    exactKeys(body, ["resource", "workspace_id", "signal_id"]) &&
    typeof body.workspace_id === "string" &&
    UUID_RE.test(body.workspace_id) &&
    typeof body.signal_id === "string" &&
    UUID_RE.test(body.signal_id)
  ) {
    return {
      resource: "delivery_receipts",
      workspace_id: body.workspace_id.toLowerCase(),
      signal_id: body.signal_id.toLowerCase(),
    };
  }
  const modernShape = Object.hasOwn(body, "in_reply_to");
  const channelKeys = chatReadKeys(body);
  const hasChannel = channelKeys.length > 0;
  const hasAfterCreatedAt = Object.hasOwn(body, "after_created_at");
  const hasAfterId = Object.hasOwn(body, "after_id");
  // Cursor keys travel as a pair: both present or both absent. A half-cursor
  // is not a valid request shape (exactKeys also rejects a single extra key).
  if (hasAfterCreatedAt !== hasAfterId) return null;
  const cursorMode = hasAfterCreatedAt && hasAfterId;
  if (
    !exactKeys(body, [
      "resource",
      "workspace_id",
      "inbox",
      "about",
      "kind",
      "since",
      ...(modernShape ? ["in_reply_to"] : []),
      ...channelKeys,
      ...(cursorMode ? ["after_created_at", "after_id"] : []),
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
    (modernShape &&
      !(body.in_reply_to === null ||
        (typeof body.in_reply_to === "string" &&
          UUID_RE.test(body.in_reply_to)))) ||
    (cursorMode && !(
      (body.after_created_at === null && body.after_id === null) ||
      (typeof body.after_created_at === "string" &&
        Number.isFinite(Date.parse(body.after_created_at)) &&
        typeof body.after_id === "string" &&
        UUID_RE.test(body.after_id))
    )) ||
    !Number.isSafeInteger(body.limit) ||
    (body.limit as number) < 1 ||
    (body.limit as number) > 100 ||
    typeof body.include_stale !== "boolean" ||
    (hasChannel &&
      !(body.channel === null ||
        (typeof body.channel === "string" &&
          channelSlugProblem(body.channel) === null)))
  ) {
    return null;
  }
  return {
    resource: "signals",
    workspace_id: body.workspace_id.toLowerCase(),
    inbox: body.inbox as boolean,
    about: body.about as string | null,
    kind: body.kind as string | null,
    since: body.since as string | null,
    ...(modernShape
      ? {
        in_reply_to: typeof body.in_reply_to === "string"
          ? body.in_reply_to.toLowerCase()
          : null,
      }
      : {}),
    ...(hasChannel
      ? {
        channel: typeof body.channel === "string"
          ? normalizeChannelSlug(body.channel)
          : undefined,
      }
      : {}),
    ...(cursorMode
      ? {
        after_created_at: typeof body.after_created_at === "string"
          ? body.after_created_at
          : null,
        after_id: typeof body.after_id === "string"
          ? body.after_id.toLowerCase()
          : null,
      }
      : {}),
    cursor_mode: cursorMode,
    limit: body.limit as number,
    include_stale: body.include_stale as boolean,
  };
}

/** Log allowlisted fields only; return a generic correlatable 500 body. */
function readFailureResponse(
  error: unknown,
  phase: ReadHandlerPhase,
  requestId: string,
): Response {
  const diagnostics = extractSafeDiagnostics(error, phase, requestId);
  console.error(formatReadFailureLog(diagnostics));
  return json(500, { ...publicReadErrorBody(diagnostics) });
}

async function handle(
  request: Request,
  requestId: string,
  setPhase: (phase: ReadHandlerPhase) => void,
): Promise<Response> {
  setPhase("auth");
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const token = bearer(request);
  if (token === null) {
    return json(401, { error: "unauthenticated" });
  }

  setPhase("parse");
  const parsed = await request.json().catch(() => null);
  const body = parseBody(parsed);
  if (body === null) return json(400, { error: "invalid_request" });
  const agentCredential = AGENT_TOKEN_RE.test(token);
  if (!agentCredential && body.resource !== "renewal_grants") {
    return json(401, { error: "unauthenticated" });
  }
  let humanUserId: string | null = null;
  if (!agentCredential) {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user || !UUID_RE.test(data.user.id)) {
      return json(401, { error: "unauthenticated" });
    }
    humanUserId = data.user.id.toLowerCase();
  }
  const tokenHash = agentCredential ? await sha256(token) : null;

  return await db.begin(async (tx) => {
    setPhase("session_setup");
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    // Spec: the read transaction never assumes swarm_command. Start as
    // swarm_read and authenticate/count through the narrow SECURITY DEFINER.
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    await tx.unsafe("SET LOCAL search_path = swarm_read, swarm, pg_catalog");
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");

    if (humanUserId !== null) {
      await tx`
        SELECT set_config(
          'request.jwt.claims',
          ${JSON.stringify({ sub: humanUserId, role: "authenticated" })},
          true
        )
      `;
      const grants = await tx<Record<string, unknown>[]>`
        SELECT *
        FROM swarm_read.renewal_grant_roster(${body.workspace_id}::uuid)
      `;
      return json(200, { grants });
    }

    setPhase("credential_lookup");
    const contextRows = await tx<ReadAgentContext[]>`
      SELECT
        token_id,
        principal_id,
        owner_user_id,
        principal_workspace_id,
        run_id,
        device_id,
        first_use,
        membership_revoked_at,
        is_revoked,
        pending_delivery_count
      FROM swarm.agent_delivery_read_context(
        ${tokenHash!},
        ${body.workspace_id}::uuid
      )
    `;
    const agent = contextRows[0];
    if (agent === undefined) {
      return json(401, { error: "unauthenticated" });
    }
    setPhase("membership");
    if (agent.is_revoked) {
      return json(403, { error: "forbidden" });
    }

    if (body.workspace_id !== agent.principal_workspace_id) {
      if (body.resource === "members") {
        return json(200, { members: [], agents: [] });
      }
      if (body.resource === "files") {
        return json(200, {
          files: [],
          sha256_note: "unverified client attestation",
          content_warning: FILE_CONTENT_WARNING,
        });
      }
      if (body.resource === "delivery_receipts") {
        return json(200, { addressed: null, receipts: [] });
      }
      if (body.resource === "renewal_grants") {
        return json(200, { grants: [] });
      }
      return json(200, {
        signals: [],
        capabilities: SIGNAL_CAPABILITIES,
        pending_delivery_count: 0,
      });
    }

    await tx`
      SELECT swarm.record_renewal_grant_use(
        ${agent.token_id}::uuid,
        ${agent.device_id}::uuid,
        NULL
      )
    `;

    setPhase("query");
    if (body.resource === "delivery_receipts") {
      // No request.jwt.claims are installed yet. That absence selects the
      // function's agent-token branch; a browser JWT instead selects its human
      // branch and cannot smuggle an agent hash through PostgREST.
      const receiptRows = await tx<{ receipt: unknown }[]>`
        SELECT swarm_read.signal_delivery_receipts(
          ${body.workspace_id}::uuid,
          ${body.signal_id}::uuid,
          ${tokenHash!}
        ) AS receipt
      `;
      const receipt = receiptRows[0]?.receipt;
      if (
        receipt === null || receipt === undefined ||
        typeof receipt !== "object" || Array.isArray(receipt)
      ) {
        return json(200, { addressed: null, receipts: [] });
      }
      const result = receipt as Record<string, unknown>;
      if (
        typeof result.addressed !== "boolean" ||
        !Array.isArray(result.receipts)
      ) {
        throw new Error("delivery receipt function returned malformed JSON");
      }
      const broadcastRoster = result.broadcast_roster;
      if (
        result.addressed === false &&
        (!broadcastRoster || typeof broadcastRoster !== "object" ||
          Array.isArray(broadcastRoster))
      ) {
        throw new Error("delivery receipt function returned malformed JSON");
      }
      if (result.addressed === false) {
        const agents = (broadcastRoster as Record<string, unknown>).agents;
        if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
          throw new Error("delivery receipt function returned malformed JSON");
        }
        const agentSection = agents as Record<string, unknown>;
        if (
          !Number.isSafeInteger(agentSection.seen) ||
          Number(agentSection.seen) < 0 ||
          !Array.isArray(agentSection.principals) ||
          agentSection.principals.some((principal) => {
            if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
              return true;
            }
            const row = principal as Record<string, unknown>;
            return typeof row.principal_id !== "string" ||
              row.principal_id !== row.recipient_agent_principal_id ||
              !(row.seen_at === null || typeof row.seen_at === "string");
          })
        ) {
          throw new Error("delivery receipt function returned malformed JSON");
        }
      }
      return json(200, {
        addressed: result.addressed,
        receipts: result.receipts,
        ...(result.addressed === false
          ? { broadcast_roster: broadcastRoster }
          : {}),
      });
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
    // Stay as swarm_read for membership-gated views. The definer already
    // stamped first-use; this path never elevates to swarm_command.
    await tx.unsafe("SET LOCAL search_path = swarm_read, auth, pg_catalog");
    if (body.resource === "renewal_grants") {
      const grants = await tx<Record<string, unknown>[]>`
        SELECT *
        FROM swarm_read.renewal_grant_for_token(
          ${body.workspace_id}::uuid,
          ${agent.token_id}::uuid
        )
      `;
      return json(200, { grants });
    }
    if (body.resource === "members") {
      const members = await tx<Record<string, unknown>[]>`
        SELECT user_id, display_name
        FROM swarm_read.member_profiles
        WHERE workspace_id = ${body.workspace_id}::uuid
        ORDER BY user_id ASC
      `;
      const agents = await tx<Record<string, unknown>[]>`
        SELECT
          p.principal_id,
          p.name,
          p.owner_user_id
        FROM swarm_read.agent_principals AS p
        JOIN swarm_read.member_profiles AS owner
          ON owner.workspace_id = p.workspace_id
         AND owner.user_id = p.owner_user_id
        WHERE p.workspace_id = ${body.workspace_id}::uuid
          AND p.revoked_at IS NULL
        ORDER BY p.principal_id ASC
      `;
      return json(200, {
        members,
        agents,
        /* Derived from agent_delivery_read_context for the bearer used on THIS request.
         * Client artifact fields are deliberately not involved. A successful response also
         * proves the credential passed current token, principal, run, device and membership
         * liveness checks above. */
        identity: {
          credential_valid: true,
          principal_id: agent.principal_id,
          owner_user_id: agent.owner_user_id,
          workspace_id: agent.principal_workspace_id,
        },
      });
    }
    if (body.resource === "files") {
      // File artifacts list (FILE-ARTIFACTS.md §7): the membership-gated view
      // carries one row per file with its current LIVE version's facts. sha256
      // is an unverified client attestation (★R4) and the shape says so.
      const files = await tx<Record<string, unknown>[]>`
        SELECT
          file_id, name, current_version, size_bytes, content_type,
          sha256, created_by_kind, created_by, uploaded_by_kind, uploaded_by,
          created_at, committed_at, tombstoned_at,
          live_version_count, retired_version_count
        FROM swarm_read.files
        WHERE workspace_id = ${body.workspace_id}::uuid
        ORDER BY lower(name) ASC
      `;
      return json(200, {
        files,
        sha256_note: "unverified client attestation",
        // ★R8: the list is agent-facing too.
        content_warning: FILE_CONTENT_WARNING,
      });
    }
    const inReplyTo = body.in_reply_to ?? null;
    /* ⚠ This query names channel_id, thread_root_id and broadcast_to_channel.
     * Deploy this function only after migrations 20260905000001..000003 are
     * VERIFIED applied (swarm.schema_migrations, not the db push output).
     * Against a database missing any of them every agent read fails. */
    /* Resolve the slug to an id ONCE rather than correlating a subquery per
     * row, so the filter can use signals_channel_newest. The lookup runs
     * against swarm_read.channels as the agent's owner, so a slug in another
     * workspace resolves to nothing here for the same reason it resolves to
     * nothing on the write side. An unknown slug is an honest refusal, never a
     * silent fall back to the unfiltered feed: falling back would return
     * strictly MORE than the caller asked for. */
    const channelSlug = body.channel ?? null;
    let channelId: string | null = null;
    if (channelSlug !== null) {
      const channelRows = await tx<{ channel_id: string }[]>`
        SELECT channel_id
        FROM swarm_read.channels
        WHERE workspace_id = ${body.workspace_id}::uuid
          AND lower(slug) = ${channelSlug}
        LIMIT 1
      `;
      if (channelRows[0] === undefined) {
        const liveRows = await tx<{ slug: string }[]>`
          SELECT slug
          FROM swarm_read.channels
          WHERE workspace_id = ${body.workspace_id}::uuid
            AND archived_at IS NULL
          ORDER BY slug
          LIMIT 200
        `;
        return json(404, {
          error: "channel_not_found",
          message: unknownChannelMessage(
            channelSlug,
            liveRows.map((row) => row.slug),
          ),
        });
      }
      channelId = channelRows[0].channel_id;
    }
    // Cursor mode always pages oldest-first. Legacy requests keep the
    // historical newest-first feed (and ASC only for in_reply_to filters).
    const orderAsc = body.cursor_mode || inReplyTo !== null;
    const orderDesc = !orderAsc;
    // Apply the after-tuple filter only when both cursor values are set.
    const afterCreatedAt = body.cursor_mode
      ? (body.after_created_at ?? null)
      : null;
    const afterId = body.cursor_mode ? (body.after_id ?? null) : null;
    const useAfterCursor = afterCreatedAt !== null && afterId !== null;
    // Relation is computed solely from the authenticated receiver's owner and
    // the server-stamped author. Filter author.revoked_at so a revoked agent
    // author cannot resolve into an ownership relation and falls to unknown.
    // An agent row the membership-gated view cannot resolve is also unknown.
    const rows = await tx<Record<string, unknown>[]>`
      SELECT
        s.id, s.workspace_id, s."from", s.from_kind, s."to",
        s.about, s.kind, s.body, s.until, s.created_at,
        s.to_agent, s.in_reply_to, s.attachments,
        s.channel_id, s.thread_root_id, s.broadcast_to_channel,
        CASE
          WHEN s.from_kind = 'user'
           AND author_member.user_id IS NOT NULL
           AND s."from" = ${agent.owner_user_id}::uuid THEN 'same_owner'
          WHEN s.from_kind = 'user'
           AND author_member.user_id IS NOT NULL THEN 'cross_owner'
          WHEN s.from_kind = 'agent'
           AND author.principal_id IS NOT NULL
           AND author_member.user_id IS NOT NULL
           AND author.owner_user_id = ${agent.owner_user_id}::uuid
            THEN 'same_owner'
          WHEN s.from_kind = 'agent'
           AND author.principal_id IS NOT NULL
           AND author_member.user_id IS NOT NULL THEN 'cross_owner'
          ELSE 'unknown'
        END AS sender_owner_relation
      FROM swarm_read.signals AS s
      LEFT JOIN swarm_read.agent_principals AS author
        ON s.from_kind = 'agent'
       AND author.workspace_id = s.workspace_id
       AND author.principal_id = s."from"
       AND author.revoked_at IS NULL
      LEFT JOIN swarm_read.member_profiles AS author_member
        ON author_member.workspace_id = s.workspace_id
       AND author_member.user_id = COALESCE(author.owner_user_id, CASE WHEN s.from_kind = 'user' THEN s."from" END)
      WHERE s.workspace_id = ${body.workspace_id}::uuid
        AND (
          (s."to" IS NULL AND s.to_agent IS NULL)
          OR s.to_agent = ${agent.principal_id}::uuid
        )
        AND (
          ${body.inbox} = false
          OR s.to_agent = ${agent.principal_id}::uuid
        )
        AND (${body.include_stale} = true OR s.until > statement_timestamp())
        AND (${body.about}::text IS NULL OR s.about = ${body.about})
        AND (${body.kind}::text IS NULL OR s.kind = ${body.kind})
        AND (
          ${inReplyTo}::uuid IS NULL
          OR s.in_reply_to = ${inReplyTo}::uuid
        )
        AND (
          ${channelId}::uuid IS NULL
          OR s.channel_id = ${channelId}::uuid
        )
        AND (
          ${body.since}::timestamptz IS NULL OR
          s.created_at >= ${body.since}::timestamptz
        )
        AND (
          -- JSON timestamps only carry millisecond precision, while Postgres
          -- stores microseconds. Truncate both sides so a client cursor built
          -- from a prior page's created_at cannot re-include that last row.
          ${useAfterCursor} = false
          OR date_trunc('milliseconds', s.created_at) >
            date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
          OR (
            date_trunc('milliseconds', s.created_at) =
              date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
            AND s.id > ${afterId}::uuid
          )
        )
      ORDER BY
        CASE WHEN ${orderAsc} THEN s.created_at END ASC,
        CASE WHEN ${orderDesc} THEN s.created_at END DESC,
        CASE WHEN ${orderAsc} THEN s.id END ASC,
        CASE WHEN ${orderDesc} THEN s.id END DESC
      LIMIT ${body.limit}
    `;
    return json(200, {
      signals: rows,
      capabilities: body.inbox
        ? HOME_INBOX_SIGNAL_CAPABILITIES
        : SIGNAL_CAPABILITIES,
      pending_delivery_count: agent.pending_delivery_count,
    });
  });
}

/* The dashboard became this function's first BROWSER caller (renewal_grants,
 * 2026-08-31). Browser calls carry Authorization/apikey/JSON headers, so they
 * are preflighted; without CORS every fetch died as a TypeError and the whole
 * channel view failed for every signed-in member. Same policy as command. */
const allowedReadOrigins = commandAllowedOrigins(
  Deno.env.get("SWARM_COMMAND_ALLOWED_ORIGINS"),
);
const readEnvironment = Deno.env.get("SWARM_ENV");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return commandPreflight(request, allowedReadOrigins, readEnvironment);
  }
  const requestId = newRequestId();
  let phase: ReadHandlerPhase = "top_level";
  const response = await handle(request, requestId, (next) => {
    phase = next;
  }).catch((error) => readFailureResponse(error, phase, requestId));
  return withCommandCors(request, response, allowedReadOrigins, readEnvironment);
});
