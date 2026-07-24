// GENERATED from src/protocol/index.ts; do not hand-edit.

// src/protocol/events.ts
var SCHEMA_VERSION = 1;
function canonicalPrincipal(actor) {
  const p = actor.agent_principal ?? actor.user;
  if (!p) throw new Error("actor has neither agent_principal nor user");
  return p;
}
var EVENT_TYPES = [
  "TaskCreated",
  "LeaseAcquired",
  "LeaseRenewed",
  "LeaseHandedOff",
  "LeaseTakenOver",
  "TaskSubmitted",
  "TaskClosed",
  "TaskReopened",
  "CommandRejected"
];
function leaseLive(state, now) {
  return state.owner !== null && state.lease_expiry !== null && state.lease_expiry > now;
}

// src/protocol/reducer.ts
function req(payload, keys, type, seq) {
  if (!payload || typeof payload !== "object") throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  for (const k of keys) {
    if (payload[k] === void 0) {
      throw new StreamIntegrityError(`event "${type}" at seq ${seq} is missing payload field "${String(k)}"`);
    }
  }
  return payload;
}
var UnknownEventTypeError = class extends Error {
  constructor(type, seq) {
    super(`unknown authoritative event type "${type}" at seq ${seq}; halting`);
    this.type = type;
    this.seq = seq;
    this.name = "UnknownEventTypeError";
  }
  type;
  seq;
};
var StreamIntegrityError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StreamIntegrityError";
  }
};
function reduceTask(prev, env3) {
  if (!EVENT_TYPES.includes(env3.type)) {
    throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  if (env3.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(`event "${env3.type}" at seq ${env3.seq} is schema v${env3.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`);
  }
  if (env3.type === "CommandRejected") {
    if (!prev) throw new StreamIntegrityError(`CommandRejected before task exists (seq ${env3.seq})`);
    req(env3.payload, ["task_id", "command", "reason", "detail"], env3.type, env3.seq);
    return prev;
  }
  if (env3.type === "TaskCreated") {
    if (prev) throw new StreamIntegrityError(`TaskCreated for an already-existing task (seq ${env3.seq})`);
    const p = req(env3.payload, ["task_id", "slug"], env3.type, env3.seq);
    return {
      task_id: p.task_id,
      slug: p.slug,
      lifecycle: "open",
      version: 1,
      epoch: 0,
      owner: null,
      lease_expiry: null,
      submission: null,
      closed_disposition: null
    };
  }
  if (!prev) throw new StreamIntegrityError(`event "${env3.type}" before TaskCreated (seq ${env3.seq})`);
  const s = prev;
  function assertEpochIncrease(ep) {
    if (typeof ep !== "number" || ep <= s.epoch) {
      throw new StreamIntegrityError(`${env3.type} at seq ${env3.seq} has non-increasing epoch ${ep} (current ${s.epoch})`);
    }
  }
  const leaseLifecycle = s.submission ? "awaiting_review" : "active";
  switch (env3.type) {
    case "LeaseAcquired": {
      const p = req(env3.payload, ["task_id", "epoch", "owner", "lease_expiry"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseRenewed": {
      const p = req(env3.payload, ["task_id", "epoch", "lease_expiry"], env3.type, env3.seq);
      if (p.epoch !== s.epoch) throw new StreamIntegrityError(`LeaseRenewed at seq ${env3.seq} epoch ${p.epoch} != current ${s.epoch}`);
      return { ...s, lease_expiry: p.lease_expiry };
    }
    case "LeaseHandedOff": {
      const p = req(env3.payload, ["task_id", "epoch", "from_owner", "to_owner", "lease_expiry"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.to_owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseTakenOver": {
      const p = req(env3.payload, ["task_id", "epoch", "owner", "lease_expiry", "grant_id"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "TaskSubmitted": {
      const p = req(env3.payload, ["task_id", "epoch", "branch", "head_sha", "evidence_set"], env3.type, env3.seq);
      return {
        ...s,
        lifecycle: "awaiting_review",
        submission: { epoch: p.epoch, branch: p.branch, head_sha: p.head_sha, evidence_set: [...p.evidence_set] }
      };
    }
    case "TaskClosed": {
      const p = req(env3.payload, ["task_id", "epoch", "disposition", "grant_id"], env3.type, env3.seq);
      return { ...s, lifecycle: "done", closed_disposition: p.disposition };
    }
    case "TaskReopened": {
      const p = req(env3.payload, ["task_id", "version"], env3.type, env3.seq);
      if (p.version <= s.version) throw new StreamIntegrityError(`TaskReopened at seq ${env3.seq} version ${p.version} not > current ${s.version}`);
      return { ...s, lifecycle: "reopened", version: p.version, submission: null, owner: null, lease_expiry: null };
    }
    default: {
      throw new UnknownEventTypeError(env3.type, env3.seq);
    }
  }
}
function reduceStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const env3 of events) {
    if (env3.seq <= lastSeq) {
      throw new StreamIntegrityError(`events out of order or duplicated: seq ${env3.seq} after ${lastSeq}`);
    }
    lastSeq = env3.seq;
    state = reduceTask(state, env3);
  }
  return state;
}

// src/protocol/commands.ts
var DISPOSITIONS = ["merged", "pr", "archive", "discard"];
function env(ctx, type, payload) {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload
  };
}
function authz(reason, detail) {
  return { ok: false, class: "authz", reason, detail, events: [] };
}
function domain(ctx, task_id, command, reason, detail) {
  const rej = env(ctx, "CommandRejected", { task_id, command, reason, detail });
  return { ok: false, class: "domain", reason, detail, events: [rej] };
}
function accept(events) {
  return { ok: true, events };
}
function decide(state, cmd, ctx) {
  const me = canonicalPrincipal(ctx.actor);
  if (!ctx.isMember(me)) return authz("bad_state", "caller is not a current member");
  if (cmd.kind === "create") {
    if (state) return domain(ctx, cmd.task_id, "create", "slug_not_unique", "task already exists");
    if (ctx.slugTaken(cmd.slug)) return domain(ctx, cmd.task_id, "create", "slug_not_unique", "slug already in use in this stream");
    return accept([env(ctx, "TaskCreated", { task_id: cmd.task_id, slug: cmd.slug })]);
  }
  if (!state) return domain(ctx, cmd.task_id, cmd.kind, "unknown_task", "no such task in this stream");
  const s = state;
  const live = leaseLive(s, ctx.now);
  if ("ttl_ms" in cmd && (!Number.isFinite(cmd.ttl_ms) || cmd.ttl_ms <= 0)) {
    return domain(ctx, cmd.task_id, cmd.kind, "bad_state", "ttl_ms must be a finite positive number");
  }
  switch (cmd.kind) {
    case "acquire": {
      const acquirable = s.lifecycle === "open" || s.lifecycle === "reopened" || (s.lifecycle === "active" || s.lifecycle === "awaiting_review") && !live;
      if (!acquirable) {
        const why = s.lifecycle === "done" ? "task is done; reopen first" : "lease is live; use takeover";
        return domain(ctx, cmd.task_id, "acquire", "not_acquirable", why);
      }
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseAcquired", { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "renew": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "renew", "already_done", "task is done; nothing to renew");
      if (s.owner !== me) return domain(ctx, cmd.task_id, "renew", "not_owner", "only the lease owner may renew");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "renew", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "renew", "lease_expired", "lease already expired; re-acquire");
      return accept([env(ctx, "LeaseRenewed", { task_id: cmd.task_id, epoch: s.epoch, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "handoff": {
      if (s.owner !== me) return domain(ctx, cmd.task_id, "handoff", "not_owner", "only the lease owner may hand off");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "handoff", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "handoff", "lease_expired", "lease expired; cannot hand off");
      if (s.lifecycle === "awaiting_review") return domain(ctx, cmd.task_id, "handoff", "bad_state", "cannot hand off during awaiting_review; close or reopen first");
      if (!ctx.isEligibleRecipient(cmd.to_owner)) return domain(ctx, cmd.task_id, "handoff", "recipient_not_member", "recipient is not a current member/principal");
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseHandedOff", { task_id: cmd.task_id, epoch, from_owner: me, to_owner: cmd.to_owner, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "takeover": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "takeover", "not_acquirable", "task is done; reopen first");
      if (live) {
        if (s.lifecycle === "awaiting_review") return domain(ctx, cmd.task_id, "takeover", "bad_state", "cannot take over during awaiting_review; close or reopen first");
        if (!ctx.validTakeoverGrant(cmd.task_id, cmd.grant_id, s.epoch, me)) {
          return domain(ctx, cmd.task_id, "takeover", "live_lease_needs_grant", "live lease; a takeover grant bound to the current epoch and issued to you is required");
        }
      }
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseTakenOver", { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms, grant_id: live ? cmd.grant_id : null })]);
    }
    case "submit": {
      if (s.owner !== me) return domain(ctx, cmd.task_id, "submit", "not_owner", "only the lease owner may submit");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "submit", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "submit", "lease_expired", "lease expired; re-acquire before submitting");
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "submit", "already_done", "task is done");
      if (!ctx.evidenceComplete(cmd.task_id, cmd.evidence_set)) return domain(ctx, cmd.task_id, "submit", "evidence_incomplete", "evidence bundle missing/invalid for this claim");
      return accept([env(ctx, "TaskSubmitted", { task_id: cmd.task_id, epoch: s.epoch, branch: cmd.branch, head_sha: cmd.head_sha, evidence_set: [...cmd.evidence_set] })]);
    }
    case "close": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "close", "already_done", "task is already done");
      if (!s.submission) return domain(ctx, cmd.task_id, "close", "not_submitted", "no frozen submission to close");
      if (cmd.epoch !== s.submission.epoch) return domain(ctx, cmd.task_id, "close", "stale_epoch", `presented epoch ${cmd.epoch} != submission epoch ${s.submission.epoch} (superseded?)`);
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === "owner" || roleOf === "admin";
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, "close", "not_owner", "only the task owner or a workspace Owner/Admin may close");
      if (ctx.claimRequiresGrant(cmd.task_id) && !isAdmin) {
        if (!ctx.validCloseGrant(cmd.task_id, cmd.grant_id, { version: s.version, epoch: s.submission.epoch, head_sha: s.submission.head_sha })) {
          return domain(ctx, cmd.task_id, "close", "close_needs_grant", "this claim requires a close grant bound to the current frozen submission (version+epoch+head SHA)");
        }
      }
      return accept([env(ctx, "TaskClosed", { task_id: cmd.task_id, epoch: s.submission.epoch, disposition: cmd.disposition, grant_id: cmd.grant_id })]);
    }
    case "reopen": {
      if (s.lifecycle === "open" || s.lifecycle === "reopened") return domain(ctx, cmd.task_id, "reopen", "bad_state", "task is already open/reopened");
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === "owner" || roleOf === "admin";
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, "reopen", "not_owner", "reopen requires a workspace Owner/Admin or the task owner");
      if (!isAdmin && cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "reopen", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      return accept([env(ctx, "TaskReopened", { task_id: cmd.task_id, version: s.version + 1 })]);
    }
  }
}

// src/protocol/idempotency.ts
import { createHash } from "node:crypto";
function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue(v[k]);
    }
    return out;
  }
  return v;
}
function idempotencyPrincipal(actor) {
  if (actor.agent_principal !== null) return `agent:${actor.agent_principal}`;
  if (actor.user !== null) return `user:${actor.user}`;
  throw new Error("actor has neither agent_principal nor user");
}
function requestHash(actor, cmd) {
  const principal = idempotencyPrincipal(actor);
  return createHash("sha256").update(canonicalJson({ principal, cmd })).digest("hex");
}
function idemKey(actor, command_id) {
  return `${idempotencyPrincipal(actor)}\0${command_id}`;
}
function toStored(decision) {
  if (decision.ok) {
    return { ok: true, event_ids: decision.events.map((e) => e.event_id) };
  }
  return {
    ok: false,
    reason: decision.reason,
    detail: decision.detail,
    class: decision.class,
    event_ids: decision.events.map((e) => e.event_id)
  };
}
function applyCommand(ledger, state, cmd, ctx) {
  const key2 = idemKey(ctx.actor, ctx.command_id);
  const hash = requestHash(ctx.actor, cmd);
  const existing = ledger.get(key2);
  if (existing) {
    if (existing.hash === hash) return { status: "replayed", response: existing.response };
    return { status: "conflict", detail: "command_id reused with a different request (409)" };
  }
  const decision = decide(state, cmd, ctx);
  const response = toStored(decision);
  if (decision.ok || decision.class === "domain") {
    ledger.set(key2, { hash, response });
  }
  return { status: "fresh", decision, response, events: decision.events };
}

// src/protocol/upcasters.ts
var registry = /* @__PURE__ */ new Map();
function key(type, fromVersion) {
  return `${type}:${fromVersion}`;
}
function registerUpcaster(type, fromVersion, fn) {
  registry.set(key(type, fromVersion), fn);
}
var UpcastError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UpcastError";
  }
};
function upcastPayload(type, fromVersion, payload) {
  let v = fromVersion;
  let p = payload;
  if (v > SCHEMA_VERSION) {
    throw new UpcastError(`event "${type}" is schema v${v}, newer than supported v${SCHEMA_VERSION}; halting`);
  }
  while (v < SCHEMA_VERSION) {
    const fn = registry.get(key(type, v));
    if (!fn) throw new UpcastError(`no upcaster for "${type}" v${v}\u2192v${v + 1}`);
    p = fn(p);
    v += 1;
  }
  return { payload: p, schema_version: SCHEMA_VERSION };
}
function upcastEnvelope(raw) {
  const { payload, schema_version } = upcastPayload(raw.type, raw.schema_version, raw.payload);
  return { ...raw, payload, schema_version };
}
registerUpcaster("TaskCreated", 0, (p) => ({ task_id: p.id, slug: p.name }));

// src/protocol/workspace-events.ts
var WORKSPACE_ROLES = ["owner", "admin", "member"];
var WORKSPACE_EVENT_TYPES = [
  "WorkspaceCreated",
  "MemberInvited",
  "InvitationRevoked",
  "InvitationAccepted",
  "MemberJoined",
  "MemberRemoved",
  "MemberRoleChanged",
  "AgentPrincipalCreated",
  "AgentPrincipalRevoked",
  "AgentTokenMinted",
  "AgentTokenRevoked",
  "CommandRejected"
];

// src/protocol/workspace-reducer.ts
function req2(payload, keys, type, seq) {
  if (!payload || typeof payload !== "object") {
    throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  }
  for (const key2 of keys) {
    if (payload[key2] === void 0) {
      throw new StreamIntegrityError(
        `event "${type}" at seq ${seq} is missing payload field "${String(key2)}"`
      );
    }
  }
  return payload;
}
function ownerDelta(from, to) {
  return (to === "owner" ? 1 : 0) - (from === "owner" ? 1 : 0);
}
function assertRole(value, field, type, seq) {
  if (!WORKSPACE_ROLES.includes(value)) {
    throw new StreamIntegrityError(
      `event "${type}" at seq ${seq} has invalid ${field} "${String(value)}"`
    );
  }
}
function assertOwnerCount(state, env3) {
  const actual = Object.values(state.members).filter(
    (member) => member.revoked_at === null && member.role === "owner"
  ).length;
  if (state.owners_count !== actual || actual < 1) {
    throw new StreamIntegrityError(
      `event "${env3.type}" at seq ${env3.seq} violates owner count invariant (projected ${state.owners_count}, actual ${actual})`
    );
  }
}
function reduceWorkspace(prev, env3) {
  if (!WORKSPACE_EVENT_TYPES.includes(env3.type)) {
    throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  if (env3.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(
      `event "${env3.type}" at seq ${env3.seq} is schema v${env3.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`
    );
  }
  if (env3.type === "CommandRejected") {
    req2(
      env3.payload,
      ["workspace_id", "command", "reason", "detail"],
      env3.type,
      env3.seq
    );
    if (!prev) {
      throw new StreamIntegrityError(`CommandRejected before WorkspaceCreated (seq ${env3.seq})`);
    }
    return prev;
  }
  if (env3.type === "WorkspaceCreated") {
    if (prev) {
      throw new StreamIntegrityError(`WorkspaceCreated for an existing workspace (seq ${env3.seq})`);
    }
    const p = req2(
      env3.payload,
      ["workspace_id", "name", "created_by", "created_at"],
      env3.type,
      env3.seq
    );
    return {
      workspace: {
        workspace_id: p.workspace_id,
        name: p.name,
        created_by: p.created_by,
        created_at: p.created_at,
        archived_at: null
      },
      members: {
        [p.created_by]: {
          user_id: p.created_by,
          role: "owner",
          invited_by: null,
          joined_at: p.created_at,
          revoked_at: null
        }
      },
      invitations: {},
      principals: {},
      tokens: {},
      owners_count: 1
    };
  }
  if (!prev) {
    throw new StreamIntegrityError(`event "${env3.type}" before WorkspaceCreated (seq ${env3.seq})`);
  }
  const s = prev;
  let next;
  switch (env3.type) {
    case "MemberInvited": {
      const p = req2(
        env3.payload,
        [
          "invitation_id",
          "email",
          "role",
          "token_hash",
          "expires_at",
          "created_by",
          "created_at"
        ],
        env3.type,
        env3.seq
      );
      if (s.invitations[p.invitation_id]) {
        throw new StreamIntegrityError(`duplicate invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      if (Object.values(s.invitations).some(
        (invitation) => invitation.token_hash === p.token_hash
      )) {
        throw new StreamIntegrityError(`duplicate invitation token_hash at seq ${env3.seq}`);
      }
      assertRole(p.role, "role", env3.type, env3.seq);
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...p,
            consumed_at: null,
            consumed_by: null,
            revoked_at: null
          }
        }
      };
      break;
    }
    case "InvitationRevoked": {
      const p = req2(env3.payload, ["invitation_id", "revoked_at"], env3.type, env3.seq);
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: { ...invitation, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "InvitationAccepted": {
      const p = req2(
        env3.payload,
        ["invitation_id", "consumed_by", "consumed_at"],
        env3.type,
        env3.seq
      );
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...invitation,
            consumed_at: p.consumed_at,
            consumed_by: p.consumed_by
          }
        }
      };
      break;
    }
    case "MemberJoined": {
      const p = req2(
        env3.payload,
        ["user_id", "role", "invited_by", "joined_at"],
        env3.type,
        env3.seq
      );
      const existing = s.members[p.user_id];
      assertRole(p.role, "role", env3.type, env3.seq);
      if (existing?.revoked_at === null) {
        throw new StreamIntegrityError(`live member "${p.user_id}" joined twice at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...p, revoked_at: null }
        },
        owners_count: s.owners_count + ownerDelta(null, p.role)
      };
      break;
    }
    case "MemberRemoved": {
      const p = req2(env3.payload, ["user_id", "revoked_at"], env3.type, env3.seq);
      const member = s.members[p.user_id];
      if (!member || member.revoked_at !== null) {
        throw new StreamIntegrityError(`cannot remove non-live member "${p.user_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, revoked_at: p.revoked_at }
        },
        owners_count: s.owners_count + ownerDelta(member.role, null)
      };
      break;
    }
    case "MemberRoleChanged": {
      const p = req2(
        env3.payload,
        ["user_id", "from_role", "to_role"],
        env3.type,
        env3.seq
      );
      const member = s.members[p.user_id];
      assertRole(p.from_role, "from_role", env3.type, env3.seq);
      assertRole(p.to_role, "to_role", env3.type, env3.seq);
      if (!member || member.revoked_at !== null || member.role !== p.from_role) {
        throw new StreamIntegrityError(`role change has stale member state at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, role: p.to_role }
        },
        owners_count: s.owners_count + ownerDelta(p.from_role, p.to_role)
      };
      break;
    }
    case "AgentPrincipalCreated": {
      const p = req2(
        env3.payload,
        ["principal_id", "owner_user_id", "name", "created_at"],
        env3.type,
        env3.seq
      );
      if (s.principals[p.principal_id]) {
        throw new StreamIntegrityError(`duplicate principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...p, revoked_at: null }
        }
      };
      break;
    }
    case "AgentPrincipalRevoked": {
      const p = req2(
        env3.payload,
        ["principal_id", "revoked_at"],
        env3.type,
        env3.seq
      );
      const principal = s.principals[p.principal_id];
      if (!principal) {
        throw new StreamIntegrityError(`unknown principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...principal, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "AgentTokenMinted": {
      const p = req2(
        env3.payload,
        [
          "token_id",
          "principal_id",
          "run_id",
          "task_id",
          "epoch",
          "scopes",
          "issued_at",
          "expires_at"
        ],
        env3.type,
        env3.seq
      );
      if (s.tokens[p.token_id]) {
        throw new StreamIntegrityError(`duplicate token "${p.token_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...p, scopes: [...p.scopes], revoked_at: null }
        }
      };
      break;
    }
    case "AgentTokenRevoked": {
      const p = req2(env3.payload, ["token_id", "revoked_at"], env3.type, env3.seq);
      const token = s.tokens[p.token_id];
      if (!token) {
        throw new StreamIntegrityError(`unknown token "${p.token_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...token, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    default:
      throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  assertOwnerCount(next, env3);
  return next;
}
function reduceWorkspaceStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new StreamIntegrityError(
        `events out of order or duplicated: seq ${event.seq} after ${lastSeq}`
      );
    }
    lastSeq = event.seq;
    state = reduceWorkspace(state, event);
  }
  return state;
}

// src/protocol/workspace-commands.ts
var INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var AGENT_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1e3;
var AGENT_TOKEN_MAX_TTL_MS = 8 * 60 * 60 * 1e3;
var HUMAN_ONLY_COMMANDS = /* @__PURE__ */ new Set([
  "create_workspace",
  "invite_member",
  "revoke_invitation",
  "accept_invitation",
  "remove_member",
  "change_role",
  "create_agent_principal",
  "revoke_agent_principal",
  "mint_agent_token"
]);
function isAgentScopeDenylisted(scope) {
  const words = scopeWords(scope);
  const has = (...values) => values.some((value) => words.has(value));
  const mutates = has(
    "accept",
    "add",
    "archive",
    "assign",
    "author",
    "change",
    "create",
    "delete",
    "demote",
    "invalidate",
    "issue",
    "map",
    "mint",
    "promote",
    "remove",
    "remap",
    "revoke",
    "set",
    "transfer",
    "update",
    "write"
  );
  if (words.has("grant") && has("create", "issuance", "issue", "mint", "revoke")) return true;
  if (has("credential", "token", "worker") && has("create", "issuance", "issue", "mint", "renew")) return true;
  if (has("invite", "invitation")) return true;
  if (has("membership", "member", "role", "owner", "ownership") && mutates) return true;
  if (has("repo", "repository") && has("archive", "map", "remap")) return true;
  if (words.has("workspace") && has("archive", "create", "delete")) return true;
  if (words.has("capability") && words.has("url") && has("create", "issue", "mint")) return true;
  if (words.has("discard")) return true;
  if (has("invalidate", "revoke") && has(
    "credential",
    "device",
    "family",
    "lineage",
    "membership",
    "principal",
    "refresh",
    "run",
    "token"
  )) return true;
  if (mutates && has("knowledge", "playbook")) return true;
  if (mutates && words.has("instruction") && has("foundational", "trusted")) return true;
  if (mutates && words.has("schema") && has("acceptance", "trusted")) return true;
  return false;
}
function scopeWords(scope) {
  return new Set(
    scope.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((word) => {
      if (word.length > 3 && word.endsWith("ies")) {
        return `${word.slice(0, -3)}y`;
      }
      if (word.length > 1 && word.endsWith("s") && !word.endsWith("ss")) {
        return word.slice(0, -1);
      }
      return word;
    })
  );
}
function env2(ctx, type, payload) {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload
  };
}
function accept2(events) {
  return { ok: true, events };
}
function authz2(reason, detail) {
  return { ok: false, class: "authz", reason, detail, events: [] };
}
function domain2(ctx, command, reason, detail) {
  return {
    ok: false,
    class: "domain",
    reason,
    detail,
    events: [
      env2(ctx, "CommandRejected", {
        workspace_id: ctx.workspace_id,
        command,
        reason,
        detail
      })
    ]
  };
}
function liveMember(state, user_id) {
  const member = state.members[user_id];
  return member?.revoked_at === null ? member : null;
}
function callerUser(ctx) {
  return ctx.actor.user;
}
function ownerOrAdmin(role) {
  return role === "owner" || role === "admin";
}
function decideWorkspace(state, cmd, ctx) {
  const user_id = callerUser(ctx);
  if (!user_id) {
    return authz2("bad_state", "credential has no server-derived human owner");
  }
  if (HUMAN_ONLY_COMMANDS.has(cmd.kind) && ctx.credential_kind !== "human") {
    return authz2("credential_kind_forbidden", "command requires an interactive human credential");
  }
  if (cmd.kind === "create_workspace") {
    if (state) {
      if (ctx.role(user_id) === null) {
        return authz2("bad_state", "caller is not a current workspace member");
      }
      return domain2(ctx, cmd.kind, "workspace_exists", "workspace already exists");
    }
    if (!ctx.operatorAllowed(ctx.actor)) {
      return authz2("operator_not_allowed", "caller is not allowed to create a workspace");
    }
    if (cmd.workspace_id !== ctx.workspace_id) {
      return authz2("bad_state", "command does not match the resolved workspace");
    }
    return accept2([
      env2(ctx, "WorkspaceCreated", {
        workspace_id: cmd.workspace_id,
        name: cmd.name,
        created_by: user_id,
        created_at: ctx.now
      })
    ]);
  }
  if (!state) {
    return authz2("workspace_not_found", "workspace is unavailable");
  }
  if (cmd.kind === "accept_invitation") {
    if (!ctx.identityVerified(user_id)) {
      return authz2("identity_not_verified", "verified identity is required");
    }
    const matches = Object.values(state.invitations).filter(
      (invitation2) => invitation2.token_hash === cmd.token_hash
    );
    if (matches.length !== 1) {
      return authz2("invitation_token_mismatch", "invitation capability is invalid");
    }
    const invitation = matches[0];
    if (invitation.consumed_at !== null || invitation.revoked_at !== null || invitation.expires_at <= ctx.now) {
      return domain2(ctx, cmd.kind, "invitation_not_live", "invitation is consumed, revoked, or expired");
    }
    if (liveMember(state, user_id)) {
      return domain2(ctx, cmd.kind, "member_exists", "invitee is already a current member");
    }
    return accept2([
      env2(ctx, "InvitationAccepted", {
        invitation_id: invitation.invitation_id,
        consumed_by: user_id,
        consumed_at: ctx.now
      }),
      env2(ctx, "MemberJoined", {
        user_id,
        role: invitation.role,
        invited_by: invitation.created_by,
        joined_at: ctx.now
      })
    ]);
  }
  const actorRole = ctx.role(user_id);
  if (actorRole === null) {
    return authz2("bad_state", "caller is not a current workspace member");
  }
  switch (cmd.kind) {
    case "invite_member": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "inviting members requires Owner/Admin");
      }
      if (cmd.role === "owner" && actorRole !== "owner") {
        return domain2(ctx, cmd.kind, "role_forbidden", "only an Owner may invite another Owner");
      }
      if (!Number.isFinite(cmd.expires_at) || cmd.expires_at <= ctx.now || cmd.expires_at - ctx.now > INVITATION_MAX_TTL_MS) {
        return domain2(ctx, cmd.kind, "invitation_ttl_invalid", "invitation TTL must be positive and at most 7 days");
      }
      if (ctx.inviteeAlreadyMember(cmd.email)) {
        return domain2(ctx, cmd.kind, "member_exists", "invitee is already a current member");
      }
      if (state.invitations[cmd.invitation_id] || Object.values(state.invitations).some(
        (invitation) => invitation.token_hash === cmd.token_hash
      )) {
        return domain2(ctx, cmd.kind, "bad_state", "invitation id or token hash already exists");
      }
      return accept2([
        env2(ctx, "MemberInvited", {
          invitation_id: cmd.invitation_id,
          email: cmd.email,
          role: cmd.role,
          token_hash: cmd.token_hash,
          expires_at: cmd.expires_at,
          created_by: user_id,
          created_at: ctx.now
        })
      ]);
    }
    case "revoke_invitation": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "revoking invitations requires Owner/Admin");
      }
      const invitation = state.invitations[cmd.invitation_id];
      if (!invitation) {
        return domain2(ctx, cmd.kind, "invitation_not_found", "invitation does not exist");
      }
      if (invitation.consumed_at !== null || invitation.revoked_at !== null || invitation.expires_at <= ctx.now) {
        return domain2(ctx, cmd.kind, "invitation_not_live", "invitation is not live");
      }
      return accept2([
        env2(ctx, "InvitationRevoked", {
          invitation_id: cmd.invitation_id,
          revoked_at: ctx.now
        })
      ]);
    }
    case "remove_member": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "removing members requires Owner/Admin");
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain2(ctx, cmd.kind, "member_not_found", "target is not a current member");
      }
      if (actorRole === "admin" && target.role === "owner") {
        return domain2(ctx, cmd.kind, "role_forbidden", "Admin cannot remove an Owner");
      }
      if (target.role === "owner" && state.owners_count <= 1) {
        return domain2(ctx, cmd.kind, "last_owner", "last Owner cannot be removed");
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null
      )) {
        return domain2(
          ctx,
          cmd.kind,
          "landing_authority_unresolved",
          "landing authority must be transferred to a live successor first"
        );
      }
      return accept2([
        env2(ctx, "MemberRemoved", { user_id: cmd.user_id, revoked_at: ctx.now })
      ]);
    }
    case "change_role": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "changing roles requires Owner/Admin");
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain2(ctx, cmd.kind, "member_not_found", "target is not a current member");
      }
      if (target.role === cmd.role) {
        return domain2(ctx, cmd.kind, "bad_state", "member already has that role");
      }
      if (actorRole === "admin" && (target.role === "owner" || cmd.role === "owner")) {
        return domain2(ctx, cmd.kind, "role_forbidden", "Admin cannot add, remove, or change an Owner");
      }
      if (target.role === "owner" && cmd.role !== "owner" && state.owners_count <= 1) {
        return domain2(ctx, cmd.kind, "last_owner", "last Owner cannot be demoted");
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null
      )) {
        return domain2(
          ctx,
          cmd.kind,
          "landing_authority_unresolved",
          "landing authority must be transferred to a live successor first"
        );
      }
      return accept2([
        env2(ctx, "MemberRoleChanged", {
          user_id: cmd.user_id,
          from_role: target.role,
          to_role: cmd.role
        })
      ]);
    }
    case "create_agent_principal": {
      if (state.principals[cmd.principal_id] || Object.values(state.principals).some((principal) => principal.name === cmd.name)) {
        return domain2(ctx, cmd.kind, "principal_name_taken", "principal id or name already exists");
      }
      return accept2([
        env2(ctx, "AgentPrincipalCreated", {
          principal_id: cmd.principal_id,
          owner_user_id: user_id,
          name: cmd.name,
          created_at: ctx.now
        })
      ]);
    }
    case "revoke_agent_principal": {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "agent principal does not exist");
      }
      if (principal.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "agent principal is already revoked");
      }
      if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "Member may revoke only their own principal");
      }
      return accept2([
        env2(ctx, "AgentPrincipalRevoked", {
          principal_id: cmd.principal_id,
          revoked_at: ctx.now
        })
      ]);
    }
    case "mint_agent_token": {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "agent principal does not exist");
      }
      if (principal.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "agent principal is revoked");
      }
      if (principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "tokens may be minted only for an owned principal");
      }
      if (!cmd.run_id || !cmd.task_id || !Number.isInteger(cmd.epoch) || cmd.epoch < 0) {
        return domain2(ctx, cmd.kind, "binding_required", "run_id, task_id, and a non-negative integer epoch are required");
      }
      const ttl = cmd.ttl_ms ?? AGENT_TOKEN_DEFAULT_TTL_MS;
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > AGENT_TOKEN_MAX_TTL_MS) {
        return domain2(ctx, cmd.kind, "token_ttl_invalid", "token TTL must be positive and at most 8 hours");
      }
      if (state.tokens[cmd.token_id]) {
        return domain2(ctx, cmd.kind, "bad_state", "token id already exists");
      }
      if (cmd.scopes.length === 0 || cmd.scopes.some((scope) => scopeWords(scope).size === 0)) {
        return domain2(ctx, cmd.kind, "scope_not_allowed", "at least one concrete scope is required");
      }
      if (cmd.scopes.some(isAgentScopeDenylisted)) {
        return domain2(ctx, cmd.kind, "scope_denylisted", "one or more scopes are human-credential-only");
      }
      const humanRights = new Set(ctx.humanRights(ctx.actor));
      if (cmd.scopes.some((scope) => !humanRights.has(scope))) {
        return domain2(ctx, cmd.kind, "scope_not_allowed", "requested scopes exceed the human credential rights");
      }
      return accept2([
        env2(ctx, "AgentTokenMinted", {
          token_id: cmd.token_id,
          principal_id: cmd.principal_id,
          run_id: cmd.run_id,
          task_id: cmd.task_id,
          epoch: cmd.epoch,
          scopes: [...cmd.scopes],
          issued_at: ctx.now,
          expires_at: ctx.now + ttl
        })
      ]);
    }
    case "revoke_agent_token": {
      if (ctx.credential_kind === "agent") {
        if (ctx.presenting_token_id !== cmd.token_id || ctx.actor.agent_principal === null) {
          return authz2(
            "credential_kind_forbidden",
            "agent credential may revoke only its exact presenting token"
          );
        }
      }
      const token = state.tokens[cmd.token_id];
      if (!token) {
        return domain2(ctx, cmd.kind, "token_not_found", "agent token does not exist");
      }
      if (token.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "token_revoked", "agent token is already revoked");
      }
      const principal = state.principals[token.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "token principal does not exist");
      }
      if (ctx.credential_kind === "agent") {
        if (token.principal_id !== ctx.actor.agent_principal) {
          return authz2(
            "credential_kind_forbidden",
            "agent credential may revoke only its exact presenting token"
          );
        }
      } else if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "Member may revoke only a token for their own principal");
      }
      return accept2([
        env2(ctx, "AgentTokenRevoked", { token_id: cmd.token_id, revoked_at: ctx.now })
      ]);
    }
  }
}
export {
  AGENT_TOKEN_DEFAULT_TTL_MS,
  AGENT_TOKEN_MAX_TTL_MS,
  DISPOSITIONS,
  EVENT_TYPES,
  INVITATION_MAX_TTL_MS,
  SCHEMA_VERSION,
  StreamIntegrityError,
  UnknownEventTypeError,
  UpcastError,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_ROLES,
  applyCommand,
  canonicalJson,
  canonicalPrincipal,
  decide,
  decideWorkspace,
  idemKey,
  isAgentScopeDenylisted,
  leaseLive,
  reduceStream,
  reduceTask,
  reduceWorkspace,
  reduceWorkspaceStream,
  registerUpcaster,
  requestHash,
  upcastEnvelope,
  upcastPayload
};
