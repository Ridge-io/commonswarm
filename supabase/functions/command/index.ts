import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";
import {
  agentCredentialRevoked,
  loadAgentCredential,
  type AgentAuthRow,
} from "../_shared/agent-auth.ts";
import {
  ANSI_ESCAPE_GLOBAL_RE,
  sanitizeSignalText,
  SIGNAL_BODY_MAX,
  SIGNAL_UNSAFE_GLOBAL_RE,
} from "../_shared/signal-text.ts";
import {
  CHANNEL_PURPOSE_MAX,
  channelSlugProblem,
  chatSignalKeys,
  chatSignalShapeProblem,
  commandFieldsMessage,
  CHANNEL_ID_RULE_TEXT,
  MODEL_CONTROL_RULE_TEXT,
  MODEL_MAX,
  MODEL_RULE_TEXT,
  normalizeChannelSlug,
  SIGNAL_KINDS,
  type SignalKind,
  parseSignalRecipients,
  type SignalRecipient,
  unknownChannelMessage,
  uuidFieldRuleText,
} from "../_shared/channels.ts";
import {
  commandAllowedOrigins,
  commandPreflight,
  withCommandCors,
} from "./cors.ts";
import {
  hasFreshInteractiveAuth,
  newestInteractiveAmrSeconds,
} from "./fresh-auth.ts";
import {
  classifyCommandFailure,
  dbCode,
  durableCommandFailure,
  finishCommandFailure,
  safeError,
  type DurableCommandFailure,
} from "./failures.ts";
import {
  ACK_AGENT_DELIVERY_KIND,
  ackAgentDelivery,
  CLAIM_AGENT_INBOX_KIND,
  claimAgentInbox,
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_ACK_RATE_LIMIT_PER_MINUTE,
  DELIVERY_CAPABILITIES,
  DELIVERY_CLAIM_DEFAULT_LIMIT,
  DELIVERY_CLAIM_MAX_LIMIT,
  DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE,
  DELIVERY_CLIENT_ERROR_CODES,
  DELIVERY_MAX_OUTSTANDING_LEASES,
  hydrateDeliveryRefs,
  parseClaimLedger,
  type AckAgentDeliveryCommand,
  type ClaimAgentInboxCommand,
  type DeliveryAckOutcome,
} from "./durable-delivery.ts";
import {
  FILE_BUCKET,
  FILE_COMMAND_KINDS,
  FILE_CREATE_RATE_LIMIT_PER_HOUR,
  FILE_DOWNLOAD_URL_KIND,
  FILE_RESTORE_KIND,
  FILE_TOMBSTONE_KIND,
  FILE_VERSION_COMMIT_KIND,
  FILE_VERSION_CREATE_KIND,
  fileDownloadUrl,
  fileRestore,
  fileTombstone,
  fileVersionCommit,
  fileVersionCreate,
  validateFileCommand,
  type FileCommand,
  type FileStorage,
} from "./file-artifacts.ts";
import { drainFilePurgeQueue } from "./file-artifacts.ts";
import {
  parseSignalAttachmentRefs,
  signalAttachmentListRefusal,
  SIGNAL_ATTACHMENT_MAX,
  type SignalAttachmentRef,
} from "./signal-attachments.ts";
import {
  markAgentSignalsSeen,
  markHumanSignalsSeen,
  SIGNALS_SEEN_KIND,
  SIGNALS_SEEN_MAX_IDS,
  type SignalsSeenCommand,
} from "./human-receipts.ts";
// Supabase's edge graph cannot resolve the NodeNext `.js` specifiers in the
// frozen TypeScript core. This checked-in bundle is regenerated directly from
// src/protocol/index.ts by build:command-core; it is not a second implementation.
import {
  applyCommand,
  canonicalPrincipal,
  decideWorkspace,
  DISPOSITIONS,
  FEEDBACK_CATEGORIES,
  normalizedFeedbackBody,
  normalizedFeedbackContext,
  reduceTask,
  reduceWorkspace,
  RENEWAL_HORIZON_DEFAULT_MS,
  RENEWAL_HORIZON_MAX_MS,
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
  | { kind: "archive_workspace" }
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
    renewal_kind?: "timeboxed" | "standing";
    renewal_horizon_ms?: number | null;
  }
  | { kind: "revoke_agent_token"; token_id: string }
  // Self-description: no target field on purpose — the presenting agent
  // credential IS the subject, the same fence shape as renew_agent_token.
  | { kind: "declare_agent_model"; model: string | null }
  | {
    kind: "submit_feedback";
    feedback_id: string;
    category: "bug" | "idea" | "friction";
    body: string;
    context: Record<string, string> | null;
  }
  // Human relabeling: the mirror of declare, gated like revoke_agent_principal.
  | { kind: "set_agent_model"; principal_id: string; model: string | null }
  // §2.3 successor endpoint. It has no fields on purpose: the presented
  // predecessor credential IS the request, and accepting any target field here
  // is exactly the escalation the fence exists to stop.
  | { kind: "renew_agent_token" };


interface SignalCommand {
  kind: "post_signal";
  signal_kind: SignalKind;
  body: string;
  to_user_id: string | null;
  to_agent_principal_id?: string | null;
  in_reply_to?: string | null;
  about: string | null;
  attachments?: SignalAttachmentRef[];
  until_ms?: number;
  /* Chat fields. Each is INDEPENDENTLY optional — see chatSignalKeys. A body
   * that carries none of them is what every installed client sends. */
  channel?: string;
  thread_root_id?: string | null;
  broadcast_to_channel?: boolean;
  /* The multi-recipient address. When present it is non-empty and every entry
   * is well formed: the validator refuses anything else, and entry 0 becomes
   * the row's scalar to_user_id / to_agent_principal_id. */
  to?: SignalRecipient[];
}

/** Channel authority. Self-contained like post_signal: emits no protocol event. */
type ChannelCommand =
  | { kind: "channel_create"; slug: string; purpose: string | null }
  | { kind: "channel_rename"; channel_id: string; slug: string }
  | { kind: "channel_archive"; channel_id: string };

interface ChannelRecord {
  channel_id: string;
  workspace_id: string;
  slug: string;
  purpose: string | null;
  created_by_principal: string;
  created_by_kind: CredentialKind;
  created_at: string;
  archived_at: string | null;
}

interface SignalAttachment extends SignalAttachmentRef {
  name: string;
  content_type: string;
  size_bytes: number;
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
  attachments: SignalAttachment[];
  until: string;
  created_at: string;
  /* Added by the chat migrations. Old clients ignore unknown top-level fields
   * by contract (src/cloud/signals.ts:315-326), so returning them is safe. */
  channel_id: string | null;
  thread_root_id: string | null;
  broadcast_to_channel: boolean;
  /* The whole recipient set, in the order the sender named it. Derived the
   * same way swarm_read.signals derives it: the rows when there are rows, and
   * the scalar recipient when there are none, so a signal posted with the old
   * scalar shape and one posted with a one-entry `to` read identically. */
  recipients: SignalRecipient[];
}

type DeliveryCommand = ClaimAgentInboxCommand | AckAgentDeliveryCommand;

type ValidatedCommand =
  | Command
  | ConnectCommand
  | SignalCommand
  | ChannelCommand
  | SignalsSeenCommand
  | DeliveryCommand
  | FileCommand;

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
  | { kind: "archive_workspace" }
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
    renewal_kind: "timeboxed" | "standing";
    renewal_horizon_ms: number | null;
  }
  | { kind: "revoke_agent_token"; token_id: string }
  | { kind: "declare_agent_model"; model: string | null }
  | {
    kind: "submit_feedback";
    feedback_id: string;
    category: "bug" | "idea" | "friction";
    body: string;
    context: Record<string, string> | null;
  }
  | { kind: "set_agent_model"; principal_id: string; model: string | null }
  | {
    kind: "renew_agent_token";
    successor_token_id: string;
    scopes: string[];
  };

interface RenewalGrantFacts {
  renewal_grant_id: string;
  kind: "timeboxed" | "standing";
  max_successors: number | null;
  successors_used: number;
  /** Issued but never delivered; subtracted from `successors_used` for the ceiling. */
  successors_stranded: number;
  horizon_expires_at: number | null;
  revoked_at: number | null;
  /** swarm.renewal_grants.suspension_active, unmodified. See the protocol interface. */
  suspension_active: boolean;
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
  grant_preflight_code:
    | "renewal_grant_not_found"
    | "renewal_grant_revoked"
    | "renewal_grant_suspended"
    | "renewal_idle_suspended"
    | "renewal_horizon_reached"
    | "renewal_device_unavailable"
    | "renewal_device_mismatch"
    | null;
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
  /* File-artifact replay fields (★R16): a lost create response must replay the
   * SAME pending slot and upload capability, so the allowlist carries them. */
  file_id?: string;
  version_id?: string;
  version_n?: number;
  name?: string;
  upload_path?: string;
  upload_token?: string;
  upload_expires_in_seconds?: number;
  commit_deadline_note?: string;
  size_bytes?: number;
  sha256?: string | null;
  sha256_note?: string;
  reference?: string;
  content_type?: string;
  download_path?: string;
  download_url_expires_in_seconds?: number;
  restorable_until?: string;
  note?: string;
  restored?: boolean;
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
  grant_kind?: "timeboxed" | "standing";
  horizon_expires_at?: string | null;
  successors_remaining?: number | null;
  revoked_at?: string;
  /** Grant-resume replay fields. Neither is a credential. */
  renewal_grant_id?: string;
  resumed_at?: string;
  signal?: SignalRecord;
  channel?: ChannelRecord;
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
/* MUST match AGENT_TOKEN_MAX_TTL_MS in src/protocol/workspace-commands.ts — this request-shape
 * bound is hand-written, NOT generated into _shared/protocol.js, and it drifted once: the
 * protocol moved to 24h (operator ruling 2026-08-18) while this line still said 8h, so the
 * server refused mints the reducer would have accepted. */
const AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* Changed-value declarations only; unchanged redeclares are free no-ops. */
const MODEL_DECLARE_RATE_LIMIT_PER_HOUR = 10;
const FEEDBACK_RATE_LIMIT_PER_HOUR = 10;
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
const REGISTER_DEVICE_KIND = "register_device";
const CREATE_WORKSPACE_KIND = "create_workspace";
const RENEW_AGENT_TOKEN_KIND = "renew_agent_token";
const MINT_CAPABILITY_KIND = "mint_capability_url";
const REVOKE_CAPABILITY_KIND = "revoke_capability_url";
/**
 * The exit from an idle suspension. Not a WORKSPACE_COMMAND_KIND and not in the
 * reducer: it changes no authority, grants nothing, and emits no event — it
 * clears a lapse flag on a grant the caller could already revoke. Handled here,
 * audited here, and gated by swarm.resume_renewal_grant.
 */
const RESUME_RENEWAL_GRANT_KIND = "resume_renewal_grant";

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
 *
 * RAISED 3 -> 10 on 2026-08-09, operator decision. The cap was reached by two
 * ordinary collaborators doing ordinary work, and because archiving is
 * unreachable (D-075) there was no way back down: the escape hatch this comment
 * names does not exist in any surface. A cap whose only remedy is unimplemented
 * is a hard ceiling, and it blocked a release-verification test.
 *
 * 10 still bounds tenant minting, which is what §9 P5 asks for. The right fix
 * remains archiving; this removes the ceiling until that exists.
 */
const FREE_TIER_WORKSPACE_LIMIT = 10;

/**
 * §9 P5 again: the same identity archiving and recreating in a loop would slip
 * the live cap above, so creations themselves are capped over a rolling day.
 * Deliberately larger than FREE_TIER_WORKSPACE_LIMIT — a user who archives a
 * mistake and starts over must not be locked out for a day.
 *
 * RAISED 6 -> 20 in the same change, to keep that relationship true. Left at 6
 * it would have become SMALLER than the live cap, silently inverting the
 * invariant this comment states and capping a legitimate user at 6 creations
 * while telling them they may hold 10.
 */
const SELF_SERVE_CREATE_DAILY_LIMIT = 20;

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
 *   signal_post        row writes (an earlier version of this line said "plus Realtime
 *                      fan-out" — there is no Realtime fan-out; it was aspirational and read
 *                      as current behaviour)
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
/* Channel authority. Deliberately NOT in WORKSPACE_COMMAND_KINDS: like
 * post_signal these are self-contained, emit no protocol event, and travel the
 * ordinary resolveRoute path rather than forcing stream.kind === "workspace".
 * Deliberately NOT in the agent denylist either — a channel grants nothing, so
 * gating it behind a human would force a person into the loop to make a label. */
const CHANNEL_COMMAND_KINDS = [
  "channel_create",
  "channel_rename",
  "channel_archive",
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
  "archive_workspace",
  "create_agent_principal",
  "mint_agent_token",
  "revoke_agent_principal",
  "set_agent_model",
  "revoke_agent_token",
  "renew_agent_token",
  "declare_agent_model",
  "submit_feedback",
  "post_signal",
  ...CHANNEL_COMMAND_KINDS,
  SIGNALS_SEEN_KIND,
  CLAIM_AGENT_INBOX_KIND,
  ACK_AGENT_DELIVERY_KIND,
  ...FILE_COMMAND_KINDS,
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
  "archive_workspace",
  "create_agent_principal",
  "mint_agent_token",
  "revoke_agent_principal",
  "set_agent_model",
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
  "declare_agent_model",
  "submit_feedback",
  RENEW_AGENT_TOKEN_KIND,
  SIGNALS_SEEN_KIND,
  CLAIM_AGENT_INBOX_KIND,
  ACK_AGENT_DELIVERY_KIND,
  ...FILE_COMMAND_KINDS,
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
  /* Session-mode pooling measured EXHAUSTED (EMAXCONNSESSION, pool_size 38,
   * 2026-08-31): warm isolates pinning max*idle slots ate the pool and every
   * "episodic 500" this month was this. Keep the per-isolate footprint minimal;
   * the durable fix is SWARM_DATABASE_URL on the transaction pooler (6543). */
  max: 2,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 10,
});
/**
 * Storage adapter for file artifacts (§7). Raw REST with the service role key:
 * the bucket is service-role-only (★R12), so every signed URL is minted here
 * and nowhere else. The runtime injects SUPABASE_SERVICE_ROLE_KEY.
 */
function fileStorage(): FileStorage {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) {
    throw new Error("file artifacts require SUPABASE_SERVICE_ROLE_KEY");
  }
  const headers = {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "content-type": "application/json",
  };
  const base = `${supabaseUrl}/storage/v1`;
  return {
    async signUpload(path) {
      // No upsert field: storage defaults to upsert OFF, which is load-bearing
      // (★R3) — a second PUT to a committed version's path must be refused.
      const response = await fetch(
        `${base}/object/upload/sign/${FILE_BUCKET}/${path}`,
        {
          method: "POST",
          // x-upsert explicitly false (★R3): the default is upsert-off, and
          // this pins it against a storage default ever moving. Whether hosted
          // storage honors both the header and the signature binding is S6's
          // to re-verify.
          headers: { ...headers, "x-upsert": "false" },
          body: "{}",
        },
      );
      if (!response.ok) {
        throw new Error(`storage upload sign failed: ${response.status}`);
      }
      const data = await response.json() as { url?: string };
      if (typeof data.url !== "string") {
        throw new Error("storage upload sign returned no url");
      }
      const relative = `/storage/v1${data.url}`;
      const token =
        new URL(relative, "http://relative.invalid").searchParams.get(
          "token",
        ) ?? "";
      return { path: relative, token };
    },
    async objectSize(path) {
      /* NOT a HEAD reading content-length. Measured on hosted storage 2026-08-18: Deno's
       * fetch always negotiates compression, hosted answers compressible objects with
       * content-encoding (br) and NO content-length, and the runtime strips the header
       * after transparent decompression — so every markdown over the CDN's compression
       * threshold read as "no object uploaded" while a 12-byte file passed. The local
       * container never compresses, which is why S4's e2e could not catch it (its
       * evidence named hosted HEAD semantics as not established; this is that gap).
       * The info endpoint's JSON `size` comes from object metadata, not transport. */
      const response = await fetch(
        `${base}/object/info/authenticated/${FILE_BUCKET}/${path}`,
        { headers },
      );
      if (!response.ok) return null;
      const info = await response.json().catch(() => null);
      const size = info && typeof info.size === "number" ? info.size : Number.NaN;
      return Number.isFinite(size) && size >= 0 ? size : null;
    },
    async removeObjects(paths) {
      // DELETE /object/{bucket} with prefixes removes what exists and reports
      // the rest in the body; only a transport/authorization failure is an
      // error. The drain treats "object absent" as already-deleted (see the
      // FileStorage contract) because pending-GC queues never-uploaded paths.
      const response = await fetch(`${base}/object/${FILE_BUCKET}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ prefixes: paths }),
        // S4 review item 1: a hung storage call must not hold the drain (and,
        // without waitUntil, the response) hostage. 3s is generous for a
        // same-network batch delete; a timeout is a recorded failed attempt.
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage object delete failed: ${response.status}`);
      }
    },
    async signDownload(path, filename, expiresInSeconds) {
      const response = await fetch(
        `${base}/object/sign/${FILE_BUCKET}/${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
        },
      );
      if (!response.ok) {
        throw new Error(`storage download sign failed: ${response.status}`);
      }
      const data = await response.json() as { signedURL?: string };
      if (typeof data.signedURL !== "string") {
        throw new Error("storage download sign returned no url");
      }
      // §5: always an attachment, never inline from our domain.
      return `/storage/v1${data.signedURL}&download=${
        encodeURIComponent(filename)
      }`;
    },
  };
}

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
  headers?: Record<string, string>;
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

function json(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(headers ?? {}),
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

  if ((FILE_COMMAND_KINDS as readonly string[]).includes(cmd.kind)) {
    return validateFileCommand(cmd);
  }

  if (cmd.kind === CLAIM_AGENT_INBOX_KIND) {
    const optionalKeys = Object.hasOwn(cmd, "limit") ? ["limit"] : [];
    const limit = Object.hasOwn(cmd, "limit")
      ? cmd.limit
      : DELIVERY_CLAIM_DEFAULT_LIMIT;
    const valid = exactKeys(cmd, [
      "kind",
      "listener_instance_id",
      ...optionalKeys,
    ]) &&
      typeof cmd.listener_instance_id === "string" &&
      UUID_RE.test(cmd.listener_instance_id) &&
      integer(limit, 1) &&
      (limit as number) <= DELIVERY_CLAIM_MAX_LIMIT;
    return valid
      ? {
        ok: true,
        command: {
          kind: "claim_agent_inbox",
          listener_instance_id: (cmd.listener_instance_id as string)
            .toLowerCase(),
          limit: limit as number,
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "claim_agent_inbox fields are malformed",
      };
  }

  if (cmd.kind === ACK_AGENT_DELIVERY_KIND) {
    const outcome = cmd.outcome;
    const lastError = Object.hasOwn(cmd, "last_error_code")
      ? cmd.last_error_code
      : null;
    const validOutcome = typeof outcome === "string" &&
      (DELIVERY_ACK_OUTCOMES as readonly string[]).includes(outcome);
    const failedTerminal = outcome === "failed_terminal";
    const validError = failedTerminal
      ? typeof lastError === "string" &&
        DELIVERY_CLIENT_ERROR_CODES.has(lastError)
      : lastError === null;
    const valid = exactKeys(cmd, [
      "kind",
      "signal_id",
      "lease_id",
      "listener_instance_id",
      "outcome",
      "last_error_code",
    ]) &&
      typeof cmd.signal_id === "string" &&
      UUID_RE.test(cmd.signal_id) &&
      ((typeof cmd.lease_id === "string" && UUID_RE.test(cmd.lease_id) &&
        typeof cmd.listener_instance_id === "string" &&
        UUID_RE.test(cmd.listener_instance_id)) ||
        (cmd.lease_id === null && cmd.listener_instance_id === null &&
          outcome === "observed")) &&
      validOutcome &&
      validError;
    return valid
      ? {
        ok: true,
        command: {
          kind: "ack_agent_delivery",
          signal_id: (cmd.signal_id as string).toLowerCase(),
          lease_id: typeof cmd.lease_id === "string"
            ? cmd.lease_id.toLowerCase()
            : null,
          listener_instance_id: typeof cmd.listener_instance_id === "string"
            ? cmd.listener_instance_id.toLowerCase()
            : null,
          outcome: outcome as DeliveryAckOutcome,
          last_error_code: lastError as string | null,
        },
      }
      : {
        ok: false,
        status: 400,
        reason: "ack_agent_delivery fields are malformed",
      };
  }

  if (cmd.kind === SIGNALS_SEEN_KIND) {
    const valid = exactKeys(cmd, ["kind", "signal_ids"]) &&
      Array.isArray(cmd.signal_ids) &&
      cmd.signal_ids.length >= 1 &&
      cmd.signal_ids.length <= SIGNALS_SEEN_MAX_IDS &&
      cmd.signal_ids.every((signalId) =>
        typeof signalId === "string" && UUID_RE.test(signalId)
      );
    return valid
      ? {
        ok: true,
        command: {
          kind: SIGNALS_SEEN_KIND,
          signal_ids: [...new Set(cmd.signal_ids as string[])]
            .map((signalId) => signalId.toLowerCase()),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: `signals_seen accepts 1..${SIGNALS_SEEN_MAX_IDS} signal ids`,
      };
  }

  /* Channel authority. Every refusal sentence below is BUILT from the same
   * constants the validator reads (supabase/functions/_shared/channels.ts), so
   * a changed bound or a new reserved name cannot leave a stale sentence
   * telling a caller a rule that is not enforced. */
  if (cmd.kind === "channel_create") {
    const required = ["slug"];
    const optional = ["purpose"];
    const keysOk = exactKeys(cmd, ["kind", ...required]) ||
      exactKeys(cmd, ["kind", ...required, ...optional]);
    const slugProblem = channelSlugProblem(cmd.slug);
    if (!keysOk || slugProblem !== null) {
      return {
        ok: false,
        status: 400,
        reason: keysOk
          ? slugProblem!
          : commandFieldsMessage("channel_create", required, optional),
      };
    }
    const rawPurpose = Object.hasOwn(cmd, "purpose") ? cmd.purpose : null;
    if (rawPurpose !== null && rawPurpose !== undefined && typeof rawPurpose !== "string") {
      return { ok: false, status: 400, reason: "A channel purpose is text." };
    }
    /* MEASURE THE STRING THAT IS STORED. The bound used to run on the sanitized
     * value and the insert stored the sanitized-and-TRIMMED value, so
     * "x".repeat(500) + " " was refused for length while the row it would have
     * written is 500 characters and satisfies the CHECK. The caller was told a
     * rule the persisted value does not break. declare_agent_model already
     * trims before its bound for this exact reason. */
    const purpose = typeof rawPurpose === "string"
      ? sanitizeSignalText(rawPurpose).trim() || null
      : null;
    if (purpose !== null && purpose.length > CHANNEL_PURPOSE_MAX) {
      return {
        ok: false,
        status: 400,
        reason: `A channel purpose is at most ${CHANNEL_PURPOSE_MAX} characters.`,
      };
    }
    return {
      ok: true,
      command: {
        kind: "channel_create",
        slug: normalizeChannelSlug(cmd.slug as string),
        purpose,
      },
    };
  }

  if (cmd.kind === "channel_rename") {
    const required = ["channel_id", "slug"];
    /* Field list first, slug rule second: a body with an extra key AND a bad
     * slug broke the shape before it broke the naming rule, and naming the
     * slug rule would send the caller to fix the wrong thing. */
    /* Three rules, three sentences, in the order they break. Bundling the uuid
     * test into the key test told a caller who sent exactly the right keys with
     * a malformed id that their FIELDS were wrong. Both arms found it. */
    const keysOk = exactKeys(cmd, ["kind", ...required]);
    const idOk = typeof cmd.channel_id === "string" &&
      UUID_RE.test(cmd.channel_id);
    const slugProblem = channelSlugProblem(cmd.slug);
    if (!keysOk || !idOk || slugProblem !== null) {
      return {
        ok: false,
        status: 400,
        reason: !keysOk
          ? commandFieldsMessage("channel_rename", required)
          : !idOk
          ? CHANNEL_ID_RULE_TEXT
          : slugProblem!,
      };
    }
    return {
      ok: true,
      command: {
        kind: "channel_rename",
        channel_id: (cmd.channel_id as string).toLowerCase(),
        slug: normalizeChannelSlug(cmd.slug as string),
      },
    };
  }

  if (cmd.kind === "channel_archive") {
    const required = ["channel_id"];
    const keysOk = exactKeys(cmd, ["kind", ...required]);
    const idOk = typeof cmd.channel_id === "string" &&
      UUID_RE.test(cmd.channel_id);
    if (!keysOk || !idOk) {
      return {
        ok: false,
        status: 400,
        reason: keysOk
          ? CHANNEL_ID_RULE_TEXT
          : commandFieldsMessage("channel_archive", required),
      };
    }
    return {
      ok: true,
      command: {
        kind: "channel_archive",
        channel_id: (cmd.channel_id as string).toLowerCase(),
      },
    };
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
    const attachmentKeys = Object.hasOwn(cmd, "attachments")
      ? ["attachments"]
      : [];
    const modernKeys = modernShape
      ? ["to_agent_principal_id", "in_reply_to"]
      : [];
    /* Each chat key is its OWN Object.hasOwn group, the until_ms/attachments
     * pattern. NEVER fold one into modernKeys: that pair is all-or-nothing and
     * every installed client always sends it, so widening it would 400 every
     * post after a perfectly ordered migration. */
    const chatKeys = chatSignalKeys(cmd);
    const channel = Object.hasOwn(cmd, "channel") ? cmd.channel : undefined;
    const threadRootId = Object.hasOwn(cmd, "thread_root_id")
      ? cmd.thread_root_id
      : undefined;
    const broadcastToChannel = Object.hasOwn(cmd, "broadcast_to_channel")
      ? cmd.broadcast_to_channel
      : undefined;
    /* `to` is its OWN Object.hasOwn group, through CHAT_SIGNAL_OPTIONAL_KEYS,
     * for the reason spelled out above: modernKeys is all-or-nothing and every
     * installed client always sends it. */
    const toList = Object.hasOwn(cmd, "to") ? cmd.to : undefined;
    const recipients = parseSignalRecipients(toList);
    /* An EMPTY list addresses nobody, so it must not make the rules below read
     * as "addressed". It is refused by chatSignalShapeProblem with a sentence
     * that says so; letting it fail baseValid instead would answer it with the
     * generic reason and hide which rule broke. */
    const addressedByList = recipients !== null && recipients.length > 0;
    const threadRoot = threadRootId === undefined
      ? null
      : threadRootId as string | null;
    const signalKinds: readonly SignalKind[] = SIGNAL_KINDS;
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
    /* Every rule the chat fields add lives in one pure function so the edge
     * cannot enforce half of them and so they are testable without Deno. Its
     * SENTENCE is what the caller gets back: routing it into the generic
     * "signal fields are malformed" reason would throw away the one part of
     * the refusal that says which rule was broken and why. */
    const chatShapeProblem = chatSignalShapeProblem({
      signal_kind: cmd.signal_kind,
      to_user_id: cmd.to_user_id,
      to_agent_principal_id: toAgentPrincipalId,
      in_reply_to: inReplyTo,
      ...(channel === undefined ? {} : { channel }),
      ...(threadRootId === undefined ? {} : { thread_root_id: threadRootId }),
      ...(broadcastToChannel === undefined
        ? {}
        : { broadcast_to_channel: broadcastToChannel }),
      ...(toList === undefined ? {} : { to: toList }),
    });
    const keysOk = exactKeys(cmd, [
      "kind",
      "signal_kind",
      "body",
      "to_user_id",
      "about",
      ...modernKeys,
      ...attachmentKeys,
      ...optionalKeys,
      ...chatKeys,
    ]);
    const baseValid = keysOk &&
      typeof cmd.signal_kind === "string" &&
      signalKinds.includes(cmd.signal_kind as SignalKind) &&
      typeof cmd.body === "string" &&
      cmd.body.length >= 1 &&
      cmd.body.length <= SIGNAL_BODY_MAX &&
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
      /* `to` is a THIRD way to address a signal, so every rule that reads the
       * scalar recipients reads it too. A working-on signal says what you are
       * doing and is addressed to nobody; a private reply is addressed by
       * in_reply_to and by nothing else. Both spellings are refused here, with
       * the same sentence, rather than one of them getting a better message
       * than the other. */
      (
        cmd.signal_kind !== "working-on" ||
        (
          cmd.to_user_id === null &&
          toAgentPrincipalId === null &&
          inReplyTo === null &&
          !addressedByList
        )
      ) &&
      (
        inReplyTo === null ||
        (
          cmd.signal_kind === "note" &&
          cmd.to_user_id === null &&
          toAgentPrincipalId === null &&
          !addressedByList
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
      ) &&
      (!Object.hasOwn(cmd, "attachments") ||
        parseSignalAttachmentRefs(cmd.attachments) !== null) &&
      /* thread_root_id's uuid shape is checked INSIDE chatSignalShapeProblem,
       * not here. Keeping a copy on the edge meant a bad uuid was refused with
       * the generic reason before the chat sentence could run, which is exactly
       * the split that function exists to prevent. */
      true;
    /* The chat sentence is only the right answer when NOTHING ELSE is wrong.
     * Gating on the key set alone was not enough: a body with signal_kind
     * "nope" AND a thread_root_id was told the thread-kind rule, when the first
     * broken rule is that "nope" is not a signal kind at all. A refusal that
     * names the wrong rule sends the caller to fix the wrong thing. */
    const valid = baseValid && chatShapeProblem === null;
    const attachments = Object.hasOwn(cmd, "attachments")
      ? parseSignalAttachmentRefs(cmd.attachments)
      : undefined;
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
          ...(attachments === undefined ? {} : { attachments: attachments! }),
          ...(cmd.until_ms === undefined
            ? {}
            : { until_ms: cmd.until_ms as number }),
          ...(channel === undefined || channel === null
            ? {}
            : { channel: normalizeChannelSlug(channel as string) }),
          ...(threadRootId === undefined
            ? {}
            : {
              thread_root_id: threadRoot === null
                ? null
                : threadRoot.toLowerCase(),
            }),
          ...(broadcastToChannel === undefined
            ? {}
            : { broadcast_to_channel: broadcastToChannel as boolean }),
          ...(addressedByList ? { to: recipients! } : {}),
        },
      }
      : {
        ok: false,
        status: 400,
        reason: baseValid && chatShapeProblem !== null
          ? chatShapeProblem
          : "signal fields are malformed or over their limits",
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

  // Self-description accepts exactly one caller field: the model text. The
  // subject is always the presenting agent principal — a body naming a
  // principal is a request to describe someone else and is refused at the
  // wire, the same fence shape as renewal above. Bounds MUST match the
  // reducer's model_invalid rule and agent_principals_model_bounded in
  // 20260730000001_workspace_access_lifecycle.sql — a hand-written duplicate
  // here has drifted before (the 8h→24h TTL constant above).
  if (cmd.kind === "declare_agent_model") {
    /* KEYS, then TYPE, in two steps. Bundled, `{model: 123}` -- exactly the
     * right keys, wrong type -- was answered with the field-list sentence,
     * which ends "and nothing else" and so tells the caller they sent an extra
     * key they did not send. channel_rename already split these two; a review
     * arm found that these did not. */
    if (!exactKeys(cmd, ["kind", "model"])) {
      return {
        ok: false,
        status: 400,
        reason: commandFieldsMessage("declare_agent_model", ["model"], [], {
          model: MODEL_RULE_TEXT,
        }),
      };
    }
    if (cmd.model !== null && typeof cmd.model !== "string") {
      return { ok: false, status: 400, reason: MODEL_RULE_TEXT };
    }
    /* Normalize EXACTLY as the reducer will (trim, empty -> null) BEFORE
     * validating, so the wire and the reducer agree on every input: a raw ""
     * is a clear, not a refusal, and a padded value is measured trimmed —
     * validating the raw value rejected what the reducer would accept and
     * vice versa (landing-round finding 1). */
    const declaredModel = cmd.model === null ? null : cmd.model.trim();
    const normalized = declaredModel === "" ? null : declaredModel;
    /* boundedText also refuses control characters, so answering it with the
     * LENGTH sentence names the wrong rule for a short model carrying one. */
    if (normalized !== null && CONTROL_RE.test(normalized)) {
      return { ok: false, status: 400, reason: MODEL_CONTROL_RULE_TEXT };
    }
    if (normalized !== null && !boundedText(normalized, MODEL_MAX)) {
      /* The LENGTH rule, not the field list. An arm sent a 121-character model
       * with exactly the right keys and was told which fields the command
       * takes, which is the wrong rule. */
      return { ok: false, status: 400, reason: MODEL_RULE_TEXT };
    }
    return {
      ok: true,
      command: { kind: "declare_agent_model", model: normalized },
    };
  }

  // Feedback from either credential kind. Normalize-before-validate (the
  // set_agent_model landing-round lesson): the body is trimmed first so the
  // wire and the reducer agree on every input. Bounds MUST match
  // normalizedFeedbackBody / normalizedFeedbackContext in
  // src/protocol/workspace-commands.ts — hand-written duplicates here have
  // drifted before (the 8h→24h TTL constant).
  if (cmd.kind === "submit_feedback") {
    /* Both the check and the sentence read FEEDBACK_CATEGORIES. They were two
     * typed copies of the same three names, which was invisible while the
     * reason went only to swarm.audit and user-facing the moment this lane put
     * it on the wire. */
    const required = ["feedback_id", "category", "body"];
    const optional = ["context"];
    const keysOk = exactKeys(cmd, ["kind", ...required]) ||
      exactKeys(cmd, ["kind", ...required, ...optional]);
    if (
      !keysOk ||
      typeof cmd.feedback_id !== "string" ||
      !UUID_RE.test(cmd.feedback_id) ||
      !FEEDBACK_CATEGORIES.includes(cmd.category as never) ||
      typeof cmd.body !== "string"
    ) {
      return {
        ok: false,
        status: 400,
        reason: commandFieldsMessage("submit_feedback", required, optional, {
          category: FEEDBACK_CATEGORIES.join("|"),
        }),
      };
    }
    /* The REDUCER's own normalizer, not a copy of it. This block used to
     * re-implement the trim, the bound and the control-character class, and the
     * comment above this validator already warned that hand-written duplicates
     * here have drifted before. Importing the constant was not enough: the
     * regex was still written out twice, byte for byte. Calling the function
     * makes the wire and the reducer the same decision by construction, and its
     * messages name which of the three rules broke instead of one sentence for
     * all of them. */
    /* The result types are declared here because deno infers this bundle from
     * the generated JavaScript rather than the .d.ts, so the discriminated
     * union does not narrow on `ok`. The shapes are the ones
     * src/protocol/workspace-commands.ts returns. */
    const normalizedBody = normalizedFeedbackBody(cmd.body) as
      | { ok: true; body: string }
      | { ok: false; message: string };
    if (!normalizedBody.ok) {
      return { ok: false, status: 400, reason: normalizedBody.message };
    }
    const trimmedBody = normalizedBody.body;
    /* Same again. The duplicate also folded control characters into the
     * "bounded strings" message, so a caller whose context was the right SIZE
     * but carried a control character was told the wrong rule. The reducer's
     * normalizer keeps those separate. */
    const normalizedContext = normalizedFeedbackContext(
      "context" in cmd ? cmd.context : null,
    ) as
      | { ok: true; context: Record<string, string> | null }
      | { ok: false; message: string };
    if (!normalizedContext.ok) {
      return { ok: false, status: 400, reason: normalizedContext.message };
    }
    const context = normalizedContext.context;
    return {
      ok: true,
      command: {
        kind: "submit_feedback",
        feedback_id: cmd.feedback_id.toLowerCase(),
        category: cmd.category as "bug" | "idea" | "friction",
        body: trimmedBody,
        context,
      },
    };
  }

  // Human relabeling: exactly a principal target and the model text. Same
  // normalize-before-validate order as declare (its landing-round finding 1),
  // and the SAME bounds — the reducer's shared normalizedModel is the source.
  if (cmd.kind === "set_agent_model") {
    /* Keys, then the id shape, then the model type -- the same three-step
     * split as declare_agent_model above, for the same reason. */
    if (!exactKeys(cmd, ["kind", "principal_id", "model"])) {
      return {
        ok: false,
        status: 400,
        reason: commandFieldsMessage(
          "set_agent_model",
          ["principal_id", "model"],
          [],
          { model: MODEL_RULE_TEXT },
        ),
      };
    }
    if (typeof cmd.principal_id !== "string" || !UUID_RE.test(cmd.principal_id)) {
      return {
        ok: false,
        status: 400,
        reason: uuidFieldRuleText("principal_id"),
      };
    }
    if (cmd.model !== null && typeof cmd.model !== "string") {
      return { ok: false, status: 400, reason: MODEL_RULE_TEXT };
    }
    const setModel = cmd.model === null ? null : cmd.model.trim();
    const normalizedSet = setModel === "" ? null : setModel;
    /* boundedText also refuses control characters, so answering it with the
     * LENGTH sentence names the wrong rule for a short model carrying one. */
    if (normalizedSet !== null && CONTROL_RE.test(normalizedSet)) {
      return { ok: false, status: 400, reason: MODEL_CONTROL_RULE_TEXT };
    }
    if (normalizedSet !== null && !boundedText(normalizedSet, MODEL_MAX)) {
      /* The LENGTH rule, not the field list. Same defect as declare. */
      return { ok: false, status: 400, reason: MODEL_RULE_TEXT };
    }
    return {
      ok: true,
      command: {
        kind: "set_agent_model",
        principal_id: cmd.principal_id.toLowerCase(),
        model: normalizedSet,
      },
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
    if (cmd.kind === "archive_workspace") {
      return exactKeys(cmd, ["kind"])
        ? { ok: true, command: { kind: "archive_workspace" } }
        : {
          ok: false,
          status: 400,
          reason: "archive_workspace fields are malformed",
        };
    }
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
      ...(Object.hasOwn(cmd, "renewal_kind") ? ["renewal_kind"] : []),
      ...(Object.hasOwn(cmd, "renewal_horizon_ms")
        ? ["renewal_horizon_ms"]
        : []),
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
    const renewalKind = cmd.renewal_kind === undefined
      ? "timeboxed"
      : cmd.renewal_kind;
    const renewalHorizonMs = cmd.renewal_horizon_ms === undefined
      ? RENEWAL_HORIZON_DEFAULT_MS
      : cmd.renewal_horizon_ms;
    const validRenewal =
      (renewalKind === "standing" && cmd.renewal_horizon_ms === undefined) ||
      (
        renewalKind === "timeboxed" &&
        integer(renewalHorizonMs, 1) &&
        renewalHorizonMs <= RENEWAL_HORIZON_MAX_MS
      );
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
      validTtl &&
      validRenewal;
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
          /* Optional wire fields stay ABSENT from the canonical command when the
           * caller omitted them (the ttl_ms/scopes convention above). Injecting
           * defaults here changed the stored request hash of every mint that
           * never mentioned renewal, which broke idempotent replay across the
           * deploy and the I4 ledger invariant. Defaults are applied where the
           * prepared command is built, from the raw wire. */
          ...(cmd.renewal_kind === undefined
            ? {}
            : { renewal_kind: renewalKind as "timeboxed" | "standing" }),
          ...(cmd.renewal_horizon_ms === undefined
            ? {}
            : { renewal_horizon_ms: renewalHorizonMs as number }),
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
    ...(response.grant_kind === "timeboxed" || response.grant_kind === "standing"
      ? { grant_kind: response.grant_kind }
      : {}),
    ...(typeof response.horizon_expires_at === "string" ||
        response.horizon_expires_at === null
      ? { horizon_expires_at: response.horizon_expires_at as string | null }
      : {}),
    ...(typeof response.successors_remaining === "number" ||
        response.successors_remaining === null
      ? { successors_remaining: response.successors_remaining as number | null }
      : {}),
    ...(typeof response.revoked_at === "string"
      ? { revoked_at: response.revoked_at }
      : {}),
    ...(typeof response.renewal_grant_id === "string"
      ? { renewal_grant_id: response.renewal_grant_id }
      : {}),
    ...(typeof response.resumed_at === "string"
      ? { resumed_at: response.resumed_at }
      : {}),
    ...(typeof response.signal_id === "string"
      ? { signal_id: response.signal_id }
      : {}),
    ...(typeof response.outcome === "string"
      ? { outcome: response.outcome }
      : {}),
    ...(record(response.signal) === null
      ? {}
      : { signal: response.signal as unknown as SignalRecord }),
    ...(typeof response.file_id === "string" ? { file_id: response.file_id } : {}),
    ...(typeof response.version_id === "string" ? { version_id: response.version_id } : {}),
    ...(typeof response.version_n === "number" ? { version_n: response.version_n } : {}),
    ...(typeof response.name === "string" ? { name: response.name } : {}),
    ...(typeof response.upload_path === "string" ? { upload_path: response.upload_path } : {}),
    ...(typeof response.upload_token === "string" ? { upload_token: response.upload_token } : {}),
    ...(typeof response.upload_expires_in_seconds === "number"
      ? { upload_expires_in_seconds: response.upload_expires_in_seconds }
      : {}),
    ...(typeof response.commit_deadline_note === "string"
      ? { commit_deadline_note: response.commit_deadline_note }
      : {}),
    ...(typeof response.size_bytes === "number" ? { size_bytes: response.size_bytes } : {}),
    ...(typeof response.sha256 === "string" || response.sha256 === null
      ? { sha256: response.sha256 as string | null }
      : {}),
    ...(typeof response.sha256_note === "string" ? { sha256_note: response.sha256_note } : {}),
    ...(typeof response.reference === "string" ? { reference: response.reference } : {}),
    ...(typeof response.content_type === "string" ? { content_type: response.content_type } : {}),
    ...(typeof response.download_path === "string" ? { download_path: response.download_path } : {}),
    ...(typeof response.download_url_expires_in_seconds === "number"
      ? { download_url_expires_in_seconds: response.download_url_expires_in_seconds }
      : {}),
    ...(typeof response.restorable_until === "string"
      ? { restorable_until: response.restorable_until }
      : {}),
    ...(typeof response.note === "string" ? { note: response.note } : {}),
    ...(typeof response.restored === "boolean" ? { restored: response.restored } : {}),
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
    SELECT m.role, m.revoked_at
    FROM swarm.memberships AS m
    JOIN swarm.workspaces AS w
      ON w.workspace_id = m.workspace_id
     AND w.archived_at IS NULL
    WHERE m.workspace_id = ${workspaceId}::uuid
      AND m.user_id = ${auth.actor.user}::uuid
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
  // Invitation acceptance is the one non-member command and bypasses
  // resolveRoute, so it must join the live workspace at this routing seam.
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
    JOIN swarm.workspaces AS w
      ON w.workspace_id = i.workspace_id
     AND w.archived_at IS NULL
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
  } else if (wire.kind === "archive_workspace") {
    command = { kind: "archive_workspace" };
  } else if (wire.kind === "revoke_agent_principal") {
    command = {
      kind: "revoke_agent_principal",
      principal_id: wire.principal_id,
    };
  } else if (wire.kind === "revoke_agent_token") {
    command = { kind: "revoke_agent_token", token_id: wire.token_id };
  } else if (wire.kind === "declare_agent_model") {
    command = { kind: "declare_agent_model", model: wire.model };
  } else if (wire.kind === "submit_feedback") {
    command = {
      kind: "submit_feedback",
      feedback_id: wire.feedback_id,
      category: wire.category,
      body: wire.body,
      context: wire.context,
    };
  } else if (wire.kind === "set_agent_model") {
    command = {
      kind: "set_agent_model",
      principal_id: wire.principal_id,
      model: wire.model,
    };
  } else if (wire.kind === RENEW_AGENT_TOKEN_KIND) {
    // Every field below is read from the authenticated predecessor row or from
    // the server. `wire` contributes nothing but its kind.
    predecessorTokenId = auth.agent?.token_id ?? null;
    const predecessor = predecessorTokenId === null
      ? undefined
      : state.tokens[predecessorTokenId];
    renewalFacts = predecessorTokenId === null
      ? null
      : await loadRenewalFacts(
        tx,
        predecessorTokenId,
        auth.agentFirstUse,
        auth.agent?.device_id ?? null,
      );
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
      renewal_kind: wire.renewal_kind ?? "timeboxed",
      renewal_horizon_ms: wire.renewal_kind === "standing"
        ? null
        : wire.renewal_horizon_ms ?? RENEWAL_HORIZON_DEFAULT_MS,
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
  deviceId: string | null,
): Promise<RenewalFacts | null> {
  const preflight = await tx<{ code: string | null }[]>`
    SELECT swarm.prepare_renewal_grant(
      (
        SELECT token.renewal_grant_id
        FROM swarm.agent_tokens AS token
        WHERE token.token_id = ${predecessorTokenId}::uuid
      ),
      ${deviceId}::uuid
    ) AS code
  `;
  const rows = await tx<{
    renewal_grant_id: string | null;
    kind: string | null;
    max_successors: number | null;
    successors_used: number | null;
    successors_stranded: number | null;
    horizon_expires_at: Date | null;
    grant_revoked_at: Date | null;
    grant_suspension_active: boolean | null;
    grant_bound_to_token: boolean | null;
    successor_token_id: string | null;
    successor_pending: boolean | null;
    lineage_revoked: boolean;
  }[]>`
    SELECT
      g.renewal_grant_id,
      g.kind,
      g.max_successors,
      g.successors_used,
      g.successors_stranded,
      g.horizon_expires_at,
      g.revoked_at AS grant_revoked_at,
      /* CURRENT suspension, not the last one recorded. suspended_at is never
         cleared — a resume is written to resumed_at so the lapse stays readable
         — and swarm.renewal_grants.suspension_active is the ONE definition of
         "suspended right now". Reading the raw column here would keep every
         resumed grant refused as renewal_grant_suspended, which is the bug
         20260904000001_standing_grant_resume.sql exists to remove.
         PASSED THROUGH, NOT REMAPPED, since 2026-09-04: this used to be
         CASE WHEN g.suspension_active THEN g.suspended_at END, which handed the reducer a
         timestamp it then tested for null. That turned this line into a second definition of
         "paused" — correct only while the CASE survived, and the reducer had no way to know if
         it did not. The reducer now reads the boolean itself. */
      g.suspension_active AS grant_suspension_active,
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
  const validKind = row.kind === "timeboxed" || row.kind === "standing";
  const validShape = row.kind === "standing"
    ? row.max_successors === null && row.horizon_expires_at === null
    : row.max_successors !== null && row.horizon_expires_at !== null;
  const grant = row.renewal_grant_id === null ||
      row.successors_used === null ||
      row.successors_stranded === null ||
      !validKind ||
      !validShape
    ? null
    : {
      renewal_grant_id: row.renewal_grant_id,
      kind: row.kind as "timeboxed" | "standing",
      max_successors: row.max_successors === null
        ? null
        : Number(row.max_successors),
      successors_used: Number(row.successors_used),
      successors_stranded: Number(row.successors_stranded),
      horizon_expires_at: millis(row.horizon_expires_at),
      revoked_at: millis(row.grant_revoked_at),
      suspension_active: row.grant_suspension_active === true,
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
    grant_preflight_code: (preflight[0]?.code ?? null) as RenewalFacts["grant_preflight_code"],
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
): Record<string, string | number | null> {
  const payload = record(events[0]?.payload) ?? {};
  const grant = prepared.renewalFacts?.grant ?? null;
  const replacing = prepared.renewalFacts?.superseded === true &&
    prepared.renewalFacts.successor_pending;
  const effectiveUsed = grant === null
    ? 0
    : grant.successors_used - grant.successors_stranded;
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
    ...(grant === null
      ? {}
      : {
        grant_kind: grant.kind,
        horizon_expires_at: grant.horizon_expires_at === null
          ? null
          : new Date(grant.horizon_expires_at).toISOString(),
        successors_remaining: grant.max_successors === null
          ? null
          : Math.max(
            0,
            grant.max_successors - effectiveUsed - (replacing ? 0 : 1),
          ),
      }),
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

    if (event.type === "WorkspaceArchived") {
      if (typeof payload.archived_at !== "number") {
        throw new Error("WorkspaceArchived payload is malformed");
      }
      const archived = await tx<{ workspace_id: string }[]>`
        UPDATE swarm.workspaces
        SET archived_at = ${new Date(payload.archived_at)}
        WHERE workspace_id = ${route.workspaceId}::uuid
          AND archived_at IS NULL
        RETURNING workspace_id
      `;
      if (archived.length !== 1) {
        throw new Error("WorkspaceArchived projection did not archive exactly one workspace");
      }
    } else if (event.type === "MemberInvited") {
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
    } else if (event.type === "AgentModelDeclared") {
      // Bounds were enforced by the reducer, mirroring
      // agent_principals_model_bounded — a violation here means the mirror
      // drifted, and the constraint failing the transaction is the alarm.
      if (typeof payload.principal_id !== "string") {
        throw new Error("AgentModelDeclared payload is malformed");
      }
      const declaredModel = payload.model === null || payload.model === undefined
        ? null
        : String(payload.model);
      const declaredRows = await tx<{ principal_id: string }[]>`
        UPDATE swarm.agent_principals
        SET model = ${declaredModel}
        WHERE principal_id = ${String(payload.principal_id)}::uuid
          AND workspace_id = ${route.workspaceId}::uuid
          AND revoked_at IS NULL
        RETURNING principal_id
      `;
      if (declaredRows.length !== 1) {
        throw new Error(
          "AgentModelDeclared projection did not update exactly one principal",
        );
      }
    } else if (event.type === "FeedbackSubmitted") {
      // Bounds were enforced by the reducer, mirroring feedback_body_bounded —
      // a violation here means the mirror drifted, and the constraint failing
      // the transaction is the alarm (the AgentModelDeclared convention).
      if (
        typeof payload.feedback_id !== "string" ||
        typeof payload.category !== "string" ||
        typeof payload.body !== "string" ||
        typeof payload.reporter_kind !== "string" ||
        typeof payload.reporter_id !== "string"
      ) {
        throw new Error("FeedbackSubmitted payload is malformed");
      }
      // Pass the object through tx.json, the file's jsonb convention (see the
      // event-payload insert in appendEvents). Hand-rolling JSON.stringify here
      // double-encodes: the client JSON-encodes a bound parameter bound for a
      // ::jsonb cast, so a pre-stringified value lands as a jsonb STRING scalar
      // and `context->>'key'` reads nothing. null stays a SQL NULL, not a jsonb
      // null — the read path and the human-reporter test both expect SQL NULL.
      const feedbackContext = payload.context === null || payload.context === undefined
        ? null
        : (payload.context as postgres.JSONValue);
      await tx`
        INSERT INTO swarm.feedback (
          feedback_id, workspace_id, reporter_kind, reporter_id,
          category, body, context, created_at
        ) VALUES (
          ${String(payload.feedback_id)}::uuid,
          ${route.workspaceId}::uuid,
          ${String(payload.reporter_kind)},
          ${String(payload.reporter_id)}::uuid,
          ${String(payload.category)},
          ${String(payload.body)},
          ${feedbackContext === null ? null : tx.json(feedbackContext)}::jsonb,
          ${new Date(Number(payload.submitted_at))}
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
      const revoked = await tx<{
        token_id: string;
        lineage_id: string;
        renewal_grant_id: string | null;
      }[]>`
        UPDATE swarm.agent_tokens
        SET revoked_at = ${revokedAt}
        WHERE token_id = ${tokenId}::uuid
          AND revoked_at IS NULL
          AND principal_id IN (
            SELECT principal_id
            FROM swarm.agent_principals
            WHERE workspace_id = ${route.workspaceId}::uuid
          )
        RETURNING token_id, lineage_id, renewal_grant_id
      `;
      if (revoked.length !== 1) {
        throw new Error(
          "AgentTokenRevoked projection did not revoke exactly one token",
        );
      }
      const lineageId = revoked[0]!.lineage_id;
      const renewalGrantId = revoked[0]!.renewal_grant_id;
      await tx`
        INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
        VALUES (
          'token',
          ${tokenId}::uuid,
          ${createdBy}::uuid
        )
        ON CONFLICT (kind, target_id) DO NOTHING
      `;
      if (renewalGrantId !== null) {
        await tx`
          UPDATE swarm.renewal_grants
          SET revoked_at = ${revokedAt},
              revoked_by = ${createdBy}::uuid
          WHERE renewal_grant_id = ${renewalGrantId}::uuid
            AND revoked_at IS NULL
        `;
      }
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
      if (prepared.command.kind !== "mint_agent_token") {
        throw new Error("token mint projection lost its mint command");
      }
      const mintCommand = prepared.command;
      const standing = mintCommand.renewal_kind === "standing";
      const horizonExpiresAt = standing
        ? null
        : new Date(
          token.issued_at + mintCommand.renewal_horizon_ms!,
        ).toISOString();
      await tx`
        INSERT INTO swarm.renewal_grants (
          renewal_grant_id, workspace_id, principal_id, run_id,
          kind, max_successors, successors_used, horizon_expires_at,
          bound_device_id, created_by
        ) VALUES (
          ${grantId}::uuid,
          ${route.workspaceId}::uuid,
          ${token.principal_id}::uuid,
          ${token.run_id}::uuid,
          ${mintCommand.renewal_kind},
          ${standing ? null : RENEWAL_MAX_SUCCESSORS_DEFAULT},
          0,
          ${horizonExpiresAt},
          ${standing ? prepared.wire.device_id : null}::uuid,
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

async function checkDeliveryRateLimit(
  tx: Sql,
  auth: AuthContext,
  workspaceId: string,
  principalId: string,
  operation: "claim" | "ack",
): Promise<{ allowed: true } | { allowed: false; result: HttpResult }> {
  const limit = operation === "claim"
    ? DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE
    : DELIVERY_ACK_RATE_LIMIT_PER_MINUTE;
  const bucketKey = `delivery:${operation}:principal:${workspaceId}:${principalId}`;

  const rows = await tx<{ count: number; resets_at: Date; retry_after_seconds: number }[]>`
    INSERT INTO swarm.rate_buckets (bucket_key, window_start, count)
    VALUES (
      ${bucketKey},
      date_trunc('minute', statement_timestamp()),
      1
    )
    ON CONFLICT (bucket_key, window_start) DO UPDATE
    SET count = LEAST(swarm.rate_buckets.count + 1, ${limit + 2})
    RETURNING
      count,
      window_start + interval '1 minute' AS resets_at,
      GREATEST(
        1,
        LEAST(
          60,
          CEIL(EXTRACT(EPOCH FROM (window_start + interval '1 minute' - statement_timestamp())))
        )
      )::int AS retry_after_seconds
  `;
  const row = rows[0];
  if (!row) throw new Error("delivery rate bucket did not return a row");
  const count = Number(row.count);
  const resetsAtIso = row.resets_at.toISOString();
  const retryAfterSec = Number(row.retry_after_seconds);
  if (count > limit) {
    if (count === limit + 1) {
      const auditReason = operation === "claim"
        ? "delivery_claim_rate_limited"
        : "delivery_ack_rate_limited";
      await insertAudit(tx, {
        auth,
        commandKind: operation === "claim" ? CLAIM_AGENT_INBOX_KIND : ACK_AGENT_DELIVERY_KIND,
        workspaceId,
        outcome: "rate_limit",
        reason: auditReason,
      });

      const alertKind = operation === "claim"
        ? "delivery_claim_rate_limit"
        : "delivery_ack_rate_limit";
      await tx`
        INSERT INTO swarm.security_alerts (kind, subject, detail)
        VALUES (
          ${alertKind},
          'agent',
          ${tx.json({
            workspace_id: workspaceId,
            recipient_principal_id: principalId,
            operation,
            limit,
            resets_at: resetsAtIso,
          })}::jsonb
        )
      `;
    }

    return {
      allowed: false,
      result: {
        status: 429,
        headers: {
          "retry-after": String(retryAfterSec),
        },
        body: {
          error: "rate_limited",
          limit,
          resets_at: resetsAtIso,
          message: "Rate limit exceeded. Please retry after the reset window.",
        },
      },
    };
  }

  return { allowed: true };
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
  // existence oracle for another tenant. This preamble runs before resolveRoute,
  // so its membership lookup must carry the same closed-workspace gate itself.
  const memberships = await tx<{ role: string }[]>`
    SELECT m.role
    FROM swarm.memberships AS m
    JOIN swarm.workspaces AS w
      ON w.workspace_id = m.workspace_id
     AND w.archived_at IS NULL
    WHERE m.workspace_id = ${workspaceId}::uuid
      AND m.user_id = ${userId}::uuid
      AND m.revoked_at IS NULL
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
 * BRING A PAUSED AGENT BACK. The one exit from an idle suspension, and the
 * reason "standing" can honestly be the default for an agent added on the web.
 *
 * WHY A SUSPENSION NEEDS AN EXIT AT ALL. A standing grant pauses itself after 14
 * days with no measured use (swarm.prepare_renewal_grant). Before this handler
 * existed that was terminal: a laptop parked over a holiday came back to an
 * agent that could never renew again, and the only remedy was minting a new
 * grant on a new lineage. That was a defensible trade while standing was opt-in
 * behind two confirmation flags. It is not defensible as the default, because
 * the add-agent screen now tells the reader their agent's access does not
 * expire — and the sentence has to be true.
 *
 * WHY IT IS NOT A REDUCER COMMAND. Resume grants nothing, widens nothing, and
 * names no new authority: it clears a lapse flag on a grant whose whole
 * authority was decided when it was minted. Like mintCapabilityUrl and
 * revokeCapabilityUrl it is self-contained and emits no protocol event. What it
 * does emit is a swarm.audit_log row, which is what "audited" means here:
 * outcome, actor, workspace, and the grant id, on refusals as well as successes.
 *
 * WHY THE GATE LIVES IN SQL. swarm.resume_renewal_grant re-reads membership,
 * role, principal ownership, revocation and current suspension under a row lock
 * it takes itself, and returns a stable code. This function never decides
 * eligibility from anything it read separately, so a mistake here cannot widen
 * the gate — the worst it can do is refuse a resume that was allowed.
 *
 * WHAT IT CANNOT DO. It cannot touch a revoked grant. Three fences say so
 * independently: this function's caller returns renewal_grant_revoked, the row
 * trigger raises SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE, and a table CHECK
 * refuses the row shape. Revocation stays the only permanent stop.
 */
async function resumeRenewalGrant(
  tx: Sql,
  body: RequestBody,
  auth: AuthContext,
  route: Route,
  ignoredIdentity: string | null,
): Promise<HttpResult> {
  const { workspaceId, streamId } = route;
  const forbidden: HttpResult = { status: 403, body: { error: "forbidden" } };
  const invalid: HttpResult = { status: 400, body: { error: "invalid_request" } };
  const refuse = async (
    outcome: string,
    reason: string,
    result: HttpResult,
    detail?: string,
  ): Promise<HttpResult> =>
    await auditRefusal(tx, auth, RESUME_RENEWAL_GRANT_KIND, {
      outcome,
      reason,
      detail: [ignoredIdentity, detail].filter(Boolean).join("; ") || null,
      workspaceId,
      streamId,
    }, result);

  /* HUMAN-INTERACTIVE ONLY, and this is the load-bearing line of the whole
     feature. A suspension is imposed ON an agent; if an agent credential could
     lift it, the pause would be a suggestion rather than a control, and a
     credential harvested from a machine nobody has touched in a month would let
     the thief restart the very grant that idleness had stopped. */
  if (auth.credentialKind !== "user" || auth.actor.user === null) {
    return await refuse(
      "authz",
      "renewal_resume_credential_kind_forbidden",
      forbidden,
    );
  }
  const userId = auth.actor.user;
  if (!auth.identityVerified) {
    return await refuse("authz", "renewal_resume_identity_not_verified", forbidden);
  }

  const command = record(body.command);
  const shapeOk = exactKeys(body, [
    "command_id",
    "client_version",
    "workspace_id",
    "stream",
    "command",
  ]) &&
    typeof body.command_id === "string" &&
    typeof body.client_version === "string" &&
    command !== null &&
    exactKeys(command, ["kind", "renewal_grant_id"]) &&
    typeof command.renewal_grant_id === "string" &&
    UUID_RE.test(command.renewal_grant_id);
  if (command === null || !shapeOk) {
    return await refuse("validation", "renewal_resume_invalid_request", invalid);
  }
  const commandId = body.command_id as string;
  const renewalGrantId = command.renewal_grant_id as string;

  const configRows = await tx<{ value: unknown }[]>`
    SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
  `;
  const minClientVersion = configRows[0]?.value;
  const clientVersion = body.client_version as string;
  if (
    typeof minClientVersion !== "string" ||
    compareSemver(clientVersion, minClientVersion) === null
  ) {
    return await refuse(
      "validation",
      "renewal_resume_invalid_client_version",
      invalid,
    );
  }
  if (compareSemver(clientVersion, minClientVersion)! < 0) {
    return await refuse("validation", "renewal_resume_client_unsupported", {
      status: 426,
      body: { error: "upgrade_required", min_client_version: minClientVersion },
    });
  }

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
      commandKind: RESUME_RENEWAL_GRANT_KIND,
      workspaceId,
      streamId,
      outcome: matches ? "replayed" : "conflict",
      reason: matches ? null : "renewal_resume_command_id_conflict",
      detail: ignoredIdentity,
      hash,
    });
    return matches
      ? replayResult(storedResponse(existing.response), RESUME_RENEWAL_GRANT_KIND)
      : { status: 409, body: { error: "command_id_conflict" } };
  }

  /* The whole gate, in one call, under its own row lock. The returned value is a
     code we assign — never a message, and never classified by parsing one
     (D-053). NULL means the resume happened. */
  const outcomeRows = await tx<{ resume_outcome: string | null }[]>`
    SELECT swarm.resume_renewal_grant(
      ${workspaceId}::uuid,
      ${renewalGrantId}::uuid,
      ${userId}::uuid
    ) AS resume_outcome
  `;
  /* ★ NULL IS THE SUCCESS VALUE, SO IT MUST SURVIVE THE READ.
   *
   * This was `outcomeRows[0]?.resume_outcome ?? "renewal_resume_forbidden"`, and `??` cannot
   * tell the success case from a missing row: NULL coalesced to the refusal string, the check
   * below was therefore always true, and NO RESUME COULD EVER REPORT SUCCESS. The damage went
   * further than a wrong status. `refuse` writes an audit row and RETURNS inside `db.begin`,
   * so the UPDATE that swarm.resume_renewal_grant had already made COMMITTED while the caller
   * was told 403; a retry then answered `renewal_grant_not_suspended`, because the resume it
   * had denied had in fact happened.
   *
   * Same shape as the renewal preflight read at index.ts:3376 (`preflight[0]?.code ?? null`):
   * preserve NULL, refuse only on a code we assign.
   *
   * WHY A REFUSAL BELOW STILL COMMITS, DELIBERATELY. `refuse` must commit — its whole job is
   * to leave an audit row for a decision the caller is not told the reason for, and a rollback
   * would erase that row along with the refusal. That is safe here only because
   * swarm.resume_renewal_grant returns every refusal code BEFORE it writes anything
   * (migration 20260904000001:551-606; the UPDATE at :608-612 is followed immediately by
   * RETURN NULL). So a committed refusal never follows a mutation. The one state that would
   * break that pairing is a missing row, which `SELECT fn(...)` cannot produce; it is treated
   * as impossible and THROWN, which rolls the transaction back rather than guessing. */
  const outcomeRow = outcomeRows[0];
  if (outcomeRow === undefined) {
    throw new Error("resume_renewal_grant returned no row");
  }
  const resumeOutcome = outcomeRow.resume_outcome;
  if (resumeOutcome !== null) {
    /* 403 for every refusal, INCLUDING "no such grant". Distinguishing a grant
       that does not exist from one the caller may not touch is an existence
       oracle across tenants, the same reason revokeCapabilityUrl collapses its
       three refusals into one. The audit row keeps the distinction for the
       operator, who is entitled to it; the caller is not. */
    return await refuse(
      "authz",
      `renewal_resume_${resumeOutcome}`,
      forbidden,
      `renewal_grant_id=${renewalGrantId}`,
    );
  }

  const resumedRows = await tx<{ resumed_at: Date }[]>`
    SELECT resumed_at
    FROM swarm.renewal_grants
    WHERE renewal_grant_id = ${renewalGrantId}::uuid
      AND workspace_id = ${workspaceId}::uuid
  `;
  const resumedAt = resumedRows[0]?.resumed_at;
  if (!resumedAt) {
    throw new Error("grant resume reported success without a resumed_at stamp");
  }

  const response: StoredResponse = {
    ok: true,
    event_ids: [],
    renewal_grant_id: renewalGrantId,
    resumed_at: resumedAt.toISOString(),
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
      RESUME_RENEWAL_GRANT_KIND,
      workspaceId,
      streamId,
      hash,
    );
  }

  await insertAudit(tx, {
    auth,
    commandKind: RESUME_RENEWAL_GRANT_KIND,
    workspaceId,
    streamId,
    outcome: "accepted",
    reason: null,
    detail: [ignoredIdentity, `renewal_grant_id=${renewalGrantId}`]
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

type ChannelOutcome =
  | { ok: true; channel: ChannelRecord }
  | {
    ok: false;
    status: number;
    error: string;
    message: string;
    reason: string;
  };

interface ChannelRow {
  channel_id: string;
  workspace_id: string;
  slug: string;
  purpose: string | null;
  created_by_principal: string;
  created_by_kind: CredentialKind;
  created_at: Date;
  archived_at: Date | null;
}

function channelRecord(row: ChannelRow): ChannelRecord {
  return {
    channel_id: row.channel_id,
    workspace_id: row.workspace_id,
    slug: row.slug,
    purpose: row.purpose,
    created_by_principal: row.created_by_principal,
    created_by_kind: row.created_by_kind,
    created_at: row.created_at.toISOString(),
    archived_at: row.archived_at === null
      ? null
      : row.archived_at.toISOString(),
  };
}

/** Live slugs in the route's workspace, for a refusal message we generate. */
async function liveChannelSlugs(tx: Sql, route: Route): Promise<string[]> {
  const rows = await tx<{ slug: string }[]>`
    SELECT slug FROM swarm.channels
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND archived_at IS NULL
    ORDER BY slug
    LIMIT 200
  `;
  return rows.map((row) => row.slug);
}

/**
 * Channel authority. Every write is pinned to the route's workspace, so a
 * client-supplied channel_id from another tenant resolves to nothing rather
 * than to somebody else's row.
 */
async function applyChannelCommand(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: ChannelCommand,
): Promise<ChannelOutcome> {
  if (command.kind === "channel_create") {
    const existing = await tx<ChannelRow[]>`
      SELECT channel_id, workspace_id, slug, purpose,
             created_by_principal, created_by_kind, created_at, archived_at
      FROM swarm.channels
      WHERE workspace_id = ${route.workspaceId}::uuid
        AND lower(slug) = ${command.slug}
      LIMIT 1
    `;
    if (existing[0] !== undefined) {
      return {
        ok: false,
        status: 409,
        error: "channel_exists",
        message:
          `This workspace already has a channel named ${command.slug}. Post to it instead.`,
        reason: "channel_slug_taken",
      };
    }
    const rows = await tx<ChannelRow[]>`
      INSERT INTO swarm.channels (
        channel_id, workspace_id, slug, purpose,
        created_by_principal, created_by_kind, created_at
      ) VALUES (
        ${crypto.randomUUID()}::uuid,
        ${route.workspaceId}::uuid,
        ${command.slug},
        ${command.purpose},
        ${canonicalPrincipal(auth.actor)}::uuid,
        ${auth.credentialKind},
        statement_timestamp()
      )
      RETURNING channel_id, workspace_id, slug, purpose,
                created_by_principal, created_by_kind, created_at, archived_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("channel insert did not return a row");
    return { ok: true, channel: channelRecord(row) };
  }

  const current = await tx<ChannelRow[]>`
    SELECT channel_id, workspace_id, slug, purpose,
           created_by_principal, created_by_kind, created_at, archived_at
    FROM swarm.channels
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND channel_id = ${command.channel_id}::uuid
    LIMIT 1
  `;
  if (current[0] === undefined) {
    return {
      ok: false,
      status: 404,
      error: "channel_not_found",
      message: "There is no channel with that id in this workspace.",
      reason: "channel_not_found",
    };
  }

  if (command.kind === "channel_archive") {
    /* Archiving twice is an accepted no-op: the caller's intent already holds,
     * and the append-only habit of this codebase is not to invent a conflict
     * where the end state is the one that was asked for. */
    const rows = await tx<ChannelRow[]>`
      UPDATE swarm.channels
      SET archived_at = COALESCE(archived_at, statement_timestamp())
      WHERE workspace_id = ${route.workspaceId}::uuid
        AND channel_id = ${command.channel_id}::uuid
      RETURNING channel_id, workspace_id, slug, purpose,
                created_by_principal, created_by_kind, created_at, archived_at
    `;
    return { ok: true, channel: channelRecord(rows[0]!) };
  }

  const clash = await tx<{ channel_id: string }[]>`
    SELECT channel_id FROM swarm.channels
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND lower(slug) = ${command.slug}
      AND channel_id <> ${command.channel_id}::uuid
    LIMIT 1
  `;
  if (clash[0] !== undefined) {
    return {
      ok: false,
      status: 409,
      error: "channel_exists",
      message:
        `This workspace already has a channel named ${command.slug}.`,
      reason: "channel_slug_taken",
    };
  }
  const renamed = await tx<ChannelRow[]>`
    UPDATE swarm.channels
    SET slug = ${command.slug}
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND channel_id = ${command.channel_id}::uuid
    RETURNING channel_id, workspace_id, slug, purpose,
              created_by_principal, created_by_kind, created_at, archived_at
  `;
  return { ok: true, channel: channelRecord(renamed[0]!) };
}

interface SignalChannelResolution {
  ok: boolean;
  channelId: string | null;
  status?: number;
  error?: string;
  message?: string;
  reason?: string;
}

/**
 * Slug to id, WITHIN THE ROUTE'S WORKSPACE. A client-supplied identifier is
 * never trusted, so cross-tenant resolution is not a check that can be
 * forgotten: the query cannot see the other tenant's row.
 */
async function resolveSignalChannel(
  tx: Sql,
  route: Route,
  command: SignalCommand,
): Promise<SignalChannelResolution> {
  const slug = command.channel;
  if (slug === undefined) return { ok: true, channelId: null };
  const rows = await tx<{ channel_id: string; archived_at: Date | null }[]>`
    SELECT channel_id, archived_at
    FROM swarm.channels
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND lower(slug) = ${slug}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return {
      ok: false,
      channelId: null,
      status: 404,
      error: "channel_not_found",
      message: unknownChannelMessage(slug, await liveChannelSlugs(tx, route)),
      reason: "channel_not_found",
    };
  }
  if (row.archived_at !== null) {
    return {
      ok: false,
      channelId: null,
      status: 409,
      error: "channel_archived",
      message:
        `${slug} is archived, so it takes no new messages. Its history still reads and its links still resolve.`,
      reason: "channel_archived",
    };
  }
  return { ok: true, channelId: row.channel_id };
}

interface ThreadRootResolution {
  ok: boolean;
  threadRootId: string | null;
  rootUntil: Date | null;
  /**
   * The window left on the root, measured by POSTGRES against the same
   * statement_timestamp() the clamp uses. Never recomputed from Date.now():
   * Deno and Postgres do not share a clock, and a skewed comparison lets an
   * explicit horizon pass the refusal and then be silently shortened by the
   * clamp, which is the one branch this design calls dishonest.
   */
  rootRemainingMs: number | null;
  rootChannelId: string | null;
  status?: number;
  error?: string;
  message?: string;
  reason?: string;
}

/**
 * A thread hangs off a TOP-LEVEL signal in the same workspace that is still
 * live. Rooting a thread on another thread's reply is refused rather than
 * silently re-pointed: re-pointing is the move that quietly changes what a
 * stored column means, which is the defect this design ruled out for
 * in_reply_to.
 */
async function resolveThreadRoot(
  tx: Sql,
  route: Route,
  command: SignalCommand,
): Promise<ThreadRootResolution> {
  const rootId = command.thread_root_id ?? null;
  if (rootId === null) {
    return {
      ok: true,
      threadRootId: null,
      rootUntil: null,
      rootRemainingMs: null,
      rootChannelId: null,
    };
  }
  const rows = await tx<{
    id: string;
    until: Date;
    remaining_ms: number;
    channel_id: string | null;
    thread_root_id: string | null;
    channel_archived_at: Date | null;
  }[]>`
    SELECT s.id, s.until,
           EXTRACT(EPOCH FROM (s.until - statement_timestamp())) * 1000
             AS remaining_ms,
           s.channel_id, s.thread_root_id,
           channel.archived_at AS channel_archived_at
    FROM swarm.signals AS s
    LEFT JOIN swarm.channels AS channel
      ON channel.channel_id = s.channel_id
     AND channel.workspace_id = s.workspace_id
    WHERE s.workspace_id = ${route.workspaceId}::uuid
      AND s.id = ${rootId}::uuid
      /* A thread may root ONLY on an undirected signal, and this query is the
       * enforcement. This function reads swarm.signals as swarm_command, which
       * bypasses swarm_read.signals — the view that IS the read policy. Without
       * this arm any member holding a signal id could hang a PUBLIC thread off
       * a DIRECTED message between two other people: the reply itself is
       * undirected and readable by everyone, so the thread would disclose that
       * the private message exists and would attach public replies to it. A
       * reply loop that needs a private one-hop answer already has in_reply_to,
       * whose meaning this lane does not touch. */
      AND s.to_user_id IS NULL
      AND s.to_agent_principal_id IS NULL
      /* Belt and braces. Every in_reply_to row is stored DIRECTED --
       * resolveSignalWriteTarget re-addresses it to the referenced signal's
       * author -- so the two arms above already exclude one. Asserting it here
       * makes the property local to this query instead of a conclusion about
       * another function that a later edit could quietly falsify. */
      AND s.in_reply_to IS NULL
      /* A one-second floor, not merely "still live". The reply's until is
       * clamped to the root's in SQL, and CHECK (until > created_at) would
       * fire if the root expired between this SELECT and the INSERT. The floor
       * turns an unexplainable 500 into an honest refusal. */
      AND s.until > statement_timestamp() + interval '1 second'
    LIMIT 1
  `;
  const root = rows[0];
  if (root === undefined) {
    return {
      ok: false,
      threadRootId: null,
      rootUntil: null,
      rootRemainingMs: null,
      rootChannelId: null,
      status: 404,
      error: "thread_root_not_found",
      message:
        "There is no live, undirected message with that id in this workspace. Threads start from messages everyone can read, and a thread cannot outlive the message it starts from. To answer a directed message privately, reply to it instead.",
      reason: "thread_root_not_found",
    };
  }
  /* A reply INHERITS its root's channel, so the archive check that
   * resolveSignalChannel does for an explicit slug never runs for a thread
   * reply -- a review arm found the sequence: create, post, archive, then reply
   * with thread_root_id alone. The reply landed in the archived channel while
   * the copy said it takes no new messages. Archive has to be checked wherever
   * a channel is STAMPED, not only where a slug is resolved. */
  if (root.channel_archived_at !== null) {
    return {
      ok: false,
      threadRootId: null,
      rootUntil: null,
      rootRemainingMs: null,
      rootChannelId: null,
      status: 409,
      error: "channel_archived",
      message:
        "That thread is in an archived channel, so it takes no new replies. Its history still reads and its links still resolve.",
      reason: "channel_archived",
    };
  }
  if (root.thread_root_id !== null) {
    return {
      ok: false,
      threadRootId: null,
      rootUntil: null,
      rootRemainingMs: null,
      rootChannelId: null,
      status: 400,
      error: "thread_root_is_a_reply",
      message:
        "That message is already a reply in a thread. Reply to the message the thread starts from.",
      reason: "thread_root_is_a_reply",
    };
  }
  return {
    ok: true,
    threadRootId: root.id,
    rootUntil: root.until,
    rootRemainingMs: Number(root.remaining_ms),
    rootChannelId: root.channel_id,
  };
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

/**
 * Is this signal addressed to the caller through swarm.signal_recipients?
 *
 * The scalar columns hold recipient 0 only, so a check that reads them alone
 * answers "no" for recipients 1..N. That was found by a review arm on this
 * lane: the second recipient of a signal could READ it and could not reply to
 * it, because in_reply_to's authorization still asked the scalar columns. A
 * message you can read and cannot answer is the trap this closes.
 *
 * It grants nothing the recipient set does not already grant: exactly the
 * people swarm_read.signals admits through the same table, narrowed to the
 * presenting principal when an agent is calling.
 */
async function signalNamesRecipient(
  tx: Sql,
  route: Route,
  signalId: string,
  caller: { agentPrincipalId: string | null; userId: string | null },
): Promise<boolean> {
  if (caller.agentPrincipalId === null && caller.userId === null) return false;
  const rows = await tx<{ hit: number }[]>`
    SELECT 1 AS hit
    FROM swarm.signal_recipients AS r
    WHERE r.signal_id = ${signalId}::uuid
      AND r.workspace_id = ${route.workspaceId}::uuid
      AND (
        (
          ${caller.agentPrincipalId}::uuid IS NOT NULL
          AND r.recipient_agent_principal_id = ${caller.agentPrincipalId}::uuid
        )
        OR (
          ${caller.userId}::uuid IS NOT NULL
          AND (
            r.recipient_user_id = ${caller.userId}::uuid
            OR EXISTS (
              SELECT 1
              FROM swarm.agent_principals AS owned
              WHERE owned.principal_id = r.recipient_agent_principal_id
                AND owned.workspace_id = r.workspace_id
                AND owned.owner_user_id = ${caller.userId}::uuid
            )
          )
        )
      )
    LIMIT 1
  `;
  return rows[0] !== undefined;
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
  const recipients = command.to ?? null;
  if (recipients !== null) {
    /* The validator guarantees a non-empty list, no scalar recipient beside it
     * and no in_reply_to, so this arm needs no re-derivation of those rules.
     *
     * EVERY recipient is checked for liveness, not just the first. A dead one
     * anywhere in the list refuses the whole post the same way a dead scalar
     * target does today -- the answer is a bare 403, which does not disclose
     * WHICH recipient is not reachable, for the same tenant-honesty reason the
     * scalar path does not. */
    for (const recipient of recipients) {
      const live = recipient.kind === "user"
        ? await signalUserTargetIsLive(tx, route, recipient.id)
        : await signalAgentTargetIsLive(tx, route, recipient.id);
      if (!live) return null;
    }
    const first = recipients[0]!;
    /* Entry 0 becomes the row's own scalar recipient. This is the whole
     * old-reader guarantee, and swarm.signal_recipients carries a deferred
     * constraint that refuses the commit if these two ever disagree. */
    return {
      toUserId: first.kind === "user" ? first.id : null,
      toAgentPrincipalId: first.kind === "agent" ? first.id : null,
      inReplyTo: null,
    };
  }
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
  const addressedByScalar = auth.agent !== null
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
  /* The scalar columns carry recipient 0. Recipients 1..N live only in
   * swarm.signal_recipients, so asking the columns alone left a signal a
   * caller can READ and cannot reply to. The second arm asks the set. */
  const addressedToCaller = addressedByScalar ||
    await signalNamesRecipient(tx, route, inReplyTo, {
      agentPrincipalId: auth.agent !== null ? auth.agent.principal_id : null,
      userId: auth.agent !== null ? null : callerUserId,
    });
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

type SignalAttachmentResolution =
  | { ok: true; attachments: SignalAttachment[] }
  | {
    ok: false;
    status: number;
    error: string;
    reason: string;
    message: string;
  };

/**
 * Pins only readable, committed versions from the routed workspace. The file
 * and version locks keep tombstone/purge from crossing the signal insert.
 */
async function resolveSignalAttachments(
  tx: Sql,
  route: Route,
  refs: readonly SignalAttachmentRef[],
): Promise<SignalAttachmentResolution> {
  const listRefusal = signalAttachmentListRefusal(refs);
  if (listRefusal === "signal_attachment_limit") {
    return {
      ok: false,
      status: 400,
      error: "signal_attachment_limit",
      reason: "signal attachment count exceeds limit",
      message: `A signal can attach at most ${SIGNAL_ATTACHMENT_MAX} files. Nothing was posted.`,
    };
  }
  if (listRefusal === "signal_attachment_duplicate") {
    return {
      ok: false,
      status: 400,
      error: "signal_attachment_duplicate",
      reason: "signal attachment reference repeats",
      message: "The same file version can be attached only once. Nothing was posted.",
    };
  }
  const attachments: SignalAttachment[] = [];
  for (const ref of refs) {
    // Compound-key lookup is the ★R14 tenant-honesty boundary. A file in a
    // different workspace has the same response as a missing id.
    const files = await tx<{
      file_id: string;
      name: string;
      tombstoned_at: Date | null;
      purged_at: Date | null;
    }[]>`
      SELECT file_id, name, tombstoned_at, purged_at
      FROM swarm.files
      WHERE file_id = ${ref.file_id}::uuid
        AND workspace_id = ${route.workspaceId}::uuid
      FOR SHARE
    `;
    const file = files[0];
    if (
      file === undefined || file.tombstoned_at !== null ||
      file.purged_at !== null
    ) {
      return {
        ok: false,
        status: 404,
        error: "signal_attachment_unavailable",
        reason: "attachment file is missing, unreadable, or outside the workspace",
        message: "An attached file is not available in this workspace. Nothing was posted.",
      };
    }

    const versions = await tx<{
      version_n: number;
      state: string;
      content_type: string;
      size_bytes: string;
    }[]>`
      SELECT version_n, state, content_type, size_bytes::text
      FROM swarm.file_versions
      WHERE file_id = ${ref.file_id}::uuid
        AND workspace_id = ${route.workspaceId}::uuid
        AND version_n = ${ref.version_n}
      FOR SHARE
    `;
    const version = versions[0];
    if (version === undefined) {
      return {
        ok: false,
        status: 404,
        error: "signal_attachment_version_unavailable",
        reason: "attachment version is missing in the routed workspace",
        message: "An attached file version does not exist in this workspace. Nothing was posted.",
      };
    }
    if (version.state !== "live") {
      return {
        ok: false,
        status: 409,
        error: "signal_attachment_not_live",
        reason: "attachment version is not committed and live",
        message: "An attached file version is not committed and live. Nothing was posted.",
      };
    }
    attachments.push({
      file_id: ref.file_id,
      version_n: version.version_n,
      name: file.name,
      content_type: version.content_type,
      size_bytes: Number(version.size_bytes),
    });
  }
  return { ok: true, attachments };
}

/** Where the signal is filed, and how long it may live once clamped. */
interface SignalPlacement {
  channelId: string | null;
  threadRootId: string | null;
  broadcastToChannel: boolean;
  untilMs: number;
  /**
   * A thread reply may not outlive its root. Applied in SQL against the same
   * statement_timestamp() the row is created at, so no clock but Postgres's
   * decides it.
   */
  untilCeiling: string | null;
  /**
   * Did the CALLER name this horizon, or is it a per-kind default?
   *
   * The two cases get different treatment, and the difference is the whole
   * honesty rule. A DEFAULT may be clamped down to the ceiling silently: the
   * caller expressed no opinion, so shortening it tells no lie. An EXPLICIT
   * horizon may never be silently shortened -- it is either stored exactly as
   * asked or REFUSED, and the refusal is decided in the same statement as the
   * insert so no time can pass between the check and the write.
   */
  untilExplicit: boolean;
}

async function postSignal(
  tx: Sql,
  route: Route,
  auth: AuthContext,
  command: SignalCommand,
  target: SignalWriteTarget,
  attachments: readonly SignalAttachment[],
  placement: SignalPlacement,
): Promise<SignalRecord | null> {
  const untilMs = placement.untilMs;
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
    channel_id: string | null;
    thread_root_id: string | null;
    broadcast_to_channel: boolean;
  }[]>`
    WITH candidate AS (
      /* The value that will actually be stored, computed ONCE so the WHERE
       * below can test the same number the row would carry.
       *
       * An explicit horizon is stored exactly as named. A defaulted one is
       * clamped to the ceiling with LEAST, which tells no lie because the
       * caller expressed no opinion.
       *
       * GREATEST is the floor that keeps the row legal. resolveThreadRoot
       * requires the root to be live with a one-second margin, but a client
       * round trip separates that SELECT from this INSERT and
       * statement_timestamp() advances with each statement. If a stall eats the
       * whole margin, the clamped value would land at or before created_at and
       * CHECK (until > created_at) would fire, turning a thread reply into a
       * 500 where a refusal belongs.
       *
       * The floor RAISES the value, so on its own it can push a defaulted reply
       * PAST its root -- a review arm found exactly that, on the one path the
       * old WHERE could not refuse. The WHERE now tests this computed value for
       * both branches, so the floor can never produce a stored row that
       * outlives its root: it is refused instead. statement_timestamp() is
       * stable within a statement, so the CTE and the WHERE agree. */
      SELECT GREATEST(
        CASE WHEN ${placement.untilExplicit}
          THEN statement_timestamp() + ${untilMs} * interval '1 millisecond'
          ELSE LEAST(
            statement_timestamp() + ${untilMs} * interval '1 millisecond',
            COALESCE(
              ${placement.untilCeiling}::timestamptz,
              statement_timestamp() + ${untilMs} * interval '1 millisecond'
            )
          )
        END,
        statement_timestamp() + interval '1 millisecond'
      ) AS until_value
    )
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at,
      channel_id, thread_root_id, broadcast_to_channel
    )
    /* SELECT ... WHERE, not VALUES, so the fits-in-the-thread test and the
     * write are ONE statement. A pre-check in the handler cannot give this
     * guarantee: statement_timestamp() advances between statements, so a
     * horizon that fit when it was checked can stop fitting before the insert,
     * and the caller would be silently shortened instead of refused. Zero rows
     * back is the refusal, and the handler turns it into a 409. */
    SELECT
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
      candidate.until_value,
      statement_timestamp(),
      ${placement.channelId}::uuid,
      ${placement.threadRootId}::uuid,
      ${placement.broadcastToChannel}
    FROM candidate
    WHERE
      ${placement.untilCeiling}::timestamptz IS NULL
      OR candidate.until_value <= ${placement.untilCeiling}::timestamptz
    RETURNING
      id, workspace_id, from_principal, from_kind,
      to_user_id, to_agent_principal_id, in_reply_to,
      about, kind, body, until, created_at,
      channel_id, thread_root_id, broadcast_to_channel
  `;
  const signal = rows[0];
  /* Zero rows is the atomic refusal above, not a failure. Every other reason an
   * insert could return nothing is impossible here: there is no ON CONFLICT and
   * no other WHERE arm. */
  if (!signal) {
    /* Zero rows is the atomic refusal above, not a failure. It is reachable on
     * BOTH the explicit and the defaulted path: the floor can raise a defaulted
     * value past the ceiling when a stall eats the root's margin, and refusing
     * is better than storing a reply that outlives its thread. Every other
     * reason an insert could return nothing is impossible here: no ON CONFLICT,
     * and no WHERE arm but the ceiling. */
    if (placement.untilCeiling !== null) return null;
    throw new Error("signal insert did not return a row");
  }
  /* One row per recipient, in the order the sender named them. Position 0
   * repeats the scalar recipient on the signal row on purpose: the table then
   * means exactly "what the caller addressed", with no arity-dependent branch.
   *
   * These rows WAKE NOBODY. No trigger on swarm.signal_recipients writes to
   * swarm.signal_deliveries, and section 4 of
   * 20260905000010_signal_recipients.sql is a page on why: the rows such a
   * trigger writes cannot be hydrated or accepted by an installed listener.
   * Recipient 0 is woken from the scalar column by the trigger on
   * swarm.signals, which ran when the insert above committed its row.
   *
   * A body with no `to` writes NOTHING here, so nothing about an installed
   * client's post changes. swarm_read.signals derives the same set from the
   * scalar column for those rows, which is why this lane needs no backfill. */
  for (const [position, recipient] of (command.to ?? []).entries()) {
    await tx`
      INSERT INTO swarm.signal_recipients (
        signal_id, workspace_id, recipient_user_id,
        recipient_agent_principal_id, position
      ) VALUES (
        ${signal.id}::uuid,
        ${route.workspaceId}::uuid,
        ${recipient.kind === "user" ? recipient.id : null}::uuid,
        ${recipient.kind === "agent" ? recipient.id : null}::uuid,
        ${position}
      )
    `;
  }
  for (const [position, attachment] of attachments.entries()) {
    await tx`
      INSERT INTO swarm.signal_attachments (
        signal_id, workspace_id, file_id, version_n, position
      ) VALUES (
        ${signal.id}::uuid,
        ${route.workspaceId}::uuid,
        ${attachment.file_id}::uuid,
        ${attachment.version_n},
        ${position}
      )
    `;
  }
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
    attachments: [...attachments],
    until: signal.until.toISOString(),
    created_at: signal.created_at.toISOString(),
    channel_id: signal.channel_id,
    thread_root_id: signal.thread_root_id,
    broadcast_to_channel: signal.broadcast_to_channel,
    recipients: signalRecipientSet(command.to ?? null, signal),
  };
}

/**
 * The recipient set a reader sees, derived the way swarm_read.signals derives
 * it: the rows the caller named when there are any, and otherwise the row's own
 * scalar recipient as a one-entry set. Both halves are here so a post that used
 * the scalar shape and a post that used a one-entry `to` return the same set,
 * and so a signal written before swarm.signal_recipients existed reads the
 * same through either surface.
 *
 * The SQL copy of this rule is in 20260905000010_signal_recipients.sql. They
 * are two expressions of one rule, and they do NOT render identically: the
 * view adds a `position` to each entry and this record does not, because the
 * order of the array already carries it.
 *
 * Where each half is measured, named exactly rather than approximately (a
 * review arm found an earlier version of this comment naming the wrong file):
 * tests/p1-local/chat-recipients-postgres.test.ts compares the SQL FALLBACK
 * against the SQL ROWS, which is the no-backfill claim; the served test
 * "a post with `to` stores the first recipient in the scalar column and the
 * whole set beside it" in tests/p1-server/chat-signals.test.ts is the one that
 * puts this function's output and the view's column side by side.
 */
function signalRecipientSet(
  named: readonly SignalRecipient[] | null,
  signal: { to_user_id: string | null; to_agent_principal_id: string | null },
): SignalRecipient[] {
  if (named !== null && named.length > 0) return [...named];
  if (signal.to_user_id !== null) {
    return [{ kind: "user", id: signal.to_user_id }];
  }
  if (signal.to_agent_principal_id !== null) {
    return [{ kind: "agent", id: signal.to_agent_principal_id }];
  }
  return [];
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

    const isDeliveryCommand =
      kind === CLAIM_AGENT_INBOX_KIND || kind === ACK_AGENT_DELIVERY_KIND;
    const isSeenCommand = kind === SIGNALS_SEEN_KIND;

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
        reason: isDeliveryCommand ? "delivery_unavailable" : "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: isDeliveryCommand ? "delivery_unavailable" : "forbidden" } };
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
        reason: isDeliveryCommand ? "delivery_unavailable" : "forbidden",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: isDeliveryCommand ? "delivery_unavailable" : "forbidden" } };
    }
    /* Dispatched HERE — after the route and the revocation sweep, before
       validateCommand — for two reasons. It needs route.workspaceId and
       route.streamId, which pre-route handlers have to look up for themselves,
       and it must inherit the archived-workspace and revoked-membership gates
       rather than restate them. It stops before validateCommand because it is
       not a reducer command and has no arm there; falling through would earn
       "unknown command kind". */
    if (kind === RESUME_RENEWAL_GRANT_KIND) {
      return await resumeRenewalGrant(tx, body, auth, route, ignoredIdentity);
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
      /* The reason reaches the CALLER, not only the audit table.
       *
       * It used to go to insertAudit alone, so a 400 was a bare
       * `{"error":"invalid_request"}` and every sentence this edge builds --
       * the slug rule, the reserved names, the field lists, the thread rules --
       * was written for an operator reading Postgres rather than for the person
       * who got the refusal. Generating those sentences from the constants is
       * worth nothing while the caller cannot see them.
       *
       * Additive and safe for installed clients: they ignore unknown top-level
       * fields by contract (src/cloud/signals.ts:315-326), and the error code
       * they branch on is unchanged. Nothing secret is added -- the strings are
       * validator-authored and already stored in swarm.audit. */
      return {
        status: validation.status,
        body: {
          error: validation.status === 413
            ? "payload_too_large"
            : "invalid_request",
          message: validation.reason,
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
    // Self-description needs no scope for the same reason self-surrender does:
    // a "declare model" scope would be pure ceremony — the reducer already
    // confines the command to the presenting principal (it has no target
    // field), and existing minted tokens could never carry a new scope. This
    // only opens the door to the reducer's own agent-only check.
    const isModelDeclare =
      validation.command.kind === "declare_agent_model";
    // Feedback needs no scope for the same reason self-description does: a
    // "submit feedback" scope would be pure ceremony — the payload is inert
    // product data (it grants nothing and targets nothing), attribution is
    // server-derived, and existing minted tokens could never carry a new
    // scope. The reducer still requires a live membership or principal.
    const isFeedback =
      validation.command.kind === "submit_feedback";
    /* Channel commands are agent-allowed by class, the way file commands are.
     * A channel grants nothing and scopes nothing, so a "channel_create" scope
     * would be pure ceremony — and existing minted tokens could never carry a
     * new scope, so gating on one would refuse every agent already running. The
     * reducer-free handler still requires a live membership or principal via
     * resolveRoute. */
    const isChannelCommand =
      (CHANNEL_COMMAND_KINDS as readonly string[]).includes(
        validation.command.kind,
      );
    if (isModelDeclare && auth.agent === null) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "declare_requires_agent_credential",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "forbidden" } };
    }
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
    if (isDeliveryCommand && auth.agent === null) {
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "authz",
        reason: "delivery_requires_agent_credential",
        detail: ignoredIdentity,
      });
      return { status: 403, body: { error: "delivery_unavailable" } };
    }
    /* ★R9.2 (file artifacts): every FILE_COMMAND_KINDS kind is agent-allowed by
     * class, exempted from the per-scope gate the way delivery commands are —
     * existing minted tokens cannot carry new scopes, and files are
     * workspace-visible like signals. Tombstone/restore enforce the §6 actor
     * rule (own uploads only for agents) inside their handlers. */
    const isFileCommand =
      (FILE_COMMAND_KINDS as readonly string[]).includes(
        validation.command.kind,
      );
    if (
      auth.agent !== null &&
      !isRenewal &&
      !isAgentTokenRevoke &&
      !isModelDeclare &&
      !isFeedback &&
      !isChannelCommand &&
      !isDeliveryCommand &&
      !isSeenCommand &&
      !isFileCommand &&
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

    if (kind === CLAIM_AGENT_INBOX_KIND || kind === ACK_AGENT_DELIVERY_KIND) {
      const agent = auth.agent;
      if (agent === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      const operation = kind === CLAIM_AGENT_INBOX_KIND ? "claim" : "ack";
      const rateCheck = await checkDeliveryRateLimit(
        tx,
        auth,
        route.workspaceId,
        agent.principal_id,
        operation,
      );
      if (!rateCheck.allowed) {
        return rateCheck.result;
      }
    }

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
          // Never put lease ids or bodies in audit detail.
          detail: ignoredIdentity,
          hash,
        });
        if (!matches) {
          return { status: 409, body: { error: "command_id_conflict" } };
        }
        if (kind === CLAIM_AGENT_INBOX_KIND && auth.agent !== null) {
          const ledger = parseClaimLedger(existing.response);
          if (ledger === null) {
            return {
              status: 403,
              body: { error: "delivery_unavailable" },
            };
          }
          const deliveries = await hydrateDeliveryRefs(tx, {
            workspaceId: route.workspaceId,
            recipientPrincipalId: auth.agent.principal_id,
            recipientOwnerUserId: auth.agent.owner_user_id,
            refs: ledger.delivery_refs,
          });
          if (deliveries === null) {
            return {
              status: 403,
              body: { error: "delivery_unavailable" },
            };
          }
          return {
            status: 200,
            body: {
              ok: true,
              status: "accepted",
              capabilities: DELIVERY_CAPABILITIES,
              deliveries,
              pending_delivery_count: ledger.pending_delivery_count,
              terminal_delivery_failure_count: ledger.terminal_delivery_failure_count,
              /* Spread, never defaulted -- see the same comment on the fresh
               * claim below. This is the replay path, so it is the ONE place
               * absent is actually reachable: a claim stored before the field
               * existed. */
              ...(ledger.oldest_pending_at === undefined
                ? {}
                : { oldest_pending_at: ledger.oldest_pending_at }),
              event_ids: [],
              events: [],
              min_client_version: minClientVersion,
            },
          };
        }
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

    if (command.kind === SIGNALS_SEEN_KIND) {
      const userId = auth.actor.user;
      const principalId = auth.agent?.principal_id ?? null;
      if (
        (auth.credentialKind === "user" && userId === null) ||
        (auth.credentialKind === "agent" && principalId === null)
      ) {
        return { status: 403, body: { error: "forbidden" } };
      }
      const seen = auth.credentialKind === "user"
        ? await markHumanSignalsSeen(tx, {
          workspaceId: route.workspaceId,
          userId: userId!,
          signalIds: command.signal_ids,
        })
        : await markAgentSignalsSeen(tx, {
          workspaceId: route.workspaceId,
          principalId: principalId!,
          signalIds: command.signal_ids,
        });
      if (seen.status === "forbidden") {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "authz",
          reason: auth.credentialKind === "user"
            ? "signal_not_eligible_for_human_receipt"
            : "signal_not_eligible_for_agent_receipt",
          detail: ignoredIdentity,
          hash,
        });
        return { status: 403, body: { error: "forbidden" } };
      }

      const response: StoredResponse = { ok: true, event_ids: [] };
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
          ${tx.json(response as unknown as postgres.JSONValue)}::jsonb
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
      return {
        status: 200,
        body: {
          status: "accepted",
          ...response,
          min_client_version: minClientVersion,
        },
      };
    }

    if ((CHANNEL_COMMAND_KINDS as readonly string[]).includes(command.kind)) {
      const outcome = await applyChannelCommand(
        tx,
        route,
        auth,
        command as ChannelCommand,
      );
      if (!outcome.ok) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: outcome.status === 404 ? "authz" : "domain",
          reason: outcome.reason,
          hash,
        });
        return {
          status: outcome.status,
          body: { error: outcome.error, message: outcome.message },
        };
      }
      const channelResponse: StoredResponse = {
        ok: true,
        event_ids: [],
        channel: outcome.channel,
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
          ${tx.json(channelResponse as unknown as postgres.JSONValue)}::jsonb
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
      return {
        status: 200,
        body: {
          status: "accepted",
          ...channelResponse,
          events: [],
          min_client_version: minClientVersion,
        },
      };
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
      const attachmentResolution = await resolveSignalAttachments(
        tx,
        route,
        command.attachments ?? [],
      );
      if (!attachmentResolution.ok) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: attachmentResolution.status === 404 ? "authz" : "domain",
          reason: attachmentResolution.reason,
          hash,
        });
        return {
          status: attachmentResolution.status,
          body: {
            error: attachmentResolution.error,
            message: attachmentResolution.message,
            ...(attachmentResolution.error === "signal_attachment_limit"
              ? { limit: SIGNAL_ATTACHMENT_MAX }
              : {}),
          },
        };
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

      const channelResolution = await resolveSignalChannel(tx, route, command);
      if (!channelResolution.ok) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: channelResolution.status === 404 ? "authz" : "domain",
          reason: channelResolution.reason!,
          hash,
        });
        return {
          status: channelResolution.status!,
          body: {
            error: channelResolution.error!,
            message: channelResolution.message!,
          },
        };
      }
      const threadResolution = await resolveThreadRoot(tx, route, command);
      if (!threadResolution.ok) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: threadResolution.status === 404 ? "authz" : "domain",
          reason: threadResolution.reason!,
          hash,
        });
        return {
          status: threadResolution.status!,
          body: {
            error: threadResolution.error!,
            message: threadResolution.message!,
          },
        };
      }
      /* Reply expiry: the server CLAMPS a defaulted horizon and REFUSES an
       * explicit one it cannot honour. Silently shortening a horizon the caller
       * typed is the dishonest branch, and it is the one case where a refusal
       * tells the truth. The per-kind defaults are longer than a short-lived
       * root for almost every combination, so refusing them all would refuse
       * almost every thread reply. */
      const requestedUntilMs = command.until_ms ??
        SIGNAL_DEFAULT_UNTIL_MS[command.signal_kind];
      const rootUntil = threadResolution.rootUntil;
      const rootRemainingMs = threadResolution.rootRemainingMs;
      if (
        rootUntil !== null && rootRemainingMs !== null &&
        command.until_ms !== undefined
      ) {
        /* An EARLY, friendly refusal. Both sides come from Postgres, so no
         * clock skew decides it -- but it is measured one statement before the
         * insert, so it cannot be the guarantee. The guarantee is the WHERE in
         * postSignal, which tests the same thing in the writing statement. This
         * check exists to give the caller the root's expiry in the message
         * rather than a bare conflict. */
        if (command.until_ms > rootRemainingMs) {
          await insertAudit(tx, {
            auth,
            commandKind: kind,
            workspaceId: route.workspaceId,
            streamId: route.streamId,
            outcome: "domain",
            reason: "thread_reply_until_exceeds_root",
            hash,
          });
          return {
            status: 409,
            body: {
              error: "thread_reply_until_exceeds_root",
              message:
                `A reply cannot outlive the message its thread starts from. That thread ends at ${rootUntil.toISOString()}. Ask for a shorter horizon, or leave it out and it is set for you.`,
              root_until: rootUntil.toISOString(),
            },
          };
        }
      }
      /* A threaded reply inherits its root's channel. The client does not get
       * to file a reply somewhere its thread is not, and a reply whose root is
       * unfiled stays unfiled. An explicit channel alongside thread_root_id is
       * REFUSED by the validator (chatSignalShapeProblem), not silently
       * ignored here, so this line only ever chooses between an inherited
       * value and a top-level post's own channel. */
      const placementChannelId = threadResolution.threadRootId !== null
        ? threadResolution.rootChannelId
        : channelResolution.channelId;
      const signal = await postSignal(
        tx,
        route,
        auth,
        command,
        signalTarget,
        attachmentResolution.attachments,
        {
          channelId: placementChannelId,
          threadRootId: threadResolution.threadRootId,
          broadcastToChannel: command.broadcast_to_channel ?? false,
          untilMs: requestedUntilMs,
          untilCeiling: rootUntil === null ? null : rootUntil.toISOString(),
          untilExplicit: command.until_ms !== undefined,
        },
      );
      if (signal === null) {
        /* The atomic arm fired: the horizon fit when it was checked and no
         * longer fit when the row was written. Refusing is the honest answer;
         * storing a shorter horizon than the caller named is the branch this
         * design rules out. */
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "domain",
          reason: "thread_reply_until_exceeds_root",
          hash,
        });
        return {
          status: 409,
          body: {
            error: "thread_reply_until_exceeds_root",
            /* This fires when the horizon the caller NAMED no longer fits the
             * time the thread has left, measured in the writing statement. The
             * thread itself is usually still very much alive -- an earlier
             * version of this sentence said it had ended, which was false for
             * every case but one and is the kind of confident wrong sentence
             * this codebase keeps producing. Say what is true: the horizon does
             * not fit, and here is what the thread runs to. */
            message: command.until_ms !== undefined
              ? "A reply cannot outlive the message its thread starts from, and the horizon you asked for no longer fits the time that thread has left. Ask for a shorter one, or leave it out and it is set for you."
              /* The defaulted path reaches this arm too, because the floor can
               * raise a defaulted value past the ceiling. Telling that caller
               * to "leave it out" is telling them to do what they already did. */
              : "That thread has too little time left to take a reply. Start a new message instead.",
            ...(rootUntil === null ? {} : { root_until: rootUntil.toISOString() }),
          },
        };
      }
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

    if ((FILE_COMMAND_KINDS as readonly string[]).includes(command.kind)) {
      const fileCommand = command as FileCommand;
      const fileActor = auth.credentialKind === "agent"
        ? { kind: "agent" as const, id: auth.agent!.principal_id }
        : { kind: "user" as const, id: auth.actor.user! };
      /* Called by handlers AFTER their row locks: a same-command-id request
       * that lost the lock race finds the winner's ledgered response here
       * instead of re-executing against changed state. The stored row must
       * match THIS request's hash and route — a same-id request with different
       * content must conflict, never wear the winner's response. */
      const ledgerRecheck = async (): Promise<
        | { hit: "stored"; stored: Record<string, unknown> }
        | { hit: "conflict" }
        | null
      > => {
        const rows = await tx<
          {
            response: unknown;
            request_hash: string;
            workspace_id: string;
            stream_id: string;
          }[]
        >`
          SELECT response, request_hash, workspace_id, stream_id
          FROM swarm.idempotency_keys
          WHERE principal_kind = ${auth.credentialKind}
            AND principal_id = ${canonicalPrincipal(auth.actor)}
            AND command_id = ${commandId}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;
        const stored = record(row.response);
        if (stored === null) return { hit: "conflict" };
        const matches = row.request_hash === hash &&
          row.workspace_id === route.workspaceId &&
          row.stream_id === route.streamId;
        return matches ? { hit: "stored", stored } : { hit: "conflict" };
      };
      /* Pre-charge recheck: a retry of a settled command id must replay before
       * it can be rate-limited (429-then-200 divergence) or refused by a
       * pre-lock 404. Concurrency is still the post-lock recheck's job. */
      const preDispatch = await ledgerRecheck();
      if (preDispatch?.hit === "conflict") {
        return { status: 409, body: { error: "command_id_conflict" } };
      }
      if (preDispatch !== null) {
        return { status: 200, body: preDispatch.stored };
      }
      // §4 rate limit, charged only for the verb that consumes quota (★R9.6) —
      // and only AFTER the pre-charge recheck above, so replaying a settled
      // command id never burns budget or returns 429 (round-3 finding).
      if (fileCommand.kind === FILE_VERSION_CREATE_KIND) {
        // Humans key by user id — credentialId is null for every human, which
        // was one shared global bucket; agents key by PRINCIPAL, because a
        // token id rotates and each rotation would reset the meter.
        const rateIdentity = auth.credentialKind === "agent"
          ? auth.agent!.principal_id
          : auth.actor.user;
        if (rateIdentity === null) {
          throw new Error("file rate limit has no stable identity");
        }
        const bucket = await incrementRateBucket(
          tx,
          `file:create:${auth.credentialKind}:${rateIdentity}`,
          FILE_CREATE_RATE_LIMIT_PER_HOUR,
        );
        if (bucket.count > FILE_CREATE_RATE_LIMIT_PER_HOUR) {
          const detail =
            `file limit ${FILE_CREATE_RATE_LIMIT_PER_HOUR} uploads/hour; resets at ${bucket.resetsAt}`;
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
          return {
            status: 429,
            body: {
              error: "rate_limited",
              message: `Upload refused: ${detail}.`,
              limit: FILE_CREATE_RATE_LIMIT_PER_HOUR,
              resets_at: bucket.resetsAt,
            },
          };
        }
      }
      const storage = fileStorage();
      const outcome = fileCommand.kind === FILE_VERSION_CREATE_KIND
        ? await fileVersionCreate(
          tx,
          route.workspaceId,
          fileActor,
          fileCommand,
          storage,
          ledgerRecheck,
        )
        : fileCommand.kind === FILE_VERSION_COMMIT_KIND
        ? await fileVersionCommit(
          tx,
          route.workspaceId,
          fileActor,
          fileCommand,
          storage,
          ledgerRecheck,
        )
        : fileCommand.kind === FILE_DOWNLOAD_URL_KIND
        ? await fileDownloadUrl(tx, route.workspaceId, fileCommand, storage)
        : fileCommand.kind === FILE_TOMBSTONE_KIND
        ? await fileTombstone(
          tx,
          route.workspaceId,
          fileActor,
          fileCommand,
          ledgerRecheck,
        )
        : await fileRestore(
          tx,
          route.workspaceId,
          fileActor,
          fileCommand,
          ledgerRecheck,
        );
      if (outcome.ok === "replay") {
        // The ledger holds accepted results only (see the refusal comment
        // below), so a recheck hit is always the winner's 200.
        return { status: 200, body: outcome.stored };
      }
      if (!outcome.ok) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: outcome.refusal.status === 403 ? "authz" : "domain",
          reason: outcome.refusal.reason,
          detail: ignoredIdentity,
          hash,
        });
        /* FILE REFUSALS ARE DELIBERATELY NOT LEDGERED — do not "fix" this by
         * ledgering them again. An earlier round did, to stop a replayed id
         * returning a different result; the inversion arm then found the trap
         * that kills that rule: a ledgered 409 file_bytes_missing FREEZES the
         * honest idempotent retry — PUT the bytes, retry the SAME command id —
         * on a stale refusal forever (same for file_not_tombstoned after a
         * tombstone). State-dependent refusals are honest reports about NOW
         * and must re-evaluate on retry; re-running them has no side effect,
         * because the ledger only ever stores ACCEPTED results (effects) and
         * the post-lock recheck above prevents double-execution of those.
         * Same-id-different-content is command_id_conflict via the hash
         * comparison, never a replay. */
        return {
          status: outcome.refusal.status,
          body: {
            error: outcome.refusal.error,
            message: outcome.refusal.message,
          },
        };
      }
      const fileResponse = {
        ok: true,
        status: "accepted",
        ...outcome.body,
        event_ids: [],
        events: [],
        min_client_version: minClientVersion,
      };
      // ★R16: the stored response makes create idempotent — a retry with the
      // same command id replays the SAME pending slot and upload URL.
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
          ${tx.json(fileResponse as unknown as postgres.JSONValue)}::jsonb
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
      return { status: 200, body: fileResponse };
    }

    if (command.kind === CLAIM_AGENT_INBOX_KIND) {
      // Auth already loaded the exact agent principal; request fields cannot
      // select another recipient. Step 1 of the claim order is complete.
      const agent = auth.agent;
      if (agent === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      const ledger = await claimAgentInbox(tx, {
        workspaceId: route.workspaceId,
        recipientPrincipalId: agent.principal_id,
        receiverOwnerUserId: agent.owner_user_id,
        listenerInstanceId: command.listener_instance_id,
        limit: command.limit,
      });
      if (ledger === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
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
          ${tx.json(ledger as unknown as postgres.JSONValue)}::jsonb
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
      const deliveries = await hydrateDeliveryRefs(tx, {
        workspaceId: route.workspaceId,
        recipientPrincipalId: agent.principal_id,
        recipientOwnerUserId: agent.owner_user_id,
        refs: ledger.delivery_refs,
      });
      if (deliveries === null) {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "domain",
          reason: "delivery_hydration_integrity",
          detail: ignoredIdentity,
          hash,
        });
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      if (ledger.terminal_delivery_failure_count > 0) {
        await tx`
          INSERT INTO swarm.security_alerts (kind, subject, detail)
          VALUES (
            'delivery_attempts_exhausted',
            'agent',
            ${tx.json({
              workspace_id: route.workspaceId,
              recipient_principal_id: agent.principal_id,
              terminal_delivery_failure_count: ledger.terminal_delivery_failure_count,
            })}::jsonb
          )
        `;
      }
      await insertAudit(tx, {
        auth,
        commandKind: kind,
        workspaceId: route.workspaceId,
        streamId: route.streamId,
        outcome: "accepted",
        detail: `terminal_delivery_failure_count=${ledger.terminal_delivery_failure_count}`,
        hash,
      });
      return {
        status: 200,
        body: {
          ok: true,
          status: "accepted",
          capabilities: DELIVERY_CAPABILITIES,
          deliveries,
          pending_delivery_count: ledger.pending_delivery_count,
          terminal_delivery_failure_count: ledger.terminal_delivery_failure_count,
          /* Spread, never defaulted: an ABSENT oldest_pending_at (a replay of a
           * claim stored before the field existed) must stay absent rather than
           * become null, which would say the queue is empty beside a count that
           * says it is not. */
          ...(ledger.oldest_pending_at === undefined
            ? {}
            : { oldest_pending_at: ledger.oldest_pending_at }),
          event_ids: [],
          events: [],
          min_client_version: minClientVersion,
        },
      };
    }

    if (command.kind === ACK_AGENT_DELIVERY_KIND) {
      const agent = auth.agent;
      if (agent === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      const result = await ackAgentDelivery(tx, {
        workspaceId: route.workspaceId,
        recipientPrincipalId: agent.principal_id,
        signalId: command.signal_id,
        leaseId: command.lease_id,
        listenerInstanceId: command.listener_instance_id,
        outcome: command.outcome,
        lastErrorCode: command.last_error_code,
      });
      if (result.status === "unavailable") {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "authz",
          reason: "delivery_unavailable",
          detail: ignoredIdentity,
          hash,
        });
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      if (result.status === "conflict") {
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "domain",
          reason: "delivery_ack_outcome_conflict",
          detail: ignoredIdentity,
          hash,
        });
        return { status: 409, body: { error: "delivery_ack_conflict" } };
      }
      const ackResponse = result.response;
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
          ${tx.json(ackResponse as unknown as postgres.JSONValue)}::jsonb
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
        outcome: result.status === "idempotent" ? "replayed" : "accepted",
        detail: ignoredIdentity,
        hash,
      });
      return {
        status: 200,
        body: {
          status: "accepted",
          ok: true,
          event_ids: [],
          signal_id: ackResponse.signal_id,
          outcome: ackResponse.outcome,
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
    if (prepared !== null && prepared.command.kind === "set_agent_model") {
      /* The human mirror of declare's two guards below: unchanged sets are
       * accepted no-ops (no event/audit/ledger/charge), and changed values
       * ride the same hourly bucket — keyed by the HUMAN user id, since that
       * is the acting identity here. The reducer still owns authorization;
       * these guards only stop append/charge churn. Compound-keyed read, the
       * ★R1 shape: the row must belong to the routed workspace. */
      const targetPrincipal = prepared.command.principal_id;
      /* Both review arms, same finding: this fast path used to return before the
       * reducer's ownership gate, so an unchanged-value submit ACCEPTED for a
       * principal the caller may not manage — an authorization probe. The fast
       * path now fires only when the caller would pass the reducer's exact gate
       * (owner/admin any; member self-only); anything else falls through and the
       * reducer refuses in its own words, so the refusal shape cannot desync. */
      const currentRows = await tx<
        { model: string | null; owner_user_id: string }[]
      >`
        SELECT model, owner_user_id FROM swarm.agent_principals
        WHERE principal_id = ${targetPrincipal}::uuid
          AND workspace_id = ${route.workspaceId}::uuid
          AND revoked_at IS NULL
      `;
      const currentRow = currentRows[0];
      /* The caller's role and identity are already resolved in scope: the route
       * carries the live membership role, and the auth actor carries the human
       * user id (HUMAN_ONLY refused agent credentials before this point). */
      const callerUserId = auth.actor.user;
      const callerMayManage = currentRow !== undefined && callerUserId !== null && (
        route.membershipRole === "owner" ||
        route.membershipRole === "admin" ||
        currentRow.owner_user_id === callerUserId
      );
      if (
        callerMayManage &&
        (currentRow.model ?? null) === prepared.command.model
      ) {
        return {
          status: 200,
          body: {
            status: "accepted",
            ok: true,
            event_ids: [],
            events: [],
            unchanged: true,
            workspace_id: route.workspaceId,
            min_client_version: minClientVersion,
          },
        };
      }
      const setBucket = await incrementRateBucket(
        tx,
        `model:set:user:${auth.actor.user}`,
        MODEL_DECLARE_RATE_LIMIT_PER_HOUR,
      );
      if (setBucket.count > MODEL_DECLARE_RATE_LIMIT_PER_HOUR) {
        const detail =
          `model set limit ${MODEL_DECLARE_RATE_LIMIT_PER_HOUR} changes/hour; resets at ${setBucket.resetsAt}`;
        await insertAudit(tx, {
          auth,
          commandKind: kind,
          workspaceId: route.workspaceId,
          streamId: route.streamId,
          outcome: "rate_limit",
          reason: "rate_limited",
          detail,
        });
        return {
          status: 429,
          body: {
            error: "rate_limited",
            message: `Model change refused: ${detail}.`,
            limit: MODEL_DECLARE_RATE_LIMIT_PER_HOUR,
            resets_at: setBucket.resetsAt,
          },
        };
      }
    }
    if (prepared !== null && prepared.command.kind === "submit_feedback") {
      /* Two guards BEFORE the reducer, the declare/set pattern:
       *
       * An EXACT duplicate body from the same reporter within the hour is an
       * accepted no-op — retry storms (a client re-running a script, a stuck
       * loop) would otherwise fill the table with identical rows. Feedback
       * that legitimately repeats across hours or with different wording is
       * NOT suppressed; repetition is itself signal. Compared against the
       * projection-target table, not folded stream state (the backfill
       * lesson). Changed submissions ride the shared hourly bucket, keyed by
       * principal for agents (token ids rotate) and user id for humans. */
      const reporterKey = auth.agent !== null
        ? `agent:${auth.agent.principal_id}`
        : `user:${auth.actor.user}`;
      const reporterUuid = auth.agent !== null
        ? auth.agent.principal_id
        : auth.actor.user;
      if (reporterUuid !== null) {
        const duplicateRows = await tx<{ feedback_id: string }[]>`
          SELECT feedback_id FROM swarm.feedback
          WHERE workspace_id = ${route.workspaceId}::uuid
            AND reporter_id = ${reporterUuid}::uuid
            AND body = ${prepared.command.body}
            AND created_at > statement_timestamp() - interval '1 hour'
          LIMIT 1
        `;
        if (duplicateRows.length > 0) {
          return {
            status: 200,
            body: {
              status: "accepted",
              ok: true,
              event_ids: [],
              events: [],
              duplicate: true,
              message:
                "This feedback matches one you sent within the hour, so it was not recorded twice. It is already with the operators of this deployment.",
              workspace_id: route.workspaceId,
              min_client_version: minClientVersion,
            },
          };
        }
        const feedbackBucket = await incrementRateBucket(
          tx,
          `feedback:${reporterKey}`,
          FEEDBACK_RATE_LIMIT_PER_HOUR,
        );
        if (feedbackBucket.count > FEEDBACK_RATE_LIMIT_PER_HOUR) {
          const detail =
            `feedback limit ${FEEDBACK_RATE_LIMIT_PER_HOUR}/hour; resets at ${feedbackBucket.resetsAt}`;
          await insertAudit(tx, {
            auth,
            commandKind: kind,
            workspaceId: route.workspaceId,
            streamId: route.streamId,
            outcome: "rate_limit",
            reason: "rate_limited",
            detail,
          });
          return {
            status: 429,
            body: {
              error: "rate_limited",
              message: `Feedback refused: ${detail}.`,
              limit: FEEDBACK_RATE_LIMIT_PER_HOUR,
              resets_at: feedbackBucket.resetsAt,
            },
          };
        }
      }
    }
    if (prepared !== null && prepared.command.kind === "declare_agent_model") {
      /* Two abuse guards (landing-round finding 4), both BEFORE the reducer:
       *
       * Unchanged declarations are accepted no-ops with NO event, audit,
       * ledger, or charge — every listener redeclares at every start, and the
       * steady state is "same label again". Compared against the TABLE the
       * projection targets, not folded stream state: out-of-band backfills
       * exist, and suppressing against a stream value the table does not hold
       * would strand the table. Changed values ride the file lane's
       * per-principal hourly bucket, keyed by PRINCIPAL because token ids
       * rotate (★R9.6's lesson). */
      const declaringPrincipal = auth.agent?.principal_id ?? null;
      if (declaringPrincipal !== null) {
        const currentRows = await tx<{ model: string | null }[]>`
          SELECT model FROM swarm.agent_principals
          WHERE principal_id = ${declaringPrincipal}::uuid
            AND workspace_id = ${route.workspaceId}::uuid
            AND revoked_at IS NULL
        `;
        const currentRow = currentRows[0];
        if (
          currentRow !== undefined &&
          (currentRow.model ?? null) === prepared.command.model
        ) {
          return {
            status: 200,
            body: {
              status: "accepted",
              ok: true,
              event_ids: [],
              events: [],
              unchanged: true,
              workspace_id: route.workspaceId,
              min_client_version: minClientVersion,
            },
          };
        }
        const declareBucket = await incrementRateBucket(
          tx,
          `model:declare:agent:${declaringPrincipal}`,
          MODEL_DECLARE_RATE_LIMIT_PER_HOUR,
        );
        if (declareBucket.count > MODEL_DECLARE_RATE_LIMIT_PER_HOUR) {
          const detail =
            `model declaration limit ${MODEL_DECLARE_RATE_LIMIT_PER_HOUR} changes/hour; resets at ${declareBucket.resetsAt}`;
          await insertAudit(tx, {
            auth,
            commandKind: kind,
            workspaceId: route.workspaceId,
            streamId: route.streamId,
            outcome: "rate_limit",
            reason: "rate_limited",
            detail,
          });
          return {
            status: 429,
            body: {
              error: "rate_limited",
              message: `Declaration refused: ${detail}.`,
              limit: MODEL_DECLARE_RATE_LIMIT_PER_HOUR,
              resets_at: declareBucket.resetsAt,
            },
          };
        }
      }
    }
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
              grant_kind: prepared.command.renewal_kind,
              horizon_expires_at: prepared.command.renewal_horizon_ms === null
                ? null
                : new Date(
                  now + prepared.command.renewal_horizon_ms,
                ).toISOString(),
              successors_remaining:
                prepared.command.renewal_kind === "standing"
                  ? null
                  : RENEWAL_MAX_SUCCESSORS_DEFAULT,
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
    if (
      outcome.decision.ok &&
      auth.agent !== null &&
      prepared?.command.kind !== RENEW_AGENT_TOKEN_KIND
    ) {
      await tx`
        SELECT swarm.record_renewal_grant_use(
          ${auth.agent.token_id}::uuid,
          ${auth.agent.device_id}::uuid,
          NULL
        )
      `;
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

    if (
      (error.commandKind === CLAIM_AGENT_INBOX_KIND ||
        error.commandKind === ACK_AGENT_DELIVERY_KIND) &&
      error.auth.agent !== null
    ) {
      const op = error.commandKind === CLAIM_AGENT_INBOX_KIND ? "claim" : "ack";
      const rateRes = await checkDeliveryRateLimit(
        tx,
        error.auth,
        error.workspaceId,
        error.auth.agent.principal_id,
        op,
      );
      if (!rateRes.allowed) {
        return rateRes.result;
      }
    }

    const configRows = await tx<{ value: unknown }[]>`
      SELECT value FROM swarm.config WHERE key = 'min_client_version' LIMIT 1
    `;
    const minClientVersion =
      typeof configRows[0]?.value === "string" ? configRows[0].value : "0.1.0";
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
    if (!matches) {
      return { status: 409, body: { error: "command_id_conflict" } };
    }
    // Body-free claim ledger must rehydrate after race resolution.
    if (
      error.commandKind === CLAIM_AGENT_INBOX_KIND &&
      error.auth.agent !== null
    ) {
      const ledger = parseClaimLedger(winner.response);
      if (ledger === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      const deliveries = await hydrateDeliveryRefs(tx, {
        workspaceId: error.workspaceId,
        recipientPrincipalId: error.auth.agent.principal_id,
        recipientOwnerUserId: error.auth.agent.owner_user_id,
        refs: ledger.delivery_refs,
      });
      if (deliveries === null) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          status: "accepted",
          capabilities: DELIVERY_CAPABILITIES,
          deliveries,
          pending_delivery_count: ledger.pending_delivery_count,
          terminal_delivery_failure_count: ledger.terminal_delivery_failure_count,
          /* Spread, never defaulted: an ABSENT oldest_pending_at (a replay of a
           * claim stored before the field existed) must stay absent rather than
           * become null, which would say the queue is empty beside a count that
           * says it is not. */
          ...(ledger.oldest_pending_at === undefined
            ? {}
            : { oldest_pending_at: ledger.oldest_pending_at }),
          event_ids: [],
          events: [],
          min_client_version: minClientVersion,
        },
      };
    }
    if (error.commandKind === ACK_AGENT_DELIVERY_KIND) {
      const response = record(winner.response);
      if (
        !response ||
        response.ok !== true ||
        typeof response.signal_id !== "string" ||
        typeof response.outcome !== "string"
      ) {
        return { status: 403, body: { error: "delivery_unavailable" } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          status: "accepted",
          signal_id: response.signal_id,
          outcome: response.outcome,
          event_ids: [],
          events: [],
          min_client_version: minClientVersion,
        },
      };
    }
    return replayResult(storedResponse(winner.response), error.commandKind);
  });
}

/** Persist one allowlisted failure row after the command transaction is gone. */
async function insertCommandFailure(
  failure: DurableCommandFailure,
): Promise<void> {
  /* handleTransaction's db.begin promise rejects only after postgres.js has
   * rolled that transaction back. Using the pool here therefore obtains a
   * usable connection outside it. This is one autocommit INSERT: no BEGIN,
   * role setup, retry, or second diagnostic round trip can amplify an outage. */
  await db`
    INSERT INTO swarm.command_failures (
      command_kind, reason, db_code, detail, request_id
    ) VALUES (
      ${failure.command_kind},
      ${failure.reason},
      ${failure.db_code},
      ${failure.detail},
      ${failure.request_id}::uuid
    )
  `;
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

  const requestId = crypto.randomUUID();
  try {
    const result = await handleTransaction(
      body,
      verifiedHuman,
      agentTokenHash,
    );
    /* S4: opportunistic purge-queue drain, AFTER the command's transaction and
     * in its own — a storage outage must never fail the command that happened
     * to trigger the drain. The queue is durable, so a swallowed failure only
     * defers work to the next file command. Bounded to keep latency flat. */
    if ((FILE_COMMAND_KINDS as readonly string[]).includes(kind)) {
      const drain = (async () => {
        try {
          await db.begin(async (drainTx) => {
            await drainTx.unsafe("SET LOCAL ROLE swarm_command");
            await drainTx.unsafe(
              "SET LOCAL search_path = swarm, pg_catalog",
            );
            await drainFilePurgeQueue(drainTx, fileStorage(), 10);
          });
        } catch (error) {
          console.error("file purge queue drain failed", safeError(error));
        }
      })();
      /* S4 review item 1: the drain must not delay an already-committed
       * command's response. waitUntil detaches it where the runtime offers
       * that; the fallback await is bounded by the storage fetch's 3s abort,
       * so even a runtime without waitUntil caps the added latency. */
      const runtime = (globalThis as {
        EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
      }).EdgeRuntime;
      if (typeof runtime?.waitUntil === "function") {
        runtime.waitUntil(drain);
      } else {
        await drain;
      }
    }
    return json(result.status, result.body, result.headers);
  } catch (error) {
    if (error instanceof LedgerRace) {
      try {
        const result = await resolveLedgerRace(error);
        return json(result.status, result.body, result.headers);
      } catch (raceError) {
        console.error("command race resolution failed", safeError(raceError));
      }
    }
    const code = dbCode(error);
    const reason = classifyCommandFailure(error instanceof TestRollback, code);
    logCommandFailure(
      "command_request_failure",
      kind,
      "error",
      reason,
      safeError(error),
    );
    // 40001 (serialization failure) and 40P01 (deadlock) deliberately still
    // fall through to the existing 500. The durable SQLSTATE will provide the
    // data needed to decide a later retryable-503 change in its own lane.
    const failure = durableCommandFailure({
      commandKind: kind,
      reason,
      code,
      error,
      requestId,
    });
    const result = await finishCommandFailure(
      failure,
      insertCommandFailure,
      (insertError) => {
        console.error("command failure persistence failed", safeError(insertError));
      },
    );
    return json(result.status, result.body);
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
