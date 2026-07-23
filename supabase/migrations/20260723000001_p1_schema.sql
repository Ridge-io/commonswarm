-- SWARM P1 private authority schema and membership-filtered read surface.
-- Application command orchestration intentionally lives outside this migration.

-- Roles are cluster-scoped and survive a local database reset, so make their
-- creation idempotent without making any schema object idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swarm_admin') THEN
    CREATE ROLE swarm_admin
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE swarm_admin
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swarm_command') THEN
    -- The password is provisioned out-of-band. No credential belongs in a migration.
    CREATE ROLE swarm_command
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE swarm_command
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swarm_read') THEN
    CREATE ROLE swarm_read
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE swarm_read
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE swarm_command SET search_path = swarm, pg_catalog;

CREATE SCHEMA swarm AUTHORIZATION swarm_admin;
CREATE SCHEMA swarm_read AUTHORIZATION swarm_admin;

REVOKE ALL ON SCHEMA swarm FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SCHEMA swarm_read FROM anon, authenticated, PUBLIC;

-- Global identity: these rows intentionally do not carry workspace_id.
CREATE TABLE swarm.users (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE swarm.devices (
  device_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES swarm.users (user_id),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  last_seen_at timestamptz
);

-- Tenancy.
CREATE TABLE swarm.workspaces (
  workspace_id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES swarm.users (user_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz
);

CREATE TABLE swarm.memberships (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  user_id uuid NOT NULL REFERENCES swarm.users (user_id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by uuid,
  joined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX memberships_by_user
  ON swarm.memberships (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE swarm.invitations (
  invitation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  email text,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  consumed_at timestamptz,
  consumed_by uuid,
  revoked_at timestamptz
);

COMMENT ON COLUMN swarm.invitations.email IS
  'Bookkeeping and invite-page rendering only; never an authorization input.';
COMMENT ON COLUMN swarm.invitations.token_hash IS
  'SHA-256 digest of the full presented swm_inv_ credential, including its prefix; plaintext is never stored.';

CREATE INDEX invitations_live
  ON swarm.invitations (workspace_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Agent identity and credential state.
CREATE TABLE swarm.agent_principals (
  principal_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  owner_user_id uuid NOT NULL REFERENCES swarm.users (user_id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, name)
);

CREATE TABLE swarm.agent_runs (
  run_id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES swarm.agent_principals (principal_id),
  device_id uuid NOT NULL REFERENCES swarm.devices (device_id),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz
);

CREATE TABLE swarm.agent_tokens (
  token_id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES swarm.agent_principals (principal_id),
  run_id uuid NOT NULL REFERENCES swarm.agent_runs (run_id),
  task_id uuid,
  epoch integer,
  scopes jsonb NOT NULL,
  token_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  surrender_only boolean NOT NULL DEFAULT false,
  predecessor_token_id uuid REFERENCES swarm.agent_tokens (token_id),
  renewal_grant_id uuid,
  lineage_id uuid NOT NULL
);

COMMENT ON COLUMN swarm.agent_tokens.token_hash IS
  'SHA-256 digest of the full presented swm_agt_ credential, including its prefix; plaintext is never stored.';

CREATE INDEX agent_tokens_by_principal
  ON swarm.agent_tokens (principal_id);
CREATE INDEX agent_tokens_by_lineage
  ON swarm.agent_tokens (lineage_id);

CREATE TABLE swarm.revocation_tombstones (
  kind text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  PRIMARY KEY (kind, target_id)
);

CREATE TABLE swarm.renewal_grants (
  renewal_grant_id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL,
  max_successors integer NOT NULL,
  successors_used integer NOT NULL DEFAULT 0,
  horizon_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- GitHub installations and workspace repository mappings.
CREATE TABLE swarm.github_installations (
  installation_row_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  github_installation_id bigint NOT NULL UNIQUE,
  suspended_at timestamptz
);

CREATE TABLE swarm.repositories (
  repo_mapping_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  github_repository_id bigint NOT NULL,
  installation_row_id uuid NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL,
  landing_authority_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (workspace_id, github_repository_id)
);

-- Independent workspace and repository streams.
CREATE TABLE swarm.streams (
  stream_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  kind text NOT NULL CHECK (kind IN ('workspace', 'repo')),
  repo_mapping_id uuid REFERENCES swarm.repositories (repo_mapping_id),
  head_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE UNIQUE INDEX one_workspace_stream
  ON swarm.streams (workspace_id)
  WHERE kind = 'workspace';
CREATE UNIQUE INDEX one_repo_stream
  ON swarm.streams (repo_mapping_id)
  WHERE kind = 'repo';

-- Required by the composite tenant-pinning foreign keys below.
CREATE UNIQUE INDEX streams_stream_workspace
  ON swarm.streams (stream_id, workspace_id);

-- Canonical append-only history. Per-stream seq is transactionally allocated
-- under a FOR UPDATE lock on streams; no PostgreSQL SEQUENCE is used because
-- sequence increments do not roll back.
CREATE TABLE swarm.events (
  workspace_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  seq bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  command_id text NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL,
  actor_user uuid,
  actor_agent_principal uuid,
  actor_run uuid,
  occurred_at_server timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp())
    CHECK (occurred_at_server = date_trunc('milliseconds', occurred_at_server)),
  payload jsonb NOT NULL
    CHECK (octet_length(payload::text) <= 65536),
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id, workspace_id)
    REFERENCES swarm.streams (stream_id, workspace_id)
);

COMMENT ON COLUMN swarm.events.occurred_at_server IS
  'statement_timestamp() floored with date_trunc(''milliseconds'', ...); never rounded or client-supplied.';

CREATE INDEX events_by_workspace
  ON swarm.events (workspace_id, stream_id, seq);

-- Rebuildable projections.
CREATE TABLE swarm.tasks (
  workspace_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  task_id uuid NOT NULL,
  slug text NOT NULL,
  lifecycle text NOT NULL,
  version integer NOT NULL,
  epoch integer NOT NULL,
  owner text,
  lease_expiry timestamptz,
  submission jsonb,
  closed_disposition text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (stream_id, task_id),
  UNIQUE (stream_id, slug),
  FOREIGN KEY (stream_id, workspace_id)
    REFERENCES swarm.streams (stream_id, workspace_id)
);

CREATE INDEX tasks_board
  ON swarm.tasks (workspace_id, lifecycle);

CREATE TABLE swarm.leases (
  stream_id uuid NOT NULL REFERENCES swarm.streams (stream_id),
  task_id uuid NOT NULL,
  epoch integer NOT NULL,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL,
  lease_expiry timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (stream_id, task_id, epoch)
);

CREATE TABLE swarm.grants (
  grant_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  type text NOT NULL
    CHECK (type IN ('takeover', 'merge', 'override-close', 'admin-op')),
  task_id uuid,
  binding jsonb NOT NULL,
  issued_by uuid NOT NULL,
  issued_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (stream_id, workspace_id)
    REFERENCES swarm.streams (stream_id, workspace_id)
);

CREATE TABLE swarm.grant_consumptions (
  grant_id uuid PRIMARY KEY REFERENCES swarm.grants (grant_id),
  consumed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  command_id text NOT NULL,
  event_id uuid NOT NULL
);

-- Idempotency is namespaced by principal kind and additionally stream-bound as
-- required by the routing-field augmentation in the approved spec.
CREATE TABLE swarm.idempotency_keys (
  principal_kind text NOT NULL CHECK (principal_kind IN ('user', 'agent')),
  principal_id text NOT NULL,
  command_id text NOT NULL,
  workspace_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal_kind, principal_id, command_id)
);

CREATE INDEX idem_purge
  ON swarm.idempotency_keys (created_at);

-- Append-only audit and security signals.
CREATE TABLE swarm.audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  actor_user uuid,
  actor_agent_principal uuid,
  actor_run uuid,
  credential_kind text,
  credential_id uuid,
  device_id uuid,
  command_kind text NOT NULL,
  workspace_id uuid,
  stream_id uuid,
  outcome text NOT NULL,
  reason text,
  detail text,
  request_hash text,
  ip inet
);

CREATE INDEX audit_by_ws
  ON swarm.audit_log (workspace_id, occurred_at DESC);
CREATE INDEX audit_by_cred
  ON swarm.audit_log (credential_id, occurred_at DESC);

CREATE TABLE swarm.security_alerts (
  alert_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  kind text NOT NULL,
  subject text NOT NULL,
  detail jsonb NOT NULL
);

CREATE TABLE swarm.rate_buckets (
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- P1 substrate only; messaging commands remain deferred.
CREATE TABLE swarm.inbox_deliveries (
  message_event_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recipient_principal text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  delivered_at timestamptz,
  acked_at timestamptz,
  PRIMARY KEY (message_event_id, recipient_principal)
);

CREATE TABLE swarm.config (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO swarm.config (key, value)
VALUES
  ('min_client_version', '"0.1.0"'::jsonb),
  ('idempotency_retention_days', '30'::jsonb);

-- Everything in the private and exposed schemas is owned by the non-login
-- administration role. Indexes follow their parent table ownership.
ALTER TABLE swarm.users OWNER TO swarm_admin;
ALTER TABLE swarm.devices OWNER TO swarm_admin;
ALTER TABLE swarm.workspaces OWNER TO swarm_admin;
ALTER TABLE swarm.memberships OWNER TO swarm_admin;
ALTER TABLE swarm.invitations OWNER TO swarm_admin;
ALTER TABLE swarm.agent_principals OWNER TO swarm_admin;
ALTER TABLE swarm.agent_runs OWNER TO swarm_admin;
ALTER TABLE swarm.agent_tokens OWNER TO swarm_admin;
ALTER TABLE swarm.revocation_tombstones OWNER TO swarm_admin;
ALTER TABLE swarm.renewal_grants OWNER TO swarm_admin;
ALTER TABLE swarm.github_installations OWNER TO swarm_admin;
ALTER TABLE swarm.repositories OWNER TO swarm_admin;
ALTER TABLE swarm.streams OWNER TO swarm_admin;
ALTER TABLE swarm.events OWNER TO swarm_admin;
ALTER TABLE swarm.tasks OWNER TO swarm_admin;
ALTER TABLE swarm.leases OWNER TO swarm_admin;
ALTER TABLE swarm.grants OWNER TO swarm_admin;
ALTER TABLE swarm.grant_consumptions OWNER TO swarm_admin;
ALTER TABLE swarm.idempotency_keys OWNER TO swarm_admin;
ALTER TABLE swarm.audit_log OWNER TO swarm_admin;
ALTER TABLE swarm.security_alerts OWNER TO swarm_admin;
ALTER TABLE swarm.rate_buckets OWNER TO swarm_admin;
ALTER TABLE swarm.inbox_deliveries OWNER TO swarm_admin;
ALTER TABLE swarm.config OWNER TO swarm_admin;

-- RLS deny-by-default for PostgREST roles: anon and authenticated intentionally
-- receive no authority-table policies. The command role's exception is explicit
-- and auditable below; table grants remain the independent privilege boundary.
ALTER TABLE swarm.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.revocation_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.renewal_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.grant_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.security_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.inbox_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.config ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.users
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.devices
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.workspaces
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.memberships
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.invitations
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.agent_principals
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.agent_runs
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.agent_tokens
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.revocation_tombstones
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.renewal_grants
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.github_installations
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.repositories
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.streams
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.events
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.tasks
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.leases
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.grants
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.grant_consumptions
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.idempotency_keys
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.audit_log
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.security_alerts
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.rate_buckets
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.inbox_deliveries
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.config
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);

-- Backstop append-only behavior even if a future migration grants mutation.
CREATE FUNCTION swarm.prevent_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'SWARM_APPEND_ONLY' USING ERRCODE = '55000';
END
$$;

ALTER FUNCTION swarm.prevent_append_only_mutation() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.prevent_append_only_mutation() FROM PUBLIC;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON swarm.events
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON swarm.audit_log
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

-- Shared membership predicate for every tenant-scoped human read.
CREATE FUNCTION swarm.is_member(p_workspace uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace
      AND m.user_id = p_user
      AND m.revoked_at IS NULL
  )
$$;

ALTER FUNCTION swarm.is_member(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.is_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.is_member(uuid, uuid)
  TO authenticated, swarm_command, swarm_read;

-- Owner-pinned views carry their authorization predicates in-view. Security
-- barriers keep caller-supplied PostgREST filters outside those predicates.
CREATE VIEW swarm_read.tasks
WITH (security_barrier = true)
AS
  SELECT t.*
  FROM swarm.tasks AS t
  WHERE swarm.is_member(t.workspace_id, auth.uid());

CREATE VIEW swarm_read.events
WITH (security_barrier = true)
AS
  SELECT e.*
  FROM swarm.events AS e
  WHERE swarm.is_member(e.workspace_id, auth.uid());

CREATE VIEW swarm_read.memberships
WITH (security_barrier = true)
AS
  SELECT m.*
  FROM swarm.memberships AS m
  WHERE swarm.is_member(m.workspace_id, auth.uid());

CREATE VIEW swarm_read.repositories
WITH (security_barrier = true)
AS
  SELECT r.*
  FROM swarm.repositories AS r
  WHERE swarm.is_member(r.workspace_id, auth.uid());

CREATE VIEW swarm_read.leases
WITH (security_barrier = true)
AS
  SELECT l.*
  FROM swarm.leases AS l
  JOIN swarm.streams AS s USING (stream_id)
  WHERE swarm.is_member(s.workspace_id, auth.uid());

CREATE VIEW swarm_read.my_devices
WITH (security_barrier = true)
AS
  SELECT d.*
  FROM swarm.devices AS d
  WHERE d.user_id = auth.uid();

CREATE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  SELECT p.*
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid());

CREATE VIEW swarm_read.agent_runs
WITH (security_barrier = true)
AS
  SELECT r.*
  FROM swarm.agent_runs AS r
  JOIN swarm.agent_principals AS p USING (principal_id)
  WHERE swarm.is_member(p.workspace_id, auth.uid());

CREATE VIEW swarm_read.audit_log
WITH (security_barrier = true)
AS
  SELECT a.*
  FROM swarm.audit_log AS a
  WHERE swarm.is_member(a.workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM swarm.memberships AS m
      WHERE m.workspace_id = a.workspace_id
        AND m.user_id = auth.uid()
        AND m.revoked_at IS NULL
        AND m.role IN ('owner', 'admin')
    );

ALTER VIEW swarm_read.tasks OWNER TO swarm_admin;
ALTER VIEW swarm_read.events OWNER TO swarm_admin;
ALTER VIEW swarm_read.memberships OWNER TO swarm_admin;
ALTER VIEW swarm_read.repositories OWNER TO swarm_admin;
ALTER VIEW swarm_read.leases OWNER TO swarm_admin;
ALTER VIEW swarm_read.my_devices OWNER TO swarm_admin;
ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
ALTER VIEW swarm_read.agent_runs OWNER TO swarm_admin;
ALTER VIEW swarm_read.audit_log OWNER TO swarm_admin;

-- Deny direct authority-table access to PostgREST roles.
REVOKE ALL ON ALL TABLES IN SCHEMA swarm FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA swarm FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA swarm
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE swarm_admin IN SCHEMA swarm
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- Exact swarm_command table privilege matrix from section 2.2.
GRANT USAGE ON SCHEMA swarm TO swarm_command;

GRANT SELECT ON
  swarm.users,
  swarm.devices,
  swarm.workspaces,
  swarm.memberships,
  swarm.invitations,
  swarm.agent_principals,
  swarm.agent_runs,
  swarm.agent_tokens,
  swarm.revocation_tombstones,
  swarm.renewal_grants,
  swarm.github_installations,
  swarm.repositories,
  swarm.streams,
  swarm.tasks,
  swarm.leases,
  swarm.grants,
  swarm.grant_consumptions,
  swarm.idempotency_keys,
  swarm.config
TO swarm_command;

GRANT INSERT ON
  swarm.events,
  swarm.audit_log,
  swarm.security_alerts,
  swarm.grant_consumptions,
  swarm.leases,
  swarm.inbox_deliveries
TO swarm_command;

GRANT INSERT, UPDATE ON
  swarm.streams,
  swarm.tasks,
  swarm.memberships,
  swarm.invitations,
  swarm.agent_principals,
  swarm.agent_runs,
  swarm.agent_tokens,
  swarm.renewal_grants,
  swarm.repositories,
  swarm.grants,
  swarm.idempotency_keys,
  swarm.rate_buckets,
  swarm.workspaces,
  swarm.devices,
  swarm.users
TO swarm_command;

-- Section 3.2 step 13 requires tombstone inserts for workspace-command
-- projection writes (the revocation commands enumerated in section 3.4).
GRANT INSERT ON swarm.revocation_tombstones TO swarm_command;

-- Section 3.2 step 12 requires updating the current lease row on LeaseRenewed.
GRANT UPDATE ON swarm.leases TO swarm_command;

-- Section 3.2 step 4½ requires reading the rate-bucket count returned by the
-- atomic INSERT ... ON CONFLICT DO UPDATE rate-limit operation.
GRANT SELECT ON swarm.rate_buckets TO swarm_command;

-- Identity columns need sequence usage for the two permitted append paths.
GRANT USAGE ON SEQUENCE
  swarm.audit_log_audit_id_seq,
  swarm.security_alerts_alert_id_seq
TO swarm_command;

-- Human PostgREST access is limited to the exposed read schema. The standalone
-- swarm_read role mirrors that read-only surface for non-PostgREST consumers.
GRANT USAGE ON SCHEMA swarm_read TO authenticated, swarm_read;
GRANT SELECT ON ALL TABLES IN SCHEMA swarm_read TO authenticated, swarm_read;

-- No read privilege is granted to anon.
REVOKE ALL ON ALL TABLES IN SCHEMA swarm_read FROM anon;

-- Retention jobs: authority events are never purged; audit rows are never
-- purged here. Audit archival after at least one year is an external operation.
CREATE FUNCTION swarm.purge_expired_idempotency_keys()
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  DELETE FROM swarm.idempotency_keys
  WHERE created_at
    < statement_timestamp()
      - make_interval(
          days => GREATEST(
            30,
            COALESCE(
              (
                SELECT (value #>> '{}')::integer
                FROM swarm.config
                WHERE key = 'idempotency_retention_days'
              ),
              30
            )
          )
        )
$$;

ALTER FUNCTION swarm.purge_expired_idempotency_keys() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_idempotency_keys() FROM PUBLIC;

CREATE FUNCTION swarm.purge_expired_rate_buckets()
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  DELETE FROM swarm.rate_buckets
  WHERE window_start < statement_timestamp() - interval '2 hours'
$$;

ALTER FUNCTION swarm.purge_expired_rate_buckets() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_rate_buckets() FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'swarm-purge-idempotency-keys',
  '17 3 * * *',
  'SELECT swarm.purge_expired_idempotency_keys()'
);

SELECT cron.schedule(
  'swarm-purge-rate-buckets',
  '42 * * * *',
  'SELECT swarm.purge_expired_rate_buckets()'
);
