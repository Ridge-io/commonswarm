import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Actor,
  AGENT_TOKEN_DEFAULT_TTL_MS,
  AGENT_TOKEN_MAX_TTL_MS,
  DecideWorkspaceCtx,
  INVITATION_MAX_TTL_MS,
  StreamIntegrityError,
  WorkspaceCommand,
  WorkspaceDecision,
  WorkspaceEventEnvelope,
  WorkspaceRole,
  WorkspaceState,
  decideWorkspace,
  isAgentScopeDenylisted,
  reduceWorkspace,
  reduceWorkspaceStream,
} from '../src/protocol/index.js';

const NOW = 10_000_000;

function human(user: string): Actor {
  return { user, agent_principal: null, run: null };
}

function agent(user: string, principal: string): Actor {
  return { user, agent_principal: principal, run: `run-${principal}` };
}

interface ApplyOptions {
  now?: number;
  actor?: Actor;
  credential_kind?: 'human' | 'agent';
  presenting_token_id?: string | null;
  operatorAllowed?: boolean;
  verified?: boolean;
  humanRights?: readonly string[];
  landingResolved?: boolean;
}

function makeWorld() {
  const events: WorkspaceEventEnvelope[] = [];
  let seq = 0;
  let eventId = 0;

  function state(): WorkspaceState | null {
    return reduceWorkspaceStream(events);
  }

  function ctx(options: ApplyOptions = {}): DecideWorkspaceCtx {
    const actor = options.actor ?? human('alice');
    return {
      now: options.now ?? NOW,
      actor,
      credential_kind: options.credential_kind ?? 'human',
      presenting_token_id: options.presenting_token_id ?? null,
      command_id: `cmd-${seq}-${eventId}`,
      workspace_id: 'ws-1',
      stream_id: 'ws-stream-1',
      operatorAllowed: () => options.operatorAllowed ?? true,
      role: (user_id) => {
        const member = state()?.members[user_id];
        return member?.revoked_at === null ? member.role : null;
      },
      inviteeAlreadyMember: (email) => {
        if (!email) return false;
        const user_id = email.split('@')[0];
        const member = state()?.members[user_id];
        return member?.revoked_at === null;
      },
      identityVerified: () => options.verified ?? true,
      humanRights: () => options.humanRights ?? [
        'task:create',
        'task:acquire',
        'message:send',
        // Included deliberately: the intrinsic denylist must still win.
        'issue_grant',
      ],
      landingAuthorityChangeResolved: () => options.landingResolved ?? true,
      nextSeq: () => ++seq,
      nextEventId: () => `we-${++eventId}`,
    };
  }

  function apply(
    cmd: WorkspaceCommand,
    options: ApplyOptions = {},
  ): WorkspaceDecision {
    const before = state();
    const decision = decideWorkspace(before, cmd, ctx(options));
    if (decision.ok || decision.class === 'domain') {
      events.push(...decision.events);
      // Contract backstop: every emitted decision must be foldable immediately.
      state();
    }
    return decision;
  }

  function create(): void {
    const decision = apply({
      kind: 'create_workspace',
      workspace_id: 'ws-1',
      name: 'Test Workspace',
    });
    assert.equal(decision.ok, true);
  }

  function invite(
    user_id: string,
    role: WorkspaceRole = 'member',
    invitation_id = `invite-${user_id}`,
    token_hash = `hash-${user_id}`,
  ): void {
    const decision = apply({
      kind: 'invite_member',
      invitation_id,
      email: `${user_id}@example.com`,
      role,
      token_hash,
      expires_at: NOW + 60_000,
    });
    assert.equal(decision.ok, true);
  }

  function join(user_id: string, role: WorkspaceRole = 'member'): void {
    invite(user_id, role);
    const decision = apply(
      { kind: 'accept_invitation', token_hash: `hash-${user_id}` },
      { actor: human(user_id) },
    );
    assert.equal(decision.ok, true);
  }

  function createPrincipal(user_id: string, principal_id = `principal-${user_id}`): void {
    const decision = apply(
      { kind: 'create_agent_principal', principal_id, name: `agent-${user_id}` },
      { actor: human(user_id) },
    );
    assert.equal(decision.ok, true);
  }

  function mint(
    user_id: string,
    token_id: string,
    principal_id = `principal-${user_id}`,
  ): WorkspaceDecision {
    return apply(
      {
        kind: 'mint_agent_token',
        token_id,
        principal_id,
        run_id: `run-${user_id}`,
        task_id: 'task-1',
        epoch: 1,
        scopes: ['task:acquire'],
      },
      { actor: human(user_id) },
    );
  }

  return { events, state, apply, create, invite, join, createPrincipal, mint };
}

function rejected(
  decision: WorkspaceDecision,
  reason: string,
  rejectionClass: 'authz' | 'domain' = 'domain',
): void {
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.class, rejectionClass);
    assert.equal(decision.reason, reason);
    assert.equal(decision.events.length, rejectionClass === 'domain' ? 1 : 0);
  }
}

describe('workspace creation and reducer', () => {
  it('creates the workspace with its creator as the sole Owner', () => {
    const world = makeWorld();
    world.create();
    const state = world.state()!;
    assert.equal(state.workspace.workspace_id, 'ws-1');
    assert.equal(state.members.alice.role, 'owner');
    assert.equal(state.owners_count, 1);
  });

  it('rejects non-allowlisted creation and agent credential creation without events', () => {
    const world = makeWorld();
    rejected(
      world.apply(
        { kind: 'create_workspace', workspace_id: 'ws-1', name: 'No' },
        { operatorAllowed: false },
      ),
      'operator_not_allowed',
      'authz',
    );
    rejected(
      world.apply(
        { kind: 'create_workspace', workspace_id: 'ws-1', name: 'No' },
        { actor: agent('alice', 'p'), credential_kind: 'agent' },
      ),
      'credential_kind_forbidden',
      'authz',
    );
    assert.equal(world.events.length, 0);
  });

  it('does not let a non-member probe an existing workspace with create_workspace', () => {
    const world = makeWorld();
    world.create();
    const before = world.events.length;
    rejected(
      world.apply(
        { kind: 'create_workspace', workspace_id: 'ws-1', name: 'Probe' },
        { actor: human('mallory') },
      ),
      'bad_state',
      'authz',
    );
    assert.equal(world.events.length, before);
  });

  it('classifies commands against absent workspace state as authz and emits nothing', () => {
    const world = makeWorld();
    rejected(
      world.apply({ kind: 'revoke_invitation', invitation_id: 'missing' }),
      'workspace_not_found',
      'authz',
    );
    assert.equal(world.events.length, 0);
  });

  it('halts on malformed owner-orphaning history', () => {
    const world = makeWorld();
    world.create();
    const bad: WorkspaceEventEnvelope = {
      ...world.events[0],
      seq: 2,
      event_id: 'bad',
      type: 'MemberRemoved',
      payload: { user_id: 'alice', revoked_at: NOW },
    };
    assert.throws(() => reduceWorkspace(world.state(), bad), StreamIntegrityError);
  });

  it('halts on duplicate invitation token_hash and invalid role enums', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    const base = world.events[0];
    const duplicateHash: WorkspaceEventEnvelope = {
      ...base,
      seq: 3,
      event_id: 'dup-hash',
      type: 'MemberInvited',
      payload: {
        invitation_id: 'different-id',
        email: 'carol@example.com',
        role: 'member',
        token_hash: 'hash-bob',
        expires_at: NOW + 1,
        created_by: 'alice',
        created_at: NOW,
      },
    };
    assert.throws(
      () => reduceWorkspace(world.state(), duplicateHash),
      /duplicate invitation token_hash/,
    );

    const invalidRole: WorkspaceEventEnvelope = {
      ...base,
      seq: 1,
      event_id: 'invalid-role',
      type: 'MemberInvited',
      payload: {
        invitation_id: 'bad-role',
        email: null,
        role: 'viewer',
        token_hash: 'unique',
        expires_at: NOW + 1,
        created_by: 'alice',
        created_at: NOW,
      },
    };
    assert.throws(
      () => reduceWorkspace(world.state(), invalidRole),
      /invalid role/,
    );

    const invalidJoined = {
      ...invalidRole,
      event_id: 'invalid-joined-role',
      type: 'MemberJoined',
      payload: {
        user_id: 'carol',
        role: 'viewer',
        invited_by: 'alice',
        joined_at: NOW,
      },
    } as WorkspaceEventEnvelope;
    assert.throws(
      () => reduceWorkspace(world.state(), invalidJoined),
      /invalid role/,
    );

    for (const payload of [
      { user_id: 'alice', from_role: 'viewer', to_role: 'member' },
      { user_id: 'alice', from_role: 'owner', to_role: 'viewer' },
    ]) {
      const invalidChanged = {
        ...invalidRole,
        event_id: `invalid-role-${payload.from_role}-${payload.to_role}`,
        type: 'MemberRoleChanged',
        payload,
      } as WorkspaceEventEnvelope;
      assert.throws(
        () => reduceWorkspace(world.state(), invalidChanged),
        /invalid (from_role|to_role)/,
      );
    }
  });

  it('every emitted accepted/domain decision folds without a harness carve-out', () => {
    const world = makeWorld();
    world.create();
    assert.doesNotThrow(() => world.state());
    const domain = world.apply({
      kind: 'revoke_invitation',
      invitation_id: 'missing',
    });
    rejected(domain, 'invitation_not_found');
    assert.doesNotThrow(() => world.state());
    assert.equal(world.state()!.workspace.workspace_id, 'ws-1');
  });
});

describe('invitations', () => {
  it('invite_member accepts for Owner/Admin and rejects role/TTL violations', () => {
    const world = makeWorld();
    world.create();
    const accepted = world.apply({
      kind: 'invite_member',
      invitation_id: 'i-bob',
      email: 'bob@example.com',
      role: 'member',
      token_hash: 'h-bob',
      expires_at: NOW + INVITATION_MAX_TTL_MS,
    });
    assert.equal(accepted.ok, true);
    assert.equal(world.state()!.invitations['i-bob'].token_hash, 'h-bob');

    rejected(
      world.apply(
        {
          kind: 'invite_member',
          invitation_id: 'i-x',
          email: 'x@example.com',
          role: 'member',
          token_hash: 'h-x',
          expires_at: NOW + 1,
        },
        { actor: human('outsider') },
      ),
      'bad_state',
      'authz',
    );
    world.join('member');
    rejected(
      world.apply(
        {
          kind: 'invite_member',
          invitation_id: 'i-y',
          email: 'y@example.com',
          role: 'member',
          token_hash: 'h-y',
          expires_at: NOW + 1,
        },
        { actor: human('member') },
      ),
      'role_forbidden',
    );
    rejected(
      world.apply({
        kind: 'invite_member',
        invitation_id: 'i-z',
        email: 'z@example.com',
        role: 'member',
        token_hash: 'h-z',
        expires_at: NOW + INVITATION_MAX_TTL_MS + 1,
      }),
      'invitation_ttl_invalid',
    );
  });

  it('invite_member rejects duplicate id/hash and Admin inviting an Owner', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    rejected(
      world.apply({
        kind: 'invite_member',
        invitation_id: 'invite-bob',
        email: 'carol@example.com',
        role: 'member',
        token_hash: 'different-hash',
        expires_at: NOW + 1,
      }),
      'bad_state',
    );
    rejected(
      world.apply({
        kind: 'invite_member',
        invitation_id: 'different-id',
        email: 'carol@example.com',
        role: 'member',
        token_hash: 'hash-bob',
        expires_at: NOW + 1,
      }),
      'bad_state',
    );
    world.join('admin', 'admin');
    rejected(
      world.apply(
        {
          kind: 'invite_member',
          invitation_id: 'owner-invite',
          email: 'owner2@example.com',
          role: 'owner',
          token_hash: 'owner-hash',
          expires_at: NOW + 1,
        },
        { actor: human('admin') },
      ),
      'role_forbidden',
    );
  });

  it('revoke_invitation accepts only a live invitation', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    assert.equal(
      world.apply({ kind: 'revoke_invitation', invitation_id: 'invite-bob' }).ok,
      true,
    );
    rejected(
      world.apply({ kind: 'revoke_invitation', invitation_id: 'invite-bob' }),
      'invitation_not_live',
    );
  });

  it('accept_invitation selects only by token_hash and joins a verified non-member', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    const decision = world.apply(
      { kind: 'accept_invitation', token_hash: 'hash-bob' },
      { actor: human('bob') },
    );
    assert.equal(decision.ok, true);
    if (decision.ok) {
      assert.deepEqual(
        decision.events.map((event) => event.type),
        ['InvitationAccepted', 'MemberJoined'],
      );
    }
    assert.equal(world.state()!.members.bob.role, 'member');
    assert.equal(world.state()!.invitations['invite-bob'].consumed_by, 'bob');
  });

  it('accept_invitation rejects invalid capability, identity, and replay', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    rejected(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'wrong' },
        { actor: human('bob') },
      ),
      'invitation_token_mismatch',
      'authz',
    );
    rejected(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob' },
        { actor: human('bob'), verified: false },
      ),
      'identity_not_verified',
      'authz',
    );
    assert.equal(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob' },
        { actor: human('bob') },
      ).ok,
      true,
    );
    rejected(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob' },
        { actor: human('bob') },
      ),
      'invitation_not_live',
    );
  });

  it('accepts a forwarded invite for a different verified identity by design', () => {
    const world = makeWorld();
    world.create();
    world.invite('bob');
    assert.equal(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob' },
        { actor: human('carol') },
      ).ok,
      true,
    );
    assert.equal(world.state()!.members.carol.role, 'member');
    assert.equal(world.state()!.members.bob, undefined);
  });

  it('accept rejects revoked and boundary-expired matched invitations as domain', () => {
    const revoked = makeWorld();
    revoked.create();
    revoked.invite('bob');
    assert.equal(
      revoked.apply({
        kind: 'revoke_invitation',
        invitation_id: 'invite-bob',
      }).ok,
      true,
    );
    rejected(
      revoked.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob' },
        { actor: human('bob') },
      ),
      'invitation_not_live',
    );

    const expired = makeWorld();
    expired.create();
    assert.equal(
      expired.apply({
        kind: 'invite_member',
        invitation_id: 'expires',
        email: 'bob@example.com',
        role: 'member',
        token_hash: 'expires-hash',
        expires_at: NOW + 1,
      }).ok,
      true,
    );
    rejected(
      expired.apply(
        { kind: 'accept_invitation', token_hash: 'expires-hash' },
        { actor: human('bob'), now: NOW + 1 },
      ),
      'invitation_not_live',
    );
  });
});

describe('membership and no-orphan authority', () => {
  it('remove_member accepts, but refuses last Owner and unresolved landing authority', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    assert.equal(
      world.apply({ kind: 'remove_member', user_id: 'bob' }).ok,
      true,
    );
    assert.notEqual(world.state()!.members.bob.revoked_at, null);

    rejected(
      world.apply({ kind: 'remove_member', user_id: 'alice' }),
      'last_owner',
    );

    world.join('carol');
    rejected(
      world.apply(
        {
          kind: 'remove_member',
          user_id: 'carol',
          landing_authority_successor_user_id: 'alice',
        },
        { landingResolved: false },
      ),
      'landing_authority_unresolved',
    );
  });

  it('change_role accepts and protects ownership transitions', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    assert.equal(
      world.apply({ kind: 'change_role', user_id: 'bob', role: 'admin' }).ok,
      true,
    );
    assert.equal(world.state()!.members.bob.role, 'admin');

    rejected(
      world.apply({ kind: 'change_role', user_id: 'alice', role: 'member' }),
      'last_owner',
    );
    rejected(
      world.apply(
        { kind: 'change_role', user_id: 'alice', role: 'admin' },
        { actor: human('bob') },
      ),
      'role_forbidden',
    );
  });

  it('Admin cannot remove an Owner, while a second Owner can be removed/demoted', () => {
    const world = makeWorld();
    world.create();
    world.join('bob', 'owner');
    world.join('carol', 'admin');
    assert.equal(world.state()!.owners_count, 2);
    rejected(
      world.apply(
        { kind: 'remove_member', user_id: 'bob' },
        { actor: human('carol') },
      ),
      'role_forbidden',
    );
    assert.equal(
      world.apply({ kind: 'remove_member', user_id: 'bob' }).ok,
      true,
    );
    assert.equal(world.state()!.owners_count, 1);

    assert.equal(
      world.apply({
        kind: 'invite_member',
        invitation_id: 'invite-bob-again',
        email: 'bob@example.com',
        role: 'owner',
        token_hash: 'hash-bob-again',
        expires_at: NOW + 1,
      }).ok,
      true,
    );
    assert.equal(
      world.apply(
        { kind: 'accept_invitation', token_hash: 'hash-bob-again' },
        { actor: human('bob') },
      ).ok,
      true,
    );
    assert.equal(world.state()!.owners_count, 2);
    assert.equal(
      world.apply({ kind: 'change_role', user_id: 'bob', role: 'member' }).ok,
      true,
    );
    assert.equal(world.state()!.owners_count, 1);
  });

  it('change_role rejects same-role and unresolved landing-authority changes', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    rejected(
      world.apply({ kind: 'change_role', user_id: 'bob', role: 'member' }),
      'bad_state',
    );
    rejected(
      world.apply(
        {
          kind: 'change_role',
          user_id: 'bob',
          role: 'admin',
          landing_authority_successor_user_id: 'alice',
        },
        { landingResolved: false },
      ),
      'landing_authority_unresolved',
    );
  });
});

describe('agent principals', () => {
  it('create_agent_principal creates an owned principal and rejects duplicate names', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');
    assert.equal(world.state()!.principals['principal-bob'].owner_user_id, 'bob');
    rejected(
      world.apply(
        {
          kind: 'create_agent_principal',
          principal_id: 'another-id',
          name: 'agent-bob',
        },
        { actor: human('bob') },
      ),
      'principal_name_taken',
    );
  });

  it('create/revoke principal are human-only; a Member may revoke only their own', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.join('carol');
    world.createPrincipal('bob');

    rejected(
      world.apply(
        {
          kind: 'create_agent_principal',
          principal_id: 'p-agent',
          name: 'agent-created',
        },
        {
          actor: agent('bob', 'principal-bob'),
          credential_kind: 'agent',
          presenting_token_id: 't',
        },
      ),
      'credential_kind_forbidden',
      'authz',
    );
    rejected(
      world.apply(
        { kind: 'revoke_agent_principal', principal_id: 'principal-bob' },
        { actor: human('carol') },
      ),
      'principal_not_owned',
    );
    assert.equal(
      world.apply(
        { kind: 'revoke_agent_principal', principal_id: 'principal-bob' },
        { actor: human('bob') },
      ).ok,
      true,
    );
  });
});

describe('agent token minting', () => {
  it('the intrinsic denylist covers every §2.3 authority category', () => {
    const denied = [
      'issue_grant',
      'mint_agent_token',
      'invite_member',
      'revoke_invitation',
      'remove_member',
      'change_role',
      'transfer_ownership',
      'map_repository',
      'create_workspace',
      'delete_workspace',
      'mint_capability_url',
      'force_discard',
      'revoke_agent_token',
      'author_trusted_knowledge',
      'trusted:knowledge:write',
      'accept_playbook',
      'update_foundational_instruction',
      'revoke_acceptance_schema',
      // Kimi #3: plural/synonym probes that must never evade the intrinsic gate.
      'members:write',
      'roles:write',
      'owners:delete',
      'invitations:create',
      'grants:issue',
      'grant_issuance',
      'tokens:mint',
      'repositories:map',
      'workspaces:delete',
      'capability:urls:mint',
      'task:discard',
      'discard',
      'invalidate_credential',
      'revoke:refresh',
      'mint_worker_token',
      'renew_worker_token',
      'create_agent_credential',
      'set_role',
      'promote_member',
      'demote_member',
    ];
    for (const scope of denied) {
      assert.equal(isAgentScopeDenylisted(scope), true, scope);
    }
    assert.equal(isAgentScopeDenylisted('task:acquire'), false);
    assert.equal(isAgentScopeDenylisted('message:send'), false);
  });

  it('mints only token metadata with narrow binding and the one-hour default', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');
    const decision = world.mint('bob', 'token-1');
    assert.equal(decision.ok, true);
    const token = world.state()!.tokens['token-1'];
    assert.equal(token.run_id, 'run-bob');
    assert.equal(token.task_id, 'task-1');
    assert.equal(token.epoch, 1);
    assert.equal(token.expires_at, NOW + AGENT_TOKEN_DEFAULT_TTL_MS);
    assert.equal('token_hash' in token, false);
  });

  it('rejects denylisted/excess scopes, missing binding, and TTL above 8h', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');

    rejected(
      world.apply(
        {
          kind: 'mint_agent_token',
          token_id: 'denylisted',
          principal_id: 'principal-bob',
          run_id: 'run-bob',
          task_id: 'task-1',
          epoch: 1,
          scopes: ['issue_grant'],
        },
        { actor: human('bob') },
      ),
      'scope_denylisted',
    );
    rejected(
      world.apply(
        {
          kind: 'mint_agent_token',
          token_id: 'excess',
          principal_id: 'principal-bob',
          run_id: 'run-bob',
          task_id: 'task-1',
          epoch: 1,
          scopes: ['admin:everything'],
        },
        { actor: human('bob') },
      ),
      'scope_not_allowed',
    );
    rejected(
      world.apply(
        {
          kind: 'mint_agent_token',
          token_id: 'unbound',
          principal_id: 'principal-bob',
          run_id: '',
          task_id: 'task-1',
          epoch: 1,
          scopes: ['task:acquire'],
        },
        { actor: human('bob') },
      ),
      'binding_required',
    );
    rejected(
      world.apply(
        {
          kind: 'mint_agent_token',
          token_id: 'too-long',
          principal_id: 'principal-bob',
          run_id: 'run-bob',
          task_id: 'task-1',
          epoch: 1,
          scopes: ['task:acquire'],
          ttl_ms: AGENT_TOKEN_MAX_TTL_MS + 1,
        },
        { actor: human('bob') },
      ),
      'token_ttl_invalid',
    );
  });

  it('rejects empty and non-tokenizable scope sets', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');
    for (const scopes of [[], ['*'], ['::']] as string[][]) {
      rejected(
        world.apply(
          {
            kind: 'mint_agent_token',
            token_id: `bad-scope-${scopes.join('-') || 'empty'}`,
            principal_id: 'principal-bob',
            run_id: 'run-bob',
            task_id: 'task-1',
            epoch: 1,
            scopes,
          },
          {
            actor: human('bob'),
            humanRights: ['*', '::'],
          },
        ),
        'scope_not_allowed',
      );
    }
  });

  it('pins mint TTL/epoch boundaries, duplicate ids, and revoked principals', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');
    const mintCommand = (
      token_id: string,
      overrides: Partial<Extract<WorkspaceCommand, { kind: 'mint_agent_token' }>> = {},
    ): WorkspaceCommand => ({
      kind: 'mint_agent_token',
      token_id,
      principal_id: 'principal-bob',
      run_id: 'run-bob',
      task_id: 'task-1',
      epoch: 1,
      scopes: ['task:acquire'],
      ...overrides,
    });

    assert.equal(
      world.apply(
        mintCommand('max-ttl', { ttl_ms: AGENT_TOKEN_MAX_TTL_MS }),
        { actor: human('bob') },
      ).ok,
      true,
    );
    assert.equal(
      world.state()!.tokens['max-ttl'].expires_at,
      NOW + AGENT_TOKEN_MAX_TTL_MS,
    );
    rejected(
      world.apply(mintCommand('max-ttl'), { actor: human('bob') }),
      'bad_state',
    );

    for (const [token_id, ttl_ms] of [
      ['zero-ttl', 0],
      ['negative-ttl', -1],
      ['nan-ttl', Number.NaN],
    ] as const) {
      rejected(
        world.apply(mintCommand(token_id, { ttl_ms }), { actor: human('bob') }),
        'token_ttl_invalid',
      );
    }
    for (const [token_id, epoch] of [
      ['negative-epoch', -1],
      ['fractional-epoch', 1.5],
    ] as const) {
      rejected(
        world.apply(mintCommand(token_id, { epoch }), { actor: human('bob') }),
        'binding_required',
      );
    }

    assert.equal(
      world.apply(
        { kind: 'revoke_agent_principal', principal_id: 'principal-bob' },
        { actor: human('bob') },
      ).ok,
      true,
    );
    rejected(
      world.apply(mintCommand('revoked-principal'), { actor: human('bob') }),
      'principal_revoked',
    );
  });
});

describe('agent token revocation', () => {
  it('human Owner/Admin may revoke any token; Member only an owned token', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.join('carol');
    world.createPrincipal('bob');
    assert.equal(world.mint('bob', 'token-bob').ok, true);

    rejected(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'token-bob' },
        { actor: human('carol') },
      ),
      'principal_not_owned',
    );
    assert.equal(
      world.apply({ kind: 'revoke_agent_token', token_id: 'token-bob' }).ok,
      true,
    );
    rejected(
      world.apply({ kind: 'revoke_agent_token', token_id: 'token-bob' }),
      'token_revoked',
    );
    rejected(
      world.apply({ kind: 'revoke_agent_token', token_id: 'missing' }),
      'token_not_found',
    );
  });

  it('Admin revokes any token and Member revokes an owned token', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.join('admin', 'admin');
    world.join('member');
    world.createPrincipal('bob');
    world.createPrincipal('member');
    assert.equal(world.mint('bob', 'token-bob').ok, true);
    assert.equal(world.mint('member', 'token-member').ok, true);
    assert.equal(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'token-bob' },
        { actor: human('admin') },
      ).ok,
      true,
    );
    assert.equal(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'token-member' },
        { actor: human('member') },
      ).ok,
      true,
    );
  });

  it('agent may revoke only its exact presenting token, never a sibling', () => {
    const world = makeWorld();
    world.create();
    world.join('bob');
    world.createPrincipal('bob');
    assert.equal(world.mint('bob', 'token-self').ok, true);
    assert.equal(world.mint('bob', 'token-sibling').ok, true);

    rejected(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'token-sibling' },
        {
          actor: agent('bob', 'principal-bob'),
          credential_kind: 'agent',
          presenting_token_id: 'token-self',
        },
      ),
      'credential_kind_forbidden',
      'authz',
    );
    assert.equal(world.state()!.tokens['token-sibling'].revoked_at, null);
    rejected(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'does-not-exist' },
        {
          actor: agent('bob', 'principal-bob'),
          credential_kind: 'agent',
          presenting_token_id: 'token-self',
        },
      ),
      'credential_kind_forbidden',
      'authz',
    );
    assert.equal(
      world.apply(
        { kind: 'revoke_agent_token', token_id: 'token-self' },
        {
          actor: agent('bob', 'principal-bob'),
          credential_kind: 'agent',
          presenting_token_id: 'token-self',
        },
      ).ok,
      true,
    );
  });
});
