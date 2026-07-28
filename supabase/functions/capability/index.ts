/**
 * The anonymous capability-URL read (§7 "Zero-install first touch"), kept in its
 * own edge function because §7's allowlist rule requires everything off the list
 * to be *unreachable*, not merely un-selected.
 *
 * `functions/read/index.ts` authenticates a swm_agt_ credential and then
 * deliberately widens itself — it sets request.jwt.claims, switches to the
 * broader member-read role, and queries the exposed read views for the message
 * stream and the roster-with-attribution that §7 forbids a capability URL from
 * ever serving. An anonymous branch inside that file would be one mis-ordered
 * early-return away from serving them. This function instead runs as
 * SET LOCAL ROLE swarm_capability, which holds EXECUTE on one projection
 * function and SELECT on no table at all: the field allowlist is enforced by
 * PostgreSQL, not by this file's discipline.
 *
 * Do not add a capability branch to `functions/read/index.ts`, and do not grant
 * swarm_capability (or anon) anything in the member-read schema.
 *
 * The forbidden-identifier grep §7 asks for is part of this file's contract: a
 * search here for the roster, message-stream, membership, delivery-queue or
 * member-read-view identifiers, or for any streaming/subscription API, must
 * return zero. It answers one request with one JSON object and closes.
 */
import postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

/** Configuration that is wrong at boot, not at request time; fail loudly. */
class CapabilityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityConfigError";
  }
}

/** An atomic rate-bucket upsert that returned no row has failed open; refuse to continue. */
class CapabilityRateBucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRateBucketError";
  }
}

const CAPABILITY_TOKEN_RE = /^swm_cap_[A-Za-z0-9_-]{43}$/;

// 1 KiB. The request carries no parameters at all (see UNIFORM FAILURE below),
// so anything larger than a couple of braces is already a malformed request.
const MAX_BODY_BYTES = 1024;

const READ_LIMIT = 120;
const GLOBAL_READ_LIMIT = 20000;

/* ★ THE ALERT-ONLY GLOBAL COUNTER IS SHARDED, AND THE SHARDING IS THE POINT.
 *
 * It used to be one bucket_key. Its INSERT ... ON CONFLICT DO UPDATE takes a
 * row-exclusive lock on that single row and holds it until the transaction
 * commits — and this transaction also runs the projection query and an audit
 * INSERT. So EVERY concurrent request on the only anonymous, internet-reachable
 * surface in the product queued behind one row, for the whole request, and the
 * queue was longest during exactly the surge this counter exists to observe.
 * A counter that never refuses had become a hard throughput ceiling, and worse,
 * a lock-contention amplifier available to any stranger: 5s lock_timeout, then
 * failures on a path whose stated design is "this one never refuses".
 *
 * Writes now land on one of GLOBAL_SHARDS rows chosen at random, so contention
 * falls by that factor. Math.random is right here: nothing is being kept secret,
 * the only requirement is even spread, and a hash-derived shard would pin one
 * caller to one row and re-create a hot spot per attacker.
 *
 * The SIGNAL IS NOT WEAKENED. The window's true total is the sum of the shards,
 * which is read — not locked — and only once a shard is past its own share, so
 * the ordinary path never pays for it. The alert still fires on the true global
 * count crossing GLOBAL_READ_LIMIT, and still exactly once per window.
 */
const GLOBAL_SHARDS = 16;
const GLOBAL_BUCKET_KEYS = Array.from(
  { length: GLOBAL_SHARDS },
  (_unused, index) => `capability:read:global:${index}`,
);
const GLOBAL_SHARD_SHARE = Math.ceil(GLOBAL_READ_LIMIT / GLOBAL_SHARDS);
const GLOBAL_ALERT_LATCH_KEY = "capability:read:global:alerted";

// Hashed in place of an absent bearer so the SHA-256 is performed on every path
// and a missing credential cannot short-circuit ahead of the database call.
const ABSENT_TOKEN_PLACEHOLDER = "swm_cap_absent";

// §2.2's five task lifecycles. The projection's value is looked up here rather
// than echoed, so a future enum member cannot leak through this surface.
const LIFECYCLES = new Set([
  "open",
  "active",
  "awaiting_review",
  "reopened",
  "done",
]);

// The projection's status vocabulary, in the normative precedence order the
// contract pins: revoked > expired > workspace_archived > issuer_revoked >
// work_item_missing > ok. Looked up rather than interpolated so an unexpected
// value cannot be written into an audit reason.
const DEAD_STATUS_REASONS = new Map<string, { reason: string; outcome: string }>([
  ["revoked", { reason: "capability_revoked", outcome: "revocation" }],
  ["expired", { reason: "capability_expired", outcome: "authz" }],
  ["workspace_archived", {
    reason: "capability_workspace_archived",
    outcome: "authz",
  }],
  ["issuer_revoked", {
    reason: "capability_issuer_revoked",
    outcome: "revocation",
  }],
  ["work_item_missing", {
    reason: "capability_work_item_missing",
    outcome: "authz",
  }],
]);

// AGENTS.md: the per-deployment Vercel URL is SSO-protected; the project alias is
// the public one. Never "*".
const DEFAULT_ALLOWED_ORIGIN = "https://coswarm-site.vercel.app";

// Character-for-character the command function's SIGNAL_UNSAFE_GLOBAL_RE. The
// narrower set this replaced (C0/C1, \u202a-\u202e and \u2066-\u2069) let through the
// zero-width space and joiners (\u200b-\u200f), ALM (\u061c), the line and paragraph
// separators (\u2028-\u2029), the word joiner (\u2060), the BOM (\ufeff) and the whole
// tags block (\u{e0000}-\u{e007f}) — the last of which is the standard way to
// smuggle invisible text past a human reviewer. Every string this function
// serves is untrusted swarm-originated data headed for a browser (§4), so it
// gets the treatment signal text already gets rather than a weaker second copy.
// These two definitions must change together; keep them identical.
const UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) {
  throw new CapabilityConfigError(
    "capability function requires SWARM_DATABASE_URL/SUPABASE_DB_URL",
  );
}

// §9 puts the *public* exposure of this mechanism at P5 while the mechanism
// itself is P2, so it ships dark. The gate answers ahead of every token check so
// that while it is off the response cannot be used to probe anything at all.
const capabilityUrlsEnabled = Deno.env.get("SWARM_CAPABILITY_URLS") === "1";
const testEnv = Deno.env.get("SWARM_ENV") === "test";

const configuredOrigins = (Deno.env.get("SWARM_CAPABILITY_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const ALLOWED_ORIGINS = new Set(
  configuredOrigins.length > 0 ? configuredOrigins : [DEFAULT_ALLOWED_ORIGIN],
);

const db = postgres(databaseUrl, {
  max: 4,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});

interface ProjectionRow {
  capability_id: string;
  workspace_id: string;
  status: string;
  work_item_slug: string | null;
  work_item_lifecycle: string | null;
  repo_full_name: string | null;
  inviter_display_name: string | null;
  workspace_age_days: number | string | null;
  expires_at: Date | string | null;
}

interface AuditRow {
  outcome: string;
  reason: string | null;
  capabilityId: string | null;
  workspaceId: string | null;
}

function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Same env-gated, test-only relaxation the command function uses for its test
  // hooks. Never reachable in a deployed environment.
  if (!testEnv) return false;
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * One header set for every response — success, uniform failure, 405 and 429 —
 * because a differing header set is itself a distinguisher (§4 uniform response).
 *
 * Referrer-Policy and X-Robots-Tag have almost no browser effect on a JSON API
 * response; they matter on the HTML page that holds the token in its fragment.
 * §7 mandates them here, so they ship here, and whoever builds that page must set
 * them there too.
 */
function securityHeaders(request: Request): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-content-type-options": "nosniff",
    "vary": "origin",
  });
  const origin = request.headers.get("origin");
  if (origin !== null && originAllowed(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function json(
  request: Request,
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders(request),
  });
}

/**
 * The single response for invalid, malformed, expired, revoked, never-existed,
 * workspace-archived, issuer-revoked, work-item-missing and feature-disabled
 * (§4 no-enumeration). Only the audit row distinguishes them.
 */
function uniformFailure(request: Request): Response {
  return json(request, 404, { error: "not_found" });
}

function preflight(request: Request): Response {
  const headers = securityHeaders(request);
  headers.delete("content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, apikey");
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers });
}

// RFC 7235 §2.1: the auth-scheme is case-INSENSITIVE and is followed by 1*SP.
// A conforming client sending `bearer swm_cap_...` was read as presenting no
// credential at all, so a valid link failed with the uniform 404 and an audit
// row reading capability_token_absent — a real link, indistinguishable from a
// forged one, and undiagnosable from the log.
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

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripControls(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(UNSAFE_GLOBAL_RE, "").slice(0, 2048);
}

/**
 * Copied rather than imported from the command function: §4 makes every
 * swarm-originated string untrusted data destined for a browser, and this
 * function must not take a dependency across a function boundary to stay safe.
 */
function displayLabel(value: string | null | undefined, fallback: string): string {
  const cleaned = stripControls(value?.replace(ANSI_ESCAPE_GLOBAL_RE, ""))
    ?.trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${stripControls(error.message) ?? ""}`.slice(0, 512);
  }
  return "unknown error";
}

/**
 * At most MAX_BODY_BYTES, and the only accepted bodies are absent, empty, or an
 * object with no keys. There is no workspace_id, task_id, or id of any kind to
 * substitute, so §10's IDOR surface is absent by construction rather than
 * defended.
 */
async function bodyIsEmpty(request: Request): Promise<boolean> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return false;
  const reader = request.body?.getReader();
  if (!reader) return true;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return false;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return false;
  }
  if (text === "") return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length === 0;
  } catch {
    return false;
  }
}

async function setTransaction(tx: Sql): Promise<void> {
  await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await tx.unsafe("SET LOCAL ROLE swarm_capability");
  await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
  await tx.unsafe("SET LOCAL lock_timeout = '5s'");
}

/**
 * enforceSignalRate's fixed-window upsert, with one deliberate difference: the
 * clamp is limit + 2, not limit + 1, so `count === limit + 1` identifies exactly
 * the first refusal in the window. Auditing every refusal would turn the audit
 * log into a DoS amplifier.
 */
async function incrementBucket(
  tx: Sql,
  bucketKey: string,
  limit: number,
): Promise<{ count: number; resetsAt: string }> {
  const rows = await tx<{ count: number; resets_at: Date }[]>`
    INSERT INTO swarm.rate_buckets (bucket_key, window_start, count)
    VALUES (
      ${bucketKey},
      date_trunc('hour', statement_timestamp()),
      1
    )
    ON CONFLICT (bucket_key, window_start) DO UPDATE
    SET count = LEAST(swarm.rate_buckets.count + 1, ${limit + 2})
    RETURNING count, window_start + interval '1 hour' AS resets_at
  `;
  const row = rows[0];
  if (!row) {
    throw new CapabilityRateBucketError(
      "capability rate bucket did not return a row",
    );
  }
  return { count: Number(row.count), resetsAt: row.resets_at.toISOString() };
}

/**
 * Exactly one audit row per request. request_hash stays NULL: the only hash this
 * function holds is the digest of a live credential, and §7 rule 5 redacts the
 * credential from audit rows. capability_id is the safe correlation handle.
 */
async function insertAudit(tx: Sql, audit: AuditRow): Promise<void> {
  await tx`
    INSERT INTO swarm.audit_log (
      actor_user, actor_agent_principal, actor_run,
      credential_kind, credential_id, device_id,
      command_kind, workspace_id, stream_id,
      outcome, reason, detail, request_hash, ip
    ) VALUES (
      NULL::uuid, NULL::uuid, NULL::uuid,
      'capability',
      ${audit.capabilityId}::uuid,
      NULL::uuid,
      'read_capability_url',
      ${audit.workspaceId}::uuid,
      NULL::uuid,
      ${audit.outcome},
      ${stripControls(audit.reason)},
      NULL,
      NULL,
      NULL
    )
  `;
}

async function insertAlert(
  tx: Sql,
  kind: string,
  subject: string,
  detail: { limit: number; resets_at: string },
): Promise<void> {
  await tx`
    INSERT INTO swarm.security_alerts (kind, subject, detail)
    VALUES (${kind}, ${subject}, ${tx.json(detail)}::jsonb)
  `;
}

/**
 * Fires the global-surge alert once per window on the shards' TRUE total, which
 * is why sharding the counter costs no signal. Reached only from a shard that is
 * already past its share, so the aggregate below is off the ordinary path.
 */
async function alertGlobalSurge(tx: Sql, resetsAt: string): Promise<void> {
  const totals = await tx<{ total: string }[]>`
    SELECT coalesce(sum(count), 0)::text AS total
    FROM swarm.rate_buckets
    WHERE bucket_key = ANY(${GLOBAL_BUCKET_KEYS}::text[])
      AND window_start = date_trunc('hour', statement_timestamp())
  `;
  if (Number(totals[0]?.total ?? "0") <= GLOBAL_READ_LIMIT) return;
  // DO NOTHING, never DO UPDATE: the latch must not reintroduce the hot row the
  // shards exist to remove. A returned row means this transaction inserted it,
  // so it is the first to cross in this window and owns the single alert. The
  // row lives in rate_buckets so the two-hour purge resets the latch with the
  // window, exactly like every other key here.
  const latched = await tx<{ bucket_key: string }[]>`
    INSERT INTO swarm.rate_buckets (bucket_key, window_start, count)
    VALUES (
      ${GLOBAL_ALERT_LATCH_KEY},
      date_trunc('hour', statement_timestamp()),
      1
    )
    ON CONFLICT (bucket_key, window_start) DO NOTHING
    RETURNING bucket_key
  `;
  if (latched.length === 0) return;
  await insertAlert(tx, "capability_read_global_surge", "global", {
    limit: GLOBAL_READ_LIMIT,
    resets_at: resetsAt,
  });
}

/**
 * Builds the response object field by field from the §7 allowlist. It never
 * spreads a database row: the next column added to swarm.tasks must not appear
 * here by default, and the projection's capability_id/workspace_id exist for the
 * audit row only.
 */
function projectionBody(row: ProjectionRow, expiresAt: Date): Record<string, unknown> {
  const lifecycle = row.work_item_lifecycle !== null &&
      LIFECYCLES.has(row.work_item_lifecycle)
    ? row.work_item_lifecycle
    : "unknown";
  const ageDays = Math.max(0, Math.trunc(Number(row.workspace_age_days ?? 0)));
  return {
    work_item: {
      slug: displayLabel(row.work_item_slug, "work-item"),
      lifecycle,
    },
    repo: row.repo_full_name === null
      ? null
      : { full_name: displayLabel(row.repo_full_name, "unknown") },
    inviter: {
      display_name: displayLabel(row.inviter_display_name, "the inviter"),
    },
    workspace: { age_days: Number.isFinite(ageDays) ? ageDays : 0 },
    expires_at: expiresAt.toISOString(),
  };
}

async function handle(request: Request): Promise<Response> {
  // Preflight answers before anything else and touches no state: it must be fast
  // and it reveals nothing, since it depends only on the verb and the Origin.
  if (request.method === "OPTIONS") return preflight(request);

  // ★ THE GATE COMES FIRST, BEFORE ANY DATABASE WORK, AND THAT ORDERING IS THE FIX.
  // It used to sit ~70 lines below, AFTER two rate-bucket upserts and after a method
  // check that wrote an audit row. This function is registered with verify_jwt=false,
  // so it is reachable from the open internet the moment it deploys — which meant that
  // while the feature was DARK, an unauthenticated request still cost one rate_buckets
  // row and one permanent swarm.audit_log row. A disabled feature must cost nothing.
  if (!capabilityUrlsEnabled) return uniformFailure(request);

  const presented = bearer(request);
  const tokenWellFormed = presented !== null &&
    CAPABILITY_TOKEN_RE.test(presented);
  // ALWAYS digest, including when the bearer is absent or malformed. Skipping the
  // hash would make "no credential" measurably cheaper than "wrong credential".
  const tokenHash = await sha256(presented ?? ABSENT_TOKEN_PLACEHOLDER);
  // A hash of a credential, never the credential, and never a prefix of one. For
  // a live link this equals hex(capability_urls.token_hash) — the same at-rest
  // posture the table itself keeps.
  const bucketKey = `capability:read:${bytesToHex(tokenHash)}`;

  // ★ THE BINDING LIMITER IS KEYED ON THE CALLER, NOT ON WHAT THE CALLER SENT.
  // The token-hash bucket below is still useful — it caps abuse of one REAL link —
  // but it cannot bind an attacker, because the attacker chooses the token. Rotating
  // the bearer produced a fresh bucket at count=1 on every single request, so 429 was
  // unreachable and the "limit" was decorative. The client address is the cheapest
  // thing on this request an attacker cannot vary for free.
  // `?? ""` on the index is required, not defensive: edge functions compile with
  // noUncheckedIndexedAccess, so split()[0] is `string | undefined` here even though
  // split always yields at least one element. tsc does not cover this tree.
  const clientIp = ((request.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "")
    .trim().slice(0, 45) || "unknown";
  const originBucketKey = `capability:read:origin:${clientIp}`;

  const methodOk = request.method === "POST";
  const bodyEmpty = methodOk ? await bodyIsEmpty(request) : true;

  return await db.begin(async (tx) => {
    await setTransaction(tx);

    // Caller-keyed first: this is the arm that actually refuses.
    const origin = await incrementBucket(tx, originBucketKey, READ_LIMIT);
    if (origin.count > READ_LIMIT) {
      // Audit ONLY on the crossing, never per request — otherwise the refusal path
      // is itself the unbounded-growth vector it exists to stop.
      if (origin.count === READ_LIMIT + 1) {
        await insertAlert(tx, "capability_read_origin_rate_limit", "capability", {
          limit: READ_LIMIT,
          resets_at: origin.resetsAt,
        });
      }
      return json(request, 429, { error: "rate_limited" });
    }

    // The bucket is keyed on the hash of whatever was PRESENTED, so an invalid
    // token and a valid one accumulate identically: the 429 discriminates request
    // volume, never token validity.
    const read = await incrementBucket(tx, bucketKey, READ_LIMIT);
    if (read.count > READ_LIMIT) {
      if (read.count === READ_LIMIT + 1) {
        await insertAlert(tx, "capability_read_rate_limit", "capability", {
          limit: READ_LIMIT,
          resets_at: read.resetsAt,
        });
        await insertAudit(tx, {
          outcome: "rate_limit",
          reason: "capability_read_rate_limited",
          capabilityId: null,
          workspaceId: null,
        });
      }
      return json(request, 429, { error: "rate_limited" });
    }

    // §5: unauthenticated limits alert rather than hard-lock. A global hard cap
    // would let one attacker close the front door on every tenant, so this one
    // never refuses. The shard limit passed here is the GLOBAL limit, not the
    // per-shard share: incrementBucket clamps at limit + 2, and a shard that
    // clamped at its share would make the sum below understate the truth.
    const shardKey =
      `capability:read:global:${Math.floor(Math.random() * GLOBAL_SHARDS)}`;
    const shard = await incrementBucket(tx, shardKey, GLOBAL_READ_LIMIT);
    if (shard.count >= GLOBAL_SHARD_SHARE) {
      await alertGlobalSurge(tx, shard.resetsAt);
    }

    /* ★ REFUSALS AUDIT ONCE PER CALLER PER WINDOW, NOT ONCE PER REQUEST.
     *
     * swarm.audit_log is append-only — a trigger blocks DELETE — and unlike
     * idempotency_keys and rate_buckets it has NO purge schedule. So on the only
     * anonymous, internet-reachable surface in the product, a row per rejected request
     * was permanent, unbounded growth that any stranger could drive: roughly 1-2 GB a
     * day at 1k rps, filling the volume, taking the command function down with it, and
     * burying every real security signal underneath.
     *
     * The refusal is still recorded — the FIRST one from a caller in each window, which
     * is what an investigator actually needs — and the flood after it is already
     * counted, because rate_buckets holds the exact request count for that key.
     *
     * The RESPONSE is unchanged and unconditional, so the uniform-failure rule is
     * untouched: invalid, expired, revoked and never-existed remain indistinguishable.
     * Only the server-side write is throttled, and a caller cannot observe it. */
    const deny = async (
      outcome: string,
      reason: string,
      response: Response,
    ): Promise<Response> => {
      if (origin.count === 1) {
        await insertAudit(tx, {
          outcome,
          reason,
          capabilityId: null,
          workspaceId: null,
        });
      }
      return response;
    };

    // Safe to distinguish: it depends on the verb, never on token state.
    if (!methodOk) {
      return await deny(
        "validation",
        "capability_method_not_allowed",
        json(request, 405, { error: "method_not_allowed" }),
      );
    }

    // The feature gate that used to live here has MOVED TO THE TOP OF handle(), above
    // every database write. Reaching this point already implies it is enabled, so a
    // second check here would be dead code that reads as defence.

    // The uniform failure, not a 400: a 400 here would give a prober a signal
    // that reacts to request shape while a valid token reacts differently.
    if (!bodyEmpty) {
      return await deny(
        "validation",
        "capability_request_not_empty",
        uniformFailure(request),
      );
    }

    // Exactly one query, on every path, malformed token included. The RETURNS
    // TABLE signature of this function IS the field allowlist, and
    // swarm_capability holds SELECT on no table, so there is no SQL here that
    // could reach the roster, the message stream, or the event ledger.
    const rows = await tx<ProjectionRow[]>`
      SELECT
        capability_id,
        workspace_id,
        status,
        work_item_slug,
        work_item_lifecycle,
        repo_full_name,
        inviter_display_name,
        workspace_age_days,
        expires_at
      FROM swarm.capability_projection(${tokenHash})
    `;

    const row = rows[0];
    if (row === undefined) {
      // Zero rows: the token never existed. Distinct audit reasons for absent,
      // malformed and unknown; one identical response for all three.
      const reason = presented === null
        ? "capability_token_absent"
        : tokenWellFormed
        ? "capability_token_unknown"
        : "capability_token_malformed";
      return await deny("authz", reason, uniformFailure(request));
    }

    if (row.status !== "ok") {
      const dead = DEAD_STATUS_REASONS.get(row.status);
      await insertAudit(tx, {
        outcome: dead?.outcome ?? "validation",
        reason: dead?.reason ?? "capability_status_unrecognized",
        capabilityId: row.capability_id,
        workspaceId: row.workspace_id,
      });
      return uniformFailure(request);
    }

    // Coerced rather than asserted: the driver's timestamptz mapping is not this
    // function's invariant to assume, and a throw here would turn a projection
    // change into a 500 that distinguishes a live token from a dead one.
    const expiresAt = row.expires_at === null
      ? null
      : row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at);
    if (
      expiresAt === null || Number.isNaN(expiresAt.getTime()) ||
      row.work_item_slug === null
    ) {
      // 'ok' with a missing allowlisted field means the projection and this
      // function disagree; serve nothing rather than a half-built object.
      await insertAudit(tx, {
        outcome: "validation",
        reason: "capability_projection_incomplete",
        capabilityId: row.capability_id,
        workspaceId: row.workspace_id,
      });
      return uniformFailure(request);
    }

    await insertAudit(tx, {
      outcome: "accepted",
      reason: null,
      capabilityId: row.capability_id,
      workspaceId: row.workspace_id,
    });
    return json(request, 200, projectionBody(row, expiresAt));
  });
}

Deno.serve((request) =>
  handle(request).catch((error) => {
    console.error(JSON.stringify({
      event: "capability_request_failure",
      error: safeError(error),
    }));
    // While the feature is dark the response must be constant even if the
    // capability role and projection function are not deployed yet, so a failure
    // on that path collapses into the same uniform 404 rather than a 500.
    return capabilityUrlsEnabled
      ? json(request, 500, { error: "internal_error" })
      : uniformFailure(request);
  })
);
