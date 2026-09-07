-- Lower idempotency_retention_days floor to 1 day and configure 2 days (L2b).
--
-- Replaces swarm.purge_expired_idempotency_keys(batch_size integer) to lower
-- the floor on general idempotency retention from 30 days to 1 day.
-- Preserves the 2-day floor and regex routing for claim-class idempotency keys
-- from 20260906000001_idle_cost_retention.sql.
-- Sets idempotency_retention_days in swarm.config to 2 days.

INSERT INTO swarm.config (key, value)
VALUES ('idempotency_retention_days', '2'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(
  batch_size integer
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
  claim_id_re text := '^claim_[0-9a-f]{32}_[0-9a-z]+$';
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
  END IF;
  retain_days := GREATEST(
    1,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'idempotency_retention_days'
      ),
      1
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
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
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
