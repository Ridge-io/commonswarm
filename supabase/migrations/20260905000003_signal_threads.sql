-- Chat platform P4, file 3 of 3: threads.
--
-- A thread gets its own identity. in_reply_to keeps its exact current meaning
-- and behaviour: "reply privately to the author of the referenced signal",
-- re-addressed server-side by resolveSignalWriteTarget. thread_root_id is the
-- NEW field and it is what opts a reply into thread behaviour, so no installed
-- cswarm reply changes meaning when this lands.
--
-- Kept as its own file, never folded into file 2: each takes an
-- ACCESS EXCLUSIVE lock on swarm.signals and recreates the read view, and
-- combining them widens the blast radius of the riskiest step for no benefit
-- before the thread client exists.
--
-- broadcast_to_channel is NOT NULL WITH A DEFAULT, and that is the whole reason
-- it is safe: the old edge's insert omits it and gets false. channel_id in
-- file 2 could not take that treatment, because a default there would have to
-- name a channel and there is none to name. The contrast is the point.
--
-- ⚠ DEPLOY COUPLING. The read edge shipped in this lane PROJECTS
-- thread_root_id and broadcast_to_channel. All THREE migration files must be
-- applied, and verified applied with a swarm.schema_migrations query rather
-- than from the db push output, BEFORE that edge is deployed. Files 2 and 3
-- stay separate so each takes its own lock window; they do not have to ship in
-- separate releases, and with this edge they cannot.

ALTER TABLE swarm.signals
  ADD COLUMN thread_root_id uuid,
  ADD COLUMN broadcast_to_channel boolean NOT NULL DEFAULT false;

-- The composite FK below needs a unique constraint on exactly (id,
-- workspace_id). id alone is the primary key, which does not satisfy a
-- two-column reference, so the index is a requirement of the FK and not a
-- performance choice. It is a full index build under the lock this file already
-- takes; on a signal table sized for 30-day retention that is bounded, but it
-- is a real cost and is named here rather than discovered during the push.
CREATE UNIQUE INDEX signals_id_workspace ON swarm.signals (id, workspace_id);

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_thread_root_workspace
  FOREIGN KEY (thread_root_id, workspace_id)
  REFERENCES swarm.signals (id, workspace_id);

CREATE INDEX signals_thread_oldest
  ON swarm.signals (workspace_id, thread_root_id, created_at, id)
  WHERE thread_root_id IS NOT NULL;

COMMENT ON COLUMN swarm.signals.thread_root_id IS
  'The signal this one is a threaded reply to. NULL means a top-level message. Independent of in_reply_to, which keeps its one-hop private-reply meaning.';
COMMENT ON COLUMN swarm.signals.broadcast_to_channel IS
  'A threaded reply the author also sent to the channel feed. Defaults to false so an edge that predates this column writes a legal row.';

-- ---------------------------------------------------------------------------
-- Second recreation of swarm_read.signals. The starting body is read from THIS
-- DATABASE, not from a migration file, because by the time this file runs the
-- live body may already carry a clause no file before it wrote -- the DM phase
-- adds a sender-visibility arm to the same view. Recreating from file 2's text
-- would append the thread columns correctly and silently delete that arm.
--
-- The body written below is therefore assembled from the live definition:
-- pg_get_viewdef output with the two new columns appended. Doing that in SQL
-- keeps the guarantee mechanical instead of asking the next author to remember.
-- ---------------------------------------------------------------------------

SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text;
  body text;
BEGIN
  live_def := current_setting('swarm.signals_view_before');

  -- pg_get_viewdef renders "SELECT ... FROM swarm.signals s WHERE ...;". Splice
  -- the two new columns in immediately before the FROM that closes the select
  -- list, so the WHERE clause travels through untouched whatever it currently
  -- contains. The match is whitespace-insensitive because the pretty-printer's
  -- indentation is a Postgres implementation detail, not a contract.
  --
  -- The attachments subquery reads FROM swarm.signal_attachments, which cannot
  -- match: the pattern requires whitespace directly after "signals".
  IF live_def !~ '\sFROM\s+swarm\.signals\s' THEN
    RAISE EXCEPTION
      'could not locate the select-list boundary in the live swarm_read.signals body; recreate it by hand and re-run the directed-visibility suite before deploying anything';
  END IF;
  IF position('channel_id' IN live_def) = 0 THEN
    RAISE EXCEPTION
      'swarm_read.signals does not carry channel_id; migration 20260905000002 has not applied to this database';
  END IF;

  body := regexp_replace(
    live_def,
    '(\s)(FROM\s+swarm\.signals\s)',
    E',\n    s.thread_root_id,\n    s.broadcast_to_channel\\1\\2'
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

-- Positive control on the recreation itself: the two new columns must now be
-- projected. Without this the splice could no-op and the assertion above would
-- still pass, because it only checks that nothing was lost.
DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF position('thread_root_id' IN after_def) = 0
     OR position('broadcast_to_channel' IN after_def) = 0 THEN
    RAISE EXCEPTION
      'swarm_read.signals recreation did not add the thread columns';
  END IF;
END;
$$;
