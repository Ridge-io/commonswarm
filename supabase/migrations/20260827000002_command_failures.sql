-- A failed command rolls its transaction back, including its audit and
-- idempotency rows. Keep one small operator-only record after that rollback so
-- a later incident can be diagnosed without relying on platform-log retention.

CREATE TABLE swarm.command_failures (
  failure_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  command_kind text NOT NULL
    CHECK (char_length(command_kind) BETWEEN 1 AND 64),
  reason text NOT NULL
    CHECK (reason IN ('internal_error', 'lock_timeout', 'test_rollback')),
  db_code text
    CHECK (
      db_code IS NULL
      OR char_length(db_code) BETWEEN 1 AND 64
    ),
  detail text NOT NULL
    CHECK (char_length(detail) BETWEEN 1 AND 512),
  request_id uuid NOT NULL
);

CREATE INDEX command_failures_by_time
  ON swarm.command_failures (occurred_at DESC);

ALTER TABLE swarm.command_failures OWNER TO swarm_admin;
ALTER TABLE swarm.command_failures ENABLE ROW LEVEL SECURITY;

-- Private by default. Agents may append one allowlisted diagnostic row but
-- cannot read, update, or delete it; no PostgREST or swarm_read surface exists.
REVOKE ALL ON TABLE swarm.command_failures
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON SEQUENCE swarm.command_failures_failure_id_seq
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT INSERT ON TABLE swarm.command_failures TO swarm_command;
GRANT USAGE ON SEQUENCE swarm.command_failures_failure_id_seq TO swarm_command;

CREATE POLICY command_failure_insert
  ON swarm.command_failures
  FOR INSERT
  TO swarm_command
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION swarm.purge_command_failures()
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  DELETE FROM swarm.command_failures
  WHERE occurred_at < statement_timestamp() - interval '30 days'
$$;

ALTER FUNCTION swarm.purge_command_failures() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_command_failures() FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'swarm-purge-command-failures',
  '53 3 * * *',
  'SELECT swarm.purge_command_failures()'
);
