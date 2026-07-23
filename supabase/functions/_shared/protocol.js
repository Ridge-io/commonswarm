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
function reduceTask(prev, env2) {
  if (!EVENT_TYPES.includes(env2.type)) {
    throw new UnknownEventTypeError(env2.type, env2.seq);
  }
  if (env2.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(`event "${env2.type}" at seq ${env2.seq} is schema v${env2.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`);
  }
  if (env2.type === "CommandRejected") {
    if (!prev) throw new StreamIntegrityError(`CommandRejected before task exists (seq ${env2.seq})`);
    req(env2.payload, ["task_id", "command", "reason", "detail"], env2.type, env2.seq);
    return prev;
  }
  if (env2.type === "TaskCreated") {
    if (prev) throw new StreamIntegrityError(`TaskCreated for an already-existing task (seq ${env2.seq})`);
    const p = req(env2.payload, ["task_id", "slug"], env2.type, env2.seq);
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
  if (!prev) throw new StreamIntegrityError(`event "${env2.type}" before TaskCreated (seq ${env2.seq})`);
  const s = prev;
  function assertEpochIncrease(ep) {
    if (typeof ep !== "number" || ep <= s.epoch) {
      throw new StreamIntegrityError(`${env2.type} at seq ${env2.seq} has non-increasing epoch ${ep} (current ${s.epoch})`);
    }
  }
  const leaseLifecycle = s.submission ? "awaiting_review" : "active";
  switch (env2.type) {
    case "LeaseAcquired": {
      const p = req(env2.payload, ["task_id", "epoch", "owner", "lease_expiry"], env2.type, env2.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseRenewed": {
      const p = req(env2.payload, ["task_id", "epoch", "lease_expiry"], env2.type, env2.seq);
      if (p.epoch !== s.epoch) throw new StreamIntegrityError(`LeaseRenewed at seq ${env2.seq} epoch ${p.epoch} != current ${s.epoch}`);
      return { ...s, lease_expiry: p.lease_expiry };
    }
    case "LeaseHandedOff": {
      const p = req(env2.payload, ["task_id", "epoch", "from_owner", "to_owner", "lease_expiry"], env2.type, env2.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.to_owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseTakenOver": {
      const p = req(env2.payload, ["task_id", "epoch", "owner", "lease_expiry", "grant_id"], env2.type, env2.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "TaskSubmitted": {
      const p = req(env2.payload, ["task_id", "epoch", "branch", "head_sha", "evidence_set"], env2.type, env2.seq);
      return {
        ...s,
        lifecycle: "awaiting_review",
        submission: { epoch: p.epoch, branch: p.branch, head_sha: p.head_sha, evidence_set: [...p.evidence_set] }
      };
    }
    case "TaskClosed": {
      const p = req(env2.payload, ["task_id", "epoch", "disposition", "grant_id"], env2.type, env2.seq);
      return { ...s, lifecycle: "done", closed_disposition: p.disposition };
    }
    case "TaskReopened": {
      const p = req(env2.payload, ["task_id", "version"], env2.type, env2.seq);
      if (p.version <= s.version) throw new StreamIntegrityError(`TaskReopened at seq ${env2.seq} version ${p.version} not > current ${s.version}`);
      return { ...s, lifecycle: "reopened", version: p.version, submission: null, owner: null, lease_expiry: null };
    }
    default: {
      throw new UnknownEventTypeError(env2.type, env2.seq);
    }
  }
}
function reduceStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const env2 of events) {
    if (env2.seq <= lastSeq) {
      throw new StreamIntegrityError(`events out of order or duplicated: seq ${env2.seq} after ${lastSeq}`);
    }
    lastSeq = env2.seq;
    state = reduceTask(state, env2);
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
export {
  DISPOSITIONS,
  EVENT_TYPES,
  SCHEMA_VERSION,
  StreamIntegrityError,
  UnknownEventTypeError,
  UpcastError,
  applyCommand,
  canonicalJson,
  canonicalPrincipal,
  decide,
  idemKey,
  leaseLive,
  reduceStream,
  reduceTask,
  registerUpcaster,
  requestHash,
  upcastEnvelope,
  upcastPayload
};
