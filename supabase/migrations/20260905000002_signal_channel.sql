-- Chat platform P1, file 2 of 3: file a signal in a channel.
--
-- channel_id is NULLABLE FOR THE LIFE OF v1. No default, no backfill, no
-- defaulting trigger, no SET NOT NULL, in any phase. NULL means "unfiled".
--
-- That single rule is what makes the migrate-then-deploy window harmless. The
-- Supabase CLI commits one migration file per transaction
-- (20260902000001_broadcast_recipient_roster.sql:11-20), so this shape is live
-- while the OLD command edge is still serving, and that edge's insert names its
-- columns and omits channel_id. A NOT NULL or a defaulting trigger here is a
-- production WRITE outage with healthy reads, which is the hardest kind to
-- attribute. Nullable makes it unreachable rather than mitigated.
--
-- The reverse window is guarded by process, not by SQL: deploy the command and
-- read functions only AFTER verifying this file applied with a
-- swarm.schema_migrations query, never from the db push output. A new edge
-- naming channel_id against a database missing it fails every post.

ALTER TABLE swarm.signals ADD COLUMN channel_id uuid;

-- MATCH SIMPLE, so a NULL channel_id passes without touching swarm.channels.
-- Tenant-pinned, so a channel_id from another workspace cannot be stamped here.
ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_channel_workspace
  FOREIGN KEY (channel_id, workspace_id)
  REFERENCES swarm.channels (channel_id, workspace_id);

CREATE INDEX signals_channel_newest
  ON swarm.signals (workspace_id, channel_id, created_at DESC, id DESC)
  WHERE channel_id IS NOT NULL;

COMMENT ON COLUMN swarm.signals.channel_id IS
  'The channel this signal is filed in. NULL means unfiled and stays legal forever. A label, never a permission: it appears in no authorization predicate.';

-- ---------------------------------------------------------------------------
-- The view-recreation control, moved into the migration where it cannot be
-- skipped.
--
-- swarm_read.signals IS the policy: the view is security_barrier, owned by
-- swarm_admin, and swarm.signals never gets FORCE ROW LEVEL SECURITY, so the
-- owner bypasses the table policy and the view's WHERE clause is what scopes
-- every human read. Three migrations already define this view and only the
-- newest is live. CREATE OR REPLACE VIEW protects column shape -- it cannot
-- rename, retype, drop or reorder a column -- but it gives the WHERE clause no
-- protection at all. A later file that starts from an older migration's body
-- silently deletes whatever clause the file between them added, with no error
-- and no failed column check.
--
-- So: snapshot the LIVE body first, recreate, then assert that every
-- authorization marker present before is still present after. The marker list
-- lives in one function, so a third or fourth recreation cannot copy a stale
-- copy of it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION swarm.assert_view_clauses_preserved(
  p_view text,
  p_before text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  after_def text;
  marker text;
  -- Every predicate fragment that grants or gates a read on the signal plane.
  -- Add a marker here when a migration adds a clause; never assert them inline.
  -- Each fragment must occur ONLY in the WHERE clause: a fragment that also
  -- appears in the select list (bare 'to_agent_principal_id' does) would stay
  -- present after its guard was deleted and report a pass it did not earn.
  -- This catches a DROPPED clause. It cannot catch a wrongly WIDENED one, so
  -- the before/after visibility suite is still owed on any predicate change.
  markers text[] := ARRAY[
    'is_member',
    'to_user_id = auth.uid()',
    'to_agent_principal_id IS NULL',
    'owner_user_id = auth.uid()',
    -- Not in the live view yet: the DM phase adds it. Listed now on purpose,
    -- because the phase that ADDS a clause is never the phase that drops it --
    -- the marker has to be here before the recreation that could lose it.
    --
    -- A review arm read this as a vacuous assertion. It is vacuous only while
    -- the clause does not exist, which is exactly when there is nothing to
    -- drop. The moment the DM phase adds it, p_before carries it on every LATER
    -- recreation and the guard fires. Listing it early is what makes that true
    -- without the DM phase having to remember to edit this array.
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

COMMENT ON FUNCTION swarm.assert_view_clauses_preserved(text, text) IS
  'Migration-time assertion: a view recreation may add columns but must not drop an authorization fragment the live body already had.';

-- Session GUC rather than a temp table: this must hold whether the migration
-- runs inside an explicit transaction block or not.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

-- Resolve the starting body from THIS DATABASE, never from a migration file.
-- An earlier version of this file pasted 20260901000010:81-133 and appended the
-- column. That matches the live body today, but it is the practice the design
-- rules out (§3.3) and a review arm was right to name it: a hotfix that added an
-- unmarked clause between that file and this one would be deleted here, and the
-- assertion below would not catch it because it only knows the markers it lists.
-- Splicing means the WHERE travels through untouched whatever it contains.
DO $$
DECLARE
  live_def text;
  body text;
BEGIN
  live_def := current_setting('swarm.signals_view_before');

  IF live_def !~ '\sFROM\s+(swarm\.)?signals\s' THEN
    RAISE EXCEPTION
      'could not locate the select-list boundary in the live swarm_read.signals body; recreate it by hand and re-run the directed-visibility suite before deploying anything';
  END IF;
  IF position('channel_id' IN live_def) > 0 THEN
    RAISE EXCEPTION
      'swarm_read.signals already carries channel_id; this migration has already been applied to this database';
  END IF;

  -- The schema qualifier is optional in the pattern: pg_get_viewdef omits it
  -- when swarm is on the session search_path, which is a property of how the
  -- migration was invoked and not of the view. swarm.signal_attachments cannot
  -- match -- after "signal" comes "_", not "s".
  body := regexp_replace(
    live_def,
    '(\s)(FROM\s+(?:swarm\.)?signals\s)',
    E',\n    s.channel_id\\1\\2'
  );
  body := rtrim(body, E' ;\n\t');

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

-- Positive control on the recreation itself: the column must now be projected.
-- The assertion above only proves nothing was LOST, so a no-op splice would
-- pass it. File 3 carries the same pair for its two columns.
DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF position('channel_id' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals recreation did not add channel_id';
  END IF;
END;
$$;
