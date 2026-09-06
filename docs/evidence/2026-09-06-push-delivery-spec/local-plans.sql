\echo === claim candidates plan ===
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
WITH candidates AS (
  SELECT d.signal_id, d.recipient_agent_principal_id
  FROM swarm.signal_deliveries AS d
  JOIN swarm.signals AS s ON s.id = d.signal_id AND s.workspace_id = d.workspace_id
  WHERE d.workspace_id = '292be0f9-ca5d-43ed-a6f7-31354fe7fe56'::uuid
    AND d.recipient_agent_principal_id = '2121f81d-71c1-44be-ba91-11badb2b02dd'::uuid
    AND d.acked_at IS NULL AND d.lease_id IS NULL AND d.attempt_count < 10
    AND s.until > statement_timestamp()
  ORDER BY d.enqueued_at ASC, d.signal_id ASC
  LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
SELECT * FROM candidates;
\echo === idempotency purge plan ===
EXPLAIN (COSTS OFF) DELETE FROM swarm.idempotency_keys WHERE created_at < now() - interval '1 day';
\echo === audit purge plan ===
EXPLAIN (COSTS OFF) DELETE FROM swarm.audit_log WHERE occurred_at < now() - interval '90 days';
\echo === table sizes local ===
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size('swarm.'||relname)) from pg_stat_user_tables where schemaname='swarm' and relname in ('audit_log','idempotency_keys','signal_deliveries','signals','signal_recipients','file_versions') order by 1;
\echo === is_member ===
select pg_get_functiondef('swarm.is_member'::regproc);
\echo === file_versions indexes ===
select indexdef from pg_indexes where schemaname='swarm' and tablename='file_versions';
\echo === realtime.send signature + grants ===
select pg_get_function_identity_arguments('realtime.send'::regproc);
select grantee, privilege_type from information_schema.routine_privileges where specific_schema='realtime' and routine_name='send';
