import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";
import {
  agentCredentialRevoked,
  loadAgentCredential,
  type AgentAuthRow,
} from "../_shared/agent-auth.ts";
import {
  commandAllowedOrigins,
  commandPreflight,
  withCommandCors,
} from "./cors.ts";
import {
  hasFreshInteractiveAuth,
  newestInteractiveAmrSeconds,
} from "./fresh-auth.ts";
// Supabase's edge graph cannot resolve the NodeNext `.js` specifiers in the
// frozen TypeScript core. This checked-in bundle is regenerated directly from
// src/protocol/index.ts by build:command-core; it is not a second implementation.
import {
  applyCommand,
  canonicalPrincipal,
  decideWorkspace,
  DISPOSITIONS,
  reduceTask,
  reduceWorkspace,
  RENEWAL_HORIZON_DEFAULT_MS,
  RENEWAL_MAX_SUCCESSORS_DEFAULT,
  requestHash,
} from "../_shared/protocol.js";

interface Actor {
  user: string | null;
  agent_principal: string | null;
  run: string | null;
}

type Command =
  | { kind: "create"; task_id: string; slug: string }
  | { kind: "acquire"; task_id: string; ttl_ms: number }
  | { kind: "renew"; task_id: string; epoch: number; ttl_ms: number }
  | {
    kind: "handoff";
    task_id: string;
    epoch: number;
    to_owner: string;
    ttl_ms: number;
  }
  | {
    kind: "takeover";
    task_id: string;
    grant_id: string | null;
    ttl_ms: number;
  }
  | {
    kind: "submit";
    task_id: string;
    epoch: number;
    branch: string;
    head_sha: string;
    evidence_set: string[];
  }
  | {
    kind: "close";
    task_id: string;
    epoch: number;
    disposition: "merged" | "pr" | "archive" | "discard";
    grant_id: string | null;
  }
  | { kind: "reopen"; task_id: string; epoch: number };

type ConnectCommand =
  | { kind: "invite_member"; email: string; ttl_ms?: number }
  | { kind: "revoke_invitation"; invitation_id: string }
  | { kind: "accept_invitation"; token: string }
  | { kind: "remove_member"; user_id: string }
  | { kind: "create_agent_principal"; name: string; model?: string }
  | { kind: "revoke_agent_principal"; principal_id: string }
  | {
    kind: "mint_agent_token";
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    ttl_ms?: number;
    device_id: string;
    scopes?: string[];
  }
  | { kind: "revoke_agent_token"; token_id: string }
  // §2.3 successor endpoint. It has no fields on purpose: the presented
  // predecessor credential IS the request, and accepting any target field here
  // is exactly the escalation the fence exists to stop.
  | { kind: "renew_agent_token" };

type SignalKind = "working-on" | "note" | "ask";

interface SignalCommand {
  kind: "post_signal";
  signal_kind: SignalKind;
  body: string;
  to_user_id: string | null;
  to_agent_principal_id?: string | null;
  in_reply_to?: string | null;
  about: string | null;
  until_ms?: number;
}

interface SignalRecord {
  id: string;
  workspace_id: string;
  from: string;
  from_kind: CredentialKind;
  to: string | null;
  to_agent: string | null;
  in_reply_to: string | null;
  about: string | null;
  kind: SignalKind;
  body: string;
  until: string;
  created_at: string;
}

type ValidatedCommand = Command | ConnectCommand | SignalCommand;

type WorkspaceRole = "owner" | "admin" | "member";

interface WorkspaceState {
  workspace: {
    workspace_id: string;
    name: string;
    created_by: string;
    created_at: number;
    archived_at: number | null;
  };
  members: Record<string, {
    user_id: string;
    role: WorkspaceRole;
    invited_by: string | null;
    joined_at: number;
    revoked_at: number | null;
  }>;
  invitations: Record<string, {
    invitation_id: string;
    email: string | null;
    role: WorkspaceRole;
    token_hash: string;
    expires_at: number;
    created_by: string;
    created_at: number;
    consumed_at: number | null;
    consumed_by: string | null;
    revoked_at: number | null;
  }>;
  principals: Record<string, {
    principal_id: string;
    owner_user_id: string;
    name: string;
    model: string | null;
    created_at: number;
    revoked_at: number | null;
  }>;
  tokens: Record<string, {
    token_id: string;
    principal_id: string;
    run_id: string;
    task_id: string | null;
    epoch: number | null;
    scopes: string[];
    issued_at: number;
    expires_at: number;
    revoked_at: number | null;
  }>;
  owners_count: number;
}

type WorkspaceCommand =
  | {
    kind: "invite_member";
    invitation_id: string;
    email: string | null;
    role: WorkspaceRole;
    token_hash: string;
    expires_at: number;
  }
  | { kind: "revoke_invitation"; invitation_id: string }
  | { kind: "accept_invitation"; token_hash: string }
  | { kind: "remove_member"; user_id: string }
  | {
    kind: "create_agent_principal";
    principal_id: string;
    name: string;
    model: string | null;
  }
  | { kind: "revoke_agent_principal"; principal_id: string }
  | {
    kind: "mint_agent_token";
    token_id: string;
    principal_id: string;
    run_id: string;
    task_id: string;
    epoch: number;
    scopes: string[];
    ttl_ms?: number;
  }
  | { kind: "revoke_agent_token"; token_id: string }
  | {
    kind: "renew_agent_token";
    successor_token_id: string;
    scopes: string[];
  };

interface RenewalGrantFacts {
  renewal_grant_id: string;
  max_successors: number;
  successors_used: number;
  /** Issued but never delivered; subtracted from `successors_used` for the ceiling. */
  successors_stranded: number;
  horizon_expires_at: number;
  revoked_at: number | null;
}

interface RenewalFacts {
  grant: RenewalGrantFacts | null;
  grant_mismatch: boolean;
  /** An UNREVOKED successor exists; a revoked one frees the slot on purpose. */
  superseded: boolean;
  /** That successor has never authenticated, so nobody holds it. */
  successor_pending: boolean;
  successor_token_id: string | null;
  /** The presenting predecessor's own first-use state, read before this request. */
  predecessor_pending: boolean;
  lineage_revoked: boolean;
}

interface WorkspaceDecideCtx {
  now: number;
  actor: Actor;
  credential_kind: "human" | "agent";
  presenting_token_id: string | null;
  command_id: string;
  workspace_id: string;
  stream_id: string;
  operatorAllowed(actor: Actor): boolean;
  role(user_id: string): WorkspaceRole | null;
  inviteeAlreadyMember(email: string | null): boolean;
  identityVerified(user_id: string): boolean;
  humanRights(actor: Actor): readonly string[];
  landingAuthorityChangeResolved(
    target_user_id: string,
    successor_user_id: string | null,
  ): boolean;
  renewalFacts?(predecessor_token_id: string): RenewalFacts;
  nextSeq(): number;
  nextEventId(): string;
}

interface StoredResponse {
  ok: boolean;
  reason?: string;
  detail?: string;
  class?: "authz" | "domain";
  event_ids: string[];
  invitation_id?: string;
  principal_id?: string;
  token_id?: string;
  run_id?: string;
  workspace_id?: string;
  /**
   * Capability-URL replay fields. The raw swm_cap_ token is deliberately absent:
   * the ledger is readable by swarm_command, so storing it there would persist a
   * live credential in plaintext. A replay identifies the link and its expiry;
   * only the fresh response ever carries the secret.
   */
  capability_id?: string;
  expires_at?: string;
  revoked_at?: string;
  signal?: SignalRecord;
}

interface EventEnvelope {
  workspace_id: string;
  stream_id: string;
  seq: number;
  event_id: string;
  command_id: string;
  type: string;
  schema_version: number;
  actor_user: string | null;
  actor_agent_principal: string | null;
  actor_run: string | null;
  occurred_at_server: number;
  payload: unknown;
}

interface TaskState {
  task_id: string;
  slug: string;
  lifecycle: "open" | "active" | "awaiting_review" | "reopened" | "done";
  version: number;
  epoch: number;
  owner: string | null;
  lease_expiry: number | null;
  submission: {
    epoch: number;
    branch: string;
    head_sha: string;
    evidence_set: string[];
  } | null;
  closed_disposition: string | null;
}

interface DecideCtx {
  now: number;
  actor: Actor;
  command_id: string;
  isMember(principal: string): boolean;
  role(principal: string): "owner" | "admin" | "member" | null;
  isEligibleRecipient(principal: string): boolean;
  claimRequiresGrant(task_id: string): boolean;
  evidenceComplete(task_id: string, evidence_set: readonly string[]): boolean;
  validTakeoverGrant(
    task_id: string,
    grant_id: string | null,
    epoch: number,
    recipient: string,
  ): boolean;
  validCloseGrant(
    task_id: string,
    grant_id: string | null,
    submission: { version: number; epoch: number; head_sha: string },
  ): boolean;
  slugTaken(slug: string): boolean;
  nextSeq(): number;
  nextEventId(): string;
  workspace_id: string;
  stream_id: string;
}

type Decision =
  | { ok: true; events: EventEnvelope[] }
  | {
    ok: false;
    class: "authz" | "domain";
    reason: string;
    detail: string;
    events: EventEnvelope[];
  };

interface FreshOutcome {
  status: "fresh";
  decision: Decision;
  response: StoredResponse;
  events: EventEnvelope[];
}

const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_TTL_MS = 4 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_MAX_TTL_MS = 8 * 60 * 60 * 1000;
const SIGNAL_MAX_UNTIL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_DEFAULT_UNTIL_MS: Record<SignalKind, number> = {
  "working-on": 24 * 60 * 60 * 1000,
  ask: 7 * 24 * 60 * 60 * 1000,
  note: 30 * 24 * 60 * 60 * 1000,
};
const SIGNAL_CREDENTIAL_LIMIT = 120;
const SIGNAL_WORKSPACE_LIMIT = 1000;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,72}$/;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const INVITATION_TOKEN_RE = /^swm_inv_[A-Za-z0-9_-]{43}$/;
/**
 * The shape the anonymous capability endpoint will require of a presented
 * credential. Asserted against every token this file mints, so a change to
 * opaqueToken cannot silently issue links the read path would reject.
 */
const CAPABILITY_TOKEN_RE = /^swm_cap_[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const CONTROL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const SIGNAL_UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
const SIGNAL_WHITESPACE_GLOBAL_RE = /[\t\n\v\f\r\u0085\u2028\u2029]+/gu;
const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const REGISTER_DEVICE_KIND = "register_device";
const CREATE_WORKSPACE_KIND = "create_workspace";
const RENEW_AGENT_TOKEN_KIND = "renew_agent_token";
const MINT_CAPABILITY_KIND = "mint_capability_url";
const REVOKE_CAPABILITY_KIND = "revoke_capability_url";

/**
 * Tombstone kind for the ONE revocation this service performs on its own
 * initiative: discarding a successor that was issued but never reached anybody
 * (§2.3 first-use supersession). It records WHY that token died, which is the
 * difference between "the service tidied up after a dropped connection" and
 * "an operator revoked this worker" — and those two must not be read the same
 * way, because the second stops the whole lineage renewing and the first must
 * not. Deliberately NOT one of the kinds agent-auth or the successor fence
 * probe ('token', 'lineage', 'family', 'principal', 'run', 'device',
 * 'membership', 'renewal_grant'): this marks a cause, it is not a revocation of
 * anything still reachable.
 */
const STRANDED_SUCCESSOR_TOMBSTONE = "stranded_successor";

/**
 * §7's zero-install on-ramp is a P5 public surface while the mechanism itself
 * is P2, so it ships dark. Evaluated before every other check in both capability
 * handlers: while the feature is off the response cannot be used to probe
 * whether an identity is verified or a workspace exists.
 */
const capabilityUrlsEnabled = Deno.env.get("SWARM_CAPABILITY_URLS") === "1";

/**
 * §7: a capability URL is a bearer credential, so its TTL ceiling is 7 days.
 * The database repeats the ceiling as a CHECK — this constant refuses early and
 * with a distinct audit reason; the constraint is what makes an 8-day link
 * impossible even if this branch is wrong.
 */
const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const CAPABILITY_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CAPABILITY_MIN_TTL_MS = 60 * 1000;

/**
 * §5's no-teammate-DoS rule: (a) is per-issuing-identity and re-mintable after
 * the window, (b) is a resource-creation ceiling on the tenant doing the
 * issuing, and (c) bounds how many live disclosure credentials a tenant can
 * have outstanding at once. None of the three can be spent by a victim.
 */
const CAPABILITY_MINT_CREDENTIAL_LIMIT = 20;
const CAPABILITY_MINT_WORKSPACE_LIMIT = 60;
const CAPABILITY_LIVE_LIMIT = 200;

/**
 * Self-serve workspace creation is the public front door (§9 P5). It ships
 * dark: until the free-tier abuse controls land, an operator must opt in.
 * Absent or any value other than "1", a stranger gets the same 403 as before.
 */
const selfServeEnabled = Deno.env.get("SWARM_SELF_SERVE") === "1";

/**
 * §9 P5 caps free-tier workspaces per *verified* identity so one attacker
 * cannot mint tenants at zero marginal cost. Counts only live workspaces, so
 * archiving frees a slot.
 */
const FREE_TIER_WORKSPACE_LIMIT = 3;

/**
 * §9 P5 again: the same identity archiving and recreating in a loop would slip
 * the live cap above, so creations themselves are capped over a rolling day.
 * Deliberately larger than FREE_TIER_WORKSPACE_LIMIT — a user who archives a
 * mistake and starts over must not be locked out for a day.
 */
const SELF_SERVE_CREATE_DAILY_LIMIT = 6;

/**
 * §8: free self-serve plus transactional email is a branded-phishing vector,
 * so outbound invites are capped per verified identity per rolling day.
 */
const INVITE_IDENTITY_DAILY_LIMIT = 10;

/**
 * §10's per-tenant caps. Seats count live members plus invitations still
 * outstanding, so an attacker cannot park unbounded pending invites in one
 * workspace; principals bound the agent identities a free tenant can hold.
 * These are free-tier resource ceilings, not authority boundaries.
 */
const FREE_TIER_MEMBER_LIMIT = 25;
const FREE_TIER_PRINCIPAL_LIMIT = 50;

/* ★ THE GLOBAL SPEND CIRCUIT BREAKER — §8's abuse taxonomy, launch-blocking in
 * §9 P5 ("a global spend circuit breaker caps aggregate Supabase/function/email
 * budget and trips to a degraded, signup-paused mode before a bill runs away";
 * §10: bounded, "not merely alerted").
 *
 * THERE IS NO DOLLAR FIGURE HERE AND NONE MAY BE ADDED. Nothing in this system
 * talks to a billing API or receives cost telemetry — §8 defers billing
 * infrastructure entirely — so a threshold written in dollars would be a number
 * nobody measured wearing the costume of a budget. What the database does hold
 * is the COUNT of the operations that spend money, so those are what the
 * ceilings are set on. Crossing one means "cost is being generated at a rate
 * nobody planned for", which is the question this control exists to answer. It
 * does not mean, and must never be reported as, "the bill reached $N".
 *
 * The five proxies, and what each one is a proxy FOR:
 *   workspace_create   a whole tenant substrate — rows, streams, retention
 *   invite_send        the invitation §8 costs as transactional email. NOTE:
 *                      nothing in this repo sends mail today — invite_member
 *                      returns a token to the caller — so this counts
 *                      invitations ISSUED, not messages delivered. Wired now
 *                      because the day mail is added is the day it costs money.
 *   signal_post        row writes plus Realtime fan-out
 *   agent_token_mint   credentials, each of which becomes invocation volume
 *
 * capability_read WAS a fifth proxy and was REMOVED as a denial-of-service hole:
 * its buckets are incremented before the bearer is resolved, so an unauthenticated
 * caller could latch a platform-wide signup pause. EVERY PROXY HERE MUST BE AN
 * AUTHENTICATED, ACCEPTED ACTION, or the ceiling becomes a lever for someone
 * holding no credential at all. Do not add one that is not.
 *
 * WHAT TRIPPING DOES, AND DELIBERATELY DOES NOT DO. It pauses SIGNUP: a crossed
 * ceiling refuses create_workspace and nothing else. Existing workspaces keep
 * working — signals, invites, tokens, reads all continue. A breaker that takes
 * the product down for every tenant because one attacker found the cheap verb
 * is a worse outcome than the bill it was avoiding, and it would hand any
 * stranger an outage button.
 *
 * The ceilings are set from the per-tenant limits above and the current tenant
 * count (invited dogfood, single digits), NOT from a measured bill — they are
 * an order-of-magnitude guess, generous enough that honest traffic never sees
 * them and small enough to catch a runaway inside one hour. When real metering
 * exists, these become numbers derived from it and this paragraph goes away.
 */
type SpendProxy =
  | "workspace_create"
  | "invite_send"
  | "signal_post"
  | "agent_token_mint";

const SPEND_CEILINGS: Record<SpendProxy, number> = {
  workspace_create: 100,
  invite_send: 400,
  signal_post: 20000,
  agent_token_mint: 1000,
};

/* The counter is SHARDED, and that is not an optimisation — it is the fix for a
 * bug this codebase already shipped once. A single global bucket_key means every
 * request on the metered path serialises behind one row-exclusive lock held for
 * the whole transaction, so the counter that exists to observe a surge becomes a
 * throughput ceiling that is worst exactly during one. It was found and removed
 * on the capability read path (see the sharding note in
 * supabase/functions/capability/index.ts); reintroducing it here would be the
 * same defect in a new file.
 *
 * Math.random is the right shard chooser: nothing is secret, the only
 * requirement is even spread, and a hash of the caller would pin one caller to
 * one row and rebuild the hot spot per attacker. The signal is not weakened —
 * the window's TRUE total is the sum of the shards, read without locking and
 * only once a shard is past its own share, so the ordinary path never pays for
 * it and the trip still fires on the real global count.
 */
const SPEND_SHARDS = 8;
const SPEND_BUCKET_KEYS: Record<SpendProxy, string[]> = Object.fromEntries(
  (Object.keys(SPEND_CEILINGS) as SpendProxy[]).map((proxy) => [
    proxy,
    Array.from(
      { length: SPEND_SHARDS },
      (_unused, index) => `spend:${proxy}:${index}`,
    ),
  ]),
) as Record<SpendProxy, string[]>;

/**
 * The commands charged from the shared routed path. post_signal and
 * create_workspace are charged at their own handlers because neither reaches
 * this table.
 */
const SPEND_PROXY_BY_COMMAND: Record<string, SpendProxy> = {
  invite_member: "invite_send",
  mint_agent_token: "agent_token_mint",
};
/* renew_agent_token is deliberately NOT metered here. The breaker exists to
 * pause growth — signups, invites, new tenants — before a bill runs away. A
 * renewal is not growth: it is an already-authorised run staying alive, and
 * charging it would let a tripped breaker silently strand every running fleet's
 * credentials, which is the 8h wall this endpoint was built to remove. The
 * §2.3 bound on renewal volume is the grant's max_successors, not spend. */

/* ★ THE CAPABILITY-READ KEY MIRROR WAS DELETED WITH THE PROXY IT FED.
 *
 * It read the capability function's sharded global counter across this file
 * boundary. The reasoning written here was that duplicating the key layout was
 * "safe in the direction that matters" because drift could only UNDERCOUNT, and
 * "undercounting can only fail to trip — it can never manufacture a pause."
 *
 * That was true and it was the wrong risk to be watching. The danger was never
 * miscounting; it was WHAT WAS BEING COUNTED. Those buckets increment before the
 * capability function resolves the bearer, so refused anonymous requests — absent,
 * malformed, unknown, revoked, expired — all landed in them. An attacker with no
 * credential could therefore drive a platform-wide signup pause, which no amount
 * of counting accuracy would have prevented. The careful note reasoned hard about
 * the safe axis while the unsafe one went unmentioned.
 */

/**
 * A speed bump, and honestly nothing more: it turns away the laziest throwaway
 * inbox and anyone determined registers a domain in a minute. It is not a
 * security control and nothing downstream may treat it as one — identity
 * verification is what the abuse posture actually rests on. Kept short and
 * obvious on purpose; a long list belongs in data, not in this file.
 */
const DISPOSABLE_EMAIL_DOMAINS = [
  "10minutemail.com",
  "dispostable.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "mailinator.com",
  "maildrop.cc",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwaway.email",
  "trashmail.com",
  "yopmail.com",
] as const;
const COMMAND_KINDS = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "invite_member",
  "revoke_invitation",
  "accept_invitation",
  "remove_member",
  "create_agent_principal",
  "mint_agent_token",
  "revoke_agent_principal",
  "revoke_agent_token",
  "renew_agent_token",
  "post_signal",
] as const;
const TASK_COMMAND_KINDS = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
] as const;
/**
 * Human-credential connect commands. An agent presenting any of these is
 * refused before the reducer runs; renewal is NOT one of them (see
 * WORKSPACE_COMMAND_KINDS).
 */
const CONNECT_COMMAND_KINDS = [
  "invite_member",
  "revoke_invitation",
  "accept_invitation",
  "remove_member",
  "create_agent_principal",
  "mint_agent_token",
  "revoke_agent_principal",
] as const;
/**
 * Everything that travels the workspace-stream path. `renew_agent_token` routes
 * here — it is a workspace-authority command decided by `decideWorkspace` — but
 * it is deliberately outside CONNECT_COMMAND_KINDS, because §2.3 renewal is
 * presented BY the agent credential being renewed. It is authorised by the
 * run's bounded renewal grant, never by a scope: `renew_agent_token` tokenises
 * to token+renew and so is permanently denylisted as a scope by design.
 */
const WORKSPACE_COMMAND_KINDS = [
  ...CONNECT_COMMAND_KINDS,
  "revoke_agent_token",
  RENEW_AGENT_TOKEN_KIND,
] as const;
const P0_AGENT_SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "post_signal",
] as const;

const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const commandEnvironment = Deno.env.get("SWARM_ENV");
const allowedCommandOrigins = commandAllowedOrigins(
  Deno.env.get("SWARM_COMMAND_ALLOWED_ORIGINS"),
);
if (!databaseUrl || !supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "command function requires SWARM_DATABASE_URL/SUPABASE_DB_URL, SUPABASE_URL, and SUPABASE_ANON_KEY",
  );
}

const hookSleep = parseStepSleep(
  Deno.env.get("SWARM_CMD_TEST_SLEEP_AFTER_STEP"),
);
const hookRollback = parseStep(Deno.env.get("SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP"));
if (
  (hookSleep !== null || hookRollback !== null) &&
  Deno.env.get("SWARM_ENV") !== "test"
) {
  throw new Error("command test hooks refuse to run unless SWARM_ENV=test");
}

const db = postgres(databaseUrl, {
  max: 4,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});
const authClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type CredentialKind = "user" | "agent";
type Role = "owner" | "admin" | "member";

interface RequestBody {
  command_id?: unknown;
  client_version?: unknown;
  workspace_id?: unknown;
  stream?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface AuthContext {
  credentialKind: CredentialKind;
  credentialId: string | null;
  deviceId: string | null;
  actor: Actor;
  agent: AgentAuthRow | null;
  /**
   * True when this request is the presented agent credential's FIRST successful
   * authentication — read from the row as it stood before this request stamped
   * it. Always false for a human credential. §2.3 first-use supersession.
   */
  agentFirstUse: boolean;
  identityVerified: boolean;
  /** Bookkeeping for the §8 disposable-domain speed bump; never authorization. */
  email: string | null;
  /** Newest interactive AMR timestamp from verified claims for this JWT. */
  interactiveAuthAtSeconds: number | null;
}

interface Route {
  workspaceId: string;
  streamId: string;
  membershipRole: Role | null;
  membershipRevokedAt: Date | null;
}

interface VerifiedHuman {
  userId: string;
  email: string | null;
  displayName: string;
  identityVerified: boolean;
  interactiveAuthAtSeconds: number | null;
}

interface PreparedWorkspace {
  wire: ConnectCommand;
  command: WorkspaceCommand;
  state: WorkspaceState;
  ctx: WorkspaceDecideCtx;
  invitationToken: string | null;
  invitationHash: Uint8Array | null;
  agentToken: string | null;
  agentTokenHash: Uint8Array | null;
  lineageId: string | null;
  /** Renewal only: the presenting predecessor and the facts read for it. */
  predecessorTokenId: string | null;
  renewalFacts: RenewalFacts | null;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface Audit {
  auth: AuthContext;
  commandKind: string;
  workspaceId?: string | null;
  streamId?: string | null;
  outcome: string;
  reason?: string | null;
  detail?: string | null;
  hash?: string | null;
}

class TestRollback extends Error {
  constructor(readonly step: number) {
    super(`test rollback before step ${step}`);
  }
}

/** Internal signal: the renewal fence lost a race and rolled back its savepoint. */
class RenewalFenceLost extends Error {
  constructor() {
    super("renewal fence lost a concurrent race");
  }
}

class LedgerRace extends Error {
  constructor(
    readonly auth: AuthContext,
    readonly commandId: string,
    readonly commandKind: string,
    readonly workspaceId: string,
    readonly streamId: string,
    readonly hash: string,
  ) {
    super("idempotency insert lost a concurrent race");
  }
}

function parseStep(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 15) {
    throw new Error("SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP must be an integer 1..15");
  }
  return value;
}

function parseStepSleep(
  raw: string | undefined,
): { step: number; milliseconds: number } | null {
  if (raw === undefined) return null;
  const match = /^(\d+):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(
      "SWARM_CMD_TEST_SLEEP_AFTER_STEP must have the form step:milliseconds",
    );
  }
  const step = Number(match[1]);
  const milliseconds = Number(match[2]);
  if (
    !Number.isInteger(step) || step < 1 || step > 15 ||
    !Number.isInteger(milliseconds) || milliseconds < 0 ||
    milliseconds > 60_000
  ) {
    throw new Error("invalid SWARM_CMD_TEST_SLEEP_AFTER_STEP");
  }
  return { step, milliseconds };
}

async function beforeStep(step: number): Promise<void> {
  if (hookRollback === step) throw new TestRollback(step);
}

async function afterStep(step: number): Promise<void> {
  if (hookSleep?.step === step) {
    await new Promise((resolve) => setTimeout(resolve, hookSleep.milliseconds));
  }
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * One scrubbing set for this file, not two. This used to run a narrower
 * CONTROL_GLOBAL_RE (C0/C1 plus \u202a-\u202e and \u2066-\u2069) that sat six lines
 * away from SIGNAL_UNSAFE_GLOBAL_RE and let through zero-width joiners, the
 * BOM, the word joiner and the entire tags block — so a label or an audit
 * reason was held to a weaker standard than the signal text beside it.
 */
function stripControls(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(SIGNAL_UNSAFE_GLOBAL_RE, "").slice(0, 2048);
}

function sanitizeSignalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(SIGNAL_WHITESPACE_GLOBAL_RE, " ")
    .replace(SIGNAL_UNSAFE_GLOBAL_RE, "");
}

function displayLabel(value: string | null | undefined, fallback: string): string {
  const cleaned = stripControls(
    value?.replace(ANSI_ESCAPE_GLOBAL_RE, ""),
  )?.trim().slice(0, 120);
  return cleaned || fallback;
}

function commandKind(body: RequestBody | null): string {
  const command = record(body?.command);
  return typeof command?.kind === "string"
    ? stripControls(command.kind)?.slice(0, 64) || "unknown"
    : "unknown";
}

function forgedActorDetail(body: RequestBody): string | null {
  const forged = [
    "actor_user",
    "actor_agent_principal",
    "actor_run",
    "device",
    "device_id",
  ].filter((key) => Object.hasOwn(body, key));
  return forged.length === 0
    ? null
    : `ignored client-supplied identity fields: ${forged.join(",")}`;
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; body: RequestBody; byteLength: number }
  | { ok: false; response: Response }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: "payload_too_large" }) };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: json(400, { error: "invalid_request" }) };
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, response: json(413, { error: "payload_too_large" }) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const body = record(parsed);
    return body
      ? { ok: true, body, byteLength }
      : { ok: false, response: json(400, { error: "invalid_request" }) };
  } catch {
    return { ok: false, response: json(400, { error: "invalid_request" }) };
  }
}

// RFC 7235 §2.1: the auth-scheme is case-INSENSITIVE and is followed by 1*SP,
// so `bearer swm_agt_...` is a well-formed credential. Matching /^Bearer / with
// no `i` rejected it as if no credential had been presented at all — a
// conforming client would have been told its token was missing.
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

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid SHA-256 hex");
  return new Uint8Array(
    value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function opaqueToken(prefix: "swm_inv_" | "swm_agt_" | "swm_cap_"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${prefix}${encoded}`;
}

async function setTransaction(tx: Sql): Promise<void> {
  await tx.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await tx.unsafe("SET LOCAL ROLE swarm_command");
  await tx.unsafe("SET LOCAL search_path = swarm, pg_catalog");
  await tx.unsafe("SET LOCAL lock_timeout = '5s'");
}

async function insertAudit(tx: Sql, audit: Audit): Promise<void> {
  const auth = audit.auth;
  await tx`
    INSERT INTO swarm.audit_log (
      actor_user, actor_agent_principal, actor_run,
      credential_kind, credential_id, device_id,
      command_kind, workspace_id, stream_id,
      outcome, reason, detail, request_hash, ip
    ) VALUES (
      ${auth?.actor.user ?? null}::uuid,
      ${auth?.actor.agent_principal ?? null}::uuid,
      ${auth?.actor.run ?? null}::uuid,
      ${auth?.credentialKind ?? null},
      ${auth?.credentialId ?? null}::uuid,
      ${auth?.deviceId ?? null}::uuid,
      ${stripControls(audit.commandKind) ?? "unknown"},
      ${audit.workspaceId ?? null}::uuid,
      ${audit.streamId ?? null}::uuid,
      ${audit.outcome},
      ${stripControls(audit.reason)},
      ${stripControls(audit.detail)},
      ${audit.hash ?? null},
      NULL
    )
  `;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${stripControls(error.message) ?? ""}`.slice(0, 512);
  }
  return "unknown error";
}

function logCommandFailure(
  event: "command_pre_auth_failure" | "command_request_failure",
  commandKind: string,
  outcome: string,
  reason: string,
  detail?: string,
): void {
  console.error(JSON.stringify({
    event,
    command_kind: stripControls(commandKind)?.slice(0, 64) || "unknown",
    outcome,
    reason,
    ...(detail === undefined ? {} : { detail: stripControls(detail) }),
  }));
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function boundedText(
  value: unknown,
  maximum: number,
  minimum = 1,
): value is string {
  return typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !CONTROL_RE.test(value);
}

function normalizedEmail(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 320 ||
    CONTROL_RE.test(value)
  ) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

/**
 * True only when the address sits on a domain we recognise as throwaway. An
 * address we cannot parse is NOT treated as disposable: the speed bump exists
 * to turn away the obvious case, and guessing would refuse honest signups on
 * no evidence. Subdomains of a listed domain count (mail.mailinator.com).
 */
function disposableEmailDomain(value: string | null): boolean {
  if (value === null) return false;
  const at = value.lastIndexOf("@");
  if (at < 0) return false;
  const domain = value.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0) return false;
  for (const listed of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain === listed || domain.endsWith(`.${listed}`)) return true;
  }
  return false;
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID_RE.test(value));
}

function validateCommand(
  value: unknown,
): { ok: true; command: ValidatedCommand } | { ok: false; status: number; reason: string } {
  const cmd = record(value);
  if (!cmd || typeof cmd.kind !== "string") {
    return { ok: false, status: 400, reason: "invalid command shape" };
  }
  if (!(COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    return { ok: false, status: 400, reason: "unknown command kind" };
  }

  if (cmd.kind === "post_signal") {
    if (Object.hasOwn(cmd, "from")) {
      return {
        ok: false,
        status: 400,
        reason: "client-supplied from is forbidden",
      };
    }
    const modernShape =
      Object.hasOwn(cmd, "to_agent_principal_id") ||
      Object.hasOwn(cmd, "in_reply_to");
    const optionalKeys = Object.hasOwn(cmd, "until_ms") ? ["until_ms"] : [];
    const modernKeys = modernShape
      ? ["to_agent_principal_id", "in_reply_to"]
      : [];
    const signalKinds: readonly SignalKind[] = ["working-on", "note", "ask"];
    const sanitizedBody = typeof cmd.body === "string"
      ? sanitizeSignalText(cmd.body)
      : "";
    const sanitizedAbout = typeof cmd.about === "string"
      ? sanitizeSignalText(cmd.about) || null
      : null;
    const toAgentPrincipalId = modernShape
      ? cmd.to_agent_principal_id
      : null;
    const inReplyTo = modernShape ? cmd.in_reply_to : null;
    const valid = exactKeys(cmd, [
      "kind",
      "signal_kind",
      "body",
      "to_user_id",
      "about",
      ...modernKeys,
      ...optionalKeys,
    ]) &&
      typeof cmd.signal_kind === "string" &&
      signalKinds.includes(cmd.signal_kind as SignalKind) &&
      typeof cmd.body === "string" &&
      cmd.body.length >= 1 &&
      cmd.body.length <= 2000 &&
      sanitizedBody.length >= 1 &&
      nullableUuid(cmd.to_user_id) &&
      (!modernShape ||
        (
          Object.hasOwn(cmd, "to_agent_principal_id") &&
          Object.hasOwn(cmd, "in_reply_to") &&
          nullableUuid(toAgentPrincipalId) &&
          nullableUuid(inReplyTo)
        )) &&
      Number(cmd.to_user_id !== null) +
          Number(toAgentPrincipalId !== null) <=
        1 &&
      (
        cmd.signal_kind !== "working-on" ||
        (
          cmd.to_user_id === null &&
          toAgentPrincipalId === null &&
          inReplyTo === null
        )
      ) &&
      (
        inReplyTo === null ||
        (
          cmd.signal_kind === "note" &&
          cmd.to_user_id === null &&
          toAgentPrincipalId === null
        )
      ) &&
      (
        cmd.about === null ||
        (
          typeof cmd.about === "string" &&
          cmd.about.length <= 500
        )
      ) &&
      (
        cmd.until_ms === undefined ||
        (
          integer(cmd.until_ms, 1) &&
          cmd.until_ms <= SIGNAL_MAX_UNTIL_MS
        )
      );
    return valid
      ? {
        ok: true,
        command: {
          kind: "post_signal",
          signal_kind: cmd.signal_kind as SignalKind,
          body: sanitizedBody,
          to_user_id: cmd.to_user_id as string | null,
          ...(modernShape
            ? {
              to_agent_principal_id: toAgentPrincipalId as string | null,
              in_reply_to: inReplyTo as string | null,
            }
            : {}),
          about: sanitizedAbout,
          ...(cmd.until_ms === undefined
            ? {}
            : { until_ms: cmd.until_ms as number }),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "signal fields are malformed or over their limits",
      };
  }

  // §2.3: the successor endpoint accepts NO caller-selected fields. A body that
  // names a principal, run, task, epoch, scope, or TTL is a request to choose a
  // renewal target and is refused at the wire, before authorization runs — the
  // presented predecessor credential is the entire input.
  if (cmd.kind === RENEW_AGENT_TOKEN_KIND) {
    return exactKeys(cmd, ["kind"])
      ? { ok: true, command: { kind: "renew_agent_token" } }
      : {
        ok: false,
        status: 400,
        reason: "renew_agent_token accepts no caller-selected fields",
      };
  }

  // Token revoke is workspace-routed and may be presented by an agent for
  // exact-token self-surrender (§2.3/§10). It is outside CONNECT so the human-
  // only registry does not pre-refuse agents before the reducer can confine
  // them to their presenting token_id.
  if (cmd.kind === "revoke_agent_token") {
    return exactKeys(cmd, ["kind", "token_id"]) &&
        typeof cmd.token_id === "string" &&
        UUID_RE.test(cmd.token_id)
      ? {
        ok: true,
        command: { kind: "revoke_agent_token", token_id: cmd.token_id },
      }
      : {
        ok: false,
        status: 400,
        reason: "revoke_agent_token fields are malformed",
      };
  }

  if ((CONNECT_COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    if (cmd.kind === "remove_member") {
      return exactKeys(cmd, ["kind", "user_id"]) &&
          typeof cmd.user_id === "string" &&
          UUID_RE.test(cmd.user_id)
        ? {
          ok: true,
          command: { kind: "remove_member", user_id: cmd.user_id },
        }
        : {
          ok: false,
          status: 400,
          reason: "remove_member fields are malformed",
        };
    }
    if (cmd.kind === "invite_member") {
      const email = normalizedEmail(cmd.email);
      const optionalKeys = Object.hasOwn(cmd, "ttl_ms") ? ["ttl_ms"] : [];
      const validTtl = cmd.ttl_ms === undefined ||
        (integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= INVITATION_MAX_TTL_MS);
      return exactKeys(cmd, ["kind", "email", ...optionalKeys]) &&
          email !== null &&
          validTtl
        ? {
          ok: true,
          command: {
            kind: "invite_member",
            email,
            ...(cmd.ttl_ms === undefined
              ? {}
              : { ttl_ms: cmd.ttl_ms as number }),
          },
        }
        : { ok: false, status: 400, reason: "invite fields are malformed" };
    }
    if (cmd.kind === "accept_invitation") {
      return exactKeys(cmd, ["kind", "token"]) &&
          typeof cmd.token === "string" &&
          INVITATION_TOKEN_RE.test(cmd.token)
        ? {
          ok: true,
          command: { kind: "accept_invitation", token: cmd.token },
        }
        : { ok: false, status: 400, reason: "invitation token is malformed" };
    }
    if (cmd.kind === "revoke_invitation") {
      return exactKeys(cmd, ["kind", "invitation_id"]) &&
          typeof cmd.invitation_id === "string" &&
          UUID_RE.test(cmd.invitation_id)
        ? {
          ok: true,
          command: {
            kind: "revoke_invitation",
            invitation_id: cmd.invitation_id,
          },
        }
        : {
          ok: false,
          status: 400,
          reason: "revoke_invitation fields are malformed",
        };
    }
    if (cmd.kind === "create_agent_principal") {
      const optionalKeys = Object.hasOwn(cmd, "model") ? ["model"] : [];
      return exactKeys(cmd, ["kind", "name", ...optionalKeys]) &&
          boundedText(cmd.name, 80) &&
          (cmd.model === undefined || boundedText(cmd.model, 120))
        ? {
          ok: true,
          command: {
            kind: "create_agent_principal",
            name: cmd.name,
            ...(cmd.model === undefined ? {} : { model: cmd.model }),
          },
        }
        : { ok: false, status: 400, reason: "principal name is malformed" };
    }
    if (cmd.kind === "revoke_agent_principal") {
      return exactKeys(cmd, ["kind", "principal_id"]) &&
          typeof cmd.principal_id === "string" &&
          UUID_RE.test(cmd.principal_id)
        ? {
          ok: true,
          command: {
            kind: "revoke_agent_principal",
            principal_id: cmd.principal_id,
          },
        }
        : {
          ok: false,
          status: 400,
          reason: "revoke_agent_principal fields are malformed",
        };
    }
    // Explicit mint arm only — never fall through from revoke kinds into a
    // mint prepare that would invent a live credential.
    if (cmd.kind !== "mint_agent_token") {
      return { ok: false, status: 400, reason: "unknown command kind" };
    }
    const optionalKeys = [
      ...(Object.hasOwn(cmd, "ttl_ms") ? ["ttl_ms"] : []),
      ...(Object.hasOwn(cmd, "scopes") ? ["scopes"] : []),
    ];
    const validScopes = cmd.scopes === undefined ||
      (
        Array.isArray(cmd.scopes) &&
        cmd.scopes.length >= 1 &&
        cmd.scopes.length <= 64 &&
        cmd.scopes.every((scope) => boundedText(scope, 128))
      );
    const validTtl = cmd.ttl_ms === undefined ||
      (integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= AGENT_TOKEN_MAX_TTL_MS);
    const valid = exactKeys(cmd, [
      "kind",
      "principal_id",
      "run_id",
      "task_id",
      "epoch",
      "device_id",
      ...optionalKeys,
    ]) &&
      typeof cmd.principal_id === "string" && UUID_RE.test(cmd.principal_id) &&
      typeof cmd.run_id === "string" && UUID_RE.test(cmd.run_id) &&
      typeof cmd.task_id === "string" && UUID_RE.test(cmd.task_id) &&
      integer(cmd.epoch) &&
      typeof cmd.device_id === "string" && UUID_RE.test(cmd.device_id) &&
      validScopes &&
      validTtl;
    return valid
      ? {
        ok: true,
        command: {
          kind: "mint_agent_token",
          principal_id: cmd.principal_id as string,
          run_id: cmd.run_id as string,
          task_id: cmd.task_id as string,
          epoch: cmd.epoch as number,
          device_id: cmd.device_id as string,
          ...(cmd.ttl_ms === undefined ? {} : { ttl_ms: cmd.ttl_ms as number }),
          ...(cmd.scopes === undefined
            ? {}
            : { scopes: [...cmd.scopes as string[]] }),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "mint_agent_token fields are malformed or out of bounds",
      };
  }

  if (typeof cmd.task_id !== "string" || !UUID_RE.test(cmd.task_id)) {
    return { ok: false, status: 400, reason: "task_id must be a UUID" };
  }

  let valid = false;
  switch (cmd.kind) {
    case "create":
      valid = exactKeys(cmd, ["kind", "task_id", "slug"]) &&
        typeof cmd.slug === "string" && SLUG_RE.test(cmd.slug);
      break;
    case "acquire":
      valid = exactKeys(cmd, ["kind", "task_id", "ttl_ms"]) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "renew":
      valid = exactKeys(cmd, ["kind", "task_id", "epoch", "ttl_ms"]) &&
        integer(cmd.epoch) && integer(cmd.ttl_ms, 1) &&
        cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "handoff":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "to_owner",
        "ttl_ms",
      ]) &&
        integer(cmd.epoch) &&
        typeof cmd.to_owner === "string" && UUID_RE.test(cmd.to_owner) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "takeover":
      valid = exactKeys(cmd, ["kind", "task_id", "grant_id", "ttl_ms"]) &&
        nullableUuid(cmd.grant_id) &&
        integer(cmd.ttl_ms, 1) && cmd.ttl_ms <= MAX_TTL_MS;
      break;
    case "submit":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "branch",
        "head_sha",
        "evidence_set",
      ]) &&
        integer(cmd.epoch) &&
        boundedText(cmd.branch, 255) &&
        typeof cmd.head_sha === "string" && SHA_RE.test(cmd.head_sha) &&
        Array.isArray(cmd.evidence_set) &&
        cmd.evidence_set.length > 0 &&
        cmd.evidence_set.length <= 128 &&
        cmd.evidence_set.every((item) => boundedText(item, 2048));
      break;
    case "close":
      valid = exactKeys(cmd, [
        "kind",
        "task_id",
        "epoch",
        "disposition",
        "grant_id",
      ]) &&
        integer(cmd.epoch) &&
        typeof cmd.disposition === "string" &&
        (DISPOSITIONS as readonly string[]).includes(cmd.disposition) &&
        nullableUuid(cmd.grant_id);
      break;
    case "reopen":
      valid = exactKeys(cmd, ["kind", "task_id", "epoch"]) &&
        integer(cmd.epoch);
      break;
  }
  if (!valid) {
    return {
      ok: false,
      status: 400,
      reason: "command fields are malformed or out of bounds",
    };
  }

  if (
    new TextEncoder().encode(JSON.stringify(cmd)).byteLength >
      MAX_EVENT_PAYLOAD_BYTES
  ) {
    return { ok: false, status: 413, reason: "event payload too large" };
  }
  return { ok: true, command: cmd as Command };
}

function compareSemver(left: string, right: string): number | null {
  const a = SEMVER_RE.exec(left);
  const b = SEMVER_RE.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function stateFromRow(row: Record<string, unknown> | undefined): TaskState | null {
  if (!row) return null;
  const submission = record(row.submission);
  return {
    task_id: String(row.task_id),
    slug: String(row.slug),
    lifecycle: row.lifecycle as TaskState["lifecycle"],
    version: Number(row.version),
    epoch: Number(row.epoch),
    owner: row.owner === null ? null : String(row.owner),
    lease_expiry: row.lease_expiry instanceof Date
      ? row.lease_expiry.getTime()
      : null,
    submission: submission
      ? {
        epoch: Number(submission.epoch),
        branch: String(submission.branch),
        head_sha: String(submission.head_sha),
        evidence_set: Array.isArray(submission.evidence_set)
          ? submission.evidence_set.map(String)
          : [],
      }
      : null,
    closed_disposition: row.closed_disposition === null
      ? null
      : String(row.closed_disposition),
  };
}

function storedResponse(value: unknown): StoredResponse {
  const response = record(value);
  if (!response || typeof response.ok !== "boolean" || !Array.isArray(response.event_ids)) {
    throw new Error("invalid stored idempotency response");
  }
  return {
    ok: response.ok,
    ...(typeof response.reason === "string" ? { reason: response.reason as StoredResponse["reason"] } : {}),
    ...(typeof response.detail === "string" ? { detail: response.detail } : {}),
    ...(response.class === "authz" || response.class === "domain"
      ? { class: response.class }
      : {}),
    event_ids: response.event_ids.map(String),
    ...(typeof response.invitation_id === "string"
      ? { invitation_id: response.invitation_id }
      : {}),
    ...(typeof response.principal_id === "string"
      ? { principal_id: response.principal_id }
      : {}),
    ...(typeof response.token_id === "string"
      ? { token_id: response.token_id }
      : {}),
    ...(typeof response.run_id === "string" ? { run_id: response.run_id } : {}),
    ...(typeof response.workspace_id === "string"
      ? { workspace_id: response.workspace_id }
      : {}),
    ...(typeof response.capability_id === "string"
      ? { capability_id: response.capability_id }
      : {}),
    ...(typeof response.expires_at === "string"
      ? { expires_at: response.expires_at }
      : {}),
    ...(typeof response.revoked_at === "string"
      ? { revoked_at: response.revoked_at }
      : {}),
    ...(record(response.signal) === null
      ? {}
      : { signal: response.signal as unknown as SignalRecord }),
  };
}

function replayResult(
  response: StoredResponse,
  commandKind?: string,
): HttpResult {
  if (commandKind === "accept_invitation" && !response.ok) {
    return { status: 403, body: { error: "forbidden" } };
  }
  return {
    status: 200,
    body: {
      status: response.ok ? "accepted" : "rejected",
      ...response,
    },
  };
}

function dbCode(error: unknown): string | null {
  return record(error)?.code as string | null ?? null;
}

/**
 * Resolves the presented agent credential for the command function.
 *
 * The identification, the first-use stamp and the predecessor handover all live
 * in `loadAgentCredential` (_shared/agent-auth.ts) so that EVERY edge function
 * that authenticates an agent records the use. An earlier version of this file
 * carried its own copy of the query with the stamp folded in, which left `read`
 * authenticating without stamping — and a credential used only for reads then
 * stayed PENDING for ever and was revoked underneath its holder by the next
 * renewal. One authentication path, one definition of "used".
 */
async function authenticateAgent(
  tx: Sql,
  tokenHash: Uint8Array,
): Promise<AuthContext | null> {
  const agent = await loadAgentCredential(tx, tokenHash);
  if (!agent) return null;
  return {
    credentialKind: "agent",
    credentialId: agent.token_id,
    deviceId: agent.device_id,
    actor: {
      user: agent.owner_user_id,
      agent_principal: agent.principal_id,
      run: agent.run_id,
    },
    agent,
    agentFirstUse: agent.first_use === true,
    identityVerified: false,
    email: null,
    interactiveAuthAtSeconds: null,
  };
}

async function authenticateHuman(
  tx: Sql,
  verified: VerifiedHuman,
): Promise<AuthContext | null> {
  const rows = await tx<{ user_id: string; email: string | null }[]>`
    INSERT INTO swarm.users (user_id, display_name, email)
    VALUES (
      ${verified.userId}::uuid,
      ${verified.displayName},
      ${verified.email}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      email = coalesce(EXCLUDED.email, swarm.users.email)
    RETURNING user_id, email
  `;
  if (!rows[0]) return null;
  return {
    credentialKind: "user",
    credentialId: null,
    deviceId: null,
    actor: { user: rows[0].user_id, agent_principal: null, run: null },
    agent: null,
    agentFirstUse: false,
    identityVerified: verified.identityVerified,
    email: verified.email ?? rows[0].email,
    interactiveAuthAtSeconds: verified.interactiveAuthAtSeconds,
  };
}

async function resolveRoute(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
): Promise<Route | null> {
  if (typeof body.workspace_id !== "string" || !UUID_RE.test(body.workspace_id)) {
    return null;
  }
  const workspaceId = body.workspace_id;
  if (
    auth.agent !== null &&
    auth.agent.principal_workspace_id !== workspaceId
  ) {
    return null;
  }

  const memberships = await tx<
    { role: Role; revoked_at: Date | null }[]
  >`
    SELECT role, revoked_at
    FROM swarm.memberships
    WHERE workspace_id = ${workspaceId}::uuid
      AND user_id = ${auth.actor.user}::uuid
    LIMIT 1
  `;
  const membership = memberships[0];
  if (!membership) return null;

  const stream = record(body.stream);
  if (!stream || typeof stream.kind !== "string") return null;
  let streamId: string | null = null;
  if (stream.kind === "workspace" && exactKeys(stream, ["kind"])) {
    const rows = await tx<{ stream_id: string }[]>`
      SELECT stream_id
      FROM swarm.streams
      WHERE workspace_id = ${workspaceId}::uuid
        AND kind = 'workspace'
      LIMIT 1
    `;
    streamId = rows[0]?.stream_id ?? null;
  } else if (
    stream.kind === "repo" &&
    exactKeys(stream, ["kind", "repo_mapping_id"]) &&
    typeof stream.repo_mapping_id === "string" &&
    UUID_RE.test(stream.repo_mapping_id)
  ) {
    const rows = await tx<{ stream_id: string }[]>`
      SELECT s.stream_id
      FROM swarm.repositories AS r
      JOIN swarm.streams AS s
        ON s.repo_mapping_id = r.repo_mapping_id
       AND s.workspace_id = r.workspace_id
       AND s.kind = 'repo'
      WHERE r.repo_mapping_id = ${stream.repo_mapping_id}::uuid
        AND r.workspace_id = ${workspaceId}::uuid
        AND r.archived_at IS NULL
      LIMIT 1
    `;
    streamId = rows[0]?.stream_id ?? null;
  }
  if (!streamId) return null;
  return {
    workspaceId,
    streamId,
    membershipRole: membership.role,
    membershipRevokedAt: membership.revoked_at,
  };
}

function invitationTokenForRoute(body: RequestBody): string | null {
  if (body.workspace_id !== undefined || body.stream !== undefined) return null;
  const command = record(body.command);
  if (
    !command ||
    command.kind !== "accept_invitation" ||
    !exactKeys(command, ["kind", "token"]) ||
    typeof command.token !== "string" ||
    !INVITATION_TOKEN_RE.test(command.token)
  ) return null;
  return command.token;
}

async function resolveInvitationRoute(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  tokenHash: Uint8Array,
): Promise<Route | null> {
  // Agent credentials never get a capability existence oracle.
  if (auth.credentialKind !== "user" || invitationTokenForRoute(body) === null) {
    return null;
  }
  const rows = await tx<{
    workspace_id: string;
    stream_id: string;
    role: Role | null;
    revoked_at: Date | null;
  }[]>`
    SELECT
      i.workspace_id,
      s.stream_id,
      m.role,
      m.revoked_at
    FROM swarm.invitations AS i
    JOIN swarm.streams AS s
      ON s.workspace_id = i.workspace_id
     AND s.kind = 'workspace'
    LEFT JOIN swarm.memberships AS m
      ON m.workspace_id = i.workspace_id
     AND m.user_id = ${auth.actor.user}::uuid
    WHERE i.token_hash = ${tokenHash}
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
      workspaceId: row.workspace_id,
      streamId: row.stream_id,
      membershipRole: row.role,
      membershipRevokedAt: row.revoked_at,
    }
    : null;
}

async function revoked(
  tx: Sql,
  auth: AuthContext,
  route: Route,
): Promise<boolean> {
  const agent = auth.agent;
  return agent === null
    ? route.membershipRevokedAt !== null
    : await agentCredentialRevoked(tx, agent, route.membershipRevokedAt);
}

async function buildContext(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: Command,
  commandId: string,
  prior: TaskState | null,
  headSeq: number,
  now: number,
): Promise<DecideCtx> {
  let eligibleRecipient = false;
  if (command.kind === "handoff") {
    const rows = await tx<{ eligible: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1
          FROM swarm.memberships AS m
          WHERE m.workspace_id = ${route.workspaceId}::uuid
            AND m.user_id::text = ${command.to_owner}
            AND m.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM swarm.agent_principals AS p
          JOIN swarm.memberships AS m
            ON m.workspace_id = p.workspace_id
           AND m.user_id = p.owner_user_id
           AND m.revoked_at IS NULL
          WHERE p.workspace_id = ${route.workspaceId}::uuid
            AND p.principal_id::text = ${command.to_owner}
            AND p.revoked_at IS NULL
        )
      ) AS eligible
    `;
    eligibleRecipient = rows[0]?.eligible ?? false;
  }

  let slugTaken = false;
  if (command.kind === "create") {
    const rows = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM swarm.tasks
        WHERE stream_id = ${route.streamId}::uuid
          AND slug = ${command.slug}
      ) AS taken
    `;
    slugTaken = rows[0]?.taken ?? false;
  }

  let takeoverGrant = false;
  if (
    command.kind === "takeover" &&
    command.grant_id !== null &&
    prior !== null
  ) {
    const recipient = canonicalPrincipal(auth.actor);
    const rows = await tx<{ valid: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM swarm.grants AS g
        WHERE g.grant_id = ${command.grant_id}::uuid
          AND g.workspace_id = ${route.workspaceId}::uuid
          AND g.stream_id = ${route.streamId}::uuid
          AND g.task_id = ${command.task_id}::uuid
          AND g.type = 'takeover'
          AND g.issued_to = ${recipient}
          AND g.binding @> ${
      tx.json({ epoch: prior.epoch })
    }::jsonb
          AND g.revoked_at IS NULL
          AND g.expires_at > statement_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM swarm.grant_consumptions AS c
            WHERE c.grant_id = g.grant_id
          )
      ) AS valid
    `;
    takeoverGrant = rows[0]?.valid ?? false;
  }

  let nextSeq = headSeq;
  return {
    now,
    actor: auth.actor,
    command_id: commandId,
    workspace_id: route.workspaceId,
    stream_id: route.streamId,
    isMember: (principal) =>
      principal === canonicalPrincipal(auth.actor) &&
      route.membershipRole !== null &&
      route.membershipRevokedAt === null,
    role: (principal) =>
      principal === canonicalPrincipal(auth.actor) ? route.membershipRole : null,
    isEligibleRecipient: (principal) =>
      command.kind === "handoff" &&
      principal === command.to_owner &&
      eligibleRecipient,
    claimRequiresGrant: () => false,
    evidenceComplete: (_taskId, evidence) =>
      evidence.length > 0 &&
      evidence.every((item) => boundedText(item, 2048)),
    validTakeoverGrant: (taskId, grantId, epoch, recipient) =>
      command.kind === "takeover" &&
      taskId === command.task_id &&
      grantId === command.grant_id &&
      epoch === prior?.epoch &&
      recipient === canonicalPrincipal(auth.actor) &&
      takeoverGrant,
    validCloseGrant: () => false,
    slugTaken: (slug) =>
      command.kind === "create" && slug === command.slug && slugTaken,
    nextSeq: () => ++nextSeq,
    nextEventId: () => crypto.randomUUID(),
  };
}

function millis(value: unknown): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function byteaHex(value: unknown): string {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "string" && /^(?:\\x)?[0-9a-f]{64}$/i.test(value)) {
    return value.replace(/^\\x/u, "").toLowerCase();
  }
  throw new Error("invalid bytea digest in workspace projection");
}

async function loadWorkspaceState(
  tx: Sql,
  route: Route,
): Promise<WorkspaceState> {
  const [workspaceRows, memberRows, invitationRows, principalRows, tokenRows] =
    await Promise.all([
      tx<Record<string, unknown>[]>`
        SELECT workspace_id, name, created_by, created_at, archived_at
        FROM swarm.workspaces
        WHERE workspace_id = ${route.workspaceId}::uuid
        LIMIT 1
      `,
      tx<Record<string, unknown>[]>`
        SELECT user_id, role, invited_by, joined_at, revoked_at
        FROM swarm.memberships
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT
          invitation_id, email, role, token_hash, expires_at,
          created_by, created_at, consumed_at, consumed_by, revoked_at
        FROM swarm.invitations
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT principal_id, owner_user_id, name, model, created_at, revoked_at
        FROM swarm.agent_principals
        WHERE workspace_id = ${route.workspaceId}::uuid
      `,
      tx<Record<string, unknown>[]>`
        SELECT
          t.token_id, t.principal_id, t.run_id, t.task_id, t.epoch,
          t.scopes, t.issued_at, t.expires_at, t.revoked_at
        FROM swarm.agent_tokens AS t
        JOIN swarm.agent_principals AS p
          ON p.principal_id = t.principal_id
        WHERE p.workspace_id = ${route.workspaceId}::uuid
      `,
    ]);
  const workspace = workspaceRows[0];
  if (!workspace) throw new Error("validated workspace disappeared");

  const members: WorkspaceState["members"] = {};
  for (const row of memberRows) {
    const userId = String(row.user_id);
    members[userId] = {
      user_id: userId,
      role: row.role as WorkspaceRole,
      invited_by: row.invited_by === null ? null : String(row.invited_by),
      joined_at: millis(row.joined_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }
  const invitations: WorkspaceState["invitations"] = {};
  for (const row of invitationRows) {
    const invitationId = String(row.invitation_id);
    invitations[invitationId] = {
      invitation_id: invitationId,
      email: row.email === null ? null : String(row.email),
      role: row.role as WorkspaceRole,
      token_hash: byteaHex(row.token_hash),
      expires_at: millis(row.expires_at) ?? 0,
      created_by: String(row.created_by),
      created_at: millis(row.created_at) ?? 0,
      consumed_at: millis(row.consumed_at),
      consumed_by: row.consumed_by === null ? null : String(row.consumed_by),
      revoked_at: millis(row.revoked_at),
    };
  }
  const principals: WorkspaceState["principals"] = {};
  for (const row of principalRows) {
    const principalId = String(row.principal_id);
    principals[principalId] = {
      principal_id: principalId,
      owner_user_id: String(row.owner_user_id),
      name: String(row.name),
      model: row.model === null ? null : String(row.model),
      created_at: millis(row.created_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }
  const tokens: WorkspaceState["tokens"] = {};
  for (const row of tokenRows) {
    const tokenId = String(row.token_id);
    tokens[tokenId] = {
      token_id: tokenId,
      principal_id: String(row.principal_id),
      run_id: String(row.run_id),
      task_id: row.task_id === null ? null : String(row.task_id),
      epoch: row.epoch === null ? null : Number(row.epoch),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      issued_at: millis(row.issued_at) ?? 0,
      expires_at: millis(row.expires_at) ?? 0,
      revoked_at: millis(row.revoked_at),
    };
  }

  return {
    workspace: {
      workspace_id: String(workspace.workspace_id),
      name: String(workspace.name),
      created_by: String(workspace.created_by),
      created_at: millis(workspace.created_at) ?? 0,
      archived_at: millis(workspace.archived_at),
    },
    members,
    invitations,
    principals,
    tokens,
    owners_count: Object.values(members).filter(
      (member) => member.revoked_at === null && member.role === "owner",
    ).length,
  };
}

async function mintBindingsValid(
  tx: Sql,
  auth: AuthContext,
  command: ValidatedCommand,
): Promise<boolean> {
  if (command.kind !== "mint_agent_token" || auth.actor.user === null) return true;
  const devices = await tx<{ user_id: string; revoked_at: Date | null }[]>`
    SELECT user_id, revoked_at
    FROM swarm.devices
    WHERE device_id = ${command.device_id}::uuid
    LIMIT 1
  `;
  const device = devices[0];
  if (
    !device ||
    device.user_id !== auth.actor.user ||
    device.revoked_at !== null
  ) return false;

  const runs = await tx<{
    principal_id: string;
    device_id: string;
    ended_at: Date | null;
  }[]>`
    SELECT principal_id, device_id, ended_at
    FROM swarm.agent_runs
    WHERE run_id = ${command.run_id}::uuid
    LIMIT 1
  `;
  const run = runs[0];
  return !run ||
    (
      run.principal_id === command.principal_id &&
      run.device_id === command.device_id &&
      run.ended_at === null
    );
}

async function prepareWorkspaceCommand(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  wire: ConnectCommand,
  commandId: string,
  headSeq: number,
  now: number,
  /**
   * ★ DEFAULT FALSE, AND THE DEFAULT IS THE SAFETY PROPERTY. Only a RETRY OF THE
   * COMMAND THAT CREATED IT may discard a pending successor.
   *
   * It is tempting to let any renewal heal any pending successor — the reasoning
   * being "if the presenter is back asking again, the response did not arrive".
   * That inference is false, and shipping it broke the one-live-successor
   * invariant in a test that had passed for weeks: three concurrent renewals of
   * one predecessor each found the previous winner's successor still PENDING,
   * each discarded it, and all three were accepted. Two callers walked away
   * holding credentials that had been revoked microseconds later. The server
   * cannot distinguish "response lost" from "response delivered, not yet
   * presented", and resolving that ambiguity by destroying the credential is the
   * wrong direction.
   *
   * The command id resolves it exactly. A caller whose renewal outcome is
   * UNKNOWN reuses its command id (src/cloud/renewal.ts: `replayable ?
   * this.pending.commandId : newRenewalCommandId()`), so a repeat under the same
   * id is that same caller saying "I never got an answer". A concurrent sibling,
   * a second process or another machine carries a DIFFERENT id and is refused
   * `predecessor_superseded`, leaving the real holder's credential alone.
   *
   * So this is set true in exactly one place: the idempotency replay path, when
   * the successor the stored response names is still live and still unused.
   */
  selfHealStranded = false,
): Promise<PreparedWorkspace> {
  const state = await loadWorkspaceState(tx, route);
  let invitationToken: string | null = null;
  let invitationHash: Uint8Array | null = null;
  let agentToken: string | null = null;
  let agentTokenHash: Uint8Array | null = null;
  let lineageId: string | null = null;
  let predecessorTokenId: string | null = null;
  let renewalFacts: RenewalFacts | null = null;
  let command: WorkspaceCommand;

  if (wire.kind === "invite_member") {
    invitationToken = opaqueToken("swm_inv_");
    invitationHash = await sha256(invitationToken);
    command = {
      kind: "invite_member",
      invitation_id: crypto.randomUUID(),
      email: wire.email,
      role: "member",
      token_hash: bytesToHex(invitationHash),
      expires_at: now + (wire.ttl_ms ?? INVITATION_TTL_MS),
    };
  } else if (wire.kind === "accept_invitation") {
    invitationHash = await sha256(wire.token);
    command = {
      kind: "accept_invitation",
      token_hash: bytesToHex(invitationHash),
    };
  } else if (wire.kind === "revoke_invitation") {
    command = {
      kind: "revoke_invitation",
      invitation_id: wire.invitation_id,
    };
  } else if (wire.kind === "create_agent_principal") {
    command = {
      kind: "create_agent_principal",
      principal_id: crypto.randomUUID(),
      name: wire.name,
      model: wire.model ?? null,
    };
  } else if (wire.kind === "remove_member") {
    command = { kind: "remove_member", user_id: wire.user_id };
  } else if (wire.kind === "revoke_agent_principal") {
    command = {
      kind: "revoke_agent_principal",
      principal_id: wire.principal_id,
    };
  } else if (wire.kind === "revoke_agent_token") {
    command = { kind: "revoke_agent_token", token_id: wire.token_id };
  } else if (wire.kind === RENEW_AGENT_TOKEN_KIND) {
    // Every field below is read from the authenticated predecessor row or from
    // the server. `wire` contributes nothing but its kind.
    predecessorTokenId = auth.agent?.token_id ?? null;
    const predecessor = predecessorTokenId === null
      ? undefined
      : state.tokens[predecessorTokenId];
    renewalFacts = predecessorTokenId === null
      ? null
      : await loadRenewalFacts(tx, predecessorTokenId, auth.agentFirstUse);
    if (renewalFacts !== null && !selfHealStranded) {
      renewalFacts = { ...renewalFacts, successor_pending: false };
    }
    agentToken = opaqueToken("swm_agt_");
    agentTokenHash = await sha256(agentToken);
    // The successor stays in the predecessor's lineage: that is what makes a
    // lineage revocation reach every descendant.
    lineageId = auth.agent?.lineage_id ?? null;
    command = {
      kind: "renew_agent_token",
      successor_token_id: crypto.randomUUID(),
      scopes: [...(predecessor?.scopes ?? [])],
    };
  } else if (wire.kind === "mint_agent_token") {
    agentToken = opaqueToken("swm_agt_");
    agentTokenHash = await sha256(agentToken);
    lineageId = crypto.randomUUID();
    command = {
      kind: "mint_agent_token",
      token_id: crypto.randomUUID(),
      principal_id: wire.principal_id,
      run_id: wire.run_id,
      task_id: wire.task_id,
      epoch: wire.epoch,
      scopes: [...(wire.scopes ?? P0_AGENT_SCOPES)],
      ...(wire.ttl_ms === undefined ? {} : { ttl_ms: wire.ttl_ms }),
    };
  } else {
    // Exhaustiveness: every ConnectCommand kind is armed above. Falling into a
    // mint would invent a live credential for an unhandled revoke/other kind.
    const unexpected: never = wire;
    void unexpected;
    throw new Error(
      "prepareWorkspaceCommand has no arm for this workspace kind; refusing mint fallthrough",
    );
  }

  let inviteeAlreadyMember = false;
  if (wire.kind === "invite_member") {
    const rows = await tx<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM swarm.users AS u
        JOIN swarm.memberships AS m
          ON m.user_id = u.user_id
         AND m.workspace_id = ${route.workspaceId}::uuid
         AND m.revoked_at IS NULL
        WHERE lower(u.email) = ${wire.email}
      ) AS present
    `;
    inviteeAlreadyMember = rows[0]?.present ?? false;
  }
  let landingAuthorityChangeResolved = true;
  if (wire.kind === "remove_member") {
    const mappings = await tx<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM swarm.repositories
        WHERE workspace_id = ${route.workspaceId}::uuid
          AND landing_authority_user_id = ${wire.user_id}::uuid
          AND archived_at IS NULL
      ) AS blocked
    `;
    landingAuthorityChangeResolved = !(mappings[0]?.blocked ?? true);
  }

  let nextSeq = headSeq;
  const ctx: WorkspaceDecideCtx = {
    now,
    actor: auth.actor,
    credential_kind: auth.credentialKind === "user" ? "human" : "agent",
    presenting_token_id: auth.agent?.token_id ?? null,
    command_id: commandId,
    workspace_id: route.workspaceId,
    stream_id: route.streamId,
    operatorAllowed: () => false,
    role: (userId) => {
      const member = state.members[userId];
      return member?.revoked_at === null ? member.role : null;
    },
    inviteeAlreadyMember: (email) =>
      wire.kind === "invite_member" &&
      email === wire.email &&
      inviteeAlreadyMember,
    identityVerified: (userId) =>
      userId === auth.actor.user && auth.identityVerified,
    humanRights: () => [...P0_AGENT_SCOPES],
    landingAuthorityChangeResolved: (targetUserId, successorUserId) =>
      wire.kind === "remove_member" &&
        targetUserId === wire.user_id &&
        successorUserId === null
        ? landingAuthorityChangeResolved
        : true,
    // Present only for a renewal that resolved a predecessor. Left undefined
    // otherwise so the reducer refuses `renewal_unsupported` instead of
    // deciding against a fabricated fact.
    ...(renewalFacts === null ? {} : { renewalFacts: () => renewalFacts! }),
    nextSeq: () => ++nextSeq,
    nextEventId: () => crypto.randomUUID(),
  };
  return {
    wire,
    command,
    state,
    ctx,
    invitationToken,
    invitationHash,
    agentToken,
    agentTokenHash,
    lineageId,
    predecessorTokenId,
    renewalFacts,
  };
}

/**
 * Reads the §2.3 renewal facts for a predecessor token. Everything the fence
 * needs is derived from the predecessor ROW — principal and run come off the
 * token, never off the request — so a compromised worker cannot point renewal
 * at another run's grant.
 */
async function loadRenewalFacts(
  tx: Sql,
  predecessorTokenId: string,
  predecessorPending: boolean,
): Promise<RenewalFacts | null> {
  const rows = await tx<{
    renewal_grant_id: string | null;
    max_successors: number | null;
    successors_used: number | null;
    successors_stranded: number | null;
    horizon_expires_at: Date | null;
    grant_revoked_at: Date | null;
    grant_bound_to_token: boolean | null;
    successor_token_id: string | null;
    successor_pending: boolean | null;
    lineage_revoked: boolean;
  }[]>`
    SELECT
      g.renewal_grant_id,
      g.max_successors,
      g.successors_used,
      g.successors_stranded,
      g.horizon_expires_at,
      g.revoked_at AS grant_revoked_at,
      (
        g.principal_id = t.principal_id
        AND g.run_id = t.run_id
      ) AS grant_bound_to_token,
      -- The LIVE successor, if any. Revoked successors are excluded to match
      -- agent_tokens_one_successor_per_predecessor, which is partial on
      -- revoked_at IS NULL: a revoked successor gives the slot back, so it must
      -- not go on reading as a supersession here either.
      (
        SELECT s.token_id
        FROM swarm.agent_tokens AS s
        WHERE s.predecessor_token_id = t.token_id
          AND s.revoked_at IS NULL
        LIMIT 1
      ) AS successor_token_id,
      (
        SELECT s.first_used_at IS NULL
        FROM swarm.agent_tokens AS s
        WHERE s.predecessor_token_id = t.token_id
          AND s.revoked_at IS NULL
        LIMIT 1
      ) AS successor_pending,
      (
        EXISTS (
          SELECT 1
          FROM swarm.agent_tokens AS l
          WHERE l.lineage_id = t.lineage_id
            AND l.revoked_at IS NOT NULL
            -- ...except one this service revoked ITSELF, as housekeeping, for a
            -- successor that never reached anybody. Without this exclusion the
            -- self-healing replacement would poison its own lineage: the first
            -- stranded successor would make every later renewal in the chain
            -- refuse renewal_lineage_revoked, turning the fix into a slower
            -- version of the bug. A revocation an OPERATOR performed carries no
            -- such tombstone and still stops the whole lineage renewing.
            AND NOT EXISTS (
              SELECT 1
              FROM swarm.revocation_tombstones AS sr
              WHERE sr.kind = ${STRANDED_SUCCESSOR_TOMBSTONE}
                AND sr.target_id = l.token_id
            )
        )
        OR EXISTS (
          SELECT 1
          FROM swarm.revocation_tombstones AS r
          WHERE r.target_id = t.lineage_id
            AND r.kind IN ('lineage', 'family')
        )
        OR EXISTS (
          -- The grant tombstone kind the renewal migration introduced.
          -- agent-auth does not probe it per command, so if it is not probed
          -- here the reducer would accept a renewal the database fence then
          -- refuses, and the two would disagree.
          SELECT 1
          FROM swarm.revocation_tombstones AS rg
          WHERE rg.kind = 'renewal_grant'
            AND rg.target_id = t.renewal_grant_id
        )
      ) AS lineage_revoked
    FROM swarm.agent_tokens AS t
    LEFT JOIN swarm.renewal_grants AS g
      ON g.renewal_grant_id = t.renewal_grant_id
    WHERE t.token_id = ${predecessorTokenId}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // The grant is the one the PREDECESSOR ROW names, not one found by searching
  // for the run's most generous. A predecessor that names no grant has none:
  // renewal is authorised at join/spawn or not at all.
  const grant = row.renewal_grant_id === null ||
      row.max_successors === null ||
      row.successors_used === null ||
      row.successors_stranded === null ||
      row.horizon_expires_at === null
    ? null
    : {
      renewal_grant_id: row.renewal_grant_id,
      max_successors: Number(row.max_successors),
      successors_used: Number(row.successors_used),
      successors_stranded: Number(row.successors_stranded),
      horizon_expires_at: millis(row.horizon_expires_at) ?? 0,
      revoked_at: millis(row.grant_revoked_at),
    };
  return {
    grant,
    // A grant bound to a different principal or run cannot authorise this
    // token, however it came to be named on the row.
    grant_mismatch: grant !== null && row.grant_bound_to_token !== true,
    superseded: row.successor_token_id !== null,
    successor_token_id: row.successor_token_id,
    successor_pending: row.successor_pending === true,
    predecessor_pending: predecessorPending,
    lineage_revoked: row.lineage_revoked,
  };
}

/**
 * Ledgered fields for an accepted renewal. The raw successor credential is
 * deliberately absent for the same reason capability tokens are: the ledger is
 * readable by swarm_command, so a replay identifies the successor and its
 * expiry but never re-issues the secret.
 */
function renewalReplayFields(
  prepared: PreparedWorkspace,
  events: readonly EventEnvelope[],
): Record<string, string> {
  const payload = record(events[0]?.payload) ?? {};
  return {
    ...(prepared.command.kind === RENEW_AGENT_TOKEN_KIND
      ? { token_id: prepared.command.successor_token_id }
      : {}),
    ...(typeof payload.principal_id === "string"
      ? { principal_id: payload.principal_id }
      : {}),
    ...(typeof payload.run_id === "string" ? { run_id: payload.run_id } : {}),
    ...(typeof payload.expires_at === "number"
      ? { expires_at: new Date(payload.expires_at).toISOString() }
      : {}),
  };
}

/**
 * The successor a stored renewal response names, IF it was never delivered.
 *
 * "Never delivered" is read as live-and-unused: `revoked_at IS NULL AND
 * first_used_at IS NULL`. Nothing acknowledges delivery, so unused is the only
 * evidence available — which is exactly why the answer is not enough on its own
 * to discard anything, and why the caller pairs it with a matching command id
 * before acting on it. See `selfHealStranded`.
 *
 * Returns null when the response names no token, when the token has been used,
 * or when it is already revoked — all of which mean there is nothing to recover
 * and the ordinary replay is the right answer.
 */
async function strandedSuccessorOf(
  tx: Sql,
  response: unknown,
): Promise<string | null> {
  const tokenId = record(response)?.token_id;
  if (typeof tokenId !== "string" || !UUID_RE.test(tokenId)) return null;
  const rows = await tx<{ token_id: string }[]>`
    SELECT token_id
    FROM swarm.agent_tokens
    WHERE token_id = ${tokenId}::uuid
      AND revoked_at IS NULL
      AND first_used_at IS NULL
      AND predecessor_token_id IS NOT NULL
  `;
  return rows[0]?.token_id ?? null;
}

/**
 * Credits back the grant slot a stranded successor spent, so its replacement is
 * not charged twice. Repeated dropped connections must not be able to eat a
 * run's renewal budget — that would turn a network problem into the human
 * reauthorisation this feature exists to remove.
 *
 * ★ THIS INCREMENTS A SECOND COUNTER; IT DOES NOT DECREMENT THE FIRST. An
 * earlier version ran `successors_used = successors_used - 1` and treated a
 * refusal as best-effort. That decrement CANNOT SUCCEED — swarm
 * .renewal_grants_spend_or_revoke_only() raises SWARM_RENEWAL_COUNTER_REWOUND
 * on any decrement, with no carve-out — so the refund failed on 100% of real
 * invocations, was swallowed, and every stranded retry permanently burned a
 * slot. The default 800-successor budget was drainable inside one predecessor
 * TTL by a worker that simply kept losing responses, which is the exact failure
 * the feature exists to remove. Two independent reviewers found it; it is not a
 * theoretical objection.
 *
 * The fix keeps both counters monotone rather than carving an exemption into
 * the guard. Effective spend is `successors_used - successors_stranded`, and a
 * credit is recorded as something that HAPPENED rather than as an unwinding of
 * something that did not — so there is still no code path anywhere that lowers
 * a number on this table, which is what made the guard worth trusting.
 *
 * NOT best-effort any more, and deliberately so: this must be part of the same
 * atomic outcome as the discard and the replacement. If it could silently fail
 * the accounting would drift from `agent_tokens_successor_fence()`'s ceiling
 * test, and the reducer and the database would once again disagree about who is
 * out of budget. A throw here unwinds the whole renewal savepoint, which is the
 * correct trade: refusing a renewal is recoverable, mis-billing it is not.
 */
async function creditStrandedSlot(
  tx: Sql,
  renewalGrantId: string,
): Promise<void> {
  const credited = await tx<{ renewal_grant_id: string }[]>`
    UPDATE swarm.renewal_grants
    SET successors_stranded = successors_stranded + 1
    WHERE renewal_grant_id = ${renewalGrantId}::uuid
    RETURNING renewal_grant_id
  `;
  // Checking the rowcount, not merely the absence of an exception. The previous
  // version returned `true` whenever no row matched — so its one "success"
  // return was the case where it had changed nothing, and the audit line it
  // produced asserted a refund that never happened.
  if (credited.length !== 1) throw new RenewalFenceLost();
}

/**
 * Discards a successor that was issued but never reached anybody, so the
 * predecessor can be given a fresh one.
 *
 * A pending successor is one with no `first_used_at`: nothing has ever
 * authenticated with it, so the only copy of its raw credential was the
 * response body that never arrived. Revoking it costs nobody anything, and
 * revoking it is what frees the one-successor slot — the unique index is
 * partial on `revoked_at IS NULL`.
 *
 * The tombstone is the durable record of WHY it died. Without a distinct cause
 * this revocation would be indistinguishable from an operator revoking the
 * worker, and `lineage_revoked` would then stop the whole chain renewing.
 *
 * Throws `RenewalFenceLost` when the row is no longer discardable — it was used
 * between the fact read and here, or another transaction got there first. The
 * caller's savepoint unwinds and the race becomes a named refusal, rather than
 * this pressing on into a lineage fork.
 */
async function discardStrandedSuccessor(
  tx: Sql,
  auth: AuthContext,
  prepared: PreparedWorkspace,
  successorTokenId: string,
  predecessorTokenId: string,
  renewalGrantId: string,
  now: number,
): Promise<void> {
  const discarded = await tx<{ token_id: string }[]>`
    UPDATE swarm.agent_tokens
    SET revoked_at = ${new Date(now)}
    WHERE token_id = ${successorTokenId}::uuid
      AND predecessor_token_id = ${predecessorTokenId}::uuid
      AND revoked_at IS NULL
      AND first_used_at IS NULL
    RETURNING token_id
  `;
  // Re-checking `first_used_at IS NULL` in the UPDATE, not trusting the fact
  // read earlier in the transaction: between that read and here the successor
  // may have authenticated somewhere else, at which point somebody DOES hold it
  // and discarding it would take a working agent down.
  if (discarded.length !== 1) throw new RenewalFenceLost();
  await tx`
    INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
    VALUES (
      ${STRANDED_SUCCESSOR_TOMBSTONE},
      ${successorTokenId}::uuid,
      ${auth.actor.user}::uuid
    )
    ON CONFLICT (kind, target_id) DO NOTHING
  `;
  await creditStrandedSlot(tx, renewalGrantId);
  await insertAudit(tx, {
    auth,
    commandKind: RENEW_AGENT_TOKEN_KIND,
    workspaceId: prepared.ctx.workspace_id,
    streamId: prepared.ctx.stream_id,
    outcome: "self_healed",
    reason: "stranded_successor_discarded",
    // No conditional "was the slot refunded" clause any more. The credit either
    // happened or this function threw, so a detail line that hedged about it
    // would be describing a state that cannot reach here. The token id is what
    // makes this row correlatable to the tombstone.
    detail:
      `successor ${successorTokenId} was issued but never used; discarded and replaced, grant slot credited back`,
  });
}

/**
 * The atomic half of §2.3 renewal: issue the successor and consume one grant
 * slot, or do neither. It runs inside a savepoint, so a lost race leaves no
 * partial effect — without it a failed slot CAS would still have discarded a
 * stranded successor while issuing nothing in its place.
 *
 * Two concurrent renewals of the same predecessor are serialised by the partial
 * UNIQUE index on `predecessor_token_id`: the loser fails 23505, re-reads state
 * and is refused `predecessor_superseded` rather than forking the lineage.
 */
async function fenceRenewal(
  tx: Sql,
  prepared: PreparedWorkspace,
  auth: AuthContext,
  events: readonly EventEnvelope[],
  now: number,
): Promise<boolean> {
  if (prepared.command.kind !== "renew_agent_token") return true;
  const grant = prepared.renewalFacts?.grant ?? null;
  const predecessorTokenId = prepared.predecessorTokenId;
  const payload = record(events[0]?.payload);
  // The reducer already refused, so there is nothing to fence.
  if (
    grant === null ||
    predecessorTokenId === null ||
    prepared.agentTokenHash === null ||
    prepared.lineageId === null ||
    payload === null
  ) return true;
  const successorId = prepared.command.successor_token_id;
  const expiresAt = typeof payload.expires_at === "number"
    ? new Date(payload.expires_at)
    : null;
  if (expiresAt === null) throw new Error("renewal event carries no expiry");

  // A live successor that has never been used is the stranded one this renewal
  // exists to replace: the reducer only reached `accept` because of that. It
  // must go before the insert — it holds the one-successor slot until it is
  // revoked.
  const strandedSuccessorId = prepared.renewalFacts?.successor_pending === true
    ? prepared.renewalFacts.successor_token_id
    : null;

  try {
    return await tx.savepoint(async (sp) => {
      if (strandedSuccessorId !== null) {
        await discardStrandedSuccessor(
          sp,
          auth,
          prepared,
          strandedSuccessorId,
          predecessorTokenId,
          grant.renewal_grant_id,
          now,
        );
      }
      // Not "insert a token": this statement IS the fence. Everything the
      // reducer just checked is re-checked by agent_tokens_successor_fence()
      // against the predecessor ROW, and the grant slot is spent by that same
      // trigger — deliberately NOT here, because an issued-but-uncounted
      // successor would be one lost transaction away. The partial UNIQUE index
      // on predecessor_token_id is the CAS: a concurrent second renewal of the
      // same predecessor fails 23505 rather than forking the lineage.
      await sp`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, task_id, epoch,
          scopes, token_hash, expires_at, lineage_id,
          predecessor_token_id, renewal_grant_id
        ) VALUES (
          ${successorId}::uuid,
          ${String(payload.principal_id)}::uuid,
          ${String(payload.run_id)}::uuid,
          ${String(payload.task_id)}::uuid,
          ${Number(payload.epoch)},
          ${tx.json((payload.scopes ?? []) as postgres.JSONValue)}::jsonb,
          ${prepared.agentTokenHash},
          ${expiresAt},
          ${prepared.lineageId}::uuid,
          ${predecessorTokenId}::uuid,
          ${grant.renewal_grant_id}::uuid
        )
      `;
      /* ★ THE PREDECESSOR IS NOT SUPERSEDED HERE ANY MORE. IT MOVED; IT WAS NOT DROPPED.
         Do not restore this as an obvious omission — the omission is the fix.

         What used to be on this line: `UPDATE agent_tokens SET expires_at = now WHERE
         token_id = predecessor`, with a comment explaining it had to come AFTER the insert
         because the database fence refuses an expired predecessor, so ending it first would
         refuse the very successor it was being ended for. THAT ORDERING ARGUMENT IS STILL
         TRUE and still constrains anyone who moves supersession back to issue time. It is
         simply no longer the shape of the code, because supersession now happens at the
         successor's FIRST USE (authenticateAgent, in the same statement that stamps
         first_used_at).

         WHY IT MOVED. Superseding at issue time strands the worker permanently whenever a
         renewal COMMITS and then loses its HTTP response — a dropped connection, or a 5xx
         after commit. The successor row existed, the predecessor was already ended, a grant
         slot was spent, and the raw successor credential lived ONLY in the response body
         that never arrived. The idempotency replay deliberately stores ids and expiry and
         never the secret (renewalReplayFields), so replaying the same command_id returned a
         body with no agent_token and the client correctly refused to invent one. Net: a
         live successor nobody could reach, an agent that stops, and a human
         reauthorisation caused by a network blip — the exact failure renewal exists to
         remove. Two reviewers split on it and both were reading the code correctly:
         fail-closed is the right SAFETY behaviour and the wrong AVAILABILITY outcome, and
         here availability is the point.

         The fix is NOT to store the raw successor anywhere at rest. It stays in exactly one
         response and nowhere else. Instead a successor is PENDING until something
         authenticates with it; a pending successor is held by nobody and is therefore
         disposable, so a renewal that finds one discards it and issues a fresh one
         (discardStrandedSuccessor, above). The predecessor stays live until the handover is
         KNOWN to have completed, which is what makes the lost response recoverable.

         The cost is a deliberate, bounded overlap: between issue and first use both
         credentials are live, for at most the predecessor's remaining TTL (<= 1h). It is
         kept from extending by `predecessor_pending_first_use` in the reducer — a token
         that has never been used may not itself renew, so unused tokens cannot chain. */
      return true;
    });
  } catch (error) {
    // 23505 is the lineage-fork CAS losing; 55000 is any named refusal raised
    // by the successor fence; 40P01 is the documented renewal-vs-revocation
    // deadlock, which the migration says must resolve toward refusal. All three
    // roll back to the savepoint, leaving the transaction usable so the caller
    // can re-read state and turn the race into a named domain refusal.
    const code = dbCode(error);
    if (
      error instanceof RenewalFenceLost ||
      code === "23505" || code === "55000" || code === "40P01"
    ) return false;
    throw error;
  }
}

async function appendEvents(
  tx: Sql,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    await tx`
      INSERT INTO swarm.events (
        workspace_id, stream_id, seq, event_id, command_id,
        type, schema_version,
        actor_user, actor_agent_principal, actor_run,
        occurred_at_server, payload
      ) VALUES (
        ${event.workspace_id}::uuid,
        ${event.stream_id}::uuid,
        ${event.seq},
        ${event.event_id}::uuid,
        ${event.command_id},
        ${event.type},
        ${event.schema_version},
        ${event.actor_user}::uuid,
        ${event.actor_agent_principal}::uuid,
        ${event.actor_run}::uuid,
        ${new Date(event.occurred_at_server)},
        ${tx.json(event.payload as postgres.JSONValue)}::jsonb
      )
    `;
  }
}

async function updateProjection(
  tx: Sql,
  route: Route,
  prior: TaskState | null,
  priorUpdatedAt: Date | null,
  events: readonly EventEnvelope[],
  now: number,
): Promise<TaskState | null> {
  let projection = prior;
  for (const event of events) {
    if (projection === null && event.type === "CommandRejected") continue;
    projection = reduceTask(projection, event);
  }
  if (projection === null) return null;

  const updatedAt = projection === prior && priorUpdatedAt !== null
    ? priorUpdatedAt
    : new Date(now);
  await tx`
    INSERT INTO swarm.tasks (
      workspace_id, stream_id, task_id, slug, lifecycle,
      version, epoch, owner, lease_expiry, submission,
      closed_disposition, updated_at
    ) VALUES (
      ${route.workspaceId}::uuid,
      ${route.streamId}::uuid,
      ${projection.task_id}::uuid,
      ${projection.slug},
      ${projection.lifecycle},
      ${projection.version},
      ${projection.epoch},
      ${projection.owner},
      ${
    projection.lease_expiry === null ? null : new Date(projection.lease_expiry)
  },
      ${
    projection.submission === null
      ? null
      : tx.json(projection.submission as postgres.JSONValue)
  }::jsonb,
      ${projection.closed_disposition},
      ${updatedAt}
    )
    ON CONFLICT (stream_id, task_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      slug = EXCLUDED.slug,
      lifecycle = EXCLUDED.lifecycle,
      version = EXCLUDED.version,
      epoch = EXCLUDED.epoch,
      owner = EXCLUDED.owner,
      lease_expiry = EXCLUDED.lease_expiry,
      submission = EXCLUDED.submission,
      closed_disposition = EXCLUDED.closed_disposition,
      updated_at = EXCLUDED.updated_at
  `;

  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (
      event.type === "LeaseAcquired" ||
      event.type === "LeaseHandedOff" ||
      event.type === "LeaseTakenOver"
    ) {
      await tx`
        UPDATE swarm.leases
        SET ended_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND ended_at IS NULL
      `;
      const owner = event.type === "LeaseHandedOff"
        ? String(payload.to_owner)
        : String(payload.owner);
      await tx`
        INSERT INTO swarm.leases (
          stream_id, task_id, epoch, owner,
          acquired_at, lease_expiry, ended_at
        ) VALUES (
          ${route.streamId}::uuid,
          ${projection.task_id}::uuid,
          ${Number(payload.epoch)},
          ${owner},
          ${new Date(event.occurred_at_server)},
          ${new Date(Number(payload.lease_expiry))},
          NULL
        )
      `;
    } else if (event.type === "LeaseRenewed") {
      await tx`
        UPDATE swarm.leases
        SET lease_expiry = ${new Date(Number(payload.lease_expiry))}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND epoch = ${Number(payload.epoch)}
          AND ended_at IS NULL
      `;
    } else if (event.type === "TaskClosed" || event.type === "TaskReopened") {
      await tx`
        UPDATE swarm.leases
        SET ended_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${projection.task_id}::uuid
          AND ended_at IS NULL
      `;
    }
  }
  return projection;
}

async function consumeInvitation(
  tx: Sql,
  prepared: PreparedWorkspace,
  auth: AuthContext,
  now: number,
): Promise<boolean> {
  if (
    prepared.command.kind !== "accept_invitation" ||
    prepared.invitationHash === null ||
    auth.actor.user === null
  ) return true;
  const rows = await tx<{ invitation_id: string }[]>`
    UPDATE swarm.invitations
    SET
      consumed_at = ${new Date(now)},
      consumed_by = ${auth.actor.user}::uuid
    WHERE token_hash = ${prepared.invitationHash}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > statement_timestamp()
    RETURNING invitation_id
  `;
  return rows.length === 1;
}

async function updateWorkspaceProjection(
  tx: Sql,
  route: Route,
  prepared: PreparedWorkspace,
  events: readonly EventEnvelope[],
): Promise<WorkspaceState> {
  let projection = prepared.state;
  for (const event of events) {
    projection = reduceWorkspace(projection, event) as WorkspaceState;
  }

  for (const event of events) {
    const payload = record(event.payload);
    if (!payload || event.type === "CommandRejected") continue;

    if (event.type === "MemberInvited") {
      const invitation = projection.invitations[String(payload.invitation_id)];
      if (!invitation) throw new Error("folded invitation projection missing");
      await tx`
        INSERT INTO swarm.invitations (
          invitation_id, workspace_id, email, role, token_hash,
          expires_at, created_by, created_at,
          consumed_at, consumed_by, revoked_at
        ) VALUES (
          ${invitation.invitation_id}::uuid,
          ${route.workspaceId}::uuid,
          ${invitation.email},
          ${invitation.role},
          ${hexToBytes(invitation.token_hash)},
          ${new Date(invitation.expires_at)},
          ${invitation.created_by}::uuid,
          ${new Date(invitation.created_at)},
          NULL,
          NULL,
          NULL
        )
      `;
    } else if (event.type === "InvitationRevoked") {
      if (
        typeof payload.invitation_id !== "string" ||
        typeof payload.revoked_at !== "number"
      ) {
        throw new Error("InvitationRevoked payload is malformed");
      }
      const updated = await tx<{ invitation_id: string }[]>`
        UPDATE swarm.invitations
        SET revoked_at = ${new Date(payload.revoked_at)}
        WHERE invitation_id = ${payload.invitation_id}::uuid
          AND workspace_id = ${route.workspaceId}::uuid
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING invitation_id
      `;
      if (updated.length !== 1) {
        throw new Error("InvitationRevoked projection did not revoke exactly one invitation");
      }
    } else if (event.type === "MemberJoined") {
      const member = projection.members[String(payload.user_id)];
      if (!member) throw new Error("folded member projection missing");
      await tx`
        INSERT INTO swarm.memberships (
          workspace_id, user_id, role, invited_by, joined_at, revoked_at
        ) VALUES (
          ${route.workspaceId}::uuid,
          ${member.user_id}::uuid,
          ${member.role},
          ${member.invited_by}::uuid,
          ${new Date(member.joined_at)},
          NULL
        )
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
          role = EXCLUDED.role,
          invited_by = EXCLUDED.invited_by,
          joined_at = EXCLUDED.joined_at,
          revoked_at = NULL
      `;
    } else if (event.type === "MemberRemoved") {
      if (
        typeof payload.user_id !== "string" ||
        typeof payload.revoked_at !== "number"
      ) {
        throw new Error("MemberRemoved payload is malformed");
      }
      const updated = await tx<{ user_id: string }[]>`
        UPDATE swarm.memberships
        SET revoked_at = ${new Date(payload.revoked_at)}
        WHERE workspace_id = ${route.workspaceId}::uuid
          AND user_id = ${payload.user_id}::uuid
          AND revoked_at IS NULL
        RETURNING user_id
      `;
      if (updated.length !== 1) {
        throw new Error("MemberRemoved projection did not revoke exactly one membership");
      }
    } else if (event.type === "AgentPrincipalCreated") {
      const principal = projection.principals[String(payload.principal_id)];
      if (!principal) throw new Error("folded principal projection missing");
      await tx`
        INSERT INTO swarm.agent_principals (
          principal_id, workspace_id, owner_user_id, name, model, created_at, revoked_at
        ) VALUES (
          ${principal.principal_id}::uuid,
          ${route.workspaceId}::uuid,
          ${principal.owner_user_id}::uuid,
          ${principal.name},
          ${principal.model},
          ${new Date(principal.created_at)},
          NULL
        )
      `;
    } else if (event.type === "AgentPrincipalRevoked") {
      // One canonical event, one atomic projection: principal stamp + principal
      // tombstone + every live token + distinct lineage tombstones + grant
      // revocation. Descendants fail closed on the next command and on renewal.
      if (
        typeof payload.principal_id !== "string" ||
        typeof payload.revoked_at !== "number"
      ) {
        throw new Error("AgentPrincipalRevoked payload is malformed");
      }
      const principalId = payload.principal_id;
      const revokedAt = new Date(payload.revoked_at);
      const createdBy = authUser(prepared.ctx.actor);
      const updated = await tx<{ principal_id: string }[]>`
        UPDATE swarm.agent_principals
        SET revoked_at = ${revokedAt}
        WHERE principal_id = ${principalId}::uuid
          AND workspace_id = ${route.workspaceId}::uuid
          AND revoked_at IS NULL
        RETURNING principal_id
      `;
      if (updated.length !== 1) {
        throw new Error(
          "AgentPrincipalRevoked projection did not revoke exactly one principal",
        );
      }
      await tx`
        INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
        VALUES (
          'principal',
          ${principalId}::uuid,
          ${createdBy}::uuid
        )
        ON CONFLICT (kind, target_id) DO NOTHING
      `;
      const liveTokens = await tx<{ token_id: string; lineage_id: string }[]>`
        SELECT token_id, lineage_id
        FROM swarm.agent_tokens
        WHERE principal_id = ${principalId}::uuid
          AND revoked_at IS NULL
      `;
      await tx`
        UPDATE swarm.agent_tokens
        SET revoked_at = ${revokedAt}
        WHERE principal_id = ${principalId}::uuid
          AND revoked_at IS NULL
      `;
      for (const token of liveTokens) {
        await tx`
          INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
          VALUES (
            'token',
            ${token.token_id}::uuid,
            ${createdBy}::uuid
          )
          ON CONFLICT (kind, target_id) DO NOTHING
        `;
      }
      const lineageIds = [...new Set(liveTokens.map((row) => row.lineage_id))];
      for (const lineageId of lineageIds) {
        await tx`
          INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
          VALUES (
            'lineage',
            ${lineageId}::uuid,
            ${createdBy}::uuid
          )
          ON CONFLICT (kind, target_id) DO NOTHING
        `;
      }
      // Grant revoke is paired (revoked_at, revoked_by); the cascade trigger
      // tombstones the grant and stamps any residual tokens.
      if (createdBy !== null) {
        await tx`
          UPDATE swarm.renewal_grants
          SET revoked_at = ${revokedAt},
              revoked_by = ${createdBy}::uuid
          WHERE principal_id = ${principalId}::uuid
            AND workspace_id = ${route.workspaceId}::uuid
            AND revoked_at IS NULL
        `;
      } else {
        await tx`
          UPDATE swarm.renewal_grants
          SET revoked_at = ${revokedAt},
              revoked_by = (
                SELECT owner_user_id
                FROM swarm.agent_principals
                WHERE principal_id = ${principalId}::uuid
              )
          WHERE principal_id = ${principalId}::uuid
            AND workspace_id = ${route.workspaceId}::uuid
            AND revoked_at IS NULL
        `;
      }
    } else if (event.type === "AgentTokenRevoked") {
      if (
        typeof payload.token_id !== "string" ||
        typeof payload.revoked_at !== "number"
      ) {
        throw new Error("AgentTokenRevoked payload is malformed");
      }
      const tokenId = payload.token_id;
      const revokedAt = new Date(payload.revoked_at);
      const createdBy = authUser(prepared.ctx.actor);
      const revoked = await tx<{ token_id: string; lineage_id: string }[]>`
        UPDATE swarm.agent_tokens
        SET revoked_at = ${revokedAt}
        WHERE token_id = ${tokenId}::uuid
          AND revoked_at IS NULL
          AND principal_id IN (
            SELECT principal_id
            FROM swarm.agent_principals
            WHERE workspace_id = ${route.workspaceId}::uuid
          )
        RETURNING token_id, lineage_id
      `;
      if (revoked.length !== 1) {
        throw new Error(
          "AgentTokenRevoked projection did not revoke exactly one token",
        );
      }
      const lineageId = revoked[0]!.lineage_id;
      await tx`
        INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
        VALUES (
          'token',
          ${tokenId}::uuid,
          ${createdBy}::uuid
        )
        ON CONFLICT (kind, target_id) DO NOTHING
      `;
      // Distinct lineage tombstone so successors and renewals fail closed even
      // when only this one token was named.
      await tx`
        INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
        VALUES (
          'lineage',
          ${lineageId}::uuid,
          ${createdBy}::uuid
        )
        ON CONFLICT (kind, target_id) DO NOTHING
      `;
    } else if (
      event.type === "AgentTokenMinted" &&
      prepared.wire.kind === RENEW_AGENT_TOKEN_KIND
    ) {
      // The successor ROW was already written by fenceRenewal, which had to run
      // before the decision was final so a lost race could become a named
      // refusal instead of a 500. Writing it again here would be a second
      // insert of the same token; the fold above is all that is left to do.
      const token = projection.tokens[String(payload.token_id)];
      if (!token || token.task_id === null || token.epoch === null) {
        throw new Error("folded successor projection missing narrow binding");
      }
    } else if (event.type === "AgentTokenMinted") {
      if (
        prepared.wire.kind !== "mint_agent_token" ||
        prepared.agentTokenHash === null ||
        prepared.lineageId === null ||
        authUser(prepared.ctx.actor) === null
      ) {
        throw new Error("token mint side-effect material missing");
      }
      const token = projection.tokens[String(payload.token_id)];
      if (!token || token.task_id === null || token.epoch === null) {
        throw new Error("folded token projection missing narrow binding");
      }
      const userId = authUser(prepared.ctx.actor)!;
      const devices = await tx<{ user_id: string }[]>`
        SELECT user_id
        FROM swarm.devices
        WHERE device_id = ${prepared.wire.device_id}::uuid
          AND revoked_at IS NULL
      `;
      if (devices[0]?.user_id !== userId) {
        throw new Error("authenticated device ownership changed during mint");
      }
      await tx`
        INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (
          ${token.run_id}::uuid,
          ${token.principal_id}::uuid,
          ${prepared.wire.device_id}::uuid
        )
        ON CONFLICT (run_id) DO NOTHING
      `;
      const runs = await tx<{
        principal_id: string;
        device_id: string;
        ended_at: Date | null;
      }[]>`
        SELECT principal_id, device_id, ended_at
        FROM swarm.agent_runs
        WHERE run_id = ${token.run_id}::uuid
      `;
      const run = runs[0];
      if (
        !run ||
        run.principal_id !== token.principal_id ||
        run.device_id !== prepared.wire.device_id ||
        run.ended_at !== null
      ) {
        throw new Error("agent run binding changed during mint");
      }

      /* ★ THE RENEWAL GRANT IS CREATED HERE, IN THE SAME TRANSACTION AS THE TOKEN, AND THAT
       * PLACEMENT IS THE WHOLE FIX.
       *
       * §2.3 says renewal is "authorized only by a bounded renewal grant created at human
       * join/spawn". A first pass implemented that as a SEPARATE create_renewal_grant
       * command the client sent before minting — and the server never implemented it. The
       * type existed only in src/cloud/command-client.ts, the client treated refusal as
       * "never worth failing the mint over", so it failed silently, every root token got
       * renewal_grant_id NULL, and the successor fence refuses exactly that. The entire
       * renewal path was built, tested, and unreachable.
       *
       * That is the SECOND time this codebase has shipped a gate on a door with no corridor
       * — create_workspace lived in the reducer with no wire kind for the same reason. The
       * structural answer is not another command to remember: a token that cannot renew is
       * useless for a session lasting days, so the grant is not optional and is therefore
       * not a separate step. Mint one, get one, atomically. There is nothing left to forget.
       *
       * created_by is the HUMAN who minted — minting is human-interactive-credential-only,
       * so this is the "authorising human" the grant column means, and it is what a later
       * human reauthorisation at the horizon is measured against. */
      const grantId = crypto.randomUUID();
      /* Measured from the token's own issued_at rather than a wall clock read here, so the
         grant and the credential it authorises start from the same instant — a horizon that
         drifts from its token by even a few milliseconds is a boundary two clocks disagree
         about, and this one decides when a human is asked to reauthorise. */
      const horizonExpiresAt = new Date(
        token.issued_at + RENEWAL_HORIZON_DEFAULT_MS,
      ).toISOString();
      await tx`
        INSERT INTO swarm.renewal_grants (
          renewal_grant_id, workspace_id, principal_id, run_id,
          max_successors, successors_used, horizon_expires_at, created_by
        ) VALUES (
          ${grantId}::uuid,
          ${route.workspaceId}::uuid,
          ${token.principal_id}::uuid,
          ${token.run_id}::uuid,
          ${RENEWAL_MAX_SUCCESSORS_DEFAULT},
          0,
          ${horizonExpiresAt},
          (
            SELECT p.owner_user_id
            FROM swarm.agent_principals AS p
            WHERE p.principal_id = ${token.principal_id}::uuid
          )
        )
      `;

      await tx`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, task_id, epoch,
          scopes, token_hash, issued_at, expires_at, lineage_id,
          renewal_grant_id
        ) VALUES (
          ${token.token_id}::uuid,
          ${token.principal_id}::uuid,
          ${token.run_id}::uuid,
          ${token.task_id}::uuid,
          ${token.epoch},
          ${tx.json(token.scopes)}::jsonb,
          ${prepared.agentTokenHash},
          ${new Date(token.issued_at)},
          ${new Date(token.expires_at)},
          ${prepared.lineageId}::uuid,
          ${grantId}::uuid
        )
      `;
    }
  }
  return projection;
}

function authUser(actor: Actor): string | null {
  return actor.user;
}

async function applyEventSideEffects(
  tx: Sql,
  events: readonly EventEnvelope[],
): Promise<void> {
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (
      (event.type === "TaskClosed" || event.type === "LeaseTakenOver") &&
      typeof payload.grant_id === "string"
    ) {
      await tx`
        INSERT INTO swarm.grant_consumptions (
          grant_id, consumed_at, command_id, event_id
        ) VALUES (
          ${payload.grant_id}::uuid,
          ${new Date(event.occurred_at_server)},
          ${event.command_id},
          ${event.event_id}::uuid
        )
      `;
    }
    if (event.type === "TaskReopened" && typeof payload.task_id === "string") {
      await tx`
        UPDATE swarm.grants
        SET revoked_at = ${new Date(event.occurred_at_server)}
        WHERE stream_id = ${event.stream_id}::uuid
          AND task_id = ${payload.task_id}::uuid
          AND revoked_at IS NULL
      `;
    }
  }
}

async function registerLoginDevice(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const command = record(body.command);
  const valid = auth.credentialKind === "user" &&
    auth.actor.user !== null &&
    auth.identityVerified &&
    body.workspace_id === undefined &&
    body.stream === undefined &&
    typeof body.client_version === "string" &&
    command !== null &&
    exactKeys(command, ["kind", "device_id", "label"]) &&
    command.kind === REGISTER_DEVICE_KIND &&
    typeof command.device_id === "string" &&
    UUID_RE.test(command.device_id) &&
    boundedText(command.label, 80);
  if (!valid) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: auth.credentialKind === "user" ? "validation" : "authz",
      reason: auth.credentialKind === "user" ? "invalid_request" : "forbidden",
      detail: ignoredIdentity,
    });
    return auth.credentialKind === "user"
      ? { status: 400, body: { error: "invalid_request" } }
      : { status: 403, body: { error: "forbidden" } };
  }

  const configRows = await tx<{ value: unknown }[]>`
    SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
  `;
  const minClientVersion = configRows[0]?.value;
  if (
    typeof minClientVersion !== "string" ||
    compareSemver(body.client_version as string, minClientVersion) === null
  ) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "validation",
      reason: "invalid client_version",
      detail: ignoredIdentity,
    });
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (compareSemver(body.client_version as string, minClientVersion)! < 0) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "validation",
      reason: "client_unsupported",
      detail: ignoredIdentity,
    });
    return {
      status: 426,
      body: { error: "upgrade_required", min_client_version: minClientVersion },
    };
  }

  const deviceId = command!.device_id as string;
  const label = command!.label as string;
  await tx`
    INSERT INTO swarm.devices (device_id, user_id, label, last_seen_at)
    VALUES (
      ${deviceId}::uuid,
      ${auth.actor.user}::uuid,
      ${label},
      statement_timestamp()
    )
    ON CONFLICT (device_id) DO NOTHING
  `;
  const devices = await tx<{ user_id: string; revoked_at: Date | null }[]>`
    SELECT user_id, revoked_at
    FROM swarm.devices
    WHERE device_id = ${deviceId}::uuid
    FOR UPDATE
  `;
  const device = devices[0];
  if (
    !device ||
    device.user_id !== auth.actor.user ||
    device.revoked_at !== null
  ) {
    await insertAudit(tx, {
      auth,
      commandKind: REGISTER_DEVICE_KIND,
      outcome: "authz",
      reason: "forbidden",
      detail: ignoredIdentity,
    });
    return { status: 403, body: { error: "forbidden" } };
  }
  await tx`
    UPDATE swarm.devices
    SET label = ${label}, last_seen_at = statement_timestamp()
    WHERE device_id = ${deviceId}::uuid
      AND user_id = ${auth.actor.user}::uuid
      AND revoked_at IS NULL
  `;
  await insertAudit(tx, {
    auth,
    commandKind: REGISTER_DEVICE_KIND,
    outcome: "accepted",
    reason: null,
    detail: ignoredIdentity,
  });
  return {
    status: 200,
    body: {
      status: "accepted",
      ok: true,
      event_ids: [],
      device_id: deviceId,
      min_client_version: minClientVersion,
    },
  };
}

/**
 * Creates a workspace for a caller who belongs to nothing yet — the one command
 * that cannot resolve a route, because the tenant it addresses does not exist.
 * That is why it short-circuits ahead of resolveRoute, exactly as
 * registerLoginDevice does, rather than threading through the routed path whose
 * idempotency key is itself (workspace_id, stream_id).
 *
 * It deliberately appends NO WorkspaceCreated event. seedDogfood has never
 * written one, so every workspace in production today starts at head_seq 0 with
 * an empty stream; emitting one here would give self-serve tenants a different
 * shape from every tenant that already exists.
 */
async function createSelfServeWorkspace(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const forbid = async (reason: string): Promise<HttpResult> => {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "authz",
      reason,
      detail: ignoredIdentity,
    });
    return { status: 403, body: { error: "forbidden" } };
  };

  // Order matters: the feature gate answers first, so that while self-serve is
  // dark the response cannot be used to probe whether an identity is verified.
  if (!selfServeEnabled) return await forbid("self_serve_disabled");
  if (auth.credentialKind !== "user" || auth.actor.user === null) {
    return await forbid("credential_kind_forbidden");
  }

  /* ★ PAST THIS POINT THE REFUSAL IS ACTIONABLE, AND HIDING IT COSTS THE USER WITHOUT
   * BUYING ANY SECRECY.
   *
   * These two used to answer with the same opaque `forbidden` as everything above. That was
   * over-applying the uniform-response rule. Uniformity exists to stop a STRANGER learning
   * about someone ELSE — whether an account exists, whether a workspace is real. Neither
   * applies here: the feature gate has already passed, the caller holds a human interactive
   * credential, and the only fact being disclosed is the state of THEIR OWN account, which
   * they are authenticated as and could read from their profile anyway.
   *
   * What the silence actually produced was a dead end. Someone signs in with GitHub, presses
   * the one button on the page, and gets "not allowed" with no way to tell whether the
   * product is closed, their account is wrong, or they did something. The fix — confirm your
   * email — is thirty seconds away and we were not telling them it existed.
   *
   * The audit reasons are unchanged, so nothing is lost for investigation; only the caller's
   * copy improves. Ordering still matters: both remain BELOW the feature gate, so while
   * self-serve is dark the response stays uniform and reveals nothing at all. */
  if (!auth.identityVerified) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "authz",
      reason: "identity_not_verified",
      detail: ignoredIdentity,
    });
    return { status: 403, body: { error: "email_not_verified" } };
  }
  // A speed bump, not a security control (see DISPOSABLE_EMAIL_DOMAINS). It
  // sits behind the verification gate so it can never be the only thing
  // standing between a stranger and a tenant.
  if (disposableEmailDomain(auth.email)) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "authz",
      reason: "disposable_email_domain",
      detail: ignoredIdentity,
    });
    return { status: 403, body: { error: "email_domain_not_accepted" } };
  }

  const command = record(body.command);
  const valid = body.workspace_id === undefined &&
    body.stream === undefined &&
    typeof body.client_version === "string" &&
    command !== null &&
    exactKeys(command, ["kind", "workspace_id", "name"]) &&
    command.kind === CREATE_WORKSPACE_KIND &&
    typeof command.workspace_id === "string" &&
    UUID_RE.test(command.workspace_id) &&
    boundedText(command.name, 80);
  if (!valid) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "validation",
      reason: "invalid_request",
      detail: ignoredIdentity,
    });
    return { status: 400, body: { error: "invalid_request" } };
  }

  const configRows = await tx<{ value: unknown }[]>`
    SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
  `;
  const minClientVersion = configRows[0]?.value;
  if (
    typeof minClientVersion !== "string" ||
    compareSemver(body.client_version as string, minClientVersion) === null
  ) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "validation",
      reason: "invalid client_version",
      detail: ignoredIdentity,
    });
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (compareSemver(body.client_version as string, minClientVersion)! < 0) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "validation",
      reason: "client_unsupported",
      detail: ignoredIdentity,
    });
    return {
      status: 426,
      body: { error: "upgrade_required", min_client_version: minClientVersion },
    };
  }

  const workspaceId = command!.workspace_id as string;
  const name = command!.name as string;

  // §8's degraded mode. Refused here — with its own audit reason, never a
  // per-identity one — because the caller has done nothing wrong and their own
  // budget is untouched: the service is paused, and the log must say so.
  const breaker = await enforceSpendBreaker(tx, auth, ignoredIdentity);
  if (breaker !== null) return breaker;

  // Counted inside the transaction and against created_by, so two concurrent
  // requests cannot both read limit-1. Archived workspaces free their slot.
  const countRows = await tx<{ live: string }[]>`
    SELECT count(*)::text AS live
    FROM swarm.workspaces
    WHERE created_by = ${auth.actor.user}::uuid
      AND archived_at IS NULL
  `;
  if (Number(countRows[0]?.live ?? "0") >= FREE_TIER_WORKSPACE_LIMIT) {
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "authz",
      reason: "workspace_limit_reached",
      detail: ignoredIdentity,
    });
    return {
      status: 403,
      body: {
        error: "workspace_limit_reached",
        limit: FREE_TIER_WORKSPACE_LIMIT,
      },
    };
  }

  // The live cap above counts tenants that exist now; this counts creations,
  // so archive-and-recreate churn is bounded too. Counted from the workspaces
  // rows themselves rather than swarm.rate_buckets — see enforceFreeTierBudget
  // for why a daily window cannot live in that table.
  const madeRows = await tx<{ made: string; resets_at: Date | null }[]>`
    SELECT
      count(*)::text AS made,
      min(created_at) + interval '24 hours' AS resets_at
    FROM swarm.workspaces
    WHERE created_by = ${auth.actor.user}::uuid
      AND created_at > statement_timestamp() - interval '24 hours'
  `;
  if (Number(madeRows[0]?.made ?? "0") >= SELF_SERVE_CREATE_DAILY_LIMIT) {
    const resetsAt = (madeRows[0]?.resets_at ?? new Date()).toISOString();
    const detail =
      `identity limit ${SELF_SERVE_CREATE_DAILY_LIMIT} workspaces/day; resets at ${resetsAt}`;
    await insertAudit(tx, {
      auth,
      commandKind: CREATE_WORKSPACE_KIND,
      outcome: "rate_limit",
      reason: "workspace_create_rate_limited",
      detail,
    });
    await tx`
      INSERT INTO swarm.security_alerts (kind, subject, detail)
      VALUES (
        'workspace_create_rate_limit',
        'identity',
        ${tx.json({
          user_id: auth.actor.user,
          limit: SELF_SERVE_CREATE_DAILY_LIMIT,
          resets_at: resetsAt,
        })}::jsonb
      )
    `;
    return {
      status: 429,
      body: {
        error: "rate_limited",
        message: `Workspace creation refused: ${detail}.`,
        limit: SELF_SERVE_CREATE_DAILY_LIMIT,
        resets_at: resetsAt,
      },
    };
  }

  await tx`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES (${workspaceId}::uuid, ${name}, ${auth.actor.user}::uuid)
    ON CONFLICT (workspace_id) DO NOTHING
  `;
  // A client-proposed id that is already taken must not silently hand the
  // caller someone else's tenant — the same guard seedDogfood applies.
  const owned = await tx<{ created_by: string }[]>`
    SELECT created_by
    FROM swarm.workspaces
    WHERE workspace_id = ${workspaceId}::uuid
  `;
  if (owned[0]?.created_by !== auth.actor.user) {
    return await forbid("workspace_id_taken");
  }
  await tx`
    INSERT INTO swarm.memberships (workspace_id, user_id, role, revoked_at)
    VALUES (${workspaceId}::uuid, ${auth.actor.user}::uuid, 'owner', NULL)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET
      role = 'owner',
      revoked_at = NULL
  `;
  await tx`
    INSERT INTO swarm.streams (stream_id, workspace_id, kind, repo_mapping_id)
    VALUES (${crypto.randomUUID()}::uuid, ${workspaceId}::uuid, 'workspace', NULL)
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
  if (!streamId) throw new Error("workspace stream creation failed");

  // Charged after the tenant exists, so the count is of substrate actually
  // created rather than of attempts.
  await chargeSpend(tx, "workspace_create");

  await insertAudit(tx, {
    auth,
    commandKind: CREATE_WORKSPACE_KIND,
    workspaceId,
    streamId,
    outcome: "accepted",
    reason: null,
    detail: ignoredIdentity,
  });
  return {
    status: 200,
    body: {
      status: "accepted",
      ok: true,
      event_ids: [],
      workspace_id: workspaceId,
      stream_id: streamId,
      min_client_version: minClientVersion,
    },
  };
}

interface SignalRateLimit {
  bucket: "credential" | "workspace";
  limit: number;
  resetsAt: string;
}

/**
 * The one fixed-window counter in this function: an atomic upsert into
 * swarm.rate_buckets on the hour boundary, clamped so a flood cannot grow the
 * integer without bound. Shared by the signal limits and the §8 spend proxies —
 * a second mechanism would be a second set of edge cases for no gain.
 */
async function incrementRateBucket(
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
    SET count = LEAST(swarm.rate_buckets.count + 1, ${limit + 1})
    RETURNING count, window_start + interval '1 hour' AS resets_at
  `;
  const row = rows[0];
  if (!row) throw new Error("signal rate bucket did not return a row");
  return {
    count: Number(row.count),
    resetsAt: row.resets_at.toISOString(),
  };
}

async function enforceSignalRate(
  tx: Sql,
  auth: AuthContext,
  workspaceId: string,
): Promise<SignalRateLimit | null> {
  const credentialIdentity = auth.credentialKind === "agent"
    ? auth.credentialId
    : auth.actor.user;
  if (credentialIdentity === null) {
    throw new Error("authenticated signal credential has no stable identity");
  }
  const credential = await incrementRateBucket(
    tx,
    `signal:credential:${auth.credentialKind}:${credentialIdentity}`,
    SIGNAL_CREDENTIAL_LIMIT,
  );
  if (credential.count > SIGNAL_CREDENTIAL_LIMIT) {
    return {
      bucket: "credential",
      limit: SIGNAL_CREDENTIAL_LIMIT,
      resetsAt: credential.resetsAt,
    };
  }
  const workspace = await incrementRateBucket(
    tx,
    `signal:workspace:${workspaceId}`,
    SIGNAL_WORKSPACE_LIMIT,
  );
  if (workspace.count > SIGNAL_WORKSPACE_LIMIT) {
    return {
      bucket: "workspace",
      limit: SIGNAL_WORKSPACE_LIMIT,
      resetsAt: workspace.resetsAt,
    };
  }
  return null;
}

/** Sums a set of shard keys over the CURRENT window without locking any of them. */
async function windowTotal(tx: Sql, bucketKeys: string[]): Promise<number> {
  const rows = await tx<{ total: string }[]>`
    SELECT coalesce(sum(count), 0)::text AS total
    FROM swarm.rate_buckets
    WHERE bucket_key = ANY(${bucketKeys}::text[])
      AND window_start = date_trunc('hour', statement_timestamp())
  `;
  return Number(rows[0]?.total ?? "0");
}

/**
 * Latches the breaker open and alerts, both exactly once per trip.
 *
 * The partial unique index in migration 20260728000001 permits a single open
 * trip, so INSERT ... ON CONFLICT DO NOTHING *is* the protocol: the first
 * transaction to cross owns the row and therefore owns the alert, and every
 * concurrent crosser is a no-op that returns no row. DO NOTHING, never DO
 * UPDATE — an update would reintroduce the hot row the shards exist to remove.
 */
async function tripSpendBreaker(
  tx: Sql,
  proxy: SpendProxy,
  observed: number,
): Promise<void> {
  const ceiling = SPEND_CEILINGS[proxy];
  const tripped = await tx<{ trip_id: string }[]>`
    INSERT INTO swarm.spend_breaker (
      tripped_by, proxy, observed, ceiling, window_start
    ) VALUES (
      'automatic',
      ${proxy},
      ${observed},
      ${ceiling},
      date_trunc('hour', statement_timestamp())
    )
    ON CONFLICT DO NOTHING
    RETURNING trip_id::text AS trip_id
  `;
  if (tripped.length === 0) return;
  await tx`
    INSERT INTO swarm.security_alerts (kind, subject, detail)
    VALUES (
      'spend_breaker_tripped',
      'global',
      ${tx.json({
        proxy,
        observed,
        ceiling,
        window: "hour",
        effect: "self_serve_workspace_creation_paused",
        cleared_by: "swarm.reset_spend_breaker(who, why)",
      })}::jsonb
    )
  `;
}

/**
 * Charges one unit of a cost proxy, and trips the breaker if the window's true
 * global total has crossed the ceiling.
 *
 * Called only on ACCEPTED commands: a refused command spent nothing worth
 * metering, and charging refusals would let a caller who is not entitled to do
 * anything at all drive the platform into signup-paused.
 *
 * The clamp handed to incrementRateBucket is the GLOBAL ceiling rather than the
 * shard's share, deliberately: a shard that clamped at its own share would make
 * the sum below understate the truth and the breaker would never trip under a
 * flood concentrated on one shard.
 */
async function chargeSpend(tx: Sql, proxy: SpendProxy): Promise<void> {
  const ceiling = SPEND_CEILINGS[proxy];
  const shard = await incrementRateBucket(
    tx,
    `spend:${proxy}:${Math.floor(Math.random() * SPEND_SHARDS)}`,
    ceiling,
  );
  // The aggregate is off the ordinary path: it runs only from a shard already
  // past its share, so honest traffic pays for one upsert and nothing else.
  if (shard.count < Math.ceil(ceiling / SPEND_SHARDS)) return;
  const total = await windowTotal(tx, SPEND_BUCKET_KEYS[proxy]);
  if (total <= ceiling) return;
  await tripSpendBreaker(tx, proxy, total);
}

interface SpendTrip {
  proxy: string;
  trippedAt: string;
  observed: number | null;
  ceiling: number | null;
}

/** The open trip, if the breaker is currently holding signup shut. */
async function openSpendTrip(tx: Sql): Promise<SpendTrip | null> {
  const rows = await tx<{
    proxy: string;
    tripped_at: Date;
    observed: string | null;
    ceiling: string | null;
  }[]>`
    SELECT proxy, tripped_at, observed::text AS observed, ceiling::text AS ceiling
    FROM swarm.spend_breaker
    WHERE cleared_at IS NULL
    ORDER BY tripped_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    proxy: row.proxy,
    trippedAt: row.tripped_at.toISOString(),
    observed: row.observed === null ? null : Number(row.observed),
    ceiling: row.ceiling === null ? null : Number(row.ceiling),
  };
}

/**
 * §8's degraded mode: while the breaker is open, self-serve workspace creation
 * is the ONE thing that stops. Every existing workspace keeps working.
 *
 * Ordering inside createSelfServeWorkspace matters twice. It sits AFTER the
 * feature gate and the identity gates, so an unverified stranger cannot use the
 * response to probe aggregate platform load. It sits BEFORE the per-identity
 * counts, because when the platform is paused an individual caller's remaining
 * budget is not the reason they are being refused and the audit row should not
 * say it was.
 *
 * ★ THE capability_read ARM IS DELETED, AND IT WAS A DENIAL-OF-SERVICE HOLE.
 *
 * It used to sum CAPABILITY_READ_BUCKET_KEYS here and trip the breaker on the
 * total. Those buckets are incremented by the capability edge function BEFORE the
 * bearer is resolved — the shard increment happens ~90 lines ahead of the
 * projection query — so an absent, malformed, unknown, revoked or expired token
 * all counted. Which means a caller holding NO CREDENTIAL OF ANY KIND could send
 * ~40k requests with random bearers in one window and latch a platform-wide
 * signup pause on every tenant, with no automatic recovery: it stayed shut until
 * a human with swarm_admin ran reset_spend_breaker() by hand.
 *
 * That is precisely what this function's own docstring above says the design
 * avoids — "charging refusals would let a caller who is not entitled to do
 * anything at all drive the platform into signup-paused" — and it is the same
 * rule the capability function states at its own global counter: "§5:
 * unauthenticated limits alert rather than hard-lock. A global hard cap would let
 * one attacker close the front door on every tenant, so this one never refuses."
 * Two files asserted the rule and the code between them broke it.
 *
 * The remaining four proxies are all AUTHENTICATED, ACCEPTED actions — a
 * workspace created, an invite sent, a signal posted, a token minted. Each costs
 * real money and each requires a credential, so the ceiling cannot be driven by
 * someone with nothing. Anonymous read volume is still bounded, still alerts, and
 * still refuses per-caller inside the capability function; it simply no longer
 * gets a lever on anyone else's signup.
 */
async function enforceSpendBreaker(
  tx: Sql,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult | null> {
  const trip = await openSpendTrip(tx);
  if (trip === null) return null;

  const measured = trip.observed === null || trip.ceiling === null
    ? "paused by an operator"
    : `${trip.proxy} observed ${trip.observed} against a ceiling of ${trip.ceiling}/hour`;
  await insertAudit(tx, {
    auth,
    commandKind: CREATE_WORKSPACE_KIND,
    outcome: "quota",
    reason: "spend_breaker_signup_paused",
    detail: [
      ignoredIdentity,
      `spend breaker open since ${trip.trippedAt}: ${measured}`,
    ].filter(Boolean).join("; "),
  });
  return {
    status: 503,
    body: {
      error: "signup_paused",
      message:
        "New workspaces are paused while an operator reviews unusual load across the service. " +
        "Existing workspaces are unaffected — signals, invites and agent tokens keep working. " +
        "Try again later.",
    },
  };
}

interface CapabilityRequest {
  userId: string;
  workspaceId: string;
  command: Record<string, unknown>;
  minClientVersion: string;
}

type CapabilityPreamble =
  | { ok: true; request: CapabilityRequest }
  | { ok: false; result: HttpResult };

/** Write the audit row a refusal owes before returning its HTTP body. */
async function auditRefusal(
  tx: Sql,
  auth: AuthContext,
  kind: string,
  entry: {
    outcome: string;
    reason: string;
    detail?: string | null;
    workspaceId?: string | null;
    streamId?: string | null;
  },
  result: HttpResult,
): Promise<HttpResult> {
  await insertAudit(tx, {
    auth,
    commandKind: kind,
    workspaceId: entry.workspaceId ?? null,
    streamId: entry.streamId ?? null,
    outcome: entry.outcome,
    reason: entry.reason,
    detail: entry.detail ?? null,
  });
  return result;
}

/**
 * The checks mint and revoke share, in the order §7 requires. The feature gate
 * answers first so that while the on-ramp is dark the response cannot be used to
 * probe whether an identity is verified or a workspace exists; the credential
 * check that follows is this file's §2.3 agent-token denylist entry, written out
 * explicitly because a capability command deliberately never reaches the
 * reducer's HUMAN_ONLY_COMMANDS gate. Every refusal carries its own reason so a
 * failure is diagnosable from swarm.audit_log alone.
 */
async function capabilityPreamble(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
  kind: string,
  commandKeySets: readonly (readonly string[])[],
): Promise<CapabilityPreamble> {
  const scope = kind === MINT_CAPABILITY_KIND
    ? "capability_mint"
    : "capability_revoke";
  const forbidden: HttpResult = { status: 403, body: { error: "forbidden" } };
  const invalid: HttpResult = { status: 400, body: { error: "invalid_request" } };
  // Recorded on refusals that happen before the caller's membership is known,
  // the same way handleTransaction's own forbidden path does it: it is the
  // tenant the caller *claimed*, never an authorization input, and it is what
  // makes a probing campaign visible in the audit log.
  const claimedWorkspace =
    typeof body.workspace_id === "string" && UUID_RE.test(body.workspace_id)
      ? body.workspace_id
      : null;
  const refuse = async (
    outcome: string,
    reason: string,
    result: HttpResult,
    workspaceId: string | null = claimedWorkspace,
  ): Promise<CapabilityPreamble> => ({
    ok: false,
    result: await auditRefusal(tx, auth, kind, {
      outcome,
      reason,
      detail: ignoredIdentity,
      workspaceId,
    }, result),
  });

  if (!capabilityUrlsEnabled) {
    return await refuse("authz", "capability_feature_disabled", forbidden);
  }
  // §7 human-mint-only: a swm_agt_ bearer can never reach the line below this
  // one, so a compromised worker cannot mint a link and exfiltrate board state.
  if (auth.credentialKind !== "user" || auth.actor.user === null) {
    return await refuse("authz", `${scope}_credential_kind_forbidden`, forbidden);
  }
  const userId = auth.actor.user;
  if (!auth.identityVerified) {
    return await refuse("authz", `${scope}_identity_not_verified`, forbidden);
  }
  // The stream is derived server-side from the named work item. Nothing about
  // the target is client-selectable beyond the id inside `command`.
  if (Object.hasOwn(body, "stream")) {
    return await refuse("validation", `${scope}_stream_field_forbidden`, invalid);
  }

  const command = record(body.command);
  const shapeOk = exactKeys(body, [
    "command_id",
    "client_version",
    "workspace_id",
    "command",
  ]) &&
    typeof body.workspace_id === "string" &&
    UUID_RE.test(body.workspace_id) &&
    typeof body.client_version === "string" &&
    command !== null &&
    command.kind === kind &&
    commandKeySets.some((keys) => exactKeys(command, keys));
  if (command === null || !shapeOk) {
    return await refuse("validation", `${scope}_invalid_request`, invalid);
  }
  const workspaceId = body.workspace_id as string;
  const clientVersion = body.client_version as string;

  const configRows = await tx<{ value: unknown }[]>`
    SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
  `;
  const minClientVersion = configRows[0]?.value;
  if (
    typeof minClientVersion !== "string" ||
    compareSemver(clientVersion, minClientVersion) === null
  ) {
    return await refuse(
      "validation",
      `${scope}_invalid_client_version`,
      invalid,
      workspaceId,
    );
  }
  if (compareSemver(clientVersion, minClientVersion)! < 0) {
    return await refuse("validation", `${scope}_client_unsupported`, {
      status: 426,
      body: { error: "upgrade_required", min_client_version: minClientVersion },
    }, workspaceId);
  }

  // Issuing a credential that discloses tenant data is at least as privileged as
  // issuing an invite, which §2.6 gates on Owner/Admin. A non-member and a
  // wrong-tenant workspace_id take this same branch, so the response is never an
  // existence oracle for another tenant.
  const memberships = await tx<{ role: string }[]>`
    SELECT role
    FROM swarm.memberships
    WHERE workspace_id = ${workspaceId}::uuid
      AND user_id = ${userId}::uuid
      AND revoked_at IS NULL
    LIMIT 1
  `;
  const role = memberships[0]?.role ?? null;
  if (role !== "owner" && role !== "admin") {
    return await refuse("authz", `${scope}_role_forbidden`, forbidden, workspaceId);
  }

  return {
    ok: true,
    request: { userId, workspaceId, command, minClientVersion },
  };
}

/**
 * Mint one capability URL (§7 zero-install on-ramp). Dispatched ahead of
 * resolveRoute for the same reason createSelfServeWorkspace is: it is
 * self-contained — its own validation, its own ceilings, its own audit rows —
 * and it emits no protocol event, so it stays out of the shared reducer path.
 *
 * The raw token exists in this function and in the fresh HTTP response, nowhere
 * else: only its SHA-256 digest is stored, and neither the token nor any prefix
 * of it reaches swarm.audit_log or swarm.idempotency_keys.
 */
async function mintCapabilityUrl(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const preamble = await capabilityPreamble(
    tx,
    body,
    auth,
    ignoredIdentity,
    MINT_CAPABILITY_KIND,
    [["kind", "task_id"], ["kind", "task_id", "ttl_ms"]],
  );
  if (!preamble.ok) return preamble.result;
  const { userId, workspaceId, command, minClientVersion } = preamble.request;
  const commandId = String(body.command_id);
  const invalidRequest = { status: 400, body: { error: "invalid_request" } };

  const taskId = command.task_id;
  if (typeof taskId !== "string" || !UUID_RE.test(taskId)) {
    return await auditRefusal(tx, auth, MINT_CAPABILITY_KIND, {
      outcome: "validation",
      reason: "capability_mint_invalid_request",
      detail: ignoredIdentity,
      workspaceId,
    }, invalidRequest);
  }
  const ttlMs = command.ttl_ms === undefined
    ? CAPABILITY_TTL_MS
    : command.ttl_ms;
  if (!integer(ttlMs, CAPABILITY_MIN_TTL_MS) || ttlMs > CAPABILITY_MAX_TTL_MS) {
    return await auditRefusal(tx, auth, MINT_CAPABILITY_KIND, {
      outcome: "validation",
      reason: "capability_mint_invalid_ttl",
      detail: ignoredIdentity,
      workspaceId,
    }, invalidRequest);
  }

  // ★ RESOLVED BY THE FULL WORK-ITEM KEY, NOT BY task_id ALONE.
  // swarm.tasks is PRIMARY KEY (stream_id, task_id) — task_id on its own is not
  // unique — so `WHERE t.task_id = $1` names a *set*, and taking its first row
  // binds a bearer credential to whichever member of that set the planner
  // happened to return. That is the cross-tenant class §7 names. Three
  // predicates close it, and none of them is redundant with the others:
  //   * t.workspace_id pins the task row itself to the caller's tenant;
  //   * the join carries the composite (stream_id, workspace_id) — the same
  //     pairing swarm.capability_urls' FK enforces — so the stream this mint
  //     writes cannot belong to a different tenant than the task;
  //   * the repositories EXISTS re-applies resolveRoute's archived_at check,
  //     which this lookup used to omit, so a link can no longer be minted
  //     against an archived repository mapping. It is written as EXISTS rather
  //     than a LEFT JOIN on purpose: a missing or foreign-tenant repository row
  //     must refuse, and `r.archived_at IS NULL` over a LEFT JOIN would pass.
  // LIMIT 2, not 1: two rows means one task_id under two streams, which this
  // function must refuse rather than resolve arbitrarily.
  // "No such task", "that task belongs to another tenant", "its repo mapping is
  // archived" and "the id is ambiguous" are all the same 403 — only the audit
  // reason distinguishes them — so a member cannot probe another tenant's ids.
  const taskRows = await tx<{ stream_id: string }[]>`
    SELECT t.stream_id
    FROM swarm.tasks t
    JOIN swarm.streams s
      ON s.stream_id = t.stream_id
     AND s.workspace_id = t.workspace_id
    WHERE t.task_id = ${taskId}::uuid
      AND t.workspace_id = ${workspaceId}::uuid
      AND s.workspace_id = ${workspaceId}::uuid
      AND (
        s.repo_mapping_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM swarm.repositories r
          WHERE r.repo_mapping_id = s.repo_mapping_id
            AND r.workspace_id = ${workspaceId}::uuid
            AND r.archived_at IS NULL
        )
      )
    ORDER BY t.stream_id
    LIMIT 2
  `;
  if (taskRows.length > 1) {
    return await auditRefusal(tx, auth, MINT_CAPABILITY_KIND, {
      outcome: "authz",
      reason: "capability_mint_work_item_ambiguous",
      detail: ignoredIdentity,
      workspaceId,
    }, { status: 403, body: { error: "forbidden" } });
  }
  const streamId = taskRows[0]?.stream_id;
  if (!streamId) {
    return await auditRefusal(tx, auth, MINT_CAPABILITY_KIND, {
      outcome: "authz",
      reason: "capability_mint_work_item_not_found",
      detail: ignoredIdentity,
      workspaceId,
    }, { status: 403, body: { error: "forbidden" } });
  }

  const rateLimited = async (
    subject: "identity" | "workspace",
    alertSubject: "user" | "workspace",
    reason: string,
    limit: number,
    resetsAt: string,
  ): Promise<HttpResult> => {
    const detail = `${subject} limit ${limit} links/hour; resets at ${resetsAt}`;
    await insertAudit(tx, {
      auth,
      commandKind: MINT_CAPABILITY_KIND,
      workspaceId,
      streamId,
      outcome: "rate_limit",
      reason,
      detail,
    });
    await tx`
      INSERT INTO swarm.security_alerts (kind, subject, detail)
      VALUES (
        'capability_mint_rate_limit',
        ${alertSubject},
        ${tx.json({
      workspace_id: workspaceId,
      user_id: userId,
      limit,
      resets_at: resetsAt,
    })}::jsonb
      )
    `;
    return {
      status: 429,
      body: {
        error: "rate_limited",
        message: `Capability link refused: ${detail}.`,
        limit,
        resets_at: resetsAt,
      },
    };
  };

  // Hourly windows on purpose: purge_expired_rate_buckets sweeps this table of
  // anything older than two hours, so a daily window stored here would silently
  // reset (the reasoning is written out at enforceFreeTierBudget).
  const credentialBucket = await incrementRateBucket(
    tx,
    `capability:mint:user:${userId}`,
    CAPABILITY_MINT_CREDENTIAL_LIMIT,
  );
  if (credentialBucket.count > CAPABILITY_MINT_CREDENTIAL_LIMIT) {
    return await rateLimited(
      "identity",
      "user",
      "capability_mint_rate_limited_credential",
      CAPABILITY_MINT_CREDENTIAL_LIMIT,
      credentialBucket.resetsAt,
    );
  }
  const workspaceBucket = await incrementRateBucket(
    tx,
    `capability:mint:workspace:${workspaceId}`,
    CAPABILITY_MINT_WORKSPACE_LIMIT,
  );
  if (workspaceBucket.count > CAPABILITY_MINT_WORKSPACE_LIMIT) {
    return await rateLimited(
      "workspace",
      "workspace",
      "capability_mint_rate_limited_workspace",
      CAPABILITY_MINT_WORKSPACE_LIMIT,
      workspaceBucket.resetsAt,
    );
  }

  // Counted from the table rather than a bucket: this is a ceiling on live
  // credentials, so the artifact itself is the only honest measurement.
  const liveRows = await tx<{ live: string }[]>`
    SELECT count(*)::text AS live
    FROM swarm.capability_urls
    WHERE workspace_id = ${workspaceId}::uuid
      AND revoked_at IS NULL
      AND expires_at > statement_timestamp()
  `;
  if (Number(liveRows[0]?.live ?? "0") >= CAPABILITY_LIVE_LIMIT) {
    return await auditRefusal(tx, auth, MINT_CAPABILITY_KIND, {
      outcome: "quota",
      reason: "capability_live_limit_reached",
      detail: ignoredIdentity,
      workspaceId,
      streamId,
    }, {
      status: 403,
      body: { error: "capability_limit_reached", limit: CAPABILITY_LIVE_LIMIT },
    });
  }

  // A retried mint must not silently issue a second live credential.
  const hash = requestHash(auth.actor, command);
  const existingRows = await tx<
    {
      workspace_id: string;
      stream_id: string;
      request_hash: string;
      response: unknown;
    }[]
  >`
    SELECT workspace_id, stream_id, request_hash, response
    FROM swarm.idempotency_keys
    WHERE principal_kind = ${auth.credentialKind}
      AND principal_id = ${canonicalPrincipal(auth.actor)}
      AND command_id = ${commandId}
    LIMIT 1
  `;
  const existing = existingRows[0];
  if (existing) {
    const matches = existing.request_hash === hash &&
      existing.workspace_id === workspaceId &&
      existing.stream_id === streamId;
    await insertAudit(tx, {
      auth,
      commandKind: MINT_CAPABILITY_KIND,
      workspaceId,
      streamId,
      outcome: matches ? "replayed" : "conflict",
      reason: matches ? null : "capability_mint_command_id_conflict",
      detail: ignoredIdentity,
      hash,
    });
    // A replay identifies the link; it never re-serves the credential.
    return matches
      ? replayResult(storedResponse(existing.response), MINT_CAPABILITY_KIND)
      : { status: 409, body: { error: "command_id_conflict" } };
  }

  const token = opaqueToken("swm_cap_");
  if (!CAPABILITY_TOKEN_RE.test(token)) {
    throw new Error("minted capability token does not match the presented-credential shape");
  }
  const tokenHash = await sha256(token);
  const capabilityId = crypto.randomUUID();
  const issued = await tx<{ expires_at: Date }[]>`
    INSERT INTO swarm.capability_urls (
      capability_id, workspace_id, stream_id, task_id,
      token_hash, created_by, mint_command_id, expires_at
    ) VALUES (
      ${capabilityId}::uuid,
      ${workspaceId}::uuid,
      ${streamId}::uuid,
      ${taskId}::uuid,
      ${tokenHash},
      ${userId}::uuid,
      ${commandId},
      statement_timestamp() + interval '1 millisecond' * ${ttlMs}::double precision
    )
    RETURNING expires_at
  `;
  const expiresAt = issued[0]?.expires_at;
  if (!expiresAt) throw new Error("capability url insert returned no row");
  const expiresAtIso = expiresAt.toISOString();

  // The ledger stores what a replay may re-serve. The token is deliberately
  // absent: swarm_command can read this table, and a live credential in
  // plaintext here would outlive the response that carried it.
  const response: StoredResponse = {
    ok: true,
    event_ids: [],
    capability_id: capabilityId,
    expires_at: expiresAtIso,
  };
  const ledgered = await tx<{ command_id: string }[]>`
    INSERT INTO swarm.idempotency_keys (
      principal_kind, principal_id, command_id,
      workspace_id, stream_id, request_hash, response
    ) VALUES (
      ${auth.credentialKind},
      ${canonicalPrincipal(auth.actor)},
      ${commandId},
      ${workspaceId}::uuid,
      ${streamId}::uuid,
      ${hash},
      ${tx.json(response as unknown as postgres.JSONValue)}::jsonb
    )
    ON CONFLICT (principal_kind, principal_id, command_id) DO NOTHING
    RETURNING command_id
  `;
  if (ledgered.length === 0) {
    throw new LedgerRace(
      auth,
      commandId,
      MINT_CAPABILITY_KIND,
      workspaceId,
      streamId,
      hash,
    );
  }

  await insertAudit(tx, {
    auth,
    commandKind: MINT_CAPABILITY_KIND,
    workspaceId,
    streamId,
    outcome: "accepted",
    reason: null,
    detail: [ignoredIdentity, `capability_id=${capabilityId}`]
      .filter(Boolean).join("; "),
    hash,
  });
  return {
    status: 200,
    body: {
      status: "accepted",
      ...response,
      // The only time this string is ever served. The server does not compose a
      // URL and never learns the site origin; the client builds
      // https://<site>/see#<token> so the secret rides in the fragment.
      capability_token: token,
      min_client_version: minClientVersion,
    },
  };
}

/**
 * Revoke one capability URL. Ships with minting because §7's "expiring and
 * revocable" is not satisfied by a TTL alone; the tombstone keeps capability
 * revocation inside the same three-layer revocation surface every other
 * credential uses.
 */
async function revokeCapabilityUrl(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const preamble = await capabilityPreamble(
    tx,
    body,
    auth,
    ignoredIdentity,
    REVOKE_CAPABILITY_KIND,
    [["kind", "capability_id"]],
  );
  if (!preamble.ok) return preamble.result;
  const { userId, workspaceId, command, minClientVersion } = preamble.request;
  const commandId = String(body.command_id);

  const capabilityId = command.capability_id;
  if (typeof capabilityId !== "string" || !UUID_RE.test(capabilityId)) {
    return await auditRefusal(tx, auth, REVOKE_CAPABILITY_KIND, {
      outcome: "validation",
      reason: "capability_revoke_invalid_request",
      detail: ignoredIdentity,
      workspaceId,
    }, { status: 400, body: { error: "invalid_request" } });
  }

  const notFound = async (streamId: string | null): Promise<HttpResult> =>
    await auditRefusal(tx, auth, REVOKE_CAPABILITY_KIND, {
      outcome: "authz",
      // One reason string covers unknown id, foreign tenant, and already
      // revoked: distinguishing them is an existence oracle across tenants. The
      // operator sees their live set through their own workspace listing.
      reason: "capability_revoke_not_found",
      detail: ignoredIdentity,
      workspaceId,
      streamId,
    }, { status: 403, body: { error: "forbidden" } });

  // Read before update: the ledger row needs the link's stream_id, and a replay
  // of an already-revoked link must return its stored response rather than the
  // refusal a second revocation would earn.
  const rows = await tx<{ stream_id: string }[]>`
    SELECT stream_id
    FROM swarm.capability_urls
    WHERE capability_id = ${capabilityId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  const streamId = rows[0]?.stream_id;
  if (!streamId) return await notFound(null);

  const hash = requestHash(auth.actor, command);
  const existingRows = await tx<
    {
      workspace_id: string;
      stream_id: string;
      request_hash: string;
      response: unknown;
    }[]
  >`
    SELECT workspace_id, stream_id, request_hash, response
    FROM swarm.idempotency_keys
    WHERE principal_kind = ${auth.credentialKind}
      AND principal_id = ${canonicalPrincipal(auth.actor)}
      AND command_id = ${commandId}
    LIMIT 1
  `;
  const existing = existingRows[0];
  if (existing) {
    const matches = existing.request_hash === hash &&
      existing.workspace_id === workspaceId &&
      existing.stream_id === streamId;
    await insertAudit(tx, {
      auth,
      commandKind: REVOKE_CAPABILITY_KIND,
      workspaceId,
      streamId,
      outcome: matches ? "replayed" : "conflict",
      reason: matches ? null : "capability_revoke_command_id_conflict",
      detail: ignoredIdentity,
      hash,
    });
    return matches
      ? replayResult(storedResponse(existing.response), REVOKE_CAPABILITY_KIND)
      : { status: 409, body: { error: "command_id_conflict" } };
  }

  // Legal under the revoke-only trigger: revoked_at and revoked_by are the only
  // columns that change.
  const revoked = await tx<{ revoked_at: Date }[]>`
    UPDATE swarm.capability_urls
    SET revoked_at = statement_timestamp(), revoked_by = ${userId}::uuid
    WHERE capability_id = ${capabilityId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND revoked_at IS NULL
    RETURNING revoked_at
  `;
  const revokedAt = revoked[0]?.revoked_at;
  if (!revokedAt) return await notFound(streamId);
  await tx`
    INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
    VALUES ('capability_url', ${capabilityId}::uuid, ${userId}::uuid)
  `;

  const response: StoredResponse = {
    ok: true,
    event_ids: [],
    capability_id: capabilityId,
    revoked_at: revokedAt.toISOString(),
  };
  const ledgered = await tx<{ command_id: string }[]>`
    INSERT INTO swarm.idempotency_keys (
      principal_kind, principal_id, command_id,
      workspace_id, stream_id, request_hash, response
    ) VALUES (
      ${auth.credentialKind},
      ${canonicalPrincipal(auth.actor)},
      ${commandId},
      ${workspaceId}::uuid,
      ${streamId}::uuid,
      ${hash},
      ${tx.json(response as unknown as postgres.JSONValue)}::jsonb
    )
    ON CONFLICT (principal_kind, principal_id, command_id) DO NOTHING
    RETURNING command_id
  `;
  if (ledgered.length === 0) {
    throw new LedgerRace(
      auth,
      commandId,
      REVOKE_CAPABILITY_KIND,
      workspaceId,
      streamId,
      hash,
    );
  }

  await insertAudit(tx, {
    auth,
    commandKind: REVOKE_CAPABILITY_KIND,
    workspaceId,
    streamId,
    outcome: "accepted",
    reason: null,
    detail: [ignoredIdentity, `capability_id=${capabilityId}`]
      .filter(Boolean).join("; "),
    hash,
  });
  return {
    status: 200,
    body: {
      status: "accepted",
      ...response,
      min_client_version: minClientVersion,
    },
  };
}

/**
 * The free-tier ceilings §9 P5 makes launch-blocking, for commands that spend a
 * shared resource: outbound invites (transactional email, hence a branded
 * phishing vector), workspace seats, and agent principals.
 *
 * Why these counts are not swarm.rate_buckets, unlike enforceSignalRate: that
 * table is swept hourly of every row whose window_start is older than two hours
 * (migration 20260723000001_p1_schema.sql, purge_expired_rate_buckets), so a
 * *daily* window stored there would silently reset every couple of hours — a
 * cap that reads as enforced and is not. Counting the invitations, memberships,
 * and principals themselves also measures the artifact instead of a proxy for
 * it.
 *
 * The counts are exact rather than best-effort under concurrency: the workspace
 * stream is already locked FOR UPDATE by the caller, so commands into one
 * workspace serialize, and invite_member/create_agent_principal are
 * human-credential-only (§2.3), so the caller also holds the row lock
 * authenticateHuman's upsert took on its own swarm.users row.
 */
async function enforceFreeTierBudget(
  tx: Sql,
  auth: AuthContext,
  route: Route,
  command: ValidatedCommand,
  hash: string,
): Promise<HttpResult | null> {
  const refuse = async (
    reason: string,
    detail: string,
    result: HttpResult,
  ): Promise<HttpResult> => {
    await insertAudit(tx, {
      auth,
      commandKind: command.kind,
      workspaceId: route.workspaceId,
      streamId: route.streamId,
      outcome: result.status === 429 ? "rate_limit" : "quota",
      reason,
      detail,
      hash,
    });
    return result;
  };

  if (command.kind === "invite_member") {
    const sentRows = await tx<{ sent: string; resets_at: Date | null }[]>`
      SELECT
        count(*)::text AS sent,
        min(created_at) + interval '24 hours' AS resets_at
      FROM swarm.invitations
      WHERE created_by = ${auth.actor.user}::uuid
        AND created_at > statement_timestamp() - interval '24 hours'
    `;
    if (Number(sentRows[0]?.sent ?? "0") >= INVITE_IDENTITY_DAILY_LIMIT) {
      const resetsAt = (sentRows[0]?.resets_at ?? new Date()).toISOString();
      const detail =
        `identity limit ${INVITE_IDENTITY_DAILY_LIMIT} invites/day; resets at ${resetsAt}`;
      await tx`
        INSERT INTO swarm.security_alerts (kind, subject, detail)
        VALUES (
          'invite_rate_limit',
          'identity',
          ${tx.json({
            workspace_id: route.workspaceId,
            user_id: auth.actor.user,
            limit: INVITE_IDENTITY_DAILY_LIMIT,
            resets_at: resetsAt,
          })}::jsonb
        )
      `;
      return await refuse("invite_rate_limited", detail, {
        status: 429,
        body: {
          error: "rate_limited",
          message: `Invite refused: ${detail}.`,
          limit: INVITE_IDENTITY_DAILY_LIMIT,
          resets_at: resetsAt,
        },
      });
    }

    // Seats in use, not members: an outstanding invitation is a seat someone
    // can still walk through, so parking pending invites cannot evade the cap.
    const seatRows = await tx<{ used: string }[]>`
      SELECT (
        (
          SELECT count(*)
          FROM swarm.memberships
          WHERE workspace_id = ${route.workspaceId}::uuid
            AND revoked_at IS NULL
        ) + (
          SELECT count(*)
          FROM swarm.invitations
          WHERE workspace_id = ${route.workspaceId}::uuid
            AND consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > statement_timestamp()
        )
      )::text AS used
    `;
    const used = Number(seatRows[0]?.used ?? "0");
    if (used >= FREE_TIER_MEMBER_LIMIT) {
      return await refuse(
        "workspace_member_limit_reached",
        `seats in use: ${used}`,
        {
          status: 403,
          body: {
            error: "member_limit_reached",
            limit: FREE_TIER_MEMBER_LIMIT,
          },
        },
      );
    }
  }

  if (command.kind === "create_agent_principal") {
    const principalRows = await tx<{ live: string }[]>`
      SELECT count(*)::text AS live
      FROM swarm.agent_principals
      WHERE workspace_id = ${route.workspaceId}::uuid
        AND revoked_at IS NULL
    `;
    const live = Number(principalRows[0]?.live ?? "0");
    if (live >= FREE_TIER_PRINCIPAL_LIMIT) {
      return await refuse(
        "workspace_principal_limit_reached",
        `live principals: ${live}`,
        {
          status: 403,
          body: {
            error: "principal_limit_reached",
            limit: FREE_TIER_PRINCIPAL_LIMIT,
          },
        },
      );
    }
  }

  return null;
}

interface SignalWriteTarget {
  toUserId: string | null;
  toAgentPrincipalId: string | null;
  inReplyTo: string | null;
}

async function signalUserTargetIsLive(
  tx: Sql,
  route: Route,
  toUserId: string | null,
): Promise<boolean> {
  if (toUserId === null) return true;
  const targetRows = await tx<{ user_id: string }[]>`
    SELECT user_id
    FROM swarm.memberships
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND user_id = ${toUserId}::uuid
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return targetRows[0] !== undefined;
}

async function signalAgentTargetIsLive(
  tx: Sql,
  route: Route,
  toAgentPrincipalId: string | null,
): Promise<boolean> {
  if (toAgentPrincipalId === null) return true;
  const targetRows = await tx<{ principal_id: string }[]>`
    SELECT p.principal_id
    FROM swarm.agent_principals AS p
    JOIN swarm.memberships AS owner
      ON owner.workspace_id = p.workspace_id
     AND owner.user_id = p.owner_user_id
     AND owner.revoked_at IS NULL
    WHERE p.workspace_id = ${route.workspaceId}::uuid
      AND p.principal_id = ${toAgentPrincipalId}::uuid
      AND p.revoked_at IS NULL
    LIMIT 1
  `;
  return targetRows[0] !== undefined;
}

async function signalAgentOwnedByUser(
  tx: Sql,
  route: Route,
  principalId: string | null,
  ownerUserId: string,
): Promise<boolean> {
  if (principalId === null) return false;
  const rows = await tx<{ principal_id: string }[]>`
    SELECT principal_id
    FROM swarm.agent_principals
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND principal_id = ${principalId}::uuid
      AND owner_user_id = ${ownerUserId}::uuid
    LIMIT 1
  `;
  return rows[0] !== undefined;
}

async function resolveSignalWriteTarget(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: SignalCommand,
): Promise<SignalWriteTarget | null> {
  const toAgentPrincipalId = command.to_agent_principal_id ?? null;
  const inReplyTo = command.in_reply_to ?? null;
  if (inReplyTo === null) {
    const userLive = await signalUserTargetIsLive(
      tx,
      route,
      command.to_user_id,
    );
    const agentLive = await signalAgentTargetIsLive(
      tx,
      route,
      toAgentPrincipalId,
    );
    return userLive && agentLive
      ? {
        toUserId: command.to_user_id,
        toAgentPrincipalId,
        inReplyTo: null,
      }
      : null;
  }

  const referenceRows = await tx<{
    from_principal: string;
    from_kind: CredentialKind;
    to_user_id: string | null;
    to_agent_principal_id: string | null;
  }[]>`
    SELECT
      from_principal,
      from_kind,
      to_user_id,
      to_agent_principal_id
    FROM swarm.signals
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND id = ${inReplyTo}::uuid
      AND kind IN ('ask', 'note')
      AND until > statement_timestamp()
    LIMIT 1
  `;
  const reference = referenceRows[0];
  if (!reference) return null;

  const callerUserId = auth.actor.user;
  const addressedToCaller = auth.agent !== null
    ? reference.to_agent_principal_id === auth.agent.principal_id
    : callerUserId !== null &&
      (
        reference.to_user_id === callerUserId ||
        await signalAgentOwnedByUser(
          tx,
          route,
          reference.to_agent_principal_id,
          callerUserId,
        )
      );
  if (!addressedToCaller) return null;

  if (reference.from_kind === "user") {
    return await signalUserTargetIsLive(
        tx,
        route,
        reference.from_principal,
      )
      ? {
        toUserId: reference.from_principal,
        toAgentPrincipalId: null,
        inReplyTo,
      }
      : null;
  }
  return await signalAgentTargetIsLive(
      tx,
      route,
      reference.from_principal,
    )
    ? {
      toUserId: null,
      toAgentPrincipalId: reference.from_principal,
      inReplyTo,
    }
    : null;
}

async function postSignal(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: SignalCommand,
  target: SignalWriteTarget,
): Promise<SignalRecord> {
  const untilMs = command.until_ms ??
    SIGNAL_DEFAULT_UNTIL_MS[command.signal_kind];
  const signalId = crypto.randomUUID();
  const rows = await tx<{
    id: string;
    workspace_id: string;
    from_principal: string;
    from_kind: CredentialKind;
    to_user_id: string | null;
    to_agent_principal_id: string | null;
    in_reply_to: string | null;
    about: string | null;
    kind: SignalKind;
    body: string;
    until: Date;
    created_at: Date;
  }[]>`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at
    ) VALUES (
      ${signalId}::uuid,
      ${route.workspaceId}::uuid,
      ${canonicalPrincipal(auth.actor)}::uuid,
      ${auth.credentialKind},
      ${target.toUserId}::uuid,
      ${target.toAgentPrincipalId}::uuid,
      ${target.inReplyTo}::uuid,
      ${command.about},
      ${command.signal_kind},
      ${command.body},
      statement_timestamp() + ${untilMs} * interval '1 millisecond',
      statement_timestamp()
    )
    RETURNING
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at
  `;
  const signal = rows[0];
  if (!signal) throw new Error("signal insert did not return a row");
  return {
    id: signal.id,
    workspace_id: signal.workspace_id,
    from: signal.from_principal,
    from_kind: signal.from_kind,
    to: signal.to_user_id,
    to_agent: signal.to_agent_principal_id,
    in_reply_to: signal.in_reply_to,
    about: signal.about,
    kind: signal.kind,
    body: signal.body,
    until: signal.until.toISOString(),
    created_at: signal.created_at.toISOString(),
  };
}

async function handleTransaction(
  body: RequestBody,
  verifiedHuman: VerifiedHuman | null,
  agentTokenHash: Uint8Array | null,
): Promise<HttpResult> {
  const kind = commandKind(body);
  const commandId = String(body.command_id);
  return await db.begin(async (tx) => {
    await beforeStep(2);
    await setTransaction(tx);
    await afterStep(2);

    await beforeStep(3);
    const auth = agentTokenHash !== null
      ? await authenticateAgent(tx, agentTokenHash)
      : verifiedHuman !== null
      ? await authenticateHuman(tx, verifiedHuman)
      : null;
    if (!auth) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "unverified principal",
      );
      return { status: 401, body: { error: "unauthenticated" } };
    }
    await afterStep(3);

    await beforeStep(4);
    const ignoredIdentity = forgedActorDetail(body);
    await afterStep(4);

    if (Object.hasOwn(body, "from")) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        outcome: "validation",
        reason: "client-supplied from is forbidden",
      });
      return { status: 400, body: { error: "invalid_request" } };
    }

    if (kind === REGISTER_DEVICE_KIND) {
      return await registerLoginDevice(tx, body, auth, ignoredIdentity);
    }

    // Must precede resolveRoute: the caller has no membership anywhere yet, so
    // route resolution would reject them before the command could be read.
    if (kind === CREATE_WORKSPACE_KIND) {
      return await createSelfServeWorkspace(tx, body, auth, ignoredIdentity);
    }

    // Also pre-route (§7): a capability command scopes a task that may live on a
    // repo stream, so it cannot travel the CONNECT_COMMAND_KINDS path, which
    // forces stream.kind === "workspace". Both handlers are self-contained and
    // emit no protocol event.
    if (kind === MINT_CAPABILITY_KIND) {
      return await mintCapabilityUrl(tx, body, auth, ignoredIdentity);
    }
    if (kind === REVOKE_CAPABILITY_KIND) {
      return await revokeCapabilityUrl(tx, body, auth, ignoredIdentity);
    }

    await beforeStep(5);
    const invitationToken = kind === "accept_invitation"
      ? invitationTokenForRoute(body)
      : null;
    const invitationRouteHash = invitationToken === null
      ? null
      : await sha256(invitationToken);
    const route = kind === "accept_invitation"
      ? invitationRouteHash === null
        ? null
        : await resolveInvitationRoute(tx, body, auth, invitationRouteHash)
      : await resolveRoute(tx, body, auth);
    const workspaceCommandRouteOk =
      !(WORKSPACE_COMMAND_KINDS as readonly string[]).includes(kind) ||
      kind === "accept_invitation" ||
      record(body.stream)?.kind === "workspace";
    if (!route || !workspaceCommandRouteOk) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: typeof body.workspace_id === "string" &&
            UUID_RE.test(body.workspace_id)
          ? body.workspace_id
          : null,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    await afterStep(5);

    await beforeStep(6);
    if (await revoked(tx, auth, route)) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "revocation",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const validation = validateCommand(body.command);
    const configRows = await tx<{ value: unknown }[]>`
      SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
    `;
    const minClientVersion = configRows[0]?.value;
    if (typeof minClientVersion !== "string") {
      throw new Error("min_client_version config is missing or malformed");
    }
    if (!validation.ok) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: validation.reason,
        detail: ignoredIdentity,
      });
      return {
        status: validation.status,
        body: {
          error: validation.status === 413
            ? "payload_too_large"
            : "invalid_request",
        },
      };
    }
    if (typeof body.client_version !== "string") {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "invalid client_version",
        detail: ignoredIdentity,
      });
      return { status: 400, body: { error: "invalid_request" } };
    }
    const versionOrder = compareSemver(body.client_version, minClientVersion);
    if (versionOrder === null) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "invalid client_version",
        detail: ignoredIdentity,
      });
      return { status: 400, body: { error: "invalid_request" } };
    }
    if (versionOrder < 0) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "validation",
        reason: "client_unsupported",
        detail: ignoredIdentity,
      });
      return {
        status: 426,
        body: { error: "upgrade_required", min_client_version: minClientVersion },
      };
    }
    // §2.3 renewal is the one command an agent presents that is NOT authorised
    // by a scope — a "renew token" scope is intrinsically denylisted, so no
    // worker can ever hold one. It is authorised by the run's bounded renewal
    // grant instead, checked in the reducer and fenced in the transaction. The
    // scope gate below is therefore skipped for it, and only for it.
    const isRenewal = validation.command.kind === RENEW_AGENT_TOKEN_KIND;
    // Agent self-surrender of the exact presenting token needs no "revoke"
    // scope — scopes of that shape are denylisted by design. The reducer still
    // refuses sibling/principal targets; this only opens the door to the check.
    const isAgentTokenRevoke =
      validation.command.kind === "revoke_agent_token";
    if (isRenewal && auth.agent === null) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "renewal_requires_agent_credential",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    if (
      auth.agent !== null &&
      !isRenewal &&
      !isAgentTokenRevoke &&
      (
        (CONNECT_COMMAND_KINDS as readonly string[]).includes(
          validation.command.kind,
        ) ||
        !Array.isArray(auth.agent.scopes) ||
        !auth.agent.scopes.every((scope) => typeof scope === "string") ||
        !auth.agent.scopes.includes(validation.command.kind)
      )
    ) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const command = validation.command;
    if (!await mintBindingsValid(tx, auth, command)) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
    const hash = requestHash(auth.actor, command);
    await afterStep(6);

    /**
     * Set only when this request is the SAME caller retrying a renewal whose
     * successor was never delivered. It unlocks two things that are otherwise
     * refused: discarding that pending successor, and overwriting this command
     * id's stored response with the new one. Both are safe only together and
     * only here — see `selfHealStranded`.
     */
    let renewalRecovery = false;

    await beforeStep(7);
    const existingRows = await tx<
      {
        workspace_id: string;
        stream_id: string;
        request_hash: string;
        response: unknown;
      }[]
    >`
      SELECT workspace_id, stream_id, request_hash, response
      FROM swarm.idempotency_keys
      WHERE principal_kind = ${auth.credentialKind}
        AND principal_id = ${canonicalPrincipal(auth.actor)}
        AND command_id = ${commandId}
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (existing) {
      const matches = existing.request_hash === hash &&
        existing.workspace_id === route.workspaceId &&
        existing.stream_id === route.streamId;
      /* ★ THE ONE REPLAY THAT MUST NOT REPLAY. A renewal stores ids and expiry and
         NEVER the successor's secret (renewalReplayFields), because a live credential
         at rest in a table read on every replay is a worse trade than any outage. So
         replaying a renewal whose response was lost hands back a body with no
         credential, and the client correctly refuses to invent one — it raises
         `successor_not_recoverable` and tells a human to issue a new credential. An
         agent dying because one HTTP response was dropped is the exact failure §2.3
         renewal exists to prevent.

         When the successor that reply names is still LIVE and still UNUSED, nobody
         ever received it — that is what unused means — so the honest answer is not to
         re-send an answer we cannot re-send, but to discard that successor and issue a
         fresh one. Falling through to re-execute is what does that; `selfHealStranded`
         is true only here, so only the caller that created the stranded successor can
         cause it to be discarded. The audit row says `renewal_recovered` rather than
         `replayed` because this is not a replay: a different credential comes back. */
      const recovering = matches &&
        kind === RENEW_AGENT_TOKEN_KIND &&
        await strandedSuccessorOf(tx, existing.response) !== null;
      if (!recovering) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: matches ? "replayed" : "conflict",
          reason: matches ? null : "command_id_conflict",
          detail: ignoredIdentity,
          hash,
        });
        return matches
          ? replayResult(storedResponse(existing.response), kind)
          : { status: 409, body: { error: "command_id_conflict" } };
      }
      renewalRecovery = true;
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "renewal_recovered",
        reason: "successor_never_delivered",
        detail: ignoredIdentity,
        hash,
      });
    }
    await afterStep(7);

    if (command.kind === "remove_member") {
      const serverTime = await tx<{ now_ms: string | number }[]>`
        SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
      `;
      const serverNowMs = Number(serverTime[0]?.now_ms);
      if (
        auth.credentialKind !== "user" ||
        !hasFreshInteractiveAuth(
          auth.interactiveAuthAtSeconds,
          serverNowMs,
        )
      ) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "authn",
          reason: "fresh_auth_required",
          detail:
            "Sign in again, then retry member removal. No membership change was recorded.",
          hash,
        });
        return {
          status: 401,
          body: {
            error: "fresh_auth_required",
            message:
              "Sign in again, then retry member removal. No membership change was recorded.",
          },
        };
      }
    }

    if (command.kind === "post_signal") {
      const signalTarget = await resolveSignalWriteTarget(
        tx,
        route,
        auth,
        command,
      );
      if (signalTarget === null) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "authz",
          reason: "signal target or reply is not eligible",
          hash,
        });
        return { status: 403, body: { error: "forbidden" } };
      }
      const rateLimit = await enforceSignalRate(
        tx,
        auth,
        route.workspaceId,
      );
      if (rateLimit !== null) {
        const detail =
          `${rateLimit.bucket} limit ${rateLimit.limit} signals/hour; resets at ${rateLimit.resetsAt}`;
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "rate_limit",
          reason: "rate_limited",
          detail,
          hash,
        });
        await tx`
          INSERT INTO swarm.security_alerts (kind, subject, detail)
          VALUES (
            'signal_rate_limit',
            ${rateLimit.bucket},
            ${tx.json({
              workspace_id: route.workspaceId,
              credential_kind: auth.credentialKind,
              credential_id: auth.credentialId,
              limit: rateLimit.limit,
              resets_at: rateLimit.resetsAt,
            })}::jsonb
          )
        `;
        return {
          status: 429,
          body: {
            error: "rate_limited",
            message: `Signal refused: ${detail}.`,
            limit: rateLimit.limit,
            resets_at: rateLimit.resetsAt,
          },
        };
      }

      const signal = await postSignal(
        tx,
        route,
        auth,
        command,
        signalTarget,
      );
      const signalResponse: StoredResponse = {
        ok: true,
        event_ids: [],
        signal,
      };
      const inserted = await tx<{ command_id: string }[]>`
        INSERT INTO swarm.idempotency_keys (
          principal_kind, principal_id, command_id,
          workspace_id, stream_id, request_hash, response
        ) VALUES (
          ${auth.credentialKind},
          ${canonicalPrincipal(auth.actor)},
          ${commandId},
          ${route.workspaceId}::uuid,
          ${route.streamId}::uuid,
          ${hash},
          ${tx.json(signalResponse as unknown as postgres.JSONValue)}::jsonb
        )
        ON CONFLICT (principal_kind, principal_id, command_id) DO NOTHING
        RETURNING command_id
      `;
      if (inserted.length === 0) {
        throw new LedgerRace(
          auth,
          commandId,
          kind,
          route.workspaceId,
          route.streamId,
          hash,
        );
      }
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "accepted",
        detail: ignoredIdentity,
        hash,
      });
      await chargeSpend(tx, "signal_post");
      return {
        status: 200,
        body: {
          status: "accepted",
          ...signalResponse,
          events: [],
          min_client_version: minClientVersion,
        },
      };
    }

    await beforeStep(8);
    const streamRows = await tx<{ head_seq: string | number }[]>`
      SELECT head_seq
      FROM swarm.streams
      WHERE stream_id = ${route.streamId}::uuid
        AND workspace_id = ${route.workspaceId}::uuid
      FOR UPDATE
    `;
    if (!streamRows[0]) throw new Error("validated stream disappeared");
    const headSeq = Number(streamRows[0].head_seq);
    await afterStep(8);

    await beforeStep(9);
    const timeRows = await tx<{ now_ms: string | number }[]>`
      SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
    `;
    let now = Number(timeRows[0]?.now_ms);
    const workspaceWire =
      (WORKSPACE_COMMAND_KINDS as readonly string[]).includes(command.kind)
        ? command as ConnectCommand
        : null;
    let prepared: PreparedWorkspace | null = null;
    let priorRow: Record<string, unknown> | undefined;
    let prior: TaskState | null = null;
    let ctx: DecideCtx | null = null;
    if (workspaceWire !== null) {
      prepared = await prepareWorkspaceCommand(
        tx,
        route,
        auth,
        workspaceWire,
        commandId,
        headSeq,
        now,
        renewalRecovery,
      );
    } else {
      const taskCommand = command as Command;
      const taskRows = await tx<Record<string, unknown>[]>`
        SELECT
          task_id, slug, lifecycle, version, epoch, owner,
          lease_expiry, submission, closed_disposition, updated_at
        FROM swarm.tasks
        WHERE stream_id = ${route.streamId}::uuid
          AND task_id = ${taskCommand.task_id}::uuid
        LIMIT 1
      `;
      priorRow = taskRows[0];
      prior = stateFromRow(priorRow);
      ctx = await buildContext(
        tx,
        route,
        auth,
        taskCommand,
        commandId,
        prior,
        headSeq,
        now,
      );
    }
    await afterStep(9);

    await beforeStep(10);
    let outcome: FreshOutcome;
    if (prepared !== null) {
      let decision = decideWorkspace(
        prepared.state,
        prepared.command,
        prepared.ctx,
      ) as Decision;
      if (
        decision.ok &&
        prepared.command.kind === "accept_invitation" &&
        !await consumeInvitation(tx, prepared, auth, now)
      ) {
        const retryTime = await tx<{ now_ms: string | number }[]>`
          SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
        `;
        now = Number(retryTime[0]?.now_ms);
        prepared = await prepareWorkspaceCommand(
          tx,
          route,
          auth,
          workspaceWire!,
          commandId,
          headSeq,
          now,
        );
        decision = decideWorkspace(
          prepared.state,
          prepared.command,
          prepared.ctx,
        ) as Decision;
        if (decision.ok) {
          throw new Error("invitation atomic consumption lost without a domain state change");
        }
      }
      // Same shape as the invitation consumption above: the fence is the
      // authority on who won, so a loser re-reads state and re-decides, which
      // turns the race into a named domain refusal instead of a 500.
      if (
        decision.ok &&
        prepared.command.kind === RENEW_AGENT_TOKEN_KIND &&
        !await fenceRenewal(tx, prepared, auth, decision.events, now)
      ) {
        const retryTime = await tx<{ now_ms: string | number }[]>`
          SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms
        `;
        now = Number(retryTime[0]?.now_ms);
        prepared = await prepareWorkspaceCommand(
          tx,
          route,
          auth,
          workspaceWire!,
          commandId,
          headSeq,
          now,
          false,
        );
        decision = decideWorkspace(
          prepared.state,
          prepared.command,
          prepared.ctx,
        ) as Decision;
        if (decision.ok) {
          throw new Error("renewal fence lost without a domain state change");
        }
      }
      const response: StoredResponse = decision.ok
        ? {
          ok: true,
          event_ids: decision.events.map((event) => event.event_id),
          ...(prepared.command.kind === "invite_member"
            ? { invitation_id: prepared.command.invitation_id }
            : prepared.command.kind === "create_agent_principal"
            ? { principal_id: prepared.command.principal_id }
            : prepared.command.kind === "mint_agent_token"
            ? {
              token_id: prepared.command.token_id,
              principal_id: prepared.command.principal_id,
              run_id: prepared.command.run_id,
              /* ★ expires_at IS WHAT MAKES THE CREDENTIAL RENEWABLE, AND IT WAS MISSING.
               *
               * Without it, the whole of §2.3 is unreachable through the documented way of
               * giving an agent a credential. src/cloud/renewal.ts `due()` returns false the
               * moment `expiresAt === null` — deliberately, because renewing on an unknown
               * deadline would supersede a predecessor that might have had fifty-nine good
               * minutes left. So a minted credential never renewed proactively, ran to its
               * TTL, and the agent stopped. That is the exact failure renewal exists to
               * prevent, reached through the front door.
               *
               * FOUND BY DOGFOODING, not by a test: a 120s credential was minted, used at
               * 105s, and no successor was ever written to the agent credential store. The
               * suites never caught it because they drive renewal by constructing the
               * artifact themselves rather than by taking what mint actually returns.
               *
               * `renewal.ts`'s own comment asserted the opposite — "cswarm token mint and the
               * connect page both state the expiry now" — which is how it stayed invisible.
               * A comment claiming a field exists is not the field existing.
               *
               * Read off the EVENT payload, the same source renewalReplayFields uses, rather
               * than recomputed from ttl_ms here: two derivations of one instant drift, and
               * the event is what the database actually stored. The client's artifact parser
               * already accepts this shape — it has exactly two, with and without this key. */
              ...(typeof record(decision.events[0]?.payload)?.expires_at === "number"
                ? {
                  expires_at: new Date(
                    record(decision.events[0]?.payload)!.expires_at as number,
                  ).toISOString(),
                }
                : {}),
            }
            : prepared.command.kind === RENEW_AGENT_TOKEN_KIND
            ? renewalReplayFields(prepared, decision.events)
            : { workspace_id: route.workspaceId }),
        }
        : {
          ok: false,
          reason: decision.reason,
          detail: decision.detail,
          class: decision.class,
          event_ids: decision.events.map((event) => event.event_id),
        };
      outcome = {
        status: "fresh",
        decision,
        response,
        events: decision.events,
      };
    } else {
      outcome = applyCommand(
        new Map(),
        prior,
        command as Command,
        ctx!,
      ) as FreshOutcome;
      if (outcome.status !== "fresh") {
        throw new Error("empty in-memory ledger unexpectedly replayed/conflicted");
      }
    }
    await afterStep(10);

    if (!outcome.decision.ok && outcome.decision.class === "authz") {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: outcome.decision.reason,
        detail: [ignoredIdentity, outcome.decision.detail].filter(Boolean).join("; "),
        hash,
      });
      return { status: 403, body: { error: "forbidden" } };
    }

    // Free-tier ceilings are charged only against a command that would
    // otherwise be accepted: a caller who is not entitled to invite is refused
    // above and never learns anything about the workspace's remaining budget.
    // Nothing is appended or ledgered when a ceiling refuses, so a retry after
    // the window rolls over is the same fresh command.
    if (outcome.decision.ok) {
      const budget = await enforceFreeTierBudget(tx, auth, route, command, hash);
      if (budget !== null) return budget;
    }

    await beforeStep(11);
    await appendEvents(tx, outcome.events);
    if (outcome.events.length > 0) {
      await tx`
        UPDATE swarm.streams
        SET head_seq = ${headSeq + outcome.events.length}
        WHERE stream_id = ${route.streamId}::uuid
      `;
    }
    await afterStep(11);

    await beforeStep(12);
    if (prepared !== null) {
      await updateWorkspaceProjection(tx, route, prepared, outcome.events);
    } else {
      await updateProjection(
        tx,
        route,
        prior,
        priorRow?.updated_at instanceof Date ? priorRow.updated_at : null,
        outcome.events,
        now,
      );
    }
    await afterStep(12);

    await beforeStep(13);
    if (prepared === null) {
      await applyEventSideEffects(tx, outcome.events);
    }
    await afterStep(13);

    await beforeStep(14);
    const inserted = await tx<{ command_id: string }[]>`
      INSERT INTO swarm.idempotency_keys (
        principal_kind, principal_id, command_id,
        workspace_id, stream_id, request_hash, response
      ) VALUES (
        ${auth.credentialKind},
        ${canonicalPrincipal(auth.actor)},
        ${commandId},
        ${route.workspaceId}::uuid,
        ${route.streamId}::uuid,
        ${hash},
        ${tx.json(outcome.response as unknown as postgres.JSONValue)}::jsonb
      )
      -- The conflict target already exists in exactly one legitimate case: a
      -- renewal recovery, where this command id's stored response named a
      -- successor that was never delivered and has just been replaced. Its
      -- response must be overwritten or the NEXT retry would replay the dead
      -- successor's ids for ever. Every other conflict is a concurrent writer
      -- and must still lose: with the flag false the WHERE excludes the row,
      -- nothing is returned, and LedgerRace is raised exactly as before.
      ON CONFLICT (principal_kind, principal_id, command_id) DO UPDATE
        SET response = EXCLUDED.response
        WHERE ${renewalRecovery}
      RETURNING command_id
    `;
    if (inserted.length === 0) {
      throw new LedgerRace(
        auth,
        commandId,
        kind,
        route.workspaceId,
        route.streamId,
        hash,
      );
    }
    await insertAudit(tx, {
      auth,
      commandKind: kind,
      workspaceId: route.workspaceId,
      streamId: route.streamId,
      outcome: outcome.decision.ok ? "accepted" : "domain",
      reason: outcome.decision.ok ? null : outcome.decision.reason,
      detail: [
        ignoredIdentity,
        outcome.decision.ok ? null : outcome.decision.detail,
      ].filter(Boolean).join("; "),
      hash,
    });

    // §8 spend proxies, charged on the accepted path only. A command the
    // reducer refused created no cost, and metering refusals would let a caller
    // with no entitlement at all drive the platform into signup-paused.
    const spendProxy = SPEND_PROXY_BY_COMMAND[command.kind];
    if (outcome.decision.ok && spendProxy !== undefined) {
      await chargeSpend(tx, spendProxy);
    }
    await afterStep(14);

    await beforeStep(15);
    const freshOnly: Record<string, unknown> = {};
    if (prepared?.command.kind === "invite_member") {
      freshOnly.invitation_token = prepared.invitationToken;
      const inviters = await tx<{ display_name: string }[]>`
        SELECT display_name
        FROM swarm.users
        WHERE user_id = ${auth.actor.user}::uuid
        LIMIT 1
      `;
      freshOnly.workspace_id = route.workspaceId;
      freshOnly.workspace_name = displayLabel(
        prepared.state.workspace.name,
        "this swarm",
      );
      freshOnly.inviter_display_name = displayLabel(
        inviters[0]?.display_name,
        "the inviter",
      );
      freshOnly.inviter_user_id = auth.actor.user;
    } else if (
      prepared?.command.kind === "mint_agent_token" ||
      prepared?.command.kind === RENEW_AGENT_TOKEN_KIND
    ) {
      freshOnly.agent_token = prepared.agentToken;
    }
    const result: HttpResult =
      prepared?.command.kind === "accept_invitation" && !outcome.decision.ok
        ? { status: 403, body: { error: "forbidden" } }
        : outcome.decision.ok
      ? {
        status: 200,
        body: {
          status: "accepted",
          ...outcome.response,
          events: outcome.events,
          min_client_version: minClientVersion,
          ...freshOnly,
        },
      }
      : {
        status: 200,
        body: {
          status: "rejected",
          ...outcome.response,
          min_client_version: minClientVersion,
        },
      };
    await afterStep(15);
    return result;
  });
}

async function resolveLedgerRace(error: LedgerRace): Promise<HttpResult> {
  return await db.begin(async (tx) => {
    await setTransaction(tx);
    const rows = await tx<
      {
        workspace_id: string;
        stream_id: string;
        request_hash: string;
        response: unknown;
      }[]
    >`
      SELECT workspace_id, stream_id, request_hash, response
      FROM swarm.idempotency_keys
      WHERE principal_kind = ${error.auth.credentialKind}
        AND principal_id = ${canonicalPrincipal(error.auth.actor)}
        AND command_id = ${error.commandId}
      LIMIT 1
    `;
    const winner = rows[0];
    if (!winner) throw new Error("idempotency race winner is missing");
    const matches = winner.request_hash === error.hash &&
      winner.workspace_id === error.workspaceId &&
      winner.stream_id === error.streamId;
    await insertAudit(tx, {
      auth: error.auth,
      commandKind: error.commandKind,
      workspaceId: error.workspaceId,
      streamId: error.streamId,
      outcome: matches ? "replayed" : "conflict",
      reason: matches ? null : "command_id_conflict",
      hash: error.hash,
      detail: "resolved concurrent idempotency race",
    });
    return matches
      ? replayResult(storedResponse(winner.response), error.commandKind)
      : { status: 409, body: { error: "command_id_conflict" } };
  });
}

async function handlePostRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const kind = commandKind(body);
  if (
    typeof body.command_id !== "string" ||
    !COMMAND_ID_RE.test(body.command_id)
  ) {
    logCommandFailure(
      "command_pre_auth_failure",
      kind,
      "validation",
      "invalid command_id",
    );
    return json(400, { error: "invalid_request" });
  }

  const credential = bearer(request);
  if (!credential) {
    logCommandFailure(
      "command_pre_auth_failure",
      kind,
      "authn",
      "missing bearer",
    );
    return json(401, { error: "unauthenticated" });
  }

  let verifiedHuman: VerifiedHuman | null = null;
  let agentTokenHash: Uint8Array | null = null;
  if (credential.startsWith("swm_agt_")) {
    if (!AGENT_TOKEN_RE.test(credential)) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "invalid agent token",
      );
      return json(401, { error: "unauthenticated" });
    }
    agentTokenHash = await sha256(credential);
  } else {
    const [
      { data, error },
      { data: claimsData, error: claimsError },
    ] = await Promise.all([
      authClient.auth.getUser(credential),
      authClient.auth.getClaims(credential),
    ]);
    if (error || claimsError || !data.user || !claimsData?.claims) {
      logCommandFailure(
        "command_pre_auth_failure",
        kind,
        "authn",
        "unverified user token",
      );
      return json(401, { error: "unauthenticated" });
    }
    const metadata = record(data.user.user_metadata);
    const email = normalizedEmail(data.user.email);
    const displayNameCandidate = [
      metadata?.full_name,
      metadata?.name,
      metadata?.user_name,
      email?.split("@")[0],
    ].find((value) => typeof value === "string" && value.length > 0);
    const strippedDisplayName = stripControls(
      typeof displayNameCandidate === "string"
        ? displayNameCandidate.replace(ANSI_ESCAPE_GLOBAL_RE, "")
        : null,
    )?.trim().slice(0, 120);
    verifiedHuman = {
      userId: data.user.id,
      email,
      displayName: strippedDisplayName || "Coswarm User",
      identityVerified: data.user.email_confirmed_at !== undefined &&
        data.user.email_confirmed_at !== null,
      interactiveAuthAtSeconds: newestInteractiveAmrSeconds(claimsData.claims),
    };
  }

  try {
    const result = await handleTransaction(
      body,
      verifiedHuman,
      agentTokenHash,
    );
    return json(result.status, result.body);
  } catch (error) {
    if (error instanceof LedgerRace) {
      try {
        const result = await resolveLedgerRace(error);
        return json(result.status, result.body);
      } catch (raceError) {
        console.error("command race resolution failed", safeError(raceError));
      }
    }
    const isTestRollback = error instanceof TestRollback;
    const isLockTimeout = dbCode(error) === "55P03";
    logCommandFailure(
      "command_request_failure",
      kind,
      "error",
      isTestRollback
        ? "test_rollback"
        : isLockTimeout
        ? "lock_timeout"
        : "internal_error",
      safeError(error),
    );
    return isLockTimeout
      ? json(503, { error: "temporarily_unavailable" })
      : json(500, { error: "internal_error" });
  }
}

async function handleRequest(request: Request): Promise<Response> {
  // Browser command calls carry Authorization, apikey and JSON headers, so they
  // are preflighted. OPTIONS must terminate before parsing, auth or database work.
  if (request.method === "OPTIONS") {
    return commandPreflight(request, allowedCommandOrigins, commandEnvironment);
  }
  return withCommandCors(
    request,
    await handlePostRequest(request),
    allowedCommandOrigins,
    commandEnvironment,
  );
}

Deno.serve(handleRequest);
