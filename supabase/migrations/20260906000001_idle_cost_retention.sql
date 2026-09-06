-- Idle-cost retention.
--
-- swarm.audit_log cannot tell an empty claim_agent_inbox from one that leased
-- a row: both were stored as outcome = 'accepted'. Going forward, empty claims
-- write no row. Historical idle polls are deleted by kind after
-- claim_audit_retention_days (7). Idempotency keys older than their contract
-- window (idempotency_retention_days, at least 30) are deleted in batches.
--
-- The append-only trigger on audit_log blocked DELETE. It now blocks UPDATE
-- only. DELETE is reserved for this SECURITY DEFINER purge, owned by
-- swarm_admin. swarm_command still has INSERT only.

INSERT INTO swarm.config (key, value)
VALUES ('claim_audit_retention_days', '7'::jsonb)
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS audit_log_append_only ON swarm.audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE ON swarm.audit_log
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE INDEX IF NOT EXISTS audit_claim_idle_purge
  ON swarm.audit_log (occurred_at)
  WHERE command_kind = 'claim_agent_inbox';

CREATE OR REPLACE FUNCTION swarm.purge_idle_claim_audit(
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
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
  END IF;
  retain_days := GREATEST(
    7,
    COALESCE(
      (
        SELECT (value #>> '{}')::integer
        FROM swarm.config
        WHERE key = 'claim_audit_retention_days'
      ),
      7
    )
  );
  DELETE FROM swarm.audit_log
  WHERE audit_id IN (
    SELECT audit_id
    FROM swarm.audit_log
    WHERE command_kind = 'claim_agent_inbox'
      AND occurred_at < statement_timestamp() - make_interval(days => retain_days)
    ORDER BY audit_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

ALTER FUNCTION swarm.purge_idle_claim_audit(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_idle_claim_audit(integer) FROM PUBLIC;

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
  DELETE FROM swarm.idempotency_keys
  WHERE (principal_kind, principal_id, command_id) IN (
    SELECT principal_kind, principal_id, command_id
    FROM swarm.idempotency_keys
    WHERE created_at < statement_timestamp() - make_interval(days => retain_days)
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

ALTER FUNCTION swarm.purge_expired_idempotency_keys(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION swarm.purge_idle_cost_tables()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  audit_deleted integer := 0;
  idem_deleted integer := 0;
  n integer;
  batches integer := 0;
BEGIN
  LOOP
    n := swarm.purge_idle_claim_audit(5000);
    audit_deleted := audit_deleted + n;
    batches := batches + 1;
    EXIT WHEN n = 0 OR batches >= 200;
  END LOOP;
  batches := 0;
  LOOP
    n := swarm.purge_expired_idempotency_keys(5000);
    idem_deleted := idem_deleted + n;
    batches := batches + 1;
    EXIT WHEN n = 0 OR batches >= 200;
  END LOOP;
  RETURN jsonb_build_object(
    'audit_log_deleted', audit_deleted,
    'idempotency_keys_deleted', idem_deleted
  );
END;
$$;

ALTER FUNCTION swarm.purge_idle_cost_tables() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_idle_cost_tables() FROM PUBLIC;

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

SELECT cron.schedule(
  'swarm-purge-idle-cost',
  '23 3 * * *',
  'SELECT swarm.purge_idle_cost_tables()'
);
