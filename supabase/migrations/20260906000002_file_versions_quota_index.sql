-- Missing index for the file_versions quota SUM in
-- supabase/functions/command/file-artifacts.ts (workspace_id + state, with
-- pending rows further filtered by created_at). Production seq-scanned this
-- table 2.8M times with only the unique (file_id, workspace_id, version_n)
-- index in the path. The existing (workspace_id, state) index does not cover
-- the pending age predicate, so the OR arm seq-scans.

CREATE INDEX IF NOT EXISTS file_versions_workspace_state_created
  ON swarm.file_versions (workspace_id, state, created_at);
