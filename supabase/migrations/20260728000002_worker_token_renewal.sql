-- Worker-token renewal: the schema side of the fenced SUCCESSOR operation
-- (spec section 2.3, "Worker-token renewal is a fenced SUCCESSOR operation, not
-- a mint"). Additive only: no applied migration is edited, and no existing
-- object is dropped or replaced.
--
-- WHAT PROBLEM THIS SOLVES.
--
-- Agent tokens default to a 1h TTL with an 8h hard maximum and there is no
-- renewal path, so 8h is not a cap with renewal behind it, it is a WALL: the
-- agent stops and a human re-mints by hand. The tempting fix - a longer TTL -
-- is the one the spec explicitly refuses, because a month-long bearer token on
-- a developer machine is a worse trade than an hourly successor chain.
--
-- swarm.renewal_grants has existed since 20260723000001 with SEVEN COLUMNS AND
-- NO WRITER. Nothing in the command function, the protocol, the CLI or the
-- client reads or writes it. This migration turns that placeholder into a table
-- that can actually authorise a successor, and - more to the point - one that
-- ENFORCES the section 2.3 fence in PostgreSQL rather than in TypeScript.
--
-- WHAT IS ENFORCED HERE, AND WHY IT IS HERE AND NOT IN DENO.
--
-- Section 2.3 requires that renewal "server-derives the immutable principal,
-- run, task, epoch, and scopes from the active predecessor token" and that the
-- successor be "exactly-equal-or-narrower than the predecessor". Every one of
-- those words is an invariant over two rows of swarm.agent_tokens, which makes
-- it expressible as a constraint. Expressed as a constraint it survives a bug
-- in the edge function, a second writer added later, and a hand-run UPDATE at a
-- psql prompt. Expressed only in Deno it survives none of those.
--
-- So: the successor fence below refuses an INSERT of a successor row that names
-- a different principal, run, task, epoch or lineage than its predecessor, that
-- carries a scope the predecessor did not have, that outlives the renewal
-- horizon, or whose lineage carries a revocation tombstone. It also performs
-- the grant counter increment ITSELF, so "issue a successor" and "spend one of
-- the grant's successors" cannot come apart - there is no code path that can
-- forget the second half, because there is no second half.
--
-- WHAT IS DELIBERATELY NOT HERE. The distinct successor endpoint, the refusal
-- of caller-selected target fields at the wire, the audit row per refusal, the
-- lease/epoch currency check, and the renewal-horizon and max_successors
-- DEFAULTS (30 days / 90 days / 800) live in the command function and the
-- protocol. This file holds only what a database can hold: the ceilings, the
-- derivation equalities, the counter, and the revocation cascade.

-- ---------------------------------------------------------------------------
-- (0) Refuse to upgrade a table someone has started writing behind our back.
-- ---------------------------------------------------------------------------

-- The columns added below are NOT NULL and are backfilled by derivation from
-- swarm.agent_principals. That derivation is only honest for rows written by a
-- writer that does not exist yet. revoked_by in particular CANNOT be derived -
-- attribution is not guessable - so a pre-existing revoked row would force this
-- migration to either fabricate a human's name against a revocation or leave
-- the attribution CHECK off. It does neither: it stops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm.renewal_grants WHERE revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'swarm.renewal_grants already holds revoked rows; revoked_by cannot be backfilled without fabricating attribution'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (1) Composite keys that let the new foreign keys pin tenancy and ownership.
-- ---------------------------------------------------------------------------

-- Both of these are unique for free (the first column is already the PRIMARY
-- KEY of its table). They exist so a composite FK can carry the second column,
-- which is the same trick capability_urls uses with streams_stream_workspace:
-- the tenant pin becomes a foreign key rather than an application check.
CREATE UNIQUE INDEX IF NOT EXISTS agent_principals_principal_workspace
  ON swarm.agent_principals (principal_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_run_principal
  ON swarm.agent_runs (run_id, principal_id);

-- ---------------------------------------------------------------------------
-- (2) swarm.renewal_grants gains the columns a successor path actually needs.
-- ---------------------------------------------------------------------------

ALTER TABLE swarm.renewal_grants
  ADD COLUMN IF NOT EXISTS workspace_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS revoked_by uuid;

-- Derivation, not invention: a grant's tenant and its authorising human are
-- both already determined by its principal. Guarded so a re-run is a no-op.
UPDATE swarm.renewal_grants AS g
SET workspace_id = p.workspace_id
FROM swarm.agent_principals AS p
WHERE p.principal_id = g.principal_id
  AND g.workspace_id IS NULL;

UPDATE swarm.renewal_grants AS g
SET created_by = p.owner_user_id
FROM swarm.agent_principals AS p
WHERE p.principal_id = g.principal_id
  AND g.created_by IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm.renewal_grants
    WHERE workspace_id IS NULL OR created_by IS NULL
  ) THEN
    RAISE EXCEPTION
      'swarm.renewal_grants holds rows whose principal_id names no agent principal; refusing to guess their tenant'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE swarm.renewal_grants
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;

-- Foreign keys. PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so each one is
-- guarded by name exactly as 20260723000001 guards its policies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_principal_workspace'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- THE TENANCY GUARANTEE, at the database: a grant cannot name a principal
    -- in one workspace while claiming another. Also makes principal_id a real
    -- reference, which it was not before.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_principal_workspace
      FOREIGN KEY (principal_id, workspace_id)
      REFERENCES swarm.agent_principals (principal_id, workspace_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_run_principal'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- A grant is bounded to one principal AND one run (section 2.3, "a bounded
    -- renewal grant created at human join/spawn"). Without the composite form
    -- a grant could name principal A and run B and authorise renewal of a run
    -- its principal never started.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_run_principal
      FOREIGN KEY (run_id, principal_id)
      REFERENCES swarm.agent_runs (run_id, principal_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_created_by_fkey'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES swarm.users (user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_revoked_by_fkey'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_revoked_by_fkey
      FOREIGN KEY (revoked_by) REFERENCES swarm.users (user_id);
  END IF;
END
$$;

-- The invariants. Each of these is the database half of a rule that also lives
-- in Deno; the point is that the Deno half can be wrong without the rule being
-- wrong.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_horizon_positive'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_horizon_positive
      CHECK (horizon_expires_at > created_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_horizon_ceiling'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- The 90-day ceiling, enforced by the DATABASE and not only by
    -- RENEWAL_HORIZON_MAX_MS in Deno - the same discipline capability_urls
    -- applies to its 7-day TTL. A server bug cannot create a grant that
    -- auto-renews a run for a year without a human ever looking at it again.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_horizon_ceiling
      CHECK (horizon_expires_at <= created_at + interval '90 days');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_successors_bounded'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- successors_used <= max_successors as a CONSTRAINT, not as an if() in
    -- application code. The counter is incremented by the successor fence
    -- below, so this is what makes "spend one" fail closed at the boundary
    -- even under concurrent renewal.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_successors_bounded
      CHECK (successors_used >= 0 AND successors_used <= max_successors);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_max_successors_positive'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- No upper bound on max_successors is written here on purpose: the 800
    -- default is a rate judgement (about 1/hour for 30 days, with headroom),
    -- not a security boundary, and the security boundary is the horizon. A
    -- ceiling nobody measured would be a number wearing the costume of a limit.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_max_successors_positive
      CHECK (max_successors > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_revoked_pair'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    -- Revoking a grant kills every descendant worker token (see the cascade
    -- below). An act with that blast radius is never unattributed.
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_revoked_pair
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));
  END IF;
END
$$;

COMMENT ON TABLE swarm.renewal_grants IS
  'Section 2.3 bounded renewal grant, created at human join/spawn. It is the ONLY thing that authorises a successor token: swarm.agent_tokens_successor_fence() derives the grant from the predecessor row, so no caller ever names one. Existed unwritten since 20260723000001; 20260728000002 gave it the tenant pin, the horizon ceiling, the counter bound and the revocation cascade.';

COMMENT ON COLUMN swarm.renewal_grants.workspace_id IS
  'The tenant, pinned by composite FK to the principal rather than trusted from the caller.';
COMMENT ON COLUMN swarm.renewal_grants.max_successors IS
  'How many successor tokens this grant may ever authorise. Default 800 is chosen in Deno (about 1/hour for 30 days with headroom); the database only enforces that it is positive and that successors_used cannot pass it.';
COMMENT ON COLUMN swarm.renewal_grants.successors_used IS
  'Incremented by swarm.agent_tokens_successor_fence() inside the same statement that inserts the successor. Never incremented by application code - if it were, an issued-but-uncounted successor would be one lost transaction away.';
COMMENT ON COLUMN swarm.renewal_grants.horizon_expires_at IS
  'The continuous-renewal horizon (section 2.3): after this instant the run does not auto-renew and a human must reauthorise. Default 30 days, ceiling 90 days - the ceiling is the CHECK beside this column, measured from a created_at pinned to the server clock, not from a value the inserting statement chose.';
COMMENT ON COLUMN swarm.renewal_grants.revoked_at IS
  'Setting this is lineage-wide and irreversible: the cascade trigger tombstones the grant and revokes every token issued under it. It cannot be cleared again.';

-- Lookup for "does this run have a live grant" (the join/spawn path, and the
-- operator listing). Partial, because a revoked grant is never a candidate.
CREATE INDEX IF NOT EXISTS renewal_grants_live_by_run
  ON swarm.renewal_grants (run_id)
  WHERE revoked_at IS NULL;

-- Bulk revoke when a principal is revoked, and the per-principal grant listing.
CREATE INDEX IF NOT EXISTS renewal_grants_by_principal
  ON swarm.renewal_grants (principal_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- (3) created_at is the server's clock, not the caller's.
-- ---------------------------------------------------------------------------

-- Exactly the hole 20260727000002 found in the capability-URL TTL ceiling, and
-- it is worth restating because it is not obvious: a CHECK of the form
-- "horizon_expires_at <= created_at + interval '90 days'" is SELF-REFERENTIAL
-- if the inserting statement supplies created_at. Name created_at far enough in
-- the future and a grant that auto-renews for a decade satisfies every
-- constraint on the table. PostgreSQL refuses non-IMMUTABLE functions inside a
-- CHECK, so statement_timestamp() cannot appear in one; the zero point is
-- pinned here instead.
--
-- A BEFORE trigger cannot tell "the DEFAULT filled this in" from "the INSERT
-- named this column", so the only safe reading of a supplied value is to
-- discard it unconditionally.
--
-- statement_timestamp(), NOT clock_timestamp(): a grant minted at exactly the
-- 90-day maximum sits exactly on the ceiling, and both sides see the same
-- instant only because statement_timestamp() is fixed for the whole statement
-- including its triggers.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_server_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_server_clock() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_server_clock() FROM PUBLIC;

COMMENT ON FUNCTION swarm.renewal_grants_server_clock() IS
  'Pins created_at so the 90-day horizon ceiling measures from something the inserting statement cannot choose. Without it the ceiling is self-referential and a caller-supplied created_at buys an unbounded renewal horizon.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'renewal_grants_server_clock'
      AND tgrelid = 'swarm.renewal_grants'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER renewal_grants_server_clock
      BEFORE INSERT ON swarm.renewal_grants
      FOR EACH ROW EXECUTE FUNCTION swarm.renewal_grants_server_clock();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (4) A grant may be spent and revoked. Nothing else.
-- ---------------------------------------------------------------------------

-- swarm.prevent_append_only_mutation() is not usable here: spending a successor
-- and revoking both need UPDATE. What must not happen is a grant being widened
-- or re-pointed after issue - raising max_successors, pushing horizon_expires_at
-- out, moving the grant to another run, or winding successors_used back down -
-- any of which would turn "bounded" into a suggestion. DELETE is refused so a
-- revoked grant cannot become a never-existed one.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'renewal_grants_spend_or_revoke_only'
      AND tgrelid = 'swarm.renewal_grants'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER renewal_grants_spend_or_revoke_only
      BEFORE UPDATE OR DELETE ON swarm.renewal_grants
      FOR EACH ROW EXECUTE FUNCTION swarm.renewal_grants_spend_or_revoke_only();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (5) Revoking a grant revokes its descendants. In the database, on the spot.
-- ---------------------------------------------------------------------------

-- Section 2.3: "revoking a token, family, or device revokes all descendant
-- workers". The existing mechanism for that is swarm.revocation_tombstones,
-- which supabase/functions/_shared/agent-auth.ts already probes on EVERY
-- command for the kinds token / principal / run / device / membership /
-- lineage / family. This extends that mechanism rather than inventing one
-- beside it, in two ways:
--
--   1. it writes a tombstone of the NEW kind 'renewal_grant', so a caller that
--      knows the grant id can be refused by the same probe; and
--   2. it stamps revoked_at on every token issued under the grant, which makes
--      the descendants unusable through the token_revoked_at check that
--      agent-auth ALREADY performs - no edge-function change is required for
--      grant revocation to take effect at command time.
--
-- (2) is the load-bearing half. A tombstone kind nothing queries yet would be a
-- second swarm.renewal_grants: a row written by hope.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_revoke_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by)
  VALUES ('renewal_grant', NEW.renewal_grant_id, NEW.revoked_by)
  ON CONFLICT (kind, target_id) DO NOTHING;

  UPDATE swarm.agent_tokens
  SET revoked_at = statement_timestamp()
  WHERE renewal_grant_id = NEW.renewal_grant_id
    AND revoked_at IS NULL;

  RETURN NULL;
END
$$;

ALTER FUNCTION swarm.renewal_grants_revoke_cascade() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_revoke_cascade() FROM PUBLIC;

COMMENT ON FUNCTION swarm.renewal_grants_revoke_cascade() IS
  'Makes grant revocation lineage-wide without asking any caller to remember to do it: tombstones the grant and revokes every token issued under it, so the descendants fail the revocation check agent-auth already runs on every command.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'renewal_grants_revoke_cascade'
      AND tgrelid = 'swarm.renewal_grants'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER renewal_grants_revoke_cascade
      AFTER UPDATE ON swarm.renewal_grants
      FOR EACH ROW
      WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
      EXECUTE FUNCTION swarm.renewal_grants_revoke_cascade();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (6) swarm.agent_tokens: the lineage columns become real.
-- ---------------------------------------------------------------------------

-- predecessor_token_id, renewal_grant_id and lineage_id have existed since
-- 20260723000001. predecessor_token_id already references agent_tokens;
-- renewal_grant_id referenced nothing at all, which is why a token could name a
-- grant that does not exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'agent_tokens_renewal_grant_fkey'
      AND conrelid = 'swarm.agent_tokens'::regclass
  ) THEN
    ALTER TABLE swarm.agent_tokens
      ADD CONSTRAINT agent_tokens_renewal_grant_fkey
      FOREIGN KEY (renewal_grant_id)
      REFERENCES swarm.renewal_grants (renewal_grant_id);
  END IF;
END
$$;

-- THIS INDEX IS THE CAS, and calling it an index undersells it.
--
-- Section 9: "concurrent refresh uses CAS". A worker with two threads, or a
-- worker retrying a renewal whose response it never saw, must not end up with
-- two live successors to one predecessor - that is a lineage fork, and it
-- doubles the live credentials while spending one grant slot. UNIQUE on
-- predecessor_token_id makes the second insert fail with 23505 instead, so the
-- compare-and-swap is the database's, not the caller's.
--
-- It is also the parent -> child edge for walking a lineage forwards.
-- (agent_tokens_by_lineage, from 20260723000001, walks it as a set.)
CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_one_successor_per_predecessor
  ON swarm.agent_tokens (predecessor_token_id)
  WHERE predecessor_token_id IS NOT NULL;

-- The revocation cascade's UPDATE, and "how many successors has this grant
-- really issued" - which is the audit answer, as opposed to successors_used,
-- which is the counter's answer. They should agree; being able to check is the
-- point.
CREATE INDEX IF NOT EXISTS agent_tokens_by_renewal_grant
  ON swarm.agent_tokens (renewal_grant_id)
  WHERE renewal_grant_id IS NOT NULL;

COMMENT ON COLUMN swarm.agent_tokens.predecessor_token_id IS
  'Set on successor tokens only. Its presence is what puts an INSERT through swarm.agent_tokens_successor_fence(); a root token minted by a human leaves it NULL and is unaffected.';
COMMENT ON COLUMN swarm.agent_tokens.renewal_grant_id IS
  'The grant that authorised this token. On a successor it is copied from the predecessor by the fence and may not differ - that is what stops a compromised worker renewing under a more generous grant.';
COMMENT ON COLUMN swarm.agent_tokens.lineage_id IS
  'Constant along a renewal chain: a successor inherits its predecessor lineage_id, enforced by the fence. Revoking the lineage (tombstone kind lineage or family) therefore reaches every descendant, however many renewals deep.';

-- ---------------------------------------------------------------------------
-- (7) The successor fence.
-- ---------------------------------------------------------------------------

-- Section 2.3, in one function. Fires only when predecessor_token_id IS NOT
-- NULL, so nothing about the existing human mint path changes.
--
-- Every refusal raises a DISTINCT message string. That is not decoration: the
-- command function maps each to its own audit reason, and a shared string would
-- collapse "your grant is exhausted" and "your lineage was revoked" into one
-- indistinguishable event in the audit log.
--
-- The order of checks is deliberate - identity, then liveness, then attenuation,
-- then spend - so that the most specific true statement is the one reported.
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

  IF grant_row.successors_used >= grant_row.max_successors THEN
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
  'Section 2.3 renewal fence, as a constraint rather than as application code: a successor row may only be equal-or-narrower than its predecessor, may not outlive its grant horizon, is refused if any tombstone touches its lineage, and spends exactly one of the grant successors in the same statement that creates it.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'agent_tokens_successor_fence'
      AND tgrelid = 'swarm.agent_tokens'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER agent_tokens_successor_fence
      BEFORE INSERT ON swarm.agent_tokens
      FOR EACH ROW
      WHEN (NEW.predecessor_token_id IS NOT NULL)
      EXECUTE FUNCTION swarm.agent_tokens_successor_fence();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (8) A revoked token stays revoked.
-- ---------------------------------------------------------------------------

-- The fence refuses to renew FROM a revoked predecessor. This closes the other
-- door: clearing revoked_at and renewing from a token that is now live again.
-- Narrow on purpose - it fires only on the NOT NULL -> NULL transition, so
-- surrender, revoke and every other UPDATE the command function performs on
-- this table are untouched.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_no_resurrection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'SWARM_TOKEN_UNREVOKE' USING ERRCODE = '55000';
END
$$;

ALTER FUNCTION swarm.agent_tokens_no_resurrection() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_no_resurrection() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'agent_tokens_no_resurrection'
      AND tgrelid = 'swarm.agent_tokens'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER agent_tokens_no_resurrection
      BEFORE UPDATE ON swarm.agent_tokens
      FOR EACH ROW
      WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
      EXECUTE FUNCTION swarm.agent_tokens_no_resurrection();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (9) RLS and the swarm_command policy, as every other authority table has it.
-- ---------------------------------------------------------------------------

-- 20260723000001 already enabled RLS on both tables and created swarm_command_all
-- on each. Both statements are re-asserted here rather than assumed: this
-- migration adds triggers that WRITE to these tables from inside other
-- statements, and a policy silently missing would surface as an unrelated
-- failure deep in the fence.
ALTER TABLE swarm.renewal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_tokens ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  authority_table text;
BEGIN
  FOREACH authority_table IN ARRAY ARRAY['renewal_grants', 'agent_tokens']
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS p
      JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE p.polname = 'swarm_command_all'
        AND n.nspname = 'swarm'
        AND c.relname = authority_table
    ) THEN
      EXECUTE format(
        'CREATE POLICY swarm_command_all ON swarm.%I AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true)',
        authority_table
      );
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- (10) The privileges the triggers need, asserted rather than assumed.
-- ---------------------------------------------------------------------------

-- NO NEW GRANT IS ISSUED BY THIS MIGRATION, and that is a claim worth checking
-- rather than believing. The triggers run with the privileges of whoever
-- inserts - swarm_command in production - and they touch four tables. If the
-- privilege matrix in 20260723000001 does not already cover them, the failure
-- must happen here at migrate time, not at 3am inside a renewal.
--
-- This is the positive-control shape the verification doctrine asks for: the
-- block is capable of failing, so its silence means something.
-- ONE PRIVILEGE PER CALL, and that is not style. has_table_privilege() given a
-- comma-separated list returns true if ANY of the listed privileges is held,
-- not all of them - so 'SELECT, UPDATE' against a role holding only SELECT
-- returns true and the check silently passes. A probe that cannot fail is
-- indistinguishable from one that passed.
DO $$
DECLARE
  required text[][] := ARRAY[
    ARRAY['swarm.renewal_grants', 'SELECT'],
    ARRAY['swarm.renewal_grants', 'UPDATE'],
    ARRAY['swarm.agent_tokens', 'SELECT'],
    ARRAY['swarm.agent_tokens', 'INSERT'],
    ARRAY['swarm.agent_tokens', 'UPDATE'],
    ARRAY['swarm.revocation_tombstones', 'INSERT'],
    ARRAY['swarm.agent_runs', 'SELECT'],
    ARRAY['swarm.agent_principals', 'SELECT'],
    ARRAY['swarm.devices', 'SELECT']
  ];
  i integer;
  missing text := '';
BEGIN
  FOR i IN 1 .. array_length(required, 1) LOOP
    IF NOT has_table_privilege('swarm_command', required[i][1], required[i][2]) THEN
      missing := missing || ' ' || required[i][1] || '(' || required[i][2] || ')';
    END IF;
  END LOOP;

  IF missing <> '' THEN
    RAISE EXCEPTION 'swarm_command lacks privileges the renewal triggers require:%', missing
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- What this migration does NOT do, written down so nobody assumes otherwise.
-- ---------------------------------------------------------------------------
--
--  * It does not create the successor endpoint. Nothing writes a row with
--    predecessor_token_id yet, so every trigger above is currently a fence
--    around a path that has no traffic. That is the intended state for this
--    lane; the command function is another lane's.
--  * It does not check lease or epoch CURRENCY. The fence proves the successor
--    names the same epoch as its predecessor; whether that epoch is still the
--    live one for the task is a read of swarm.leases the command function makes
--    with the request in hand.
--  * It does not write audit rows. Refusals here raise distinct message strings
--    for the command function to map to distinct audit reasons; the mapping and
--    the rows are that lane's.
--  * It adds tombstone kind 'renewal_grant'. The fence queries it. agent-auth
--    does not yet, so a grant revoked while a token is still inside its 1h TTL
--    is stopped by the descendant revoked_at stamp in (5), not by the tombstone.
--    Both are lineage-wide; only the second is instantaneous.
--  * It does not change the human mint path, the 1h default, or the 8h maximum.
