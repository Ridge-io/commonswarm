-- Outer upload size bound at storage layer (Item C — docs/design/SWARM-CLOUD.md §2.8).
-- Supabase Storage itself refuses an upload exceeding the bucket limit (25 MiB = 26214400 bytes).
-- Note: signed upload URLs do not bind per-URL size or digest; the bucket limit provides the
-- outer maximum bound, while commit refuses an object larger than declared; an object smaller
-- than its declaration is accepted rather than refused because the declaration gated quota.
-- Bound against FILE_MAX_VERSION_BYTES in tests/p1-cli/file-create-rate-limit.test.ts.

DO $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE storage.buckets
  SET file_size_limit = 26214400
  WHERE id = 'swarm-files';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 row updated in storage.buckets for id = swarm-files, got %', v_rows;
  END IF;
END $$;
