-- Workspace-brain topics keep one stable name. The newest 20 committed
-- versions stay live; older committed versions are marked retired and keep
-- their storage object so an explicit member read can still resolve them.

ALTER TABLE swarm.file_versions
  DROP CONSTRAINT file_versions_state_check;

ALTER TABLE swarm.file_versions
  ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT file_versions_state_check
    CHECK (state IN ('pending', 'live', 'retired', 'purged')),
  ADD CONSTRAINT file_versions_retired_at_check
    CHECK (state <> 'retired' OR retired_at IS NOT NULL);

CREATE INDEX file_versions_file_state_version
  ON swarm.file_versions (file_id, state, version_n);

-- Additive wire fields. Existing clients ignore them; 0.1.48 brain clients use
-- them to distinguish the rolling live window from retained history.
CREATE OR REPLACE VIEW swarm_read.files
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
    v.committed_at,
    counts.live_version_count,
    counts.retired_version_count
  FROM swarm.files AS f
  LEFT JOIN swarm.file_versions AS v
    ON v.file_id = f.file_id
   AND v.workspace_id = f.workspace_id
   AND v.version_n = f.current_version
   AND v.state = 'live'
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE counted.state = 'live')::integer
        AS live_version_count,
      count(*) FILTER (WHERE counted.state = 'retired')::integer
        AS retired_version_count
    FROM swarm.file_versions AS counted
    WHERE counted.file_id = f.file_id
      AND counted.workspace_id = f.workspace_id
  ) AS counts ON true
  WHERE swarm.is_member(f.workspace_id, auth.uid())
    AND f.purged_at IS NULL;

ALTER VIEW swarm_read.files OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.files TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.files FROM anon;
