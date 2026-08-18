-- File artifacts (docs/design/2026-08-18-FILE-ARTIFACTS.md §8) — S1.
-- A fourth primitive: named, workspace-scoped, versioned blobs. Postgres is the
-- authority; the storage bucket is a blob store nothing trusts on its own.

CREATE TABLE swarm.files (
  file_id        uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by     uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 0,
  tombstoned_at  timestamptz,
  tombstoned_by  uuid,
  -- Set by the purge job once the tombstone window ended AND every version is
  -- purged: the name becomes reusable while the row survives for audit.
  purged_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- ★R14: the composite target for file_versions' composite FK, so a version
  -- can never disagree with its file about the tenant.
  UNIQUE (file_id, workspace_id)
);

-- ★R13: expression uniqueness must be an index; UNIQUE (workspace_id, lower(name))
-- inside CREATE TABLE does not apply in PostgreSQL. Partial: a PURGED file
-- releases its name (the "purge frees a name" refusal copy must be true).
CREATE UNIQUE INDEX files_workspace_name_ci
  ON swarm.files (workspace_id, lower(name))
  WHERE purged_at IS NULL;

CREATE TABLE swarm.file_versions (
  version_id     uuid PRIMARY KEY,
  file_id        uuid NOT NULL,
  -- Denormalized for RLS and the quota SUM (★R14: the composite FK below is what
  -- keeps this column honest — divergence here IS the tenant-isolation bug).
  workspace_id   uuid NOT NULL,
  version_n      integer NOT NULL CHECK (version_n >= 1),
  state          text NOT NULL CHECK (state IN ('pending', 'live', 'purged')),
  -- ★R4: at commit this becomes the size MEASURED from storage metadata; at
  -- create it holds the client's declared size, which is what the quota gated.
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  -- ★R4: UNVERIFIED client attestation, never authority. The server does not
  -- hash the object; path binding, upsert-off, and measured size are the
  -- authority facts.
  sha256         text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- ★R8: unverified client declaration, allowlist-checked at create.
  content_type   text NOT NULL,
  storage_path   text NOT NULL,
  uploaded_by_kind text NOT NULL CHECK (uploaded_by_kind IN ('user', 'agent')),
  uploaded_by    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  committed_at   timestamptz,
  UNIQUE (file_id, version_n),
  FOREIGN KEY (file_id, workspace_id)
    REFERENCES swarm.files (file_id, workspace_id)
);

CREATE INDEX file_versions_workspace_state
  ON swarm.file_versions (workspace_id, state);
-- The pending sweep (★R15) scans by state and age.
CREATE INDEX file_versions_pending_created
  ON swarm.file_versions (created_at)
  WHERE state = 'pending';

ALTER TABLE swarm.files OWNER TO swarm_admin;
ALTER TABLE swarm.file_versions OWNER TO swarm_admin;
ALTER TABLE swarm.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.file_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.files
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.file_versions
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

-- Unlike signals these rows mutate (version bump, commit, tombstone, purge), so
-- no append-only trigger; every write still travels the command function's
-- SECURITY DEFINER path — there are no client grants.
REVOKE ALL ON TABLE swarm.files FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE swarm.file_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.files TO swarm_command;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.file_versions TO swarm_command;

-- Membership-gated read view: one row per file with its current LIVE version's
-- facts, matching the read resource shape (§7). Tombstoned files stay visible
-- (the tombstone is part of what a member can see; the CLI filters by default).
CREATE VIEW swarm_read.files
WITH (security_barrier = true)
AS
  SELECT
    f.file_id,
    f.workspace_id,
    f.name,
    f.current_version,
    f.created_by_kind,
    f.created_by,
    f.created_at,
    f.tombstoned_at,
    v.size_bytes,
    v.content_type,
    v.sha256,
    v.uploaded_by_kind,
    v.uploaded_by,
    v.committed_at
  FROM swarm.files AS f
  LEFT JOIN swarm.file_versions AS v
    ON v.file_id = f.file_id
   AND v.workspace_id = f.workspace_id
   AND v.version_n = f.current_version
   AND v.state = 'live'
  WHERE swarm.is_member(f.workspace_id, auth.uid())
    AND f.purged_at IS NULL;

ALTER VIEW swarm_read.files OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.files TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.files FROM anon;

-- The private bucket. ★R12: service-role-only — no storage policies are created
-- here, and S1's evidence enumerates that none exist elsewhere. Every object
-- access goes through server-issued signed URLs.
-- DO UPDATE, not DO NOTHING: a pre-existing bucket of this name must be forced
-- private, or a misconfigured public bucket would survive the migration.
INSERT INTO storage.buckets (id, name, public)
VALUES ('swarm-files', 'swarm-files', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Object deletion CANNOT happen here: storage protects its tables with a
-- trigger ("Direct deletion from storage tables is not allowed. Use the
-- Storage API instead." — measured on the local stack, 2026-08-18). So the
-- claim writes the object paths into a durable queue, and S4 drains the queue
-- through the Storage API with the service key. Restore semantics do not wait
-- for the bytes: a claimed row is 'purged' the moment the claim commits.
CREATE TABLE swarm.file_purge_queue (
  storage_path text PRIMARY KEY,
  claimed_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  deleted_at   timestamptz
);
ALTER TABLE swarm.file_purge_queue OWNER TO swarm_admin;
ALTER TABLE swarm.file_purge_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.file_purge_queue
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE swarm.file_purge_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.file_purge_queue TO swarm_command;

-- ★R6: purge claims in ONE transaction so restore can never race it; the
-- function body is a single statement set inside the cron transaction.
-- ★R15: pending rows are claimed after 3 hours — the pinned storage-js upload
-- URL is valid for two, plus an hour of margin for the signing delay; their
-- objects — uploaded or not — join the same queue.
CREATE OR REPLACE FUNCTION swarm.purge_file_artifacts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, storage, pg_catalog
AS $$
BEGIN
  -- Lock order: FILE rows first, the same rows file_restore locks FOR UPDATE,
  -- so a concurrent restore either commits before this claim sees the file or
  -- blocks until the claim commits — never interleaves. (Review finding: the
  -- claim used to lock only version rows while restore locked the file row.)
  WITH expired_files AS (
    SELECT f.file_id, f.workspace_id
    FROM swarm.files AS f
    WHERE f.tombstoned_at IS NOT NULL
      AND f.tombstoned_at < statement_timestamp() - interval '30 days'
    FOR UPDATE
  ),
  tombstone_claim AS (
    UPDATE swarm.file_versions AS v
    SET state = 'purged'
    FROM expired_files AS f
    WHERE f.file_id = v.file_id
      AND f.workspace_id = v.workspace_id
      AND v.state != 'purged'
    RETURNING v.storage_path
  ),
  -- ★R15 with the signing-delay margin: the row's clock starts before the
  -- upload URL is signed, so a 2h claim could kill a row whose 2h URL still
  -- works. Claim only after 3h: URL validity plus an hour of margin.
  pending_claim AS (
    UPDATE swarm.file_versions AS v
    SET state = 'purged'
    WHERE v.state = 'pending'
      AND v.created_at < statement_timestamp() - interval '3 hours'
    RETURNING v.storage_path
  ),
  -- Orphan objects: paths in the bucket with no version row at all (a PUT that
  -- outlived a lost create response, or debris). Queued on the same schedule.
  orphans AS (
    SELECT o.name AS storage_path
    FROM storage.objects AS o
    WHERE o.bucket_id = 'swarm-files'
      AND o.created_at < statement_timestamp() - interval '3 hours'
      AND NOT EXISTS (
        SELECT 1 FROM swarm.file_versions AS v WHERE v.storage_path = o.name
      )
  )
  INSERT INTO swarm.file_purge_queue (storage_path)
  SELECT storage_path FROM tombstone_claim
  UNION
  SELECT storage_path FROM pending_claim
  UNION
  SELECT storage_path FROM orphans
  ON CONFLICT (storage_path) DO NOTHING;

  -- Item 6 (S2 verify round): once the window ended and every version is
  -- purged, the FILE releases its name — purged_at flips under the same
  -- file-row locks the claim above took, and the partial unique index stops
  -- counting it. The row itself is never deleted: name, sizes, and audit
  -- attribution outlive the bytes (spec §6).
  UPDATE swarm.files AS f
  SET purged_at = statement_timestamp()
  WHERE f.tombstoned_at IS NOT NULL
    AND f.tombstoned_at < statement_timestamp() - interval '30 days'
    AND f.purged_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.file_versions AS v
      WHERE v.file_id = f.file_id
        AND v.workspace_id = f.workspace_id
        AND v.state != 'purged'
    );
END;
$$;

ALTER FUNCTION swarm.purge_file_artifacts() OWNER TO swarm_admin;
-- The definer runs as swarm_admin, which enumerates (never deletes) objects
-- for the orphan sweep.
GRANT USAGE ON SCHEMA storage TO swarm_admin;
GRANT SELECT ON TABLE storage.objects TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_file_artifacts() FROM PUBLIC;

SELECT cron.schedule(
  'swarm_purge_file_artifacts',
  '17 * * * *',
  $$SELECT swarm.purge_file_artifacts()$$
);
