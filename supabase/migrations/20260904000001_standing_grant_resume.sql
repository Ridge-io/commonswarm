-- Idle suspension of a standing grant becomes RECOVERABLE by a human, and stays
-- one-way for everybody else. Revocation is untouched and stays permanent.
--
-- WHAT WAS WRONG. 20260901000001_standing_grants.sql made "standing" mean "no
-- horizon", and then took it back: swarm.prepare_renewal_grant self-suspends a
-- standing grant after 14 days with no measured use, and
-- swarm.renewal_grants_spend_or_revoke_only() raised SWARM_RENEWAL_GRANT_UNSUSPEND
-- on ANY un-suspend. So a standing grant was a 14-day grant with an unhelpful
-- ending: park a laptop over a holiday and the agent was dead with no way back
-- except minting a new grant and a new lineage. That rule was tolerable while
-- standing was an opt-in behind two confirmation flags. It is not tolerable now
-- that standing is what a person gets by default from the web add-agent flow,
-- because the promise printed on that screen is that the agent does not expire.
--
-- The design already said so and the migration under-implemented it:
-- docs/design/2026-08-31-STANDING-GRANTS.md:36-37 — "Idle > 14d: set
-- suspended_at ... Resume is one explicit owner action; never automatic."
--
-- WHAT THIS INSTALLS. Idle suspension stays, at the same 14 days, and stays
-- LOUD and fail-closed: while a grant is suspended no successor is issued, no
-- use is recorded, and nothing the agent can do lifts it. What changes is that
-- the suspension now has an exit, and the exit is a person:
--
--   * A workspace owner or admin, or the member who owns the principal, may
--     resume a suspended grant through swarm.resume_renewal_grant(). That
--     function checks membership and role itself, and the command edge writes a
--     swarm.audit_log row for the call like every other command.
--   * The resume is recorded on the row: resumed_at, resumed_by, resume_count.
--     Nothing is erased. suspended_at is NEVER cleared, so the suspension that
--     happened stays readable forever, and a second idle lapse simply stamps a
--     later suspended_at.
--   * A REVOKED grant can never be resumed. Three independent fences say so: the
--     function refuses, the row trigger raises SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE,
--     and a table CHECK refuses a row whose resume is later than its revocation.
--     Revocation remains the only permanent kill switch, exactly as the copy says.
--
-- ⚠️ DEPLOY ORDER IS LOAD-BEARING. Three artifacts change together and only one
-- order is safe:
--
--   1. THIS MIGRATION FIRST. The command function is being changed in the same
--      lane to read swarm.renewal_grants.suspension_active. Deploy that function
--      before this migration and EVERY renewal 500s on a column that does not
--      exist yet. Applying this migration first is safe on its own: the old
--      function reads suspended_at, which still exists and still means "paused"
--      for every grant — nothing can be resumed until step 2 ships the only
--      caller of swarm.resume_renewal_grant.
--   2. THE COMMAND FUNCTION SECOND (`supabase functions deploy command`).
--   3. THE SITE LAST. site/src/lib/agent-connect.ts now sends
--      renewal_kind: "standing", and the command function validates the mint
--      body with an exact key set. A deployment whose command function predates
--      renewal_kind rejects that mint with 400 "malformed", so the web
--      add-agent flow breaks completely. NOT VERIFIED IN THIS LANE: which
--      command-function build is live on the hosted project. Check before
--      deploying the site.
--
-- Rolling BACKWARDS has the same shape: revert the site first, the function
-- second, and leave this migration applied (it is additive).
--
-- SUSPENDED AND REVOKED MUST NOT BE CONFUSABLE, so they are not the same shape.
-- "Suspended" is a derived predicate over a pair of forward-only timestamps and
-- is expressible as false again. "Revoked" is a single timestamp that no code
-- path in this schema can clear, and swarm.renewal_grants_revoke_cascade already
-- fans it out to tombstones. There is exactly ONE definition of "suspended right
-- now" — the generated column suspension_active below — and every reader uses it,
-- so a reader cannot accidentally implement a fourth answer.

ALTER TABLE swarm.renewal_grants
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resumed_by uuid REFERENCES swarm.users (user_id),
  ADD COLUMN IF NOT EXISTS resume_count integer NOT NULL DEFAULT 0;

-- The single definition of "suspended right now". Generated and STORED so that
-- every reader — preflight, fence, use-recorder, roster, agent read, and the
-- command edge — is reading the same expression rather than its own copy of it.
-- Immutable inputs only: IS NULL and timestamptz comparison.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'swarm.renewal_grants'::regclass
      AND attname = 'suspension_active'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD COLUMN suspension_active boolean
      GENERATED ALWAYS AS (
        suspended_at IS NOT NULL
        AND (resumed_at IS NULL OR resumed_at <= suspended_at)
      ) STORED;
  END IF;
END
$$;

ALTER TABLE swarm.renewal_grants
  DROP CONSTRAINT IF EXISTS renewal_grants_resume_shape,
  DROP CONSTRAINT IF EXISTS renewal_grants_resume_needs_suspension,
  DROP CONSTRAINT IF EXISTS renewal_grants_resume_not_after_revoke,
  DROP CONSTRAINT IF EXISTS renewal_grants_resume_count_bounded;

ALTER TABLE swarm.renewal_grants
  -- The three resume fields are one fact and move together, or a row could
  -- claim a resume nobody performed.
  ADD CONSTRAINT renewal_grants_resume_shape
    CHECK (
      (resumed_at IS NULL AND resumed_by IS NULL AND resume_count = 0)
      OR (resumed_at IS NOT NULL AND resumed_by IS NOT NULL AND resume_count > 0)
    ),
  -- You cannot resume something that never stopped.
  ADD CONSTRAINT renewal_grants_resume_needs_suspension
    CHECK (resumed_at IS NULL OR suspended_at IS NOT NULL),
  -- REVOCATION IS PERMANENT, asserted by the table itself and not only by the
  -- trigger, so a maintenance session that disables triggers still cannot leave
  -- a revoked grant in a resumed state.
  ADD CONSTRAINT renewal_grants_resume_not_after_revoke
    CHECK (resumed_at IS NULL OR revoked_at IS NULL OR resumed_at <= revoked_at),
  ADD CONSTRAINT renewal_grants_resume_count_bounded
    CHECK (resume_count >= 0);

COMMENT ON COLUMN swarm.renewal_grants.resumed_at IS
  'Last human resume of an idle suspension. Forward-only, never cleared, and always later than the suspended_at it answers. NULL means this grant has never been resumed.';
COMMENT ON COLUMN swarm.renewal_grants.resumed_by IS
  'The workspace member who resumed. Set only together with resumed_at; the audit row for the call is in swarm.audit_log.';
COMMENT ON COLUMN swarm.renewal_grants.resume_count IS
  'How many times a human has resumed this grant. Monotone: the trigger accepts +1 and only alongside a new resumed_at.';
COMMENT ON COLUMN swarm.renewal_grants.suspension_active IS
  'The ONE definition of "suspended right now": a suspension stamped, and no later resume. Every reader uses this column rather than testing suspended_at, so suspended-vs-resumed cannot be answered two ways.';
COMMENT ON COLUMN swarm.renewal_grants.suspended_at IS
  'Most recent idle suspension. Standing renewal stamps it after more than 14 days without measured use. Forward-only and never cleared: a resume is recorded in resumed_at instead, so the lapse stays readable. Ask suspension_active, not this column, for current state.';

-- Grants may spend, record use, suspend, RESUME, and revoke. Authority fields
-- remain immutable, counters and timestamps remain monotone, one-way state
-- cannot be cleared, and a revoked grant can never be resumed.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_spend_or_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  resuming boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNDELETABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.max_successors IS DISTINCT FROM OLD.max_successors
    OR NEW.horizon_expires_at IS DISTINCT FROM OLD.horizon_expires_at
    OR NEW.bound_device_id IS DISTINCT FROM OLD.bound_device_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.successors_used < OLD.successors_used THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_COUNTER_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.successors_stranded < OLD.successors_stranded THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_STRANDED_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.last_used_at IS NOT NULL
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LAST_USE_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.last_used_device_id IS DISTINCT FROM OLD.last_used_device_id
    OR NEW.last_used_from IS DISTINCT FROM OLD.last_used_from
  ) AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP' USING ERRCODE = '55000';
  END IF;
  IF OLD.new_host_at IS NOT NULL
     AND NEW.new_host_at IS DISTINCT FROM OLD.new_host_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_NEW_HOST_REWOUND' USING ERRCODE = '55000';
  END IF;

  -- The suspension RECORD is still one-way. Clearing suspended_at is refused as
  -- it always was, and it may not move backwards either: a resume is written to
  -- resumed_at, so the lapse that happened stays on the row forever.
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNSUSPEND' USING ERRCODE = '55000';
  END IF;
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at < OLD.suspended_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SUSPENSION_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNREVOKE' USING ERRCODE = '55000';
  END IF;

  resuming := NEW.resumed_at IS DISTINCT FROM OLD.resumed_at;

  IF OLD.resumed_at IS NOT NULL
     AND (NEW.resumed_at IS NULL OR NEW.resumed_at < OLD.resumed_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.resume_count < OLD.resume_count THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;

  IF resuming THEN
    -- REVOCATION IS FOREVER. This is the fence that keeps "suspended, a person
    -- can bring it back" and "revoked, dead" from ever being the same state.
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE'
        USING ERRCODE = '55000';
    END IF;
    -- A resume answers a suspension that already happened, in a statement that
    -- does not also suspend. Without the second clause a single UPDATE could
    -- suspend and resume at once and mean nothing.
    IF OLD.suspended_at IS NULL
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
       OR NEW.resumed_at <= OLD.suspended_at
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_WITHOUT_SUSPENSION'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.resumed_by IS NULL OR NEW.resume_count <> OLD.resume_count + 1 THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Attribution and the counter move only WITH a resume, so neither can be
    -- edited to imply a resume that did not occur.
    IF NEW.resumed_by IS DISTINCT FROM OLD.resumed_by
       OR NEW.resume_count <> OLD.resume_count
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_spend_or_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() FROM PUBLIC;

COMMENT ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() IS
  'Grant row fence: authority fields immutable; counters, last use, suspension and resume forward-only; suspended_at never cleared; revoked_at never cleared; and a revoked grant can never be resumed.';

-- Preflight, now with an exit from suspension and an idle clock that a resume
-- restarts.
CREATE OR REPLACE FUNCTION swarm.prepare_renewal_grant(
  p_renewal_grant_id uuid,
  p_device_id uuid
)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
  idle_since timestamptz;
BEGIN
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF grant_row.suspension_active THEN
    RETURN 'renewal_grant_suspended';
  END IF;

  /* THE IDLE CLOCK RESTARTS AT THE RESUME, and this is the line that makes the
     resume mean anything. A grant is suspended precisely because it has been
     idle for more than 14 days, so at the instant a person resumes it its
     last_used_at is still old. Measured from last_used_at alone, the very next
     renewal attempt would re-suspend it before the agent could record a use —
     the resume would be a no-op that looked like a fix. The baseline is
     therefore the later of "last measured use" and "last human resume". */
  idle_since := COALESCE(grant_row.last_used_at, grant_row.created_at);
  IF grant_row.resumed_at IS NOT NULL AND grant_row.resumed_at > idle_since THEN
    idle_since := grant_row.resumed_at;
  END IF;

  IF grant_row.kind = 'standing'
     AND idle_since < statement_timestamp() - interval '14 days'
  THEN
    UPDATE swarm.renewal_grants
    SET suspended_at = statement_timestamp()
    WHERE renewal_grant_id = grant_row.renewal_grant_id
      AND (suspended_at IS NULL OR suspended_at < statement_timestamp());
    RETURN 'renewal_idle_suspended';
  END IF;

  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RETURN 'renewal_horizon_reached';
  END IF;

  IF grant_row.bound_device_id IS NOT NULL AND p_device_id IS NULL THEN
    RETURN 'renewal_device_unavailable';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
    RETURN 'renewal_device_mismatch';
  END IF;
  IF grant_row.last_used_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
  END IF;

  RETURN NULL;
END
$$;

ALTER FUNCTION swarm.prepare_renewal_grant(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) TO swarm_command;

-- Use recording asks suspension_active, so a resumed grant records use again
-- and a suspended one still records nothing.
CREATE OR REPLACE FUNCTION swarm.record_renewal_grant_use(
  p_token_id uuid,
  p_device_id uuid,
  p_last_used_from text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  UPDATE swarm.renewal_grants AS grant_row
  SET last_used_at = statement_timestamp(),
      last_used_device_id = p_device_id,
      last_used_from = COALESCE(p_last_used_from, grant_row.last_used_from),
      new_host_at = CASE
        WHEN grant_row.new_host_at IS NOT NULL THEN grant_row.new_host_at
        WHEN grant_row.bound_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
          THEN statement_timestamp()
        WHEN grant_row.last_used_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  FROM swarm.agent_tokens AS token
  WHERE token.token_id = p_token_id
    AND token.renewal_grant_id = grant_row.renewal_grant_id
    AND grant_row.revoked_at IS NULL
    AND NOT grant_row.suspension_active;
END;
$$;

ALTER FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  TO swarm_command, swarm_read;

-- The successor fence asks suspension_active for the same reason.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_successor_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  pred swarm.agent_tokens%ROWTYPE;
  grant_row swarm.renewal_grants%ROWTYPE;
  owner_user uuid;
  run_device uuid;
  run_ended timestamptz;
  principal_revoked timestamptz;
  device_revoked timestamptz;
BEGIN
  NEW.issued_at := statement_timestamp();

  SELECT * INTO pred
  FROM swarm.agent_tokens
  WHERE token_id = NEW.predecessor_token_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM pred.principal_id
    OR NEW.run_id IS DISTINCT FROM pred.run_id
    OR NEW.task_id IS DISTINCT FROM pred.task_id
    OR NEW.epoch IS DISTINCT FROM pred.epoch
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TARGET_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NEW.lineage_id IS DISTINCT FROM pred.lineage_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.renewal_grant_id IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_UNGRANTED_PREDECESSOR' USING ERRCODE = '55000';
  END IF;
  IF NEW.renewal_grant_id IS DISTINCT FROM pred.renewal_grant_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF pred.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pred.surrender_only THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_SURRENDERED' USING ERRCODE = '55000';
  END IF;

  SELECT p.owner_user_id, p.revoked_at, r.device_id, r.ended_at, d.revoked_at
    INTO owner_user, principal_revoked, run_device, run_ended, device_revoked
  FROM swarm.agent_principals AS p
  JOIN swarm.agent_runs AS r ON r.run_id = pred.run_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE p.principal_id = pred.principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BINDING_MISSING' USING ERRCODE = '55000';
  END IF;
  IF principal_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PRINCIPAL_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF run_ended IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RUN_ENDED' USING ERRCODE = '55000';
  END IF;
  IF device_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.revocation_tombstones AS tombstone
    WHERE (tombstone.kind, tombstone.target_id) IN (
      ('token', pred.token_id),
      ('lineage', pred.lineage_id),
      ('family', pred.lineage_id),
      ('principal', pred.principal_id),
      ('run', pred.run_id),
      ('device', run_device),
      ('membership', owner_user),
      ('renewal_grant', pred.renewal_grant_id)
    )
  ) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.scopes) <> 'array'
     OR jsonb_typeof(pred.scopes) <> 'array'
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPES_MALFORMED' USING ERRCODE = '55000';
  END IF;
  IF NOT (pred.scopes @> NEW.scopes) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPE_WIDENED' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = pred.renewal_grant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISSING' USING ERRCODE = '55000';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.suspension_active THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_SUSPENDED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_HORIZON_REACHED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND run_device IS DISTINCT FROM grant_row.bound_device_id
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF grant_row.max_successors IS NOT NULL
     AND grant_row.successors_used - grant_row.successors_stranded >= grant_row.max_successors
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_EXHAUSTED' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at <= NEW.issued_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > NEW.issued_at + interval '8 hours' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_EXCEEDED'
      USING ERRCODE = '55000', CONSTRAINT = 'renewal_ttl_exceeded';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND NEW.expires_at > grant_row.horizon_expires_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BEYOND_HORIZON' USING ERRCODE = '55000';
  END IF;

  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1,
      last_used_at = statement_timestamp(),
      last_used_device_id = run_device,
      new_host_at = CASE
        WHEN new_host_at IS NOT NULL THEN new_host_at
        WHEN last_used_device_id IS NOT NULL
             AND run_device IS DISTINCT FROM last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_tokens_successor_fence() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_successor_fence() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_successor_fence() IS
  'Standing/timeboxed successor fence: validates predecessor lineage and liveness, grant revocation/active suspension/horizon/device binding, scope attenuation, short bearer TTL, and atomically records spend plus use.';

-- THE EXIT. One explicit, authenticated action by a person who may already
-- revoke this grant, refused for every other caller and for every revoked
-- grant. Returns a stable code, never prose (D-053), so the edge classifies on
-- a value we assign rather than on a message.
CREATE OR REPLACE FUNCTION swarm.resume_renewal_grant(
  p_workspace_id uuid,
  p_renewal_grant_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
  actor_role text;
  principal_owner uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_renewal_grant_id IS NULL OR p_user_id IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  /* The workspace comes from the route, not from the grant, and both must
     agree. Without this a member of workspace A could name a grant id belonging
     to workspace B and be authorised by A's membership. */
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
    AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The closed-workspace gate is repeated here rather than left to the command
     edge's resolveRoute. This function is the whole authorization decision, and
     a second caller wired to it later must not be able to resume an agent in a
     workspace the owner has closed. */
  SELECT m.role INTO actor_role
  FROM swarm.memberships AS m
  JOIN swarm.workspaces AS w
    ON w.workspace_id = m.workspace_id
   AND w.archived_at IS NULL
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_user_id
    AND m.revoked_at IS NULL;
  IF actor_role IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  SELECT p.owner_user_id INTO principal_owner
  FROM swarm.agent_principals AS p
  WHERE p.principal_id = grant_row.principal_id
    AND p.workspace_id = p_workspace_id
    AND p.revoked_at IS NULL;
  IF principal_owner IS NULL THEN
    /* The principal is gone or revoked. Resuming its grant would restore
       renewal for an agent the workspace has already retired. */
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The same gate as revoke_agent_principal: owner/admin manage any agent in
     the workspace, a plain member manages only their own. Whoever may kill this
     grant may also bring it back; nobody else may do either. */
  IF actor_role NOT IN ('owner', 'admin') AND principal_owner <> p_user_id THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF NOT grant_row.suspension_active THEN
    RETURN 'renewal_grant_not_suspended';
  END IF;

  UPDATE swarm.renewal_grants
  SET resumed_at = statement_timestamp(),
      resumed_by = p_user_id,
      resume_count = resume_count + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid)
  TO swarm_command;

COMMENT ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid) IS
  'One human resume of an idle-suspended grant, gated like revoke_agent_principal. Refuses a revoked grant, a grant in another workspace, a retired principal, and any caller who could not revoke it. Returns NULL on success or a stable refusal code.';

-- The two member/agent reads report EFFECTIVE suspension in suspended_at: a
-- resumed grant reads as not suspended, which is what every existing consumer
-- (dashboard badge, cswarm grant status, the reducer facts) already means by
-- that field. The signature is unchanged on purpose so no caller has to be
-- edited to stay correct.
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at
  FROM swarm.agent_principals AS principal
  JOIN LATERAL (
    SELECT candidate.*
    FROM swarm.renewal_grants AS candidate
    WHERE candidate.workspace_id = p_workspace_id
      AND candidate.principal_id = principal.principal_id
    ORDER BY
      (candidate.revoked_at IS NULL) DESC,
      candidate.created_at DESC,
      candidate.renewal_grant_id DESC
    LIMIT 1
  ) AS grant_row ON true
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS token ON true
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

ALTER FUNCTION swarm_read.renewal_grant_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_roster(uuid)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_roster(uuid) IS
  'One current grant row per live principal for a verified live workspace member. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Includes token ids and timestamps, never token hashes or bearer secrets.';

CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_for_token(
  p_workspace_id uuid,
  p_token_id uuid
)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    latest.token_id,
    latest.issued_at,
    latest.expires_at,
    latest.first_used_at,
    latest.revoked_at
  FROM swarm.agent_tokens AS presenting
  JOIN swarm.renewal_grants AS grant_row
    ON grant_row.renewal_grant_id = presenting.renewal_grant_id
  JOIN swarm.agent_principals AS principal
    ON principal.principal_id = grant_row.principal_id
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS latest ON true
  WHERE presenting.token_id = p_token_id
    AND grant_row.workspace_id = p_workspace_id
    AND principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL;
$$;

ALTER FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  TO swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) IS
  'The current renewal grant for one already-authenticated agent token. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Never returns another principal or workspace.';

-- Catalogue controls. Each one names something a caller could get wrong, and
-- every one of them fails against the pre-migration schema.
DO $$
DECLARE
  resume_generated char;
BEGIN
  SELECT attgenerated INTO resume_generated
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'swarm.renewal_grants'::regclass
    AND attname = 'suspension_active'
    AND NOT attisdropped;
  IF resume_generated IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'suspension_active is not a stored generated column; readers would each define suspension themselves';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'swarm.renewal_grants'::regclass
      AND conname = 'renewal_grants_resume_not_after_revoke'
  ) THEN
    RAISE EXCEPTION 'the table does not refuse a resume later than its revocation';
  END IF;

  -- Every reader must ask suspension_active, not suspended_at. A reader left on
  -- the raw column would keep a resumed grant dead, which is the bug this
  -- migration exists to remove.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
        ('swarm', 'prepare_renewal_grant'),
        ('swarm', 'record_renewal_grant_use'),
        ('swarm', 'agent_tokens_successor_fence'),
        ('swarm', 'resume_renewal_grant'),
        ('swarm_read', 'renewal_grant_roster'),
        ('swarm_read', 'renewal_grant_for_token')
      )
      AND p.prosrc NOT LIKE '%suspension_active%'
  ) THEN
    RAISE EXCEPTION 'a renewal-grant reader still decides suspension from suspended_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'swarm'
      AND p.proname = 'renewal_grants_spend_or_revoke_only'
      AND p.prosrc NOT LIKE '%SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE%'
  ) THEN
    RAISE EXCEPTION 'the grant trigger does not refuse a resume after revocation';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'swarm.resume_renewal_grant(uuid,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can resume a grant directly, bypassing the command edge audit row';
  END IF;
  IF has_function_privilege(
    'anon',
    'swarm.resume_renewal_grant(uuid,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon can resume a grant';
  END IF;
END
$$;
