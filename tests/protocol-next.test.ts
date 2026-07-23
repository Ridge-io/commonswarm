// Property/behaviour tests for the SWARM-CLOUD protocol core (P0).
// Run: npm test   (node --import tsx --test)
//
// These encode the §10 launch-blocking invariants that live in the pure core:
// exactly-one-epoch lease race, epoch fencing, expiry, submission survival +
// supersession, idempotent retry, 409 on key-reuse-different-hash, reopen
// invalidation, grant-bound takeover, handoff-to-non-member, unknown-event
// halt, and a golden full-history replay (incl. a v0→v1 upcast).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Actor, EventEnvelope, TaskState, canonicalPrincipal,
  reduceStream, reduceTask, UnknownEventTypeError, StreamIntegrityError,
  Command, DecideCtx, decide,
  IdemLedger, applyCommand, requestHash,
  upcastEnvelope, registerUpcaster, UpcastError,
} from '../src/protocol/index.js';

// ---- Test world: models the command function + guarded stream append ---------

interface Oracles {
  members?: string[];
  roles?: Record<string, 'owner' | 'admin' | 'member'>;
  gatedTasks?: string[];               // tasks whose claim requires a close grant
  takeoverGrants?: Array<{ task: string; grant: string; epoch: number; recipient: string }>;
  closeGrants?: Array<{ task: string; grant: string; version: number; epoch: number; head_sha: string }>;
  evidenceOk?: (evidence: readonly string[]) => boolean;
}

function actor(principal: string): Actor {
  return { user: null, agent_principal: principal, run: `run-${principal}` };
}

function makeWorld(o: Oracles = {}) {
  const events: EventEnvelope[] = [];
  const ledger: IdemLedger = new Map();
  let seq = 0;
  let eid = 0;
  let clock = 1_000_000;
  const members = new Set(o.members ?? ['alice', 'bob', 'carol']);
  const roles = o.roles ?? { alice: 'owner' };
  const gated = new Set(o.gatedTasks ?? []);
  const evidenceOk = o.evidenceOk ?? ((ev: readonly string[]) => ev.length > 0);

  function state(): TaskState | null {
    return reduceStream(events);
  }
  function slugs(): Set<string> {
    const s = new Set<string>();
    for (const e of events) if (e.type === 'TaskCreated') s.add((e.payload as any).slug);
    return s;
  }
  function ctxFor(who: string, command_id: string, now: number): DecideCtx {
    return {
      now,
      actor: actor(who),
      command_id,
      isMember: (p) => members.has(p),
      role: (p) => roles[p] ?? (members.has(p) ? 'member' : null),
      isEligibleRecipient: (p) => members.has(p),
      claimRequiresGrant: (t) => gated.has(t),
      evidenceComplete: (_t, ev) => evidenceOk(ev),
      validTakeoverGrant: (t, g, epoch, recipient) =>
        !!g && (o.takeoverGrants ?? []).some((x) =>
          x.task === t && x.grant === g && x.epoch === epoch && x.recipient === recipient),
      validCloseGrant: (t, g, submission) =>
        !!g && (o.closeGrants ?? []).some((x) =>
          x.task === t && x.grant === g &&
          x.version === submission.version && x.epoch === submission.epoch &&
          x.head_sha === submission.head_sha),
      slugTaken: (slug) => slugs().has(slug),
      nextSeq: () => ++seq,
      nextEventId: () => `e${++eid}`,
      workspace_id: 'ws1',
      stream_id: 'repo1',
    };
  }

  function taskHeadPosition(task_id: string): number {
    return events.filter((event) =>
      !!event.payload && typeof event.payload === 'object' &&
      (event.payload as { task_id?: unknown }).task_id === task_id,
    ).length;
  }

  // Decide against the current task-stream head, capturing its position.
  function decideFor(who: string, cmd: Command, at?: { now?: number; command_id?: string }) {
    const s = state();
    const decidedHeadPosition = taskHeadPosition(cmd.task_id);
    const ctx = ctxFor(who, at?.command_id ?? `cmd-${who}-${seq}-${eid}-${clock}`, at?.now ?? clock);
    const decision = decide(s, cmd, ctx);
    return { decision, task_id: cmd.task_id, decidedHeadPosition, ctx };
  }

  // Optimistic commit: append only if no event for this task has appeared since
  // decide-time. Epoch/version alone miss submit, close, renew, and rejection.
  function commit(d: ReturnType<typeof decideFor>): { committed: boolean; conflict?: boolean } {
    if (!d.decision.ok && d.decision.class === 'authz') {
      return { committed: false };
    }
    if (taskHeadPosition(d.task_id) !== d.decidedHeadPosition) {
      return { committed: false, conflict: true };
    }
    if (!d.decision.ok) {
      // Domain rejections are committed visible history once their observed
      // head is confirmed current.
      events.push(...d.decision.events);
      return { committed: true };
    }
    events.push(...d.decision.events);
    return { committed: true };
  }

  // Sequential convenience: decide + commit against current head.
  function apply(who: string, cmd: Command, at?: { now?: number; command_id?: string }) {
    return { ...commit(decideFor(who, cmd, at)), decision: decideFor.length ? undefined : undefined };
  }
  function applyD(who: string, cmd: Command, at?: { now?: number; command_id?: string }) {
    const d = decideFor(who, cmd, at);
    const c = commit(d);
    return { decision: d.decision, ...c };
  }

  return {
    events, ledger, state, ctxFor, decideFor, commit, apply: applyD,
    addMember: (principal: string) => members.add(principal),
    advance: (ms: number) => { clock += ms; return clock; },
    now: () => clock,
    lastType: () => events[events.length - 1]?.type,
  };
}

const TTL = 60_000;

// ---- Reducer invariants -----------------------------------------------------

describe('reducer', () => {
  it('unknown event type HALTS (never skips)', () => {
    const base: EventEnvelope = {
      workspace_id: 'ws1', stream_id: 'r', seq: 1, event_id: 'e1', command_id: 'c1',
      type: 'TaskCreated', schema_version: 1, actor_user: null, actor_agent_principal: 'alice',
      actor_run: 'r1', occurred_at_server: 1, payload: { task_id: 't', slug: 't' },
    };
    const bad = { ...base, seq: 2, event_id: 'e2', type: 'FrobnicateTask' as any };
    assert.throws(() => reduceStream([base, bad]), UnknownEventTypeError);
  });

  it('a non-create event before TaskCreated is a stream-integrity error', () => {
    const acq: EventEnvelope = {
      workspace_id: 'ws1', stream_id: 'r', seq: 1, event_id: 'e1', command_id: 'c1',
      type: 'LeaseAcquired', schema_version: 1, actor_user: null, actor_agent_principal: 'a',
      actor_run: 'r', occurred_at_server: 1, payload: { task_id: 't', epoch: 1, owner: 'a', lease_expiry: 9 },
    };
    assert.throws(() => reduceStream([acq]), StreamIntegrityError);
  });

  it('out-of-order / duplicate seq is rejected', () => {
    const mk = (seq: number): EventEnvelope => ({
      workspace_id: 'ws1', stream_id: 'r', seq, event_id: `e${seq}`, command_id: 'c',
      type: 'TaskCreated', schema_version: 1, actor_user: null, actor_agent_principal: 'a',
      actor_run: 'r', occurred_at_server: 1, payload: { task_id: 't', slug: 't' },
    });
    assert.throws(() => reduceStream([mk(2), mk(2)]), StreamIntegrityError);
  });

  it('a non-monotonic lease epoch halts the fold', () => {
    const envelope = {
      workspace_id: 'ws1', stream_id: 'r', event_id: 'e', command_id: 'c',
      schema_version: 1, actor_user: null, actor_agent_principal: 'alice',
      actor_run: 'r1', occurred_at_server: 1,
    } as const;
    const stream: EventEnvelope[] = [
      {
        ...envelope, seq: 1, type: 'TaskCreated',
        payload: { task_id: 't', slug: 't' },
      },
      {
        ...envelope, seq: 2, type: 'LeaseAcquired',
        payload: { task_id: 't', epoch: 2, owner: 'bob', lease_expiry: 10 },
      },
      {
        ...envelope, seq: 3, type: 'LeaseTakenOver',
        payload: { task_id: 't', epoch: 1, owner: 'carol', lease_expiry: 20, grant_id: null },
      },
    ];
    assert.throws(() => reduceStream(stream), StreamIntegrityError);
  });
});

// ---- Lease authority (§2.2) -------------------------------------------------

describe('lease race → exactly one epoch wins', () => {
  it('two acquires against the same head: one commits, the other conflicts', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const dA = w.decideFor('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const dC = w.decideFor('carol', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const rA = w.commit(dA);
    const rC = w.commit(dC);
    assert.equal(rA.committed, true);
    assert.equal(rC.committed, false);
    assert.equal(rC.conflict, true);
    const s = w.state()!;
    assert.equal(s.epoch, 1);
    assert.equal(s.owner, 'bob');
  });
});

describe('epoch fencing', () => {
  it('renew/submit/handoff with a stale epoch is rejected', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });   // epoch 1
    // carol takes over an expired lease later → epoch 2; bob's epoch-1 token is stale
    w.advance(TTL + 1);
    w.apply('carol', { kind: 'acquire', task_id: 't', ttl_ms: TTL }); // epoch 2 (expired reacquire)
    const r = w.apply('bob', { kind: 'renew', task_id: 't', epoch: 1, ttl_ms: TTL });
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.reason, 'not_owner'); // bob no longer owner
    // an explicit stale-epoch submit by the real owner presenting the wrong epoch
    const r2 = w.apply('carol', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 's', evidence_set: ['x'] });
    assert.equal(r2.decision.ok, false);
    if (!r2.decision.ok) assert.equal(r2.decision.reason, 'stale_epoch');
  });

  it('expired-lease mutation (renew) is rejected', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.advance(TTL + 1);
    const r = w.apply('bob', { kind: 'renew', task_id: 't', epoch: 1, ttl_ms: TTL });
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.reason, 'lease_expired');
  });
});

describe('takeover', () => {
  it('live lease requires a takeover grant bound to the CURRENT epoch', () => {
    const w = makeWorld({ takeoverGrants: [{ task: 't', grant: 'g-epoch1', epoch: 1, recipient: 'carol' }] });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL }); // epoch 1, live
    // no grant → refused
    const noGrant = w.apply('carol', { kind: 'takeover', task_id: 't', grant_id: null, ttl_ms: TTL });
    assert.equal(noGrant.decision.ok, false);
    if (!noGrant.decision.ok) assert.equal(noGrant.decision.reason, 'live_lease_needs_grant');
    // correct grant → epoch 2
    const ok = w.apply('carol', { kind: 'takeover', task_id: 't', grant_id: 'g-epoch1', ttl_ms: TTL });
    assert.equal(ok.decision.ok, true);
    assert.equal(w.state()!.epoch, 2);
    assert.equal(w.state()!.owner, 'carol');
  });

  it('a takeover grant does NOT work after the epoch changed (grant dies on epoch change)', () => {
    const w = makeWorld({ takeoverGrants: [{ task: 't', grant: 'g1', epoch: 1, recipient: 'carol' }] });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });   // epoch 1
    w.apply('carol', { kind: 'takeover', task_id: 't', grant_id: 'g1', ttl_ms: TTL }); // epoch 2 (grant for epoch 1 consumed)
    // bob tries to reuse the same epoch-1 grant against the now-epoch-2 live lease
    const stale = w.apply('bob', { kind: 'takeover', task_id: 't', grant_id: 'g1', ttl_ms: TTL });
    assert.equal(stale.decision.ok, false);
    if (!stale.decision.ok) assert.equal(stale.decision.reason, 'live_lease_needs_grant');
  });

  it('takeover of an EXPIRED lease needs no grant', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.advance(TTL + 1);
    const ok = w.apply('carol', { kind: 'takeover', task_id: 't', grant_id: null, ttl_ms: TTL });
    assert.equal(ok.decision.ok, true);
    assert.equal(w.state()!.epoch, 2);
  });

  it('a takeover grant cannot be spent by a different recipient', () => {
    const w = makeWorld({
      members: ['alice', 'bob', 'carol', 'mallory'],
      takeoverGrants: [{ task: 't', grant: 'for-carol', epoch: 1, recipient: 'carol' }],
    });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const stolen = w.apply('mallory', {
      kind: 'takeover', task_id: 't', grant_id: 'for-carol', ttl_ms: TTL,
    });
    assert.equal(stolen.decision.ok, false);
    if (!stolen.decision.ok) assert.equal(stolen.decision.reason, 'live_lease_needs_grant');
    assert.equal(w.state()!.owner, 'bob');
    assert.equal(w.state()!.epoch, 1);
  });

  it('a live lease cannot be taken over while its submission awaits review', () => {
    const w = makeWorld({
      takeoverGrants: [{ task: 't', grant: 'for-carol', epoch: 1, recipient: 'carol' }],
    });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'sha1', evidence_set: ['ev'],
    });
    const takeover = w.apply('carol', {
      kind: 'takeover', task_id: 't', grant_id: 'for-carol', ttl_ms: TTL,
    });
    assert.equal(takeover.decision.ok, false);
    if (!takeover.decision.ok) assert.equal(takeover.decision.reason, 'bad_state');
    assert.equal(w.state()!.lifecycle, 'awaiting_review');
    assert.equal(w.state()!.owner, 'bob');
  });
});

describe('handoff', () => {
  it('to a non-member is rejected', () => {
    const w = makeWorld({ members: ['alice', 'bob'] });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const r = w.apply('bob', { kind: 'handoff', task_id: 't', epoch: 1, to_owner: 'mallory', ttl_ms: TTL });
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.reason, 'recipient_not_member');
  });

  it('to a member bumps epoch and transfers ownership', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const r = w.apply('bob', { kind: 'handoff', task_id: 't', epoch: 1, to_owner: 'carol', ttl_ms: TTL });
    assert.equal(r.decision.ok, true);
    assert.equal(w.state()!.epoch, 2);
    assert.equal(w.state()!.owner, 'carol');
  });

  it('is rejected while a submission awaits review', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'sha1', evidence_set: ['ev'],
    });
    const handoff = w.apply('bob', {
      kind: 'handoff', task_id: 't', epoch: 1, to_owner: 'carol', ttl_ms: TTL,
    });
    assert.equal(handoff.decision.ok, false);
    if (!handoff.decision.ok) assert.equal(handoff.decision.reason, 'bad_state');
    assert.equal(w.state()!.lifecycle, 'awaiting_review');
    assert.equal(w.state()!.owner, 'bob');
  });
});

// ---- Submission / close (§2.2 + §2.4 gate) ----------------------------------

describe('submission survives lease expiry and supersession works', () => {
  it('submission stays valid after the lease expires; close works against the frozen epoch', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });          // epoch 1
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'sha1', evidence_set: ['ev'] });
    assert.equal(w.state()!.lifecycle, 'awaiting_review');
    w.advance(TTL + 1); // lease expires — submission must remain closeable
    assert.equal(w.state()!.submission!.head_sha, 'sha1');
    // non-gated close by the task owner, bound to the frozen epoch 1
    const c = w.apply('bob', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null });
    assert.equal(c.decision.ok, true);
    assert.equal(w.state()!.lifecycle, 'done');
  });

  it('expired awaiting-review reacquisition preserves the frozen submission and remains closeable', () => {
    for (const reacquireWith of ['acquire', 'takeover'] as const) {
      const w = makeWorld();
      w.apply('alice', { kind: 'create', task_id: 't', slug: `t-${reacquireWith}` });
      w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
      w.apply('bob', {
        kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
        head_sha: 'sha1', evidence_set: ['ev'],
      });
      w.advance(TTL + 1);
      const reacquired = reacquireWith === 'acquire'
        ? w.apply('carol', { kind: 'acquire', task_id: 't', ttl_ms: TTL })
        : w.apply('carol', { kind: 'takeover', task_id: 't', grant_id: null, ttl_ms: TTL });
      assert.equal(reacquired.decision.ok, true);
      assert.equal(w.state()!.epoch, 2);
      assert.equal(w.state()!.lifecycle, 'awaiting_review');
      assert.equal(w.state()!.submission!.head_sha, 'sha1');

      const closed = w.apply('carol', {
        kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null,
      });
      assert.equal(closed.decision.ok, true);
      assert.equal(w.state()!.lifecycle, 'done');
    }
  });

  it('a new submit supersedes the prior frozen submission', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'sha1', evidence_set: ['ev'] });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'sha2', evidence_set: ['ev2'] });
    assert.equal(w.state()!.submission!.head_sha, 'sha2');
    // closing against a superseded head is impossible: the frozen submission is sha2 now
    const c = w.apply('bob', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null });
    assert.equal(c.decision.ok, true); // epoch matches; the frozen submission is sha2
  });

  it('submit without evidence is rejected', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const r = w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 's', evidence_set: [] });
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.reason, 'evidence_incomplete');
  });
});

describe('close gating (§2.4)', () => {
  it('a gated claim cannot be closed by the owner without a valid close grant', () => {
    const w = makeWorld({ gatedTasks: ['t'], roles: { alice: 'owner' } });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'shaX', evidence_set: ['ev'] });
    const noGrant = w.apply('bob', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null });
    assert.equal(noGrant.decision.ok, false);
    if (!noGrant.decision.ok) assert.equal(noGrant.decision.reason, 'close_needs_grant');
  });

  it('a gated claim CAN be closed with a grant bound to the frozen version, epoch, and SHA', () => {
    const w = makeWorld({
      gatedTasks: ['t'],
      closeGrants: [{ task: 't', grant: 'cg', version: 1, epoch: 1, head_sha: 'shaX' }],
    });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'shaX', evidence_set: ['ev'] });
    const ok = w.apply('bob', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: 'cg' });
    assert.equal(ok.decision.ok, true);
    assert.equal(w.state()!.lifecycle, 'done');
  });

  it('a human Owner/Admin may close a gated claim directly', () => {
    const w = makeWorld({ gatedTasks: ['t'], roles: { alice: 'owner' } });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 'shaX', evidence_set: ['ev'] });
    const ok = w.apply('alice', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null });
    assert.equal(ok.decision.ok, true);
  });

  it('a close grant does not survive reopen plus a same-SHA resubmission', () => {
    const w = makeWorld({
      gatedTasks: ['t'],
      closeGrants: [{ task: 't', grant: 'old-grant', version: 1, epoch: 1, head_sha: 'same-sha' }],
    });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'same-sha', evidence_set: ['ev1'],
    });
    w.apply('alice', { kind: 'reopen', task_id: 't', epoch: 1 });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 2, branch: 'b',
      head_sha: 'same-sha', evidence_set: ['ev2'],
    });
    const close = w.apply('bob', {
      kind: 'close', task_id: 't', epoch: 2, disposition: 'merged', grant_id: 'old-grant',
    });
    assert.equal(close.decision.ok, false);
    if (!close.decision.ok) assert.equal(close.decision.reason, 'close_needs_grant');
    assert.equal(w.state()!.lifecycle, 'awaiting_review');
  });
});

describe('task-head optimistic commit guard', () => {
  it('allows exactly one of two same-grant close decisions to commit', () => {
    const w = makeWorld({
      gatedTasks: ['t'],
      closeGrants: [{ task: 't', grant: 'cg', version: 1, epoch: 1, head_sha: 'sha1' }],
    });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'sha1', evidence_set: ['ev'],
    });
    const first = w.decideFor('bob', {
      kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: 'cg',
    });
    const second = w.decideFor('bob', {
      kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: 'cg',
    });
    assert.equal(first.decision.ok, true);
    assert.equal(second.decision.ok, true);
    assert.deepEqual(w.commit(first), { committed: true });
    assert.deepEqual(w.commit(second), { committed: false, conflict: true });
    assert.equal(w.events.filter((event) => event.type === 'TaskClosed').length, 1);
  });

  it('rejects a submit decision made stale by a concurrently committed close', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'sha1', evidence_set: ['ev1'],
    });
    const close = w.decideFor('alice', {
      kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null,
    });
    const staleSubmit = w.decideFor('bob', {
      kind: 'submit', task_id: 't', epoch: 1, branch: 'b',
      head_sha: 'sha2', evidence_set: ['ev2'],
    });
    assert.equal(close.decision.ok, true);
    assert.equal(staleSubmit.decision.ok, true);
    assert.deepEqual(w.commit(close), { committed: true });
    assert.deepEqual(w.commit(staleSubmit), { committed: false, conflict: true });
    assert.equal(w.state()!.lifecycle, 'done');
    assert.equal(w.state()!.submission!.head_sha, 'sha1');
  });
});

describe('reopen invalidates the open submission', () => {
  it('reopen clears the submission, bumps version, and re-opens for acquire', () => {
    const w = makeWorld({ roles: { alice: 'owner' } });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 't', epoch: 1, branch: 'b', head_sha: 's', evidence_set: ['ev'] });
    const r = w.apply('alice', { kind: 'reopen', task_id: 't', epoch: 1 });
    assert.equal(r.decision.ok, true);
    const s = w.state()!;
    assert.equal(s.lifecycle, 'reopened');
    assert.equal(s.submission, null);
    assert.equal(s.version, 2);
    // a stale close against the old submission is now impossible
    const c = w.apply('bob', { kind: 'close', task_id: 't', epoch: 1, disposition: 'merged', grant_id: null });
    assert.equal(c.decision.ok, false);
    if (!c.decision.ok) assert.equal(c.decision.reason, 'not_submitted');
  });

  it('a non-admin task owner cannot reopen with a stale epoch', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    w.apply('bob', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    const reopen = w.apply('bob', { kind: 'reopen', task_id: 't', epoch: 0 });
    assert.equal(reopen.decision.ok, false);
    if (!reopen.decision.ok) assert.equal(reopen.decision.reason, 'stale_epoch');
    assert.equal(w.state()!.version, 1);
    assert.equal(w.state()!.lifecycle, 'active');
  });
});

// ---- Idempotency (§2.1) -----------------------------------------------------

describe('idempotency', () => {
  it('retry with the same (principal,command_id,hash) returns the original result and appends no new event', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const before = w.events.length;
    const cmd: Command = { kind: 'acquire', task_id: 't', ttl_ms: TTL };
    const ctx1 = w.ctxFor('bob', 'CMD-1', w.now());
    const out1 = applyCommand(w.ledger, w.state(), cmd, ctx1);
    assert.equal(out1.status, 'fresh');
    if (out1.status === 'fresh') w.events.push(...out1.events);
    const afterFirst = w.events.length;
    // retry: same command_id, same request
    const ctx2 = w.ctxFor('bob', 'CMD-1', w.now() + 5);
    const out2 = applyCommand(w.ledger, w.state(), cmd, ctx2);
    assert.equal(out2.status, 'replayed');
    assert.equal(w.events.length, afterFirst); // no new event appended on replay
    assert.ok(afterFirst > before);
  });

  it('reusing a command_id with a DIFFERENT request → 409 conflict', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const ctxA = w.ctxFor('bob', 'CMD-9', w.now());
    const a = applyCommand(w.ledger, w.state(), { kind: 'acquire', task_id: 't', ttl_ms: TTL }, ctxA);
    if (a.status === 'fresh') w.events.push(...a.events);
    const ctxB = w.ctxFor('bob', 'CMD-9', w.now());
    const b = applyCommand(w.ledger, w.state(), { kind: 'acquire', task_id: 't', ttl_ms: 999 }, ctxB);
    assert.equal(b.status, 'conflict');
  });

  it('the stored response covers a rejection too (a retried rejection replays, not re-executes)', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    // bob renews without owning → domain rejection
    const ctx = w.ctxFor('bob', 'CMD-R', w.now());
    const first = applyCommand(w.ledger, w.state(), { kind: 'renew', task_id: 't', epoch: 1, ttl_ms: TTL }, ctx);
    assert.equal(first.status, 'fresh');
    if (first.status === 'fresh') { assert.equal(first.response.ok, false); w.events.push(...first.events); }
    const retry = applyCommand(w.ledger, w.state(), { kind: 'renew', task_id: 't', epoch: 1, ttl_ms: TTL }, w.ctxFor('bob', 'CMD-R', w.now()));
    assert.equal(retry.status, 'replayed');
    assert.equal(retry.response.ok, false);
  });

  it('does not ledger an authz rejection, so a later-member retry is evaluated again', () => {
    const w = makeWorld({ members: ['alice', 'bob'] });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const cmd: Command = { kind: 'acquire', task_id: 't', ttl_ms: TTL };
    const first = applyCommand(
      w.ledger, w.state(), cmd, w.ctxFor('mallory', 'CMD-AUTHZ', w.now()),
    );
    assert.equal(first.status, 'fresh');
    if (first.status === 'fresh') {
      assert.equal(first.decision.ok, false);
      if (!first.decision.ok) assert.equal(first.decision.class, 'authz');
    }
    assert.equal(w.ledger.size, 0);

    w.addMember('mallory');
    const retry = applyCommand(
      w.ledger, w.state(), cmd, w.ctxFor('mallory', 'CMD-AUTHZ', w.now()),
    );
    assert.equal(retry.status, 'fresh');
    if (retry.status === 'fresh') {
      assert.equal(retry.decision.ok, true);
      w.events.push(...retry.events);
    }
    assert.equal(w.state()!.owner, 'mallory');
  });

  it('namespaces user and agent principals that share the same textual id', () => {
    const w = makeWorld({ members: ['same-name'] });
    const cmd: Command = { kind: 'create', task_id: 't', slug: 't' };
    const agentCtx = w.ctxFor('same-name', 'SAME-COMMAND-ID', w.now());
    const userCtx: DecideCtx = {
      ...w.ctxFor('same-name', 'SAME-COMMAND-ID', w.now()),
      actor: { user: 'same-name', agent_principal: null, run: null },
    };
    const agentResult = applyCommand(w.ledger, null, cmd, agentCtx);
    const userResult = applyCommand(w.ledger, null, cmd, userCtx);
    assert.equal(agentResult.status, 'fresh');
    assert.equal(userResult.status, 'fresh');
    assert.equal(w.ledger.size, 2);
  });
});

// ---- Authz vs domain rejection ----------------------------------------------

describe('rejection classes (§2.1)', () => {
  it('a non-member is refused with NO stream event (authz, audit-only)', () => {
    const w = makeWorld({ members: ['alice', 'bob'] });
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const before = w.events.length;
    const r = w.apply('mallory', { kind: 'acquire', task_id: 't', ttl_ms: TTL });
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.class, 'authz');
    assert.equal(w.events.length, before); // no event appended
  });

  it('a member hitting a bad precondition gets a committed CommandRejected event (domain)', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 't', slug: 't' });
    const before = w.events.length;
    const r = w.apply('bob', { kind: 'renew', task_id: 't', epoch: 1, ttl_ms: TTL }); // bob not owner
    assert.equal(r.decision.ok, false);
    if (!r.decision.ok) assert.equal(r.decision.class, 'domain');
    assert.equal(w.events.length, before + 1);
    assert.equal(w.lastType(), 'CommandRejected');
  });
});

// ---- Upcasters + golden replay ----------------------------------------------

describe('upcasters + golden full-history replay', () => {
  it('a v0 TaskCreated upcasts to v1 and folds identically', () => {
    const rawV0: EventEnvelope = {
      workspace_id: 'ws1', stream_id: 'r', seq: 1, event_id: 'e1', command_id: 'c1',
      type: 'TaskCreated', schema_version: 0, actor_user: null, actor_agent_principal: 'alice',
      actor_run: 'r1', occurred_at_server: 1, payload: { id: 'task-legacy', name: 'legacy-slug' },
    };
    const up = upcastEnvelope(rawV0);
    assert.equal(up.schema_version, 1);
    assert.deepEqual(up.payload, { task_id: 'task-legacy', slug: 'legacy-slug' });
    const s = reduceTask(null, up);
    assert.equal(s.task_id, 'task-legacy');
    assert.equal(s.slug, 'legacy-slug');
    assert.equal(s.lifecycle, 'open');
  });

  it('upcasts a non-first old-version event within a full stream fold', () => {
    registerUpcaster('LeaseAcquired', 0, (payload: {
      task_id: string; epoch: number; holder: string; expires_at: number;
    }) => ({
      task_id: payload.task_id,
      epoch: payload.epoch,
      owner: payload.holder,
      lease_expiry: payload.expires_at,
    }));
    const raw: EventEnvelope[] = [
      {
        workspace_id: 'ws1', stream_id: 'r', seq: 1, event_id: 'e1', command_id: 'c1',
        type: 'TaskCreated', schema_version: 1, actor_user: null,
        actor_agent_principal: 'alice', actor_run: 'r1', occurred_at_server: 1,
        payload: { task_id: 'task-legacy-midstream', slug: 'legacy-midstream' },
      },
      {
        workspace_id: 'ws1', stream_id: 'r', seq: 2, event_id: 'e2', command_id: 'c2',
        type: 'LeaseAcquired', schema_version: 0, actor_user: null,
        actor_agent_principal: 'bob', actor_run: 'r2', occurred_at_server: 2,
        payload: {
          task_id: 'task-legacy-midstream', epoch: 1,
          holder: 'bob', expires_at: 123_456,
        },
      },
    ];
    const folded = reduceStream(raw.map(upcastEnvelope));
    assert.equal(folded!.lifecycle, 'active');
    assert.equal(folded!.epoch, 1);
    assert.equal(folded!.owner, 'bob');
    assert.equal(folded!.lease_expiry, 123_456);
  });

  it('an event NEWER than supported halts on upcast', () => {
    const future: EventEnvelope = {
      workspace_id: 'ws1', stream_id: 'r', seq: 1, event_id: 'e1', command_id: 'c1',
      type: 'TaskCreated', schema_version: 99, actor_user: null, actor_agent_principal: 'a',
      actor_run: 'r', occurred_at_server: 1, payload: {},
    };
    assert.throws(() => upcastEnvelope(future), UpcastError);
  });

  it('golden replay: create→acquire→submit→close folds to a done task at epoch 1', () => {
    const w = makeWorld();
    w.apply('alice', { kind: 'create', task_id: 'g', slug: 'g' });
    w.apply('bob', { kind: 'acquire', task_id: 'g', ttl_ms: TTL });
    w.apply('bob', { kind: 'submit', task_id: 'g', epoch: 1, branch: 'main', head_sha: 'deadbeef', evidence_set: ['ci:green'] });
    w.apply('bob', { kind: 'close', task_id: 'g', epoch: 1, disposition: 'merged', grant_id: null });
    // Re-fold the entire persisted stream from scratch → deterministic terminal state.
    const replayed = reduceStream(w.events);
    assert.deepEqual(replayed, {
      task_id: 'g', slug: 'g', lifecycle: 'done', version: 1, epoch: 1,
      owner: 'bob', lease_expiry: w.events.find((e) => e.type === 'LeaseAcquired')!.occurred_at_server + TTL,
      submission: { epoch: 1, branch: 'main', head_sha: 'deadbeef', evidence_set: ['ci:green'] },
      closed_disposition: 'merged',
    });
  });
});
