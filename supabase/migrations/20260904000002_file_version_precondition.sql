-- Optional compare-and-set for a file version write.
--
-- `brain put` is two phases from the client: create a pending version, PUT the
-- bytes, then commit. `current_version` moves only at commit, so a check taken
-- at create cannot stop two writers who both read version n from both
-- committing; the create lock is released with that transaction. The requested
-- precondition therefore has to survive on the pending row and be re-checked at
-- commit, under the same file lock that create takes.
--
-- NULL means the write asked for no precondition, which stays the default and
-- keeps last-write-wins for every existing client.
ALTER TABLE swarm.file_versions
  ADD COLUMN IF NOT EXISTS if_version integer
    CHECK (if_version IS NULL OR if_version >= 0);

COMMENT ON COLUMN swarm.file_versions.if_version IS
  'Version this write was derived from; re-checked against files.current_version at commit. NULL = unconditional.';
