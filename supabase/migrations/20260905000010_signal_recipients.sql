-- Chat platform L2: one signal, N recipients.
--
-- WHAT THIS DOES NOT DO, first, because it is the whole compatibility argument.
-- `signals_one_recipient` is NOT relaxed and `to_user_id` /
-- `to_agent_principal_id` are NOT dropped. They keep holding the FIRST
-- recipient, and a deferred constraint below makes that a database guarantee
-- rather than an edge convention. A reader that knows only those two columns is
-- therefore INCOMPLETE (it sees one of three recipients) and never WRONG (the
-- one it sees really is addressed). That is what lets this land with no client
-- flag day: every installed cswarm and every browser build keeps working.
--
-- ⚠ SECOND RLS PREDICATE CHANGE on swarm_read.signals.
--   WAS, after 20260905000003 and before this file:
--     is_member(workspace_id, auth.uid())
--     AND ( (to_user_id IS NULL AND to_agent_principal_id IS NULL)
--           OR to_user_id = auth.uid()
--           OR EXISTS (an agent_principals row for to_agent_principal_id owned
--                      by auth.uid()) )
--   IS, after this file:
--     ( <the whole predicate above, spliced through untouched> )
--     OR ( is_member(workspace_id, auth.uid())
--          AND EXISTS (a swarm.signal_recipients row for this signal naming
--                      auth.uid(), or an agent principal auth.uid() owns) )
--   The new disjunct carries its OWN is_member gate, which is what makes an
--   OR at the top level safe: it cannot admit a row to a non-member. The
--   predicate only WIDENS, and only to people the sender addressed. Widening
--   is what assert_view_clauses_preserved cannot catch, so the before/after
--   visibility suite (tests/p1-local/chat-recipients-postgres.test.ts) is the
--   control that has to exist for this file, and it does.
--
-- ⚠ DEPLOY COUPLING. The read edge shipped in this lane names s.recipients.
-- Apply this migration, VERIFY it applied with a swarm.schema_migrations query
-- rather than from the db push output, and only then deploy `command` and
-- `read`. Against a database missing this file every agent read fails.

-- ---------------------------------------------------------------------------
-- 1. The side table
-- ---------------------------------------------------------------------------

-- The composite FK below needs a unique key on exactly (id, workspace_id).
-- 20260730000002:8 already builds it and 20260901000010:6, 20260901000020:5 and
-- 20260905000003:37 all re-declare it with IF NOT EXISTS. Keep the house idiom:
-- state the requirement, tolerate the row already being there.
CREATE UNIQUE INDEX IF NOT EXISTS signals_id_workspace
  ON swarm.signals (id, workspace_id);

CREATE TABLE swarm.signal_recipients (
  signal_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recipient_user_id uuid,
  recipient_agent_principal_id uuid,
  -- THE CAP, one of its two enforcement points. The other is
  -- SIGNAL_RECIPIENT_MAX in supabase/functions/_shared/channels.ts, which the
  -- edge validator reads and builds its refusal sentence from.
  -- tests/chat-channel-constants.test.ts fails if this bound and that constant
  -- drift apart, the same way it already pins the channel slug bound.
  -- Positions are unique per signal (the primary key) and cannot exceed 7, so
  -- this CHECK caps the row count at 8 on its own, with no counting trigger.
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, position),
  -- Exactly one recipient kind per row. This mirrors signals_one_recipient one
  -- level down: the row is a person OR an agent, never both and never neither.
  CHECK (num_nonnulls(recipient_user_id, recipient_agent_principal_id) = 1),
  -- A recipient may not be named twice on one signal. UNIQUE is NULLS DISTINCT
  -- by default, so the many NULLs in the unused column do not collide.
  UNIQUE (signal_id, recipient_user_id),
  UNIQUE (signal_id, recipient_agent_principal_id),
  -- ★R14: workspace_id is denormalized and both composite FKs keep it honest,
  -- so a recipient can never point across a tenant boundary.
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (workspace_id, recipient_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id),
  FOREIGN KEY (recipient_agent_principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id)
);

-- The inbox lookups. The primary key already serves the per-signal correlated
-- subqueries the view runs; these two serve "which signals name me".
CREATE INDEX signal_recipients_agent_inbox
  ON swarm.signal_recipients (workspace_id, recipient_agent_principal_id, signal_id)
  WHERE recipient_agent_principal_id IS NOT NULL;

CREATE INDEX signal_recipients_user_inbox
  ON swarm.signal_recipients (workspace_id, recipient_user_id, signal_id)
  WHERE recipient_user_id IS NOT NULL;

ALTER TABLE swarm.signal_recipients OWNER TO swarm_admin;
ALTER TABLE swarm.signal_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.signal_recipients
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.signal_recipients FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT ON TABLE swarm.signal_recipients TO swarm_command;
-- swarm_read gets NOTHING here on purpose. The read edge reaches recipients
-- only through swarm_read.signals, which is owned by swarm_admin and is the one
-- place the visibility predicate lives.

COMMENT ON TABLE swarm.signal_recipients IS
  'The full recipient set of an immutable signal, in order. Position 0 is also '
  'stored on swarm.signals.to_user_id / to_agent_principal_id, so a reader that '
  'knows only those columns is incomplete rather than wrong.';
COMMENT ON COLUMN swarm.signal_recipients.position IS
  'Order the sender named them in. 0 is the first recipient and must equal the '
  'signal row''s own scalar recipient.';

-- ---------------------------------------------------------------------------
-- 2. Immutability: same shape as swarm.signal_attachments
-- ---------------------------------------------------------------------------
-- A recipient row may be inserted only while its parent signal still belongs to
-- the current transaction. Without this, INSERTing a recipient tomorrow would
-- change WHO CAN READ yesterday's immutable signal, with no UPDATE anywhere.
-- That is a bigger hole here than it is for attachments, because this table is
-- an input to the read predicate.
CREATE FUNCTION swarm.require_new_signal_for_recipient()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.xmin::text::bigint =
        (pg_current_xact_id()::text::bigint & 4294967295)
  ) THEN
    RAISE EXCEPTION 'signal recipients can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.require_new_signal_for_recipient() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.require_new_signal_for_recipient() FROM PUBLIC;

CREATE TRIGGER signal_recipients_same_transaction
  BEFORE INSERT ON swarm.signal_recipients
  FOR EACH ROW EXECUTE FUNCTION swarm.require_new_signal_for_recipient();

CREATE TRIGGER signal_recipients_append_only
  BEFORE UPDATE OR DELETE ON swarm.signal_recipients
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

-- ---------------------------------------------------------------------------
-- 3. The first-recipient guarantee, enforced rather than promised
-- ---------------------------------------------------------------------------
-- "An old reader is incomplete, never wrong" is only true while position 0 IS
-- the scalar recipient on the signal row. The edge writes it that way; this
-- trigger is what makes it a property of the database instead of a property of
-- one caller. It is DEFERRED because the recipient rows are written after the
-- signal row inside one transaction and the set is not complete until commit.
CREATE FUNCTION swarm.assert_signal_recipients_consistent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_count integer;
  v_highest integer;
  v_first_user uuid;
  v_first_agent uuid;
  v_to_user uuid;
  v_to_agent uuid;
BEGIN
  SELECT count(*)::integer, max(r.position)
  INTO v_count, v_highest
  FROM swarm.signal_recipients AS r
  WHERE r.signal_id = NEW.signal_id;

  -- Contiguous from 0. Without this a caller could write positions 0 and 7 and
  -- the "first recipient" idea would survive while the ORDER the sender named
  -- would not, and the count would stop being derivable from the highest slot.
  IF v_count <> v_highest + 1 THEN
    RAISE EXCEPTION
      'signal % has % recipient rows but the highest position is %; positions must run 0..n-1',
      NEW.signal_id, v_count, v_highest
      USING ERRCODE = '23514';
  END IF;

  SELECT r.recipient_user_id, r.recipient_agent_principal_id
  INTO v_first_user, v_first_agent
  FROM swarm.signal_recipients AS r
  WHERE r.signal_id = NEW.signal_id AND r.position = 0;

  SELECT s.to_user_id, s.to_agent_principal_id
  INTO v_to_user, v_to_agent
  FROM swarm.signals AS s
  WHERE s.id = NEW.signal_id;

  IF v_first_user IS DISTINCT FROM v_to_user
     OR v_first_agent IS DISTINCT FROM v_to_agent THEN
    RAISE EXCEPTION
      'signal %: recipient 0 must be the row''s own to_user_id/to_agent_principal_id, or a reader that knows only those columns is wrong rather than merely incomplete',
      NEW.signal_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.assert_signal_recipients_consistent() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.assert_signal_recipients_consistent() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER signal_recipients_first_is_the_scalar
  AFTER INSERT ON swarm.signal_recipients
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION swarm.assert_signal_recipients_consistent();

-- ---------------------------------------------------------------------------
-- 4. NO DELIVERY FAN-OUT. Why there is no trigger here.
-- ---------------------------------------------------------------------------
-- An earlier version of this file carried a trigger on swarm.signal_recipients
-- that enqueued one swarm.signal_deliveries row per AGENT recipient, with the
-- ON CONFLICT DO NOTHING that keeps recipient 0 from being woken twice. A
-- review arm showed that those rows CANNOT BE DELIVERED, and that writing them
-- is worse than not waking the agent at all. Both halves are measured, and both
-- are outside this migration:
--
--   1. supabase/functions/command/durable-delivery.ts, hydrateDeliveryRefs:
--      its WHERE carries `s.to_agent_principal_id = <the claiming principal>`.
--      The scalar column holds recipient 0, so a row for recipient 1 leases,
--      fails to hydrate, and the handler answers 403 delivery_unavailable and
--      COMMITS -- so the lease and attempt_count stick. Ten claims terminalize
--      the row as delivery_attempts_exhausted and raise a security alert. The
--      same scalar filter gates the `expired` acknowledgement.
--   2. src/cloud/delivery.ts:423 -- the INSTALLED listener refuses any delivery
--      whose signal.to_agent is not its own principal. So even a server that
--      hydrated correctly could not hand the row to a shipped client. Making it
--      deliverable needs either a client release (lane L3) or a wire whose
--      to_agent means "this delivery's recipient" rather than "the signal's
--      scalar recipient" -- a semantic change nobody has ruled on.
--
-- The alternative of writing the rows and refusing to lease them was rejected:
-- pending_delivery_count and oldest_pending_at would then report a queue that
-- grows and can never be drained, which is a false signal rather than a
-- missing feature.
--
-- SO, EXACTLY: recipients 1..N can READ a signal and can REPLY to it. They are
-- not woken. Recipient 0 is woken by swarm.enqueue_signal_delivery() from the
-- scalar column, unchanged. tests/p1-local/chat-recipients-postgres.test.ts and
-- tests/p1-server/chat-signals.test.ts both measure that, so the day someone
-- adds the fan-out they are told what else has to move.

-- ---------------------------------------------------------------------------
-- 5. The clause guard learns this lane's marker BEFORE the recreation runs
-- ---------------------------------------------------------------------------
-- Same reasoning the DM marker carries in 20260905000002: the phase that ADDS a
-- clause is never the phase that drops it, so the marker has to be in the array
-- before the recreation that could lose it. On THIS run it is vacuous, because
-- p_before is the body from before this file. From the next recreation on it
-- fires.
CREATE OR REPLACE FUNCTION swarm.assert_view_clauses_preserved(
  p_view text,
  p_before text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  after_def text;
  marker text;
  markers text[] := ARRAY[
    'is_member',
    'to_user_id = auth.uid()',
    'to_agent_principal_id IS NULL',
    'owner_user_id = auth.uid()',
    -- Added by 20260905000010. It must occur ONLY in the WHERE: the recipients
    -- aggregate in the select list reads the same table and the same column,
    -- but never compares it to auth.uid(), so this fragment cannot survive the
    -- deletion of the clause it guards.
    'recipient_user_id = auth.uid()',
    -- Not in the live view yet: the DM phase adds it.
    'from_principal = auth.uid()'
  ];
BEGIN
  after_def := pg_get_viewdef(p_view::regclass, true);
  FOREACH marker IN ARRAY markers LOOP
    IF position(marker IN p_before) > 0 AND position(marker IN after_def) = 0 THEN
      RAISE EXCEPTION
        'view % lost the authorization fragment "%" during recreation; resolve the starting body with pg_get_viewdef against this database, not from a migration file',
        p_view, marker;
    END IF;
  END LOOP;
END;
$$;
ALTER FUNCTION swarm.assert_view_clauses_preserved(text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.assert_view_clauses_preserved(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. Third recreation of swarm_read.signals
-- ---------------------------------------------------------------------------
-- The starting body is read from THIS DATABASE, never from a migration file.
-- Unlike the two recreations before it, this one changes the WHERE as well as
-- the select list, so it cannot append and stop. It splices instead:
--
--   head  = everything up to and including the top-level "FROM swarm.signals "
--   alias = "s ... WHERE "
--   rest  = the whole existing predicate, whatever it currently contains
--
-- and writes head || alias || '(' || rest || ') OR (' || the new disjunct || ')'.
-- Wrapping the existing predicate in parentheses and ORing beside it is what
-- keeps a clause a later hotfix added travelling through untouched.
--
-- The split has to be done in two steps and cannot be one regexp_replace,
-- because the attachments subquery in the select list contains its own WHERE
-- and regexp_replace would find that one first. Splitting at the top-level FROM
-- first puts that subquery entirely in `head`, so the first WHERE in what is
-- left is the top-level one by construction.

SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text;
  with_column text;
  tagged text;
  head text;
  tail text;
  tagged_where text;
  alias_and_where text;
  predicate text;
  body text;
BEGIN
  live_def := current_setting('swarm.signals_view_before');

  IF position('broadcast_to_channel' IN live_def) = 0 THEN
    RAISE EXCEPTION
      'swarm_read.signals does not carry broadcast_to_channel; migration 20260905000003 has not applied to this database';
  END IF;
  IF position('signal_recipients' IN live_def) > 0 THEN
    RAISE EXCEPTION
      'swarm_read.signals already reads swarm.signal_recipients; this migration has already been applied to this database';
  END IF;

  -- (a) Append the recipients column immediately before the top-level FROM,
  -- exactly the splice 20260905000002 and ...0003 use. The attachments
  -- subquery reads FROM swarm.signal_attachments and cannot match: the pattern
  -- requires whitespace directly after "signals". The subquery added below
  -- reads FROM swarm.signal_recipients and cannot match for the same reason,
  -- so the NEXT migration's splice still finds exactly one boundary. The
  -- control at the end of this file measures that rather than assuming it.
  IF live_def !~ '\sFROM\s+(swarm\.)?signals\s' THEN
    RAISE EXCEPTION
      'could not locate the select-list boundary in the live swarm_read.signals body; recreate it by hand and re-run the directed-visibility suite before deploying anything';
  END IF;

  with_column := regexp_replace(
    live_def,
    '(\s)(FROM\s+(?:swarm\.)?signals\s)',
    $q$,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'kind', CASE WHEN recipient.recipient_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
            'id', COALESCE(recipient.recipient_user_id, recipient.recipient_agent_principal_id),
            'position', recipient.position
          ) ORDER BY recipient.position
        )
        FROM swarm.signal_recipients AS recipient
        WHERE recipient.signal_id = s.id
          AND recipient.workspace_id = s.workspace_id
      ),
      CASE
        WHEN s.to_user_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'user', 'id', s.to_user_id, 'position', 0))
        WHEN s.to_agent_principal_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', s.to_agent_principal_id, 'position', 0))
        ELSE '[]'::jsonb
      END
    ) AS recipients\1\2$q$
  );

  -- (b) Split at the top-level FROM, then at the FIRST WHERE after it. Two
  -- steps, not one regexp_replace: the attachments subquery in the select list
  -- carries its own WHERE and a single pass would find that one first.
  -- Splitting at the top-level FROM puts that subquery entirely in `head`, so
  -- the first WHERE in what is left is the top-level one by construction.
  tagged := regexp_replace(
    with_column,
    '(\sFROM\s+(?:swarm\.)?signals\s)',
    '\1@@SWARM_SPLIT@@'
  );
  IF split_part(tagged, '@@SWARM_SPLIT@@', 2) = ''
     OR split_part(tagged, '@@SWARM_SPLIT@@', 3) <> '' THEN
    RAISE EXCEPTION
      'expected exactly one top-level FROM swarm.signals in the live body; recreate swarm_read.signals by hand';
  END IF;
  head := split_part(tagged, '@@SWARM_SPLIT@@', 1);
  tail := split_part(tagged, '@@SWARM_SPLIT@@', 2);

  tagged_where := regexp_replace(tail, '\sWHERE\s', ' WHERE @@SWARM_WHERE@@ ');
  IF tagged_where = tail THEN
    RAISE EXCEPTION
      'the live swarm_read.signals body has no top-level WHERE; this migration widens a predicate and refuses to invent one';
  END IF;
  alias_and_where := split_part(tagged_where, '@@SWARM_WHERE@@', 1);
  predicate := rtrim(split_part(tagged_where, '@@SWARM_WHERE@@', 2), E' ;\n\t');

  -- The existing predicate travels through inside one pair of parentheses,
  -- whatever it currently contains. The new disjunct carries its OWN membership
  -- gate, which is what makes an OR at the top level safe: it cannot admit a
  -- row to someone outside the workspace. It admits exactly the people the
  -- sender addressed -- in person, or through an agent they own, the same two
  -- ways the existing arm admits a scalar recipient.
  body := head || alias_and_where || '(' || predicate || $q$)
  OR (
    swarm.is_member(s.workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM swarm.signal_recipients AS addressee
      WHERE addressee.signal_id = s.id
        AND addressee.workspace_id = s.workspace_id
        AND (
          addressee.recipient_user_id = auth.uid()
          OR EXISTS (
            SELECT 1
            FROM swarm.agent_principals AS owned
            WHERE owned.principal_id = addressee.recipient_agent_principal_id
              AND owned.workspace_id = addressee.workspace_id
              AND owned.owner_user_id = auth.uid()
          )
        )
    )
  )$q$;

  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;

SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals',
  current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

-- Positive control on the recreation itself. assert_view_clauses_preserved only
-- checks that nothing was LOST, so a splice that no-opped would still pass it.
DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF position(' AS recipients' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals recreation did not add the recipients column';
  END IF;
  IF position('recipient_user_id = auth.uid()' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals recreation did not add the recipient visibility arm';
  END IF;
  -- And the boundary the NEXT recreation depends on is still unique.
  IF (SELECT count(*) FROM regexp_matches(after_def, '\sFROM\s+(swarm\.)?signals\s', 'g')) <> 1 THEN
    RAISE EXCEPTION
      'swarm_read.signals now has more than one FROM swarm.signals boundary; the next migration cannot splice it';
  END IF;
END;
$$;
