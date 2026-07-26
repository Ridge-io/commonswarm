// Agent-token binding: what `mint_agent_token` actually validates.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────
// 2026-07-26. `mint_agent_token` issues a credential bound to principal_id + run_id + task_id +
// epoch. Three of those four are accepted AS LITERALS: nothing is compared against workspace or
// task state. The only epoch validation is `Number.isInteger(epoch) && epoch >= 0`
// (workspace-commands.ts, the `binding_required` branch) — A TEST OF THE SHAPE OF THE NUMBER,
// NEVER OF ITS MEANING.
//
// AND THE BINDING IS WRITE-ONLY (Atlas, 2026-07-26). It is not merely unvalidated at issue —
// it is never read back. `loadAgentCredential` in supabase/functions/_shared/agent-auth.ts
// SELECTs thirteen columns, including scopes, surrender_only, three revoked_at columns and
// expires_at. `t.task_id` and `t.epoch` ARE NOT AMONG THEM, and neither string appears anywhere
// in that file. So a leaked token is not confined to a task or an epoch at all: it is valid for
// whatever its SCOPES allow, on ANY task, until it expires or a human revokes it.
//
// Do not read `stale_epoch` as protection here. That check compares the epoch in the COMMAND
// PAYLOAD, never the one in the token — so a lease changing hands does not invalidate a token.
//
// ── THE CONTROLS ARE NOT OPTIONAL ────────────────────────────────────────────────────────────
// ARM 3 and ARM 4 exist so that "the mint succeeded" cannot be confused with "the check never
// ran". Without them, an accepted mint is indistinguishable from a probe pointed at nothing —
// and a probe that cannot fail is the defect class this repo has paid for repeatedly. Do not
// delete them to save two assertions; they are what make ARMs 1-2 evidence rather than output.
//
// ── THE WRITE PATH STILL REQUIRES THESE FIELDS (measured) ────────────────────────────────────
// "Nothing reads these fields" is true of the AUTH path and false of the MINT path (Sable).
// Sites that require them, each re-derived at eed9299:
//   supabase/functions/command/index.ts:164        wire type declares run_id/task_id/epoch
//                                                  required — none is optional
//   supabase/functions/command/index.ts:877-892    the edge wire gate: exactKeys, plus UUID_RE
//                                                  on principal_id/run_id/task_id/device_id and
//                                                  integer(epoch). THIS RUNS BEFORE THE PROTOCOL,
//                                                  so a malformed id never reaches the arms below
//   supabase/functions/command/index.ts:1606-1608  prepareWorkspaceCommand copies wire.run_id,
//                                                  wire.task_id, wire.epoch into the command
//   supabase/functions/command/index.ts:1520,2459  mintBindingsValid keys the agent_runs lookup
//                                                  by the CALLER-SUPPLIED run_id
//   supabase/functions/command/index.ts:1915       throws 'folded token projection missing
//                                                  narrow binding' when task_id or epoch is null
//   src/protocol/workspace-reducer.ts:314          lists task_id and epoch among required
//                                                  AgentTokenMinted payload fields
// Sable additionally reports runtime wire validation (exactKeys + UUID/integer) on these fields;
// I did not isolate it and am not citing it as mine.
//
// The schema will not catch a partial change — agent_tokens.task_id and .epoch are nullable. So
// the surface and the server disagree about whether these are optional, and the disagreement is
// invisible until runtime.
//
// THIS LIST IS WHAT I MEASURED, NOT AN INVENTORY. It went from two entries to five when a second
// seat looked, which is the honest reason to distrust its completeness rather than its accuracy.
// Re-derive before relying on it:
//   git grep -n 'task_id\|epoch\|run_id' -- supabase/functions/command src/protocol
// An incomplete measurement misleads exactly like a stale instruction, and it does it without
// ever becoming false — which is why "measurements do not rot" is too comfortable a claim.
//
// ── THIS HEADER DOES NOT TELL YOU WHAT TO DO, AND THAT IS DELIBERATE ─────────────────────────
// It used to. Three times, in one morning, it carried an instruction that was correct when
// written and wrong within the hour: "invert these arms when the binding is enforced" (the
// ruling became delete), "delete this file when the fields come off" (the write path still
// required them), and an ordering note written against a delete that became something else
// again. A COMMENT THAT TELLS THE FUTURE WHAT TO DO IS A PREDICTION, and this one has a losing
// record against a decision set that moved faster than the file.
//
// So: above this line are MEASUREMENTS, each with a file and line you can re-run. They were true
// at 273c472 and they rot only if the code changes, which you will notice because these tests
// fail. Below it there is nothing to obey. FIND THE CURRENT RULING; DO NOT TRUST THIS COMMENT
// FOR INTENT.
//
// What the arms mean, which is not a prediction:
//   - the two CONTROL arms assert that `binding_required` rejects a malformed epoch. If a change
//     removes that rejection they fail, and that is information, not breakage.
//   - the two CURRENT-BEHAVIOUR arms assert today's acceptance of a meaningless binding. They
//     are CHARACTERISATION, not specification. Nothing here argues the behaviour is desirable.
// If an arm fails, the behaviour it names changed. Whether that change is right is a question
// for whoever made it, and this file has no standing to answer it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Actor,
  DecideWorkspaceCtx,
  WorkspaceCommand,
  decideWorkspace,
  reduceWorkspace,
} from '../src/protocol/index.js';

const NOW = 10_000_000;

function human(user: string): Actor {
  return { user, agent_principal: null, run: null };
}

/** A workspace with one human owner and one agent principal, built by replaying real commands. */
function world() {
  let state: unknown;
  let seq = 0;
  let eventId = 0;

  const ctx = (): DecideWorkspaceCtx =>
    ({
      now: NOW,
      actor: human('alice'),
      credential_kind: 'human',
      presenting_token_id: null,
      command_id: `cmd-${seq}-${eventId}`,
      workspace_id: 'ws-1',
      stream_id: 'ws-stream-1',
      operatorAllowed: () => true,
      role: (user_id: string) => {
        const member = (state as any)?.members?.[user_id];
        return member?.revoked_at === null ? member.role : null;
      },
      inviteeAlreadyMember: () => false,
      identityVerified: () => true,
      humanRights: () => ['task:create', 'task:acquire', 'message:send'],
      landingAuthorityChangeResolved: () => true,
      nextSeq: () => ++seq,
      nextEventId: () => `we-${++eventId}`,
    }) as unknown as DecideWorkspaceCtx;

  function apply(cmd: WorkspaceCommand) {
    const decision = decideWorkspace(state as never, cmd, ctx());
    if (decision.ok) {
      for (const event of decision.events) state = reduceWorkspace(state as never, event);
    }
    return decision;
  }

  apply({ kind: 'create_workspace', workspace_id: 'ws-1', name: 'w', owner_email: 'alice@x.com' } as never);
  apply({ kind: 'create_agent_principal', principal_id: 'p1', name: 'agent-1' } as never);

  /** Mint with an arbitrary binding. Returns the decision so the caller can inspect it. */
  function mint(token_id: string, task_id: string, epoch: number) {
    return apply({
      kind: 'mint_agent_token',
      token_id,
      principal_id: 'p1',
      run_id: 'run-1',
      task_id,
      epoch,
      scopes: ['task:acquire'],
    } as never);
  }

  return { mint };
}

describe('mint_agent_token binding validation', () => {
  it('CONTROL: rejects a negative epoch — proves the check exists and can fire', () => {
    const decision = world().mint('tok-negative', 'task-1', -1);
    assert.equal(decision.ok, false, 'a negative epoch must be rejected');
    assert.equal((decision as { reason: string }).reason, 'binding_required');
  });

  it('CONTROL: rejects a non-integer epoch — the same check, second arm', () => {
    const decision = world().mint('tok-fractional', 'task-1', 1.5);
    assert.equal(decision.ok, false, 'a fractional epoch must be rejected');
    assert.equal((decision as { reason: string }).reason, 'binding_required');
  });

  // The task_id is a well-formed UUID that names no task, deliberately. An earlier version used
  // the string 'TASK-THAT-DOES-NOT-EXIST', which the protocol also accepts — but the edge wire
  // (supabase/functions/command/index.ts ~880-890) applies UUID_RE to task_id, so that input is
  // rejected before it ever reaches here (Vane). The arm proved a protocol-layer permissiveness
  // that the deployed system does not expose. A valid UUID naming nothing passes the wire AND
  // this layer, which is the claim actually worth making.
  it('CURRENT BEHAVIOUR (wrong): mints against a well-formed task_id that names no task', () => {
    const decision = world().mint('tok-phantom', '00000000-0000-4000-8000-000000000000', 7);
    assert.equal(decision.ok, true, 'today the binding is not compared against any task state');
  });

  it('CURRENT BEHAVIOUR (wrong): mints epoch 0 and epoch 999999 for the same task', () => {
    assert.equal(world().mint('tok-zero', 'task-1', 0).ok, true, 'epoch 0 accepted today');
    assert.equal(world().mint('tok-huge', 'task-1', 999_999).ok, true, 'epoch 999999 accepted today');
  });
});
