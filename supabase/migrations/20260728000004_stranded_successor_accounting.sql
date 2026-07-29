-- Stranded-successor accounting: make the self-healing reissue in
-- 20260728000003 actually free, instead of only claiming to be.
--
-- WHAT WAS WRONG.
--
-- 20260728000003 moved supersession to first use so that a renewal whose HTTP
-- response is lost can be retried: the stranded successor is revoked and a
-- fresh one issued. The design required that the replacement NOT be charged a
-- second grant slot, because otherwise a run of dropped connections eats the
-- renewal budget and forces the human reauthorisation the whole feature exists
-- to remove.
--
-- The command function tried to honour that by DECREMENTING successors_used
-- after discarding a stranded successor. That decrement can never succeed:
-- swarm.renewal_grants_spend_or_revoke_only() refuses any decrement with
-- SWARM_RENEWAL_COUNTER_REWOUND, and correctly so - in every other
-- circumstance a decrement is a free successor. So the refund was dead code
-- that always failed, was swallowed as best-effort, and every stranded retry
-- permanently burned a slot. Measured, not inferred: the trigger predicate is
-- `NEW.successors_used < OLD.successors_used`, with no exemption.
--
-- The reducer meanwhile subtracted one from the ceiling test when replacing a
-- pending successor. That made the two halves DISAGREE: at
-- successors_used = max_successors the reducer would authorise a replacement
-- and the fence would refuse it with SWARM_RENEWAL_GRANT_EXHAUSTED, which the
-- command function reports as a lost race and re-decides into
-- `predecessor_superseded` - a refusal naming the wrong cause.
--
-- WHAT THIS DOES INSTEAD.
--
-- Adds a second MONOTONE counter, successors_stranded, and makes the effective
-- spend `successors_used - successors_stranded` everywhere it is tested. A
-- stranded successor delivered nothing, so it is credited back by counting it,
-- never by unwinding anything.
--
-- Both counters stay increment-only, so the no-rewind property that made the
-- old guard trustworthy is preserved exactly rather than carved out: there is
-- still no code path anywhere that lowers a number on this table. That is the
-- whole reason for a second counter rather than an exemption in the first.
--
-- WHAT THIS DELIBERATELY PERMITS. An agent that renews and discards the
-- response in a loop is now not rate-limited by the grant: each iteration
-- charges one and credits one, netting zero. That is intended - it is the
-- definition of "the attempt delivered nothing" - and it is bounded elsewhere:
-- at most one live successor exists per predecessor at any instant (the
-- partial unique index), the 30-day horizon is untouched, and every discard
-- writes a revocation tombstone plus a `self_healed` audit row, so the
-- behaviour is loud rather than silent. What it must NOT do is let a
-- credential accumulate, and it does not.

ALTER TABLE swarm.renewal_grants
  ADD COLUMN IF NOT EXISTS successors_stranded integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN swarm.renewal_grants.successors_stranded IS
  'How many successors this grant issued that were never used - the response carrying the raw credential was lost, so the successor was discarded and replaced. Subtracted from successors_used to give the effective spend, so a lost response costs a retry rather than a slot. Monotone like successors_used: swarm.renewal_grants_spend_or_revoke_only() refuses to lower either, and the CHECK below stops it exceeding successors_used, which together make "credit" expressible only as something that actually happened.';

-- The credit cannot exceed the spend. Without this, raising successors_stranded
-- alone would manufacture unlimited headroom - the exact free-successor bug the
-- monotonicity rule exists to prevent, entered through the other door.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_stranded_bounded'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_stranded_bounded
      CHECK (successors_stranded >= 0 AND successors_stranded <= successors_used);
  END IF;
END
$$;

-- The bound becomes effective-spend rather than raw spend. This REPLACES
-- renewal_grants_successors_bounded, whose `successors_used <= max_successors`
-- would otherwise cap total issuance at max_successors however many of those
-- were stranded - i.e. it would keep enforcing the bug this migration removes.
--
-- Dropping and re-adding is safe on existing data without a NOT VALID dance:
-- the new predicate is strictly WEAKER (every row satisfying the old one
-- satisfies the new one, since successors_stranded defaults to 0), so the
-- validating scan cannot fail. It is not weaker in the sense that matters -
-- effective spend is still hard-capped at max_successors.
ALTER TABLE swarm.renewal_grants
  DROP CONSTRAINT IF EXISTS renewal_grants_successors_bounded;

ALTER TABLE swarm.renewal_grants
  ADD CONSTRAINT renewal_grants_successors_bounded
  CHECK (
    successors_used >= 0
    AND successors_used - successors_stranded <= max_successors
  );

COMMENT ON CONSTRAINT renewal_grants_successors_bounded ON swarm.renewal_grants IS
  'The grant ceiling, as a constraint rather than as application code, now measured on effective spend (successors_used - successors_stranded). It is the backstop if the ceiling test inside swarm.agent_tokens_successor_fence() ever races; the two must state the same arithmetic or the backstop is testing a different rule than the check it backs.';

-- ---------------------------------------------------------------------------
-- The guard learns about the second counter.
-- ---------------------------------------------------------------------------

-- Copied verbatim from 20260728000002 with ONE addition: the monotonicity rule
-- for successors_stranded. Everything else - the DELETE refusal, the
-- immutability list, the counter rewind, the unrevoke refusal - is byte-for-byte
-- the same, so this replacement removes no guarantee.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_spend_or_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A distinct string from the widening refusal below: they are different
    -- refusals and the audit log should not have to guess which one happened.
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNDELETABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.max_successors IS DISTINCT FROM OLD.max_successors
    OR NEW.horizon_expires_at IS DISTINCT FROM OLD.horizon_expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  -- The counter is monotone. A decrement would be a free successor.
  IF NEW.successors_used < OLD.successors_used THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_COUNTER_REWOUND' USING ERRCODE = '55000';
  END IF;

  -- The stranded counter is monotone for the same reason: it is subtracted
  -- from successors_used to get the effective spend, so winding it UP is the
  -- free successor, and winding it DOWN would retroactively exhaust a grant
  -- that had already been credited. Both directions are refused by requiring
  -- monotonicity here and bounding it by successors_used in a CHECK.
  IF NEW.successors_stranded < OLD.successors_stranded THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_STRANDED_REWOUND' USING ERRCODE = '55000';
  END IF;

  -- Revocation is one-way. Section 2.3: recovery from revocation is
  -- cause-specific (interactive login, restored membership, deliberate rejoin)
  -- and is never "unset the flag".
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNREVOKE' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_spend_or_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The fence tests effective spend.
-- ---------------------------------------------------------------------------

-- Copied verbatim from 20260728000002 with ONE line changed: the ceiling test
-- becomes `successors_used - successors_stranded >= max_successors`. The whole
-- identity / liveness / attenuation / spend sequence, the FOR SHARE lock, the
-- lock-order note and every distinct refusal string are unchanged. Verified by
-- diffing the two function bodies: exactly one line differs.
--
-- It is restated in full rather than patched because PostgreSQL has no way to
-- amend a function body in place; CREATE OR REPLACE takes the whole thing.
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
  -- issued_at is pinned for the same reason renewal_grants.created_at is: the
  -- 8h TTL ceiling below measures from it, and a ceiling measured from a value
  -- the caller supplied is not a ceiling.
  NEW.issued_at := statement_timestamp();

  -- FOR SHARE, not a bare SELECT. Without the lock a concurrent transaction can
  -- revoke the predecessor between this read and the INSERT, and the successor
  -- outlives the revocation it was supposed to be refused by.
  SELECT * INTO pred
  FROM swarm.agent_tokens
  WHERE token_id = NEW.predecessor_token_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE = '55000';
  END IF;

  -- ---- Identity: server-derived, never caller-selected. -------------------
  -- The spec's phrase is "no caller-selected target fields are accepted". The
  -- wire refuses to READ such fields; this refuses to STORE a row where they
  -- differ, which is the same sentence said in a place a wire bug cannot reach.
  IF NEW.principal_id IS DISTINCT FROM pred.principal_id
    OR NEW.run_id IS DISTINCT FROM pred.run_id
    OR NEW.task_id IS DISTINCT FROM pred.task_id
    OR NEW.epoch IS DISTINCT FROM pred.epoch
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TARGET_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF NEW.lineage_id IS DISTINCT FROM pred.lineage_id THEN
    -- A successor on a fresh lineage would be a laundering step: it would shed
    -- every lineage and family tombstone aimed at its ancestors.
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF pred.renewal_grant_id IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_UNGRANTED_PREDECESSOR' USING ERRCODE = '55000';
  END IF;

  IF NEW.renewal_grant_id IS DISTINCT FROM pred.renewal_grant_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISMATCH' USING ERRCODE = '55000';
  END IF;

  -- ---- Liveness of the predecessor. ---------------------------------------
  IF pred.revoked_at IS NOT NULL THEN
    -- "an individually-revoked worker can never be resurrected by renewal".
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF pred.expires_at <= statement_timestamp() THEN
    -- Renewal is a chain of LIVE tokens. Allowing an expired predecessor to
    -- renew would make expiry advisory and hand any leaked historical token an
    -- unlimited second life.
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_EXPIRED' USING ERRCODE = '55000';
  END IF;

  IF pred.surrender_only THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_SURRENDERED' USING ERRCODE = '55000';
  END IF;

  -- ---- Liveness of everything the predecessor hangs from. -----------------
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

  -- ---- The lineage-wide tombstone probe, fail-closed. ---------------------
  -- Same kinds agent-auth checks per command, plus 'renewal_grant'. The row
  -- constructor form uses the (kind, target_id) PRIMARY KEY. Checking here as
  -- well as at command time is the "on every renewal AND every command" the
  -- spec asks for: a tombstone written one second before this INSERT must stop
  -- the successor being created at all, not merely stop it being used.
  IF EXISTS (
    SELECT 1
    FROM swarm.revocation_tombstones AS t
    WHERE (t.kind, t.target_id) IN (
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

  -- ---- Attenuation, measured against the PREDECESSOR. ---------------------
  -- Not against the human's rights. That inversion was the blocking finding
  -- that produced this design (section 11 refactor ledger): measuring against
  -- the human turns every narrow worker token into a ladder up to the human's
  -- full scope set.
  --
  -- jsonb @> on two arrays is set containment, so this reads exactly as
  -- "predecessor scopes are a superset of successor scopes" - equal is allowed,
  -- narrower is allowed, one extra element is not.
  IF jsonb_typeof(NEW.scopes) <> 'array' OR jsonb_typeof(pred.scopes) <> 'array' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPES_MALFORMED' USING ERRCODE = '55000';
  END IF;

  IF NOT (pred.scopes @> NEW.scopes) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPE_WIDENED' USING ERRCODE = '55000';
  END IF;

  -- surrender_only needs no check of its own: setting it on the successor is a
  -- narrowing and is allowed, and the widening direction cannot arise because a
  -- surrender_only predecessor is refused outright above.

  -- ---- The grant: live, inside its horizon, and not spent. ----------------
  -- FOR UPDATE serialises concurrent renewals against the same grant, which is
  -- what makes the counter a real budget rather than a racy one.
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

  IF grant_row.horizon_expires_at <= statement_timestamp() THEN
    -- The periodic human checkpoint. This is the refusal a long-running fleet
    -- is SUPPOSED to hit every 30 days.
    RAISE EXCEPTION 'SWARM_RENEWAL_HORIZON_REACHED' USING ERRCODE = '55000';
  END IF;

  IF grant_row.successors_used - grant_row.successors_stranded >= grant_row.max_successors THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_EXHAUSTED' USING ERRCODE = '55000';
  END IF;

  -- ---- The successor's own lifetime. --------------------------------------
  IF NEW.expires_at <= NEW.issued_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_INVALID' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at > NEW.issued_at + interval '8 hours' THEN
    -- The 8h hard maximum, unchanged and now unavoidable on this path. Scoped
    -- to successors on purpose: a table-wide CHECK would also re-judge every
    -- row the human mint path and its fixtures have already written, and this
    -- migration does not get to change that path.
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_EXCEEDED' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at > grant_row.horizon_expires_at THEN
    -- Without this the horizon is trivially escapable: renew at 29 days 23
    -- hours and hold a valid token for 8 hours past the checkpoint that was
    -- supposed to require a human.
    RAISE EXCEPTION 'SWARM_RENEWAL_BEYOND_HORIZON' USING ERRCODE = '55000';
  END IF;

  -- LOCK ORDER, stated because it is the one place this file can lose a race.
  -- The fence locks the predecessor token and then the grant; the revocation
  -- cascade in (5) locks the grant and then its tokens. A renewal running
  -- against a revocation OF THE SAME GRANT can therefore deadlock, and
  -- PostgreSQL will abort one of the two with 40P01. Both outcomes are safe and
  -- neither is silent: if the renewal loses, no successor exists and the retry
  -- is refused with SWARM_RENEWAL_GRANT_REVOKED; if the revocation loses, the
  -- human's revoke errors and is retried. The race resolves toward refusal,
  -- which is the direction section 0 requires.

  -- ---- Spend. -------------------------------------------------------------
  -- Inside the trigger, so issuance and accounting are the same statement.
  -- renewal_grants_successors_bounded is the backstop if this ever races.
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_tokens_successor_fence() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_successor_fence() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_successor_fence() IS
  'Section 2.3 renewal fence, as a constraint rather than as application code: a successor row may only be equal-or-narrower than its predecessor, may not outlive its grant horizon, is refused if any tombstone touches its lineage, and spends exactly one of the grant successors in the same statement that creates it. The spend is tested against EFFECTIVE usage (successors_used - successors_stranded) so that a successor whose response was lost, and which therefore reached nobody, does not consume budget.';

-- ---------------------------------------------------------------------------
-- Privileges the new column needs, measured rather than believed.
-- ---------------------------------------------------------------------------

-- No new GRANT is issued: swarm_command already holds UPDATE on
-- swarm.renewal_grants table-wide and a new column inherits that. The point of
-- this block is to make that inheritance a MEASUREMENT rather than an
-- assumption, and to prove the same inheritance did not reach anon.
--
-- The anon arm is the positive control. If both arms answered the same way the
-- probe would be measuring nothing and its silence would mean nothing.
DO $$
BEGIN
  IF NOT has_column_privilege(
    'swarm_command', 'swarm.renewal_grants', 'successors_stranded', 'UPDATE'
  ) THEN
    RAISE EXCEPTION
      'swarm_command cannot UPDATE swarm.renewal_grants.successors_stranded; the table-level grant did not reach the new column'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    IF has_column_privilege(
      'anon', 'swarm.renewal_grants', 'successors_stranded', 'SELECT'
    ) THEN
      RAISE EXCEPTION
        'anon can read swarm.renewal_grants.successors_stranded; the new column leaked past the PostgREST deny-by-default'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION
      'role anon does not exist, so the negative arm of this privilege probe cannot fail and the positive arm proves nothing'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Verification: exercise the new arithmetic, do not merely inspect it.
-- ---------------------------------------------------------------------------

-- Catalogue checks first, then a LIVE round trip against a throwaway grant.
-- Reading the constraint text proves the migration wrote what it meant to
-- write; only executing an UPDATE proves the trigger and the CHECK agree with
-- it. The transaction is rolled back to a savepoint so this leaves nothing
-- behind.
DO $$
DECLARE
  bounded_src text;
  fence_src text;
  guard_src text;
  col_default text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO bounded_src
  FROM pg_catalog.pg_constraint
  WHERE conname = 'renewal_grants_successors_bounded'
    AND conrelid = 'swarm.renewal_grants'::regclass;

  IF bounded_src IS NULL THEN
    RAISE EXCEPTION 'renewal_grants_successors_bounded is missing after this migration'
      USING ERRCODE = '55000';
  END IF;
  IF position('successors_stranded' IN bounded_src) = 0 THEN
    RAISE EXCEPTION
      'renewal_grants_successors_bounded still caps raw spend, not effective spend: %', bounded_src
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO fence_src
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'swarm' AND p.proname = 'agent_tokens_successor_fence';

  IF fence_src IS NULL OR position('successors_stranded' IN fence_src) = 0 THEN
    RAISE EXCEPTION
      'agent_tokens_successor_fence() does not mention successors_stranded; its ceiling test still disagrees with the constraint above'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO guard_src
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'swarm' AND p.proname = 'renewal_grants_spend_or_revoke_only';

  IF guard_src IS NULL OR position('SWARM_RENEWAL_STRANDED_REWOUND' IN guard_src) = 0 THEN
    RAISE EXCEPTION
      'renewal_grants_spend_or_revoke_only() does not refuse a stranded-counter rewind; the credit is not monotone'
      USING ERRCODE = '55000';
  END IF;

  -- The positive control for the two probes above: the SAME position() test,
  -- run against the counter-rewind string that has been in the guard since
  -- 20260728000002. It must be found. If it were not, position() would be
  -- returning 0 for everything and the two silences above would prove nothing.
  IF position('SWARM_RENEWAL_COUNTER_REWOUND' IN guard_src) = 0 THEN
    RAISE EXCEPTION
      'the pre-existing SWARM_RENEWAL_COUNTER_REWOUND refusal is not in the guard body; this probe cannot distinguish anything'
      USING ERRCODE = '55000';
  END IF;

  SELECT a.atthasdef INTO col_default
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'swarm.renewal_grants'::regclass
    AND a.attname = 'successors_stranded'
    AND NOT a.attisdropped;

  IF col_default IS NULL THEN
    RAISE EXCEPTION 'swarm.renewal_grants.successors_stranded was not created'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- The live round trip. Every arm is capable of failing; that is the only
-- reason the block's silence is worth anything.
DO $$
DECLARE
  g uuid;
  ws uuid;
  pr uuid;
  rn uuid;
  usr uuid;
  refused boolean;
BEGIN
  -- Borrow any existing (workspace, principal, run, user) tuple rather than
  -- fabricating one: renewal_grants is pinned to the principal by composite FK,
  -- so an invented row would fail the FK and this block would report a
  -- constraint failure that has nothing to do with what it is testing.
  SELECT g2.workspace_id, g2.principal_id, g2.run_id, g2.created_by
    INTO ws, pr, rn, usr
  FROM swarm.renewal_grants AS g2
  LIMIT 1;

  IF ws IS NULL THEN
    -- Nothing to borrow on a fresh database. Say so rather than passing
    -- silently: a check that was skipped is not a check that succeeded.
    RAISE NOTICE 'no existing renewal_grants row to model a probe on; live arithmetic check SKIPPED (catalogue checks above still ran)';
    RETURN;
  END IF;

  g := gen_random_uuid();
  INSERT INTO swarm.renewal_grants (
    renewal_grant_id, workspace_id, principal_id, run_id,
    max_successors, successors_used, successors_stranded,
    horizon_expires_at, created_by
  ) VALUES (
    g, ws, pr, rn, 1, 1, 0, statement_timestamp() + interval '1 day', usr
  );

  -- (a) At the ceiling with nothing stranded, effective spend is 1 of 1.
  --     Raising successors_used must be refused by the bound.
  BEGIN
    refused := false;
    UPDATE swarm.renewal_grants SET successors_used = 2 WHERE renewal_grant_id = g;
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'effective-spend ceiling did not refuse spending past max_successors'
      USING ERRCODE = '55000';
  END IF;

  -- (b) Crediting a stranded successor makes room for exactly one more.
  UPDATE swarm.renewal_grants SET successors_stranded = 1 WHERE renewal_grant_id = g;
  UPDATE swarm.renewal_grants SET successors_used = 2 WHERE renewal_grant_id = g;

  -- (c) ...and no more than one. Effective spend is 1 of 1 again.
  BEGIN
    refused := false;
    UPDATE swarm.renewal_grants SET successors_used = 3 WHERE renewal_grant_id = g;
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'crediting one stranded successor made room for more than one replacement'
      USING ERRCODE = '55000';
  END IF;

  -- (d) The credit cannot exceed the spend.
  BEGIN
    refused := false;
    UPDATE swarm.renewal_grants SET successors_stranded = 99 WHERE renewal_grant_id = g;
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'successors_stranded was allowed to exceed successors_used; unlimited headroom is manufacturable'
      USING ERRCODE = '55000';
  END IF;

  -- (e) The credit is monotone.
  --
  -- Caught by SQLSTATE, not by the `raise_exception` condition name. The guard
  -- raises with `USING ERRCODE = '55000'` (object_not_in_prerequisite_state),
  -- and `raise_exception` is P0001 — the code a bare RAISE would have used. A
  -- handler naming the wrong condition does not fail safe: the exception escapes
  -- and aborts the migration, which is how this was found.
  BEGIN
    refused := false;
    UPDATE swarm.renewal_grants SET successors_stranded = 0 WHERE renewal_grant_id = g;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'successors_stranded was allowed to decrease; the credit is not monotone'
      USING ERRCODE = '55000';
  END IF;

  -- Undo. DELETE is refused by the guard on purpose, so the probe row is
  -- removed with the trigger disabled for this transaction only.
  ALTER TABLE swarm.renewal_grants DISABLE TRIGGER renewal_grants_spend_or_revoke_only;
  DELETE FROM swarm.renewal_grants WHERE renewal_grant_id = g;
  ALTER TABLE swarm.renewal_grants ENABLE TRIGGER renewal_grants_spend_or_revoke_only;
END
$$;

-- ---------------------------------------------------------------------------
-- What this migration does NOT do.
-- ---------------------------------------------------------------------------
--
--  * It does not write successors_stranded. The command function's discard path
--    does that, in the same transaction that revokes the stranded successor and
--    writes its tombstone. Until that lands this column stays 0 and the
--    arithmetic above is identical to the arithmetic it replaced.
--
--  * It does not rate-limit renewal. A caller that discards responses in a loop
--    nets zero spend by design (see the header). If that ever needs bounding it
--    belongs with the other spend ceilings in the command function, measured
--    against the audit rows the discard path already writes - not here.
