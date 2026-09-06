-- Idle-cost retention for idempotency_keys only.
--
-- Existing job swarm-purge-idempotency-keys stays the only cron. This
-- file replaces the zero-arg purge with a batched loop and shortens
-- claim-class keys (command_id like claim_agent_inbox_%) to
-- claim_idempotency_retention_days (2, floor 2). Other keys keep
-- GREATEST(30, idempotency_retention_days).
--
-- rate_buckets upsert already uses PRIMARY KEY (bucket_key, window_start).
-- Empty polls no longer upsert. Index window_start for the 2-hour purge.

INSERT INTO swarm.config (key, value)
VALUES ('claim_idempotency_retention_days', '2'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(
  batch_size integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  deleted integer;
  retain_days integer;
  claim_days integer;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
  END IF;
  retain_days := GREATEST(
    30,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'idempotency_retention_days'
      ),
      30
    )
  );
  claim_days := GREATEST(
    2,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'claim_idempotency_retention_days'
      ),
      2
    )
  );
  DELETE FROM swarm.idempotency_keys
  WHERE (principal_kind, principal_id, command_id) IN (
    SELECT principal_kind, principal_id, command_id
    FROM swarm.idempotency_keys
    WHERE (
        command_id LIKE 'claim_agent_inbox_%'
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id NOT LIKE 'claim_agent_inbox_%'
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

ALTER FUNCTION swarm.purge_expired_idempotency_keys(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  n integer;
  batches integer := 0;
BEGIN
  LOOP
    n := swarm.purge_expired_idempotency_keys(5000);
    batches := batches + 1;
    EXIT WHEN n = 0 OR batches >= 200;
  END LOOP;
END;
$$;

ALTER FUNCTION swarm.purge_expired_idempotency_keys() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS rate_buckets_window_start
  ON swarm.rate_buckets (window_start);
