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

-- Body below is 20260901000010_signal_attachments.sql:81-133 with s.channel_id
-- appended at the END of the select list and NOTHING else changed. The
-- assertion after it is what proves that claim against this database rather
-- than against my reading of a file.
CREATE OR REPLACE VIEW swarm_read.signals
WITH (security_barrier = true)
AS
  SELECT
    s.id,
    s.workspace_id,
    s.from_principal AS "from",
    s.from_kind,
    s.to_user_id AS "to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at,
    s.to_agent_principal_id AS to_agent,
    s.in_reply_to,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'file_id', attachment.file_id,
            'version_n', attachment.version_n,
            'name', file.name,
            'content_type', version.content_type,
            'size_bytes', version.size_bytes::double precision
          ) ORDER BY attachment.position
        )
        FROM swarm.signal_attachments AS attachment
        JOIN swarm.files AS file
          ON file.file_id = attachment.file_id
         AND file.workspace_id = attachment.workspace_id
        JOIN swarm.file_versions AS version
          ON version.file_id = attachment.file_id
         AND version.workspace_id = attachment.workspace_id
         AND version.version_n = attachment.version_n
        WHERE attachment.signal_id = s.id
          AND attachment.workspace_id = s.workspace_id
      ),
      '[]'::jsonb
    ) AS attachments,
    s.channel_id
  FROM swarm.signals AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (
      (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL)
      OR s.to_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS principal
        WHERE principal.principal_id = s.to_agent_principal_id
          AND principal.workspace_id = s.workspace_id
          AND principal.owner_user_id = auth.uid()
      )
    );

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;

SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals',
  current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);
