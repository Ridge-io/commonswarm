-- Pending successors: the schema side of moving supersession from ISSUE time to
-- FIRST-USE time. Additive only: no applied migration is edited, and the only
-- existing object replaced is one index, replaced by a narrower version of
-- itself inside this transaction.
--
-- WHAT PROBLEM THIS SOLVES.
--
-- 20260728000002 made a successor real at INSERT. The renewal command then
-- superseded the predecessor in the same transaction. That is correct right up
-- to the moment the HTTP response carrying the raw successor credential is
-- lost - a dropped connection, or a 5xx after commit. Then:
--
--   * the successor row exists and is live,
--   * the predecessor is already superseded,
--   * a renewal-grant successor slot is already spent,
--   * and the raw credential existed ONLY in that lost body.
--
-- The idempotency replay cannot help: renewalReplayFields deliberately stores
-- ids and expiry and never the secret, so a replay returns a body with no
-- agent_token and the client correctly refuses to invent one. Net: a live
-- successor nobody can reach, an agent that stops, and a human reauthorisation
-- caused by a network blip - the exact failure renewal exists to remove.
--
-- The fix is NOT to store the raw successor anywhere at rest. That trades a
-- bounded outage for an unbounded exposure: a live credential in a table read
-- on every replay. The secret keeps existing in exactly one response and
-- nowhere else.
--
-- Instead: a successor is PENDING until its first successful authentication.
-- Supersession of the predecessor moves to that moment. An unused pending
-- successor is disposable BY DEFINITION - nobody holds it, because holding it
-- is precisely what "used" means - so a renewal that finds one may discard it
-- and issue a fresh one. A network blip costs a retry, not a human.
--
-- WHAT IS HERE, AND WHAT IS NOT.
--
-- Here (design steps 1 and 3, plus the immutability rule they depend on):
-- the first_used_at column, the narrowing of the one-successor CAS index so a
-- REVOKED stranded successor stops holding the slot, and the rule that
-- first_used_at is written once by the authentication path and never again.
--
-- NOT here, and deliberately: the authentication-time UPDATE that stamps
-- first_used_at and supersedes the predecessor (design step 2), the
-- self-healing renewal that revokes a pending successor and reissues without
-- charging a second grant slot (step 4), and the refusal to renew FROM a
-- pending successor (step 5). Those are the agent-auth, command-function and
-- protocol lanes. This file holds only what a database can hold.

-- ---------------------------------------------------------------------------
-- (0) Refuse to narrow a guarantee that is not there to narrow.
-- ---------------------------------------------------------------------------

-- Section (3) below drops agent_tokens_one_successor_per_predecessor and
-- recreates it narrower. If that index were already missing, the drop would be
-- a silent no-op and the create would look like a success while in fact
-- INSTALLING the CAS for the first time - which would mean the broad guarantee
-- 20260728000002 claims had never actually held. Stop instead of guessing.
--
-- Uniqueness is asserted separately from existence on purpose: an index by that
-- name that is not unique is not a CAS, and "the name is present" is not the
-- measurement we want.
DO $$
DECLARE
  idx_oid oid;
  is_unique boolean;
BEGIN
  SELECT c.oid INTO idx_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relname = 'agent_tokens_one_successor_per_predecessor'
    AND n.nspname = 'swarm'
    AND c.relkind = 'i';

  IF idx_oid IS NULL THEN
    RAISE EXCEPTION
      'swarm.agent_tokens_one_successor_per_predecessor is absent; 20260728000002 is not applied, or something dropped the CAS. Refusing to create it here under the guise of narrowing it.'
      USING ERRCODE = '55000';
  END IF;

  SELECT i.indisunique INTO is_unique
  FROM pg_catalog.pg_index AS i
  WHERE i.indexrelid = idx_oid;

  IF NOT is_unique THEN
    RAISE EXCEPTION
      'swarm.agent_tokens_one_successor_per_predecessor exists but is not UNIQUE; it is not the CAS this migration is narrowing.'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (1) The column. NULL means PENDING.
-- ---------------------------------------------------------------------------

ALTER TABLE swarm.agent_tokens
  ADD COLUMN IF NOT EXISTS first_used_at timestamptz;

COMMENT ON COLUMN swarm.agent_tokens.first_used_at IS
  'NULL means PENDING: issued, but never successfully authenticated with, therefore held by nobody and safe to discard. The authentication path stamps it once, and the SAME statement supersedes the predecessor (expires_at = statement_timestamp() where token_id = this row predecessor_token_id) - so this column, not the moment of issue, is the supersession trigger. It is write-once: swarm.agent_tokens_first_use_immutable() refuses any later rewrite or clear, because a token that could un-use itself could reopen the predecessor/successor overlap window at will.';

-- A token cannot be used before it was issued. This is a table-wide CHECK,
-- which 20260728000002 explicitly avoided for the TTL ceiling because it would
-- have re-judged rows the human mint path had already written. That objection
-- does not apply here: the column is new, so every existing row holds NULL, and
-- NULL >= anything is NULL, which a CHECK passes. The constraint therefore
-- judges only rows written after this migration.
--
-- It is added VALIDATED rather than NOT VALID, which costs a full scan under
-- ACCESS EXCLUSIVE. That is the right trade at P3-1 dogfood volumes and it
-- avoids leaving a half-applied constraint for someone to finish later; revisit
-- it when this table is large enough for the scan to be a real outage. The
-- ADD COLUMN above is metadata-only - no default, so no rewrite.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'agent_tokens_first_use_after_issue'
      AND conrelid = 'swarm.agent_tokens'::regclass
  ) THEN
    ALTER TABLE swarm.agent_tokens
      ADD CONSTRAINT agent_tokens_first_use_after_issue
      CHECK (first_used_at IS NULL OR first_used_at >= issued_at);
  END IF;
END
$$;

COMMENT ON CONSTRAINT agent_tokens_first_use_after_issue ON swarm.agent_tokens IS
  'A first use that predates issuance is not a clock skew story worth accommodating; it is a writer bug, and the row it would produce is one whose pending window cannot be reasoned about.';

-- ---------------------------------------------------------------------------
-- (2) The CAS index becomes partial on LIVE rows.
-- ---------------------------------------------------------------------------

-- WHAT CHANGES, PRECISELY: the guarantee is not weakened, the row set it
-- ranges over is narrowed. Before: at most one successor row per predecessor,
-- for ever, revoked or not. After: at most one LIVE (revoked_at IS NULL)
-- successor row per predecessor.
--
-- WHY IT MUST CHANGE. Under the old predicate a stranded successor holds its
-- predecessor's slot permanently: revoking it does not release the slot, so the
-- self-healing reissue in design step 4 would collide with 23505 against a row
-- that is already dead. The whole recovery path is unreachable without this.
--
-- WHAT SURVIVES UNCHANGED. The concurrency argument in 20260728000002 - a
-- worker with two threads, or one retrying a renewal whose response it never
-- saw, must not end up with two LIVE successors to one predecessor, because
-- that is a lineage fork that doubles the live credentials while spending one
-- slot. Two concurrent inserts still both target revoked_at IS NULL rows, so
-- the second still fails with 23505 and the compare-and-swap is still the
-- database's rather than the caller's.
--
-- WHAT NO LONGER HOLDS, stated so nobody keeps relying on it. 20260728000002
-- also called this index "the parent -> child edge for walking a lineage
-- forwards", and that edge is no longer single-valued: a predecessor may now
-- have several historical successor rows, all revoked but one. Any forward walk
-- must filter revoked_at IS NULL, or use agent_tokens_by_lineage and treat the
-- lineage as the set it is.
--
-- The drop and the create are in ONE transaction, which is why this is not
-- CONCURRENTLY: a concurrent build cannot run inside a transaction block, and
-- outside one it would leave a window with no CAS at all. Narrowing can never
-- fail on existing data - the new predicate selects a subset of the rows the
-- old one already held unique - so the in-transaction lock is brief.
DO $$
DECLARE
  predicate text;
BEGIN
  SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid)
    INTO predicate
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relname = 'agent_tokens_one_successor_per_predecessor'
    AND n.nspname = 'swarm';

  -- Re-runnable: if the predicate already mentions revoked_at this migration
  -- has already done its work, and dropping the live CAS to rebuild an
  -- identical one would be churn against a table under load.
  IF predicate IS NULL OR position('revoked_at' IN predicate) = 0 THEN
    DROP INDEX swarm.agent_tokens_one_successor_per_predecessor;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_one_successor_per_predecessor
  ON swarm.agent_tokens (predecessor_token_id)
  WHERE predecessor_token_id IS NOT NULL AND revoked_at IS NULL;

COMMENT ON INDEX swarm.agent_tokens_one_successor_per_predecessor IS
  'The renewal CAS, narrowed to live rows: at most one successor per predecessor WHERE revoked_at IS NULL. A revoked stranded successor releases the slot so a renewal can reissue; a live one still forks nothing. It also serves the "does this predecessor already have a live successor, and is it pending?" lookup the self-healing renewal makes.';

-- ---------------------------------------------------------------------------
-- (3) first_used_at is write-once.
-- ---------------------------------------------------------------------------

-- Two refusals, two DISTINCT message strings, in the shape
-- swarm.agent_tokens_no_resurrection() established: the condition lives in the
-- trigger WHEN clause and the function body does nothing but raise. A shared
-- string would collapse "someone tried to un-use a token" and "someone minted a
-- token already marked used" into one indistinguishable audit event, and they
-- are different bugs with different blast radii.

-- (a) No rewrite, no clear. NULL -> value is the one permitted transition; it
-- is the authentication path stamping first use. value -> the same value is
-- also permitted, so a re-stamping UPDATE is idempotent rather than fatal.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_first_use_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'SWARM_TOKEN_FIRST_USE_IMMUTABLE' USING ERRCODE = '55000';
END
$$;

ALTER FUNCTION swarm.agent_tokens_first_use_immutable() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_first_use_immutable() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_first_use_immutable() IS
  'Clearing first_used_at would return a used token to PENDING, which would make it discardable by a renewal that a live worker is holding, and would reopen the bounded overlap window design step 5 requires to stay bounded. Moving it forward would relocate a supersession that has already happened. Neither is a legitimate operation, so neither is a permitted UPDATE.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'agent_tokens_first_use_immutable'
      AND tgrelid = 'swarm.agent_tokens'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER agent_tokens_first_use_immutable
      BEFORE UPDATE ON swarm.agent_tokens
      FOR EACH ROW
      WHEN (
        OLD.first_used_at IS NOT NULL
        AND NEW.first_used_at IS DISTINCT FROM OLD.first_used_at
      )
      EXECUTE FUNCTION swarm.agent_tokens_first_use_immutable();
  END IF;
END
$$;

-- (b) No token is born used. first_used_at is not a caller-supplied field and
-- no writer sets it at INSERT: it is stamped later, by the authentication path,
-- and that stamp is the whole recoverability story. A row inserted with it
-- already set would be a successor that skipped PENDING - unreachable by the
-- self-healing reissue in step 4, which refuses a USED successor with
-- predecessor_superseded, and immediately renewable in violation of step 5.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_first_use_not_preset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'SWARM_TOKEN_FIRST_USE_PRESET' USING ERRCODE = '55000';
END
$$;

ALTER FUNCTION swarm.agent_tokens_first_use_not_preset() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_first_use_not_preset() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_first_use_not_preset() IS
  'A token inserted with first_used_at already set would be born non-PENDING, which makes it permanently non-disposable and immediately renewable. Since nothing legitimately sets the column at INSERT, refusing it costs nothing and closes the only route by which write-once could be satisfied while still producing a used-at-birth token.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname = 'agent_tokens_first_use_not_preset'
      AND tgrelid = 'swarm.agent_tokens'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER agent_tokens_first_use_not_preset
      BEFORE INSERT ON swarm.agent_tokens
      FOR EACH ROW
      WHEN (NEW.first_used_at IS NOT NULL)
      EXECUTE FUNCTION swarm.agent_tokens_first_use_not_preset();
  END IF;
END
$$;

-- TRIGGER FIRING ORDER, named because it changes which refusal is REPORTED and
-- 20260728000002 explicitly cares about that. PostgreSQL fires BEFORE row
-- triggers in trigger-name order, so on this table it is now:
--
--   INSERT: agent_tokens_first_use_not_preset, then agent_tokens_successor_fence
--   UPDATE: agent_tokens_first_use_immutable, then agent_tokens_no_resurrection
--
-- Both new triggers therefore pre-empt the older one when both would fire. That
-- is acceptable and not a regression of the fence's "most specific true
-- statement" ordering, because both new conditions are properties of the NEW
-- row alone rather than of the predecessor relationship the fence reasons
-- about, and neither can be reached by anything a caller sends over the wire -
-- first_used_at is not a request field. Reaching either means our own writer
-- is wrong, and in that case naming the writer bug first is the more useful
-- report. Both paths still refuse.

-- A RESTORE CONSEQUENCE, worth knowing before someone hits it at 3am. Row
-- triggers fire on COPY, so a pg_restore of swarm.agent_tokens rows that carry
-- a non-NULL first_used_at will be refused by (b). That is correct for every
-- ordinary write and wrong only for a restore, where the fix is the usual one:
-- ALTER TABLE swarm.agent_tokens DISABLE TRIGGER agent_tokens_first_use_not_preset
-- around the load, and re-enable it after.

-- ---------------------------------------------------------------------------
-- (4) RLS and the swarm_command policy, re-asserted rather than assumed.
-- ---------------------------------------------------------------------------

-- 20260723000001 enabled RLS on this table and created swarm_command_all;
-- 20260728000002 re-asserted both for the same reason this does. A policy
-- silently missing would not surface here - it would surface as an
-- unauthenticated-looking failure inside the authentication path, which is the
-- worst possible place to debug it.
ALTER TABLE swarm.agent_tokens OWNER TO swarm_admin;
ALTER TABLE swarm.agent_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE p.polname = 'swarm_command_all'
      AND n.nspname = 'swarm'
      AND c.relname = 'agent_tokens'
  ) THEN
    CREATE POLICY swarm_command_all ON swarm.agent_tokens
      AS PERMISSIVE FOR ALL TO swarm_command
      USING (true) WITH CHECK (true);
  END IF;
END
$$;

-- Deny-by-default for the PostgREST roles is re-stated for the new column
-- specifically. The GRANTs in 20260723000001 are table-level, so a new column
-- inherits them - which is convenient for swarm_command and would be a hole for
-- anon/authenticated if they held anything on this table. They do not; (5)
-- measures that rather than asserting it.
REVOKE ALL ON swarm.agent_tokens FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- (5) The privileges the new column needs, measured rather than believed.
-- ---------------------------------------------------------------------------

-- NO NEW GRANT IS ISSUED BY THIS MIGRATION. swarm_command already holds
-- SELECT and INSERT, UPDATE on swarm.agent_tokens table-wide, and both callers
-- of loadAgentCredential() - the command and read edge functions - run under
-- SET LOCAL ROLE swarm_command, so the design-step-2 stamp is already
-- privileged. That is a claim, and this block is what makes it a measurement.
--
-- ONE PRIVILEGE PER CALL: has_table_privilege() given a comma-separated list
-- returns true if ANY listed privilege is held, so 'SELECT, UPDATE' against a
-- role holding only SELECT passes silently.
--
-- The column-level probes are the ones that actually measure the new artifact.
-- has_column_privilege on first_used_at is the direct question - is the column
-- writable by the role that must write it - and the anon arm is its POSITIVE
-- CONTROL: it must come back FALSE. If both arms return the same answer the
-- probe is not measuring anything and its silence would mean nothing.
DO $$
DECLARE
  required text[][] := ARRAY[
    ARRAY['swarm.agent_tokens', 'SELECT'],
    ARRAY['swarm.agent_tokens', 'UPDATE']
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
    RAISE EXCEPTION 'swarm_command lacks privileges the first-use stamp requires:%', missing
      USING ERRCODE = '55000';
  END IF;

  IF NOT has_column_privilege(
    'swarm_command', 'swarm.agent_tokens', 'first_used_at', 'UPDATE'
  ) THEN
    RAISE EXCEPTION
      'swarm_command cannot UPDATE swarm.agent_tokens.first_used_at; the table-level grant did not reach the new column'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    IF has_column_privilege(
      'anon', 'swarm.agent_tokens', 'first_used_at', 'SELECT'
    ) THEN
      RAISE EXCEPTION
        'anon can read swarm.agent_tokens.first_used_at; the new column leaked past the PostgREST deny-by-default'
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
-- (6) Verification: measure the artifacts this migration claims to have made.
-- ---------------------------------------------------------------------------

-- Every check here is capable of failing, which is the only reason its silence
-- is worth anything. The index predicate check carries its own positive
-- control: the identical probe is run against agent_tokens_by_renewal_grant,
-- whose predicate must NOT mention revoked_at. If both arms agree, the
-- instrument - not the schema - is what we are looking at.
DO $$
DECLARE
  col_type text;
  col_nullable boolean;
  cas_predicate text;
  control_predicate text;
  cas_unique boolean;
  trigger_count integer;
BEGIN
  SELECT a.atttypid::regtype::text, NOT a.attnotnull
    INTO col_type, col_nullable
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'swarm.agent_tokens'::regclass
    AND a.attname = 'first_used_at'
    AND NOT a.attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION 'swarm.agent_tokens.first_used_at was not created' USING ERRCODE = '55000';
  END IF;
  IF col_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'first_used_at is %, not timestamptz', col_type USING ERRCODE = '55000';
  END IF;
  IF NOT col_nullable THEN
    RAISE EXCEPTION 'first_used_at is NOT NULL; PENDING has no representation' USING ERRCODE = '55000';
  END IF;

  SELECT i.indisunique, pg_catalog.pg_get_expr(i.indpred, i.indrelid)
    INTO cas_unique, cas_predicate
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relname = 'agent_tokens_one_successor_per_predecessor'
    AND n.nspname = 'swarm';

  SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid)
    INTO control_predicate
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relname = 'agent_tokens_by_renewal_grant'
    AND n.nspname = 'swarm';

  IF cas_predicate IS NULL OR control_predicate IS NULL THEN
    RAISE EXCEPTION
      'one of the two indexes under test is missing its predicate; the comparison below would be vacuous'
      USING ERRCODE = '55000';
  END IF;

  IF NOT cas_unique THEN
    RAISE EXCEPTION 'the recreated one-successor index is not UNIQUE' USING ERRCODE = '55000';
  END IF;

  IF position('revoked_at' IN cas_predicate) = 0 THEN
    RAISE EXCEPTION
      'agent_tokens_one_successor_per_predecessor still covers revoked rows: %', cas_predicate
      USING ERRCODE = '55000';
  END IF;

  -- The positive control. Identical probe, index that must not match.
  IF position('revoked_at' IN control_predicate) <> 0 THEN
    -- The format argument goes with RAISE's format string; DETAIL is a USING
    -- option and does not fill a % placeholder. Written the other way this
    -- raised 42601 "too few parameters specified for RAISE" at APPLY time,
    -- which aborted the whole migration - so the positive control was itself
    -- the thing that could not run.
    RAISE EXCEPTION
      'the control index agent_tokens_by_renewal_grant also mentions revoked_at (%); this probe cannot distinguish anything',
      control_predicate
      USING ERRCODE = '55000';
  END IF;

  IF position('predecessor_token_id' IN cas_predicate) = 0 THEN
    RAISE EXCEPTION
      'agent_tokens_one_successor_per_predecessor lost its predecessor_token_id arm: %', cas_predicate
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO trigger_count
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'swarm.agent_tokens'::regclass
    AND NOT tgisinternal
    AND tgenabled <> 'D'
    AND tgname IN (
      'agent_tokens_first_use_immutable',
      'agent_tokens_first_use_not_preset'
    );

  IF trigger_count <> 2 THEN
    RAISE EXCEPTION
      'expected 2 enabled first-use triggers on swarm.agent_tokens, found %', trigger_count
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- What this migration does NOT do, written down so nobody assumes otherwise.
-- ---------------------------------------------------------------------------
--
--  * It does not stamp first_used_at. Nothing writes the column yet, so every
--    token in the table is PENDING by the definition above and none of it
--    matters until the authentication path starts writing - which is design
--    step 2 and another lane's. Until then this migration is inert: the two new
--    triggers guard a column nobody sets, and the narrowed index behaves
--    identically to the old one because no successor row is revoked.
--
--  * It does not move supersession. The renewal command still supersedes the
--    predecessor at issue time until that lane changes; this file only makes
--    the later moment representable.
--
--  * It does not stop a PENDING successor being renewed (design step 5). That
--    check belongs in swarm.agent_tokens_successor_fence(), in the "liveness of
--    the predecessor" block beside the pred.expires_at test, so that the
--    fence's identity-then-liveness ordering is preserved and the refusal gets
--    its own distinct string. Adding it here as a separate trigger would have
--    fired BEFORE the fence's identity checks and reported the wrong reason.
--
--  * It does not touch the grant counter. The fence increments
--    successors_used unconditionally inside the INSERT, so a self-healing
--    reissue after a stranded attempt will currently charge a SECOND slot -
--    which design step 4 forbids, because repeated network failures would then
--    exhaust the budget. Fixing that means either the fence learning to skip
--    the increment when it is replacing a pending successor, or the reissue
--    path compensating. Both are outside this lane; neither is done.
--
--  * It does not bound the overlap window beyond what already bounds it. Between
--    issue and first use the predecessor and successor are both live, for at
--    most the predecessor's remaining TTL (<= 1h). That ceiling is the
--    predecessor's own expires_at, enforced by the existing agent-auth expiry
--    check, and nothing here extends it.
