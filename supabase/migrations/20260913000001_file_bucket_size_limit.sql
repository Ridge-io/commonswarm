-- Bind upload size at storage layer (Item C — docs/design/SWARM-CLOUD.md §2.8).
-- Supabase Storage itself refuses an oversized PUT instead of our code noticing afterwards.
-- Sets file_size_limit on the private swarm-files bucket to 25 MiB (FILE_MAX_VERSION_BYTES = 26214400 bytes).
-- Bound against FILE_MAX_VERSION_BYTES in tests/p1-cli/file-create-rate-limit.test.ts.

UPDATE storage.buckets
SET file_size_limit = 26214400
WHERE id = 'swarm-files';
