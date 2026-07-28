-- Capability URLs: the zero-install first touch (spec section 7, "Zero-install
-- first touch — the capability-URL on-ramp").
--
-- A capability URL is a bearer credential that lets a newcomer see ONE named
-- work item in a browser before installing anything. The security envelope is
-- a positive allowlist, never a denylist: this migration is where that
-- allowlist is enforced by PostgreSQL rather than by TypeScript, so that no
-- bug in an edge function can widen the projection.
--
-- Four objects carry that weight and none of them is ceremony:
--   * swarm.capability_urls          - the credential row, tenant-pinned by FK.
--   * swarm.capability_urls_revoke_only() - revocation is the only legal UPDATE.
--   * swarm_capability               - a role with SELECT on nothing at all.
--   * swarm.capability_projection()  - the allowlist, as a function signature.

-- ---------------------------------------------------------------------------
-- (C) The anonymous-serving role.
-- ---------------------------------------------------------------------------

-- Created exactly like swarm_read in 20260723000001: cluster-scoped, NOLOGIN,
-- and granted to the migrating role so a connection can SET LOCAL ROLE to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swarm_capability') THEN
    CREATE ROLE swarm_capability
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

DO $$ BEGIN EXECUTE format('GRANT swarm_capability TO %I', current_user); END $$;

-- Same drift refusal as the three P1 roles: refuse to continue rather than
-- silently serve anonymous traffic from a role that has acquired authority.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'swarm_capability'
      AND (
        rolcanlogin
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR NOT rolinherit
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'swarm_capability has unsafe role attributes';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (A) The table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swarm.capability_urls (
  capability_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  stream_id uuid NOT NULL,
  task_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  created_by uuid NOT NULL REFERENCES swarm.users (user_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  mint_command_id text NOT NULL
    CHECK (mint_command_id ~ '^[A-Za-z0-9_-]{8,72}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES swarm.users (user_id),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '7 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  -- THE IDOR GUARANTEE, at the database. streams_stream_workspace exists for
  -- exactly this composite-FK purpose. A capability row cannot name a stream
  -- belonging to another tenant, and because tasks are keyed by stream it
  -- therefore cannot reach another tenant's work item even if every line of
  -- TypeScript above it were wrong.
  FOREIGN KEY (stream_id, workspace_id)
    REFERENCES swarm.streams (stream_id, workspace_id)
);

-- There is DELIBERATELY NO foreign key on (stream_id, task_id) -> swarm.tasks.
-- swarm.tasks is a rebuildable projection (20260723000001); an FK would make a
-- projection rebuild (delete + reinsert) fail against already-issued links.
-- Integrity is enforced at mint time instead — the mint handler SELECTs the
-- task in-transaction and refuses if it is absent — and at read time the
-- projection's LEFT JOIN simply yields status 'work_item_missing'. Do not
-- "fix" the missing FK.

COMMENT ON TABLE swarm.capability_urls IS
  'Section 7 zero-install capability URLs: one bearer credential scoped to exactly one work item. Every column here is either the tenant pin, the credential digest, the TTL, or the attribution needed for revocation; nothing about the projection served to an anonymous caller is decided in this table, only in swarm.capability_projection().';

COMMENT ON COLUMN swarm.capability_urls.capability_id IS
  'Internal handle for revoke and for audit correlation. Never a credential and never derived from the token, so it is safe to write into swarm.audit_log.credential_id.';
COMMENT ON COLUMN swarm.capability_urls.workspace_id IS
  'The tenant. Envelope rule 7: the row names the tenant, never the request — the read endpoint accepts no tenant selector at all.';
COMMENT ON COLUMN swarm.capability_urls.stream_id IS
  'Half of the work-item key, and the column the composite FK pins to this workspace. Derived server-side at mint from (workspace_id, task_id); never client-selectable.';
COMMENT ON COLUMN swarm.capability_urls.task_id IS
  'The other half. (stream_id, task_id) is the PRIMARY KEY of swarm.tasks, so the pair names exactly one work item — the "one work item, not a tenant''s activity" scope.';
COMMENT ON COLUMN swarm.capability_urls.token_hash IS
  'SHA-256 digest of the full presented swm_cap_ credential, including its prefix; plaintext is never stored.';
COMMENT ON COLUMN swarm.capability_urls.created_by IS
  'The inviter identity the projection is allowed to serve, and the subject of the per-identity mint rate limit.';
COMMENT ON COLUMN swarm.capability_urls.mint_command_id IS
  'Ties this row to its swarm.idempotency_keys entry. swarm.audit_log has no command_id column, so without this a mint audit row cannot be matched to the credential it issued.';
COMMENT ON COLUMN swarm.capability_urls.expires_at IS
  'Envelope rule 4 (TTL <= 7 days) enforced by the CHECK constraints beside it, not only by a constant in Deno. A server bug cannot mint an 8-day link.';
COMMENT ON COLUMN swarm.capability_urls.revoked_by IS
  'Revocation is always attributable to a human; an unattributed revocation would be a hole in G3 attribution, which the (revoked_at IS NULL) = (revoked_by IS NULL) CHECK closes.';

-- No last_read_at / read_count columns: a read counter would force GRANT UPDATE
-- on this table to the anonymous-serving role. Every read already writes one
-- swarm.audit_log row; count them there.

-- 2. UNIQUE (token_hash) is declared inline above: it is the single equality
--    probe the anonymous path performs, and it stops a duplicate-hash row
--    making the projection ambiguous.

-- 3. The per-workspace live-link count (the mint quota) and the owner's
--    list-links operation. Mirrors invitations_live.
CREATE INDEX IF NOT EXISTS capability_urls_live
  ON swarm.capability_urls (workspace_id)
  WHERE revoked_at IS NULL;

-- 4. The per-identity mint rate count. The equivalent per-identity invite count
--    scans swarm.invitations today; do not repeat that here.
CREATE INDEX IF NOT EXISTS capability_urls_by_issuer
  ON swarm.capability_urls (created_by, created_at DESC);

-- 5. Bulk revoke when a work item closes. PostgreSQL does not index FK sources
--    automatically, and on (stream_id, task_id) there is no FK at all.
CREATE INDEX IF NOT EXISTS capability_urls_by_task
  ON swarm.capability_urls (stream_id, task_id)
  WHERE revoked_at IS NULL;

ALTER TABLE swarm.capability_urls OWNER TO swarm_admin;
ALTER TABLE swarm.capability_urls ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- (B) Revocation is the only legal mutation.
-- ---------------------------------------------------------------------------

-- This table cannot use swarm.prevent_append_only_mutation() because revoking
-- needs an UPDATE. Load-bearing, not ceremony: without it an UPDATE could
-- re-point an already-distributed link at a different task_id, and a DELETE
-- could turn a revoked link into a "never existed" row, erasing its issuance
-- history. (The TTL ceiling is safe either way — the CHECK is re-evaluated on
-- UPDATE — but the re-pointing is not.)
CREATE OR REPLACE FUNCTION swarm.capability_urls_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_CAPABILITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.capability_id IS DISTINCT FROM OLD.capability_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.mint_command_id IS DISTINCT FROM OLD.mint_command_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'SWARM_CAPABILITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.capability_urls_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.capability_urls_revoke_only() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'capability_urls_revoke_only'
      AND tgrelid = 'swarm.capability_urls'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER capability_urls_revoke_only
      BEFORE UPDATE OR DELETE ON swarm.capability_urls
      FOR EACH ROW EXECUTE FUNCTION swarm.capability_urls_revoke_only();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (D) swarm.capability_projection - THE ALLOWLIST, ENFORCED BY POSTGRES.
-- ---------------------------------------------------------------------------

-- The single most important object in this migration. The anonymous-serving
-- role holds EXECUTE on this function and SELECT on NO table, so the field
-- allowlist IS the RETURNS TABLE signature below. There is no SQL the
-- capability edge function could be tricked into running that reaches
-- swarm.memberships, swarm.signals, swarm.events, swarm.agent_tokens,
-- swarm.inbox_deliveries, or any column of swarm.users other than the one
-- display_name selected here.
--
-- SECURITY DEFINER runs the body as swarm_admin, the table owner; the schema
-- never sets FORCE ROW LEVEL SECURITY, so the owner bypasses RLS — the same
-- mechanism swarm.is_member already relies on.
--
-- Zero rows returned means the token never existed. One row with status <> 'ok'
-- means it existed and is dead. The HTTP layer collapses both into one uniform
-- response; only the audit row distinguishes them.
CREATE OR REPLACE FUNCTION swarm.capability_projection(p_token_hash bytea)
RETURNS TABLE (
  capability_id uuid,
  workspace_id uuid,
  status text,
  work_item_slug text,
  work_item_lifecycle text,
  repo_full_name text,
  inviter_display_name text,
  workspace_age_days integer,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  WITH resolved AS (
    SELECT
      c.capability_id AS cap_id,
      c.workspace_id AS ws_id,
      c.expires_at AS cap_expires_at,
      t.slug AS src_slug,
      t.lifecycle AS src_lifecycle,
      r.full_name AS src_repo_full_name,
      u.display_name AS src_display_name,
      GREATEST(
        0,
        floor(extract(epoch FROM statement_timestamp() - w.created_at) / 86400)
      )::integer AS src_age_days,
      -- THE STATUS PRECEDENCE ORDER IS NORMATIVE. A link that is both revoked
      -- and expired audits as 'revoked'. Without a pinned order, four
      -- implementers produce four different audit reasons for the same row.
      CASE
        WHEN c.revoked_at IS NOT NULL THEN 'revoked'
        WHEN c.expires_at <= statement_timestamp() THEN 'expired'
        WHEN w.archived_at IS NOT NULL THEN 'workspace_archived'
        -- Section 5 three-layer revocation: the capability dies when its
        -- issuer's membership dies. swarm.is_member needs no grant to
        -- swarm_capability — it is called from inside a definer function
        -- already running as swarm_admin. Do not grant it.
        WHEN NOT swarm.is_member(c.workspace_id, c.created_by) THEN 'issuer_revoked'
        WHEN t.task_id IS NULL THEN 'work_item_missing'
        ELSE 'ok'
      END AS cap_status
    FROM swarm.capability_urls AS c
    -- Written as ON, not USING: every RETURNS TABLE column above is an output
    -- parameter name in scope inside this body, so an unqualified
    -- USING (workspace_id) would collide with the workspace_id output
    -- parameter. Every column reference in this function is qualified.
    JOIN swarm.workspaces AS w
      ON w.workspace_id = c.workspace_id
    LEFT JOIN swarm.tasks AS t
      ON t.stream_id = c.stream_id
     AND t.task_id = c.task_id
    LEFT JOIN swarm.streams AS s
      ON s.stream_id = c.stream_id
     AND s.workspace_id = c.workspace_id
    -- repo_full_name is NULL when the work item lives on the workspace stream
    -- (streams.repo_mapping_id IS NULL). That is a normal state, not an error.
    LEFT JOIN swarm.repositories AS r
      ON r.repo_mapping_id = s.repo_mapping_id
     AND r.workspace_id = c.workspace_id
     AND r.archived_at IS NULL
    LEFT JOIN swarm.users AS u
      ON u.user_id = c.created_by
    WHERE c.token_hash = p_token_hash
  )
  SELECT
    res.cap_id,
    res.ws_id,
    res.cap_status,
    CASE WHEN res.cap_status = 'ok' THEN res.src_slug END,
    CASE WHEN res.cap_status = 'ok' THEN res.src_lifecycle END,
    CASE WHEN res.cap_status = 'ok' THEN res.src_repo_full_name END,
    CASE WHEN res.cap_status = 'ok' THEN res.src_display_name END,
    CASE WHEN res.cap_status = 'ok' THEN res.src_age_days END,
    CASE WHEN res.cap_status = 'ok' THEN res.cap_expires_at END
  FROM resolved AS res
$$;

COMMENT ON FUNCTION swarm.capability_projection(bytea) IS
  'The section 7 per-URL field allowlist, expressed as a function signature so PostgreSQL enforces it. capability_id and workspace_id are returned for the AUDIT ROW ONLY and must never be copied into an HTTP body.';

ALTER FUNCTION swarm.capability_projection(bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.capability_projection(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.capability_projection(bytea) TO swarm_capability;

-- ---------------------------------------------------------------------------
-- (E) The grant matrix.
-- ---------------------------------------------------------------------------

-- Deny direct access to the PostgREST roles first, exactly as the signals
-- migration closes. No swarm_read view is created over this table, so anon
-- gains nothing anywhere.
REVOKE ALL ON TABLE swarm.capability_urls FROM PUBLIC, anon, authenticated;

-- swarm_command is the mint/revoke path. It already holds INSERT on
-- swarm.revocation_tombstones, swarm.audit_log and swarm.security_alerts, and
-- SELECT/INSERT/UPDATE on swarm.rate_buckets, so nothing new is needed there.
GRANT SELECT, INSERT, UPDATE ON swarm.capability_urls TO swarm_command;

-- swarm_capability is the anonymous read path. What follows is the COMPLETE
-- list of its privileges. It has SELECT on no table whatsoever — the only way
-- it reaches tenant data is swarm.capability_projection(), granted above.
GRANT USAGE ON SCHEMA swarm TO swarm_capability;
GRANT INSERT ON swarm.audit_log TO swarm_capability;
GRANT INSERT ON swarm.security_alerts TO swarm_capability;
GRANT SELECT, INSERT, UPDATE ON swarm.rate_buckets TO swarm_capability;
GRANT USAGE ON SEQUENCE
  swarm.audit_log_audit_id_seq,
  swarm.security_alerts_alert_id_seq
TO swarm_capability;

-- EXPLICITLY NOT GRANTED to swarm_capability, named here so that a future
-- migration cannot add one absent-mindedly: memberships, signals, events,
-- tasks, streams, repositories, users, workspaces, capability_urls,
-- invitations, devices, agent_principals, agent_runs, agent_tokens, leases,
-- grants, grant_consumptions, idempotency_keys, inbox_deliveries,
-- github_installations, renewal_grants, revocation_tombstones, config, and
-- every view in schema swarm_read (it does not even hold USAGE on that schema).
-- Launch test, with both arms in one invocation or the instrument is untested:
-- as swarm_capability, SELECT 1 FROM swarm.memberships LIMIT 1 must raise
-- 42501 insufficient_privilege, and SELECT * FROM
-- swarm.capability_projection($1) must succeed in the same session.

-- PostgreSQL has no CREATE POLICY IF NOT EXISTS. Keep the set explicit and
-- guarded, as 20260723000001 does.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE p.polname = 'swarm_command_all'
      AND n.nspname = 'swarm'
      AND c.relname = 'capability_urls'
  ) THEN
    CREATE POLICY swarm_command_all ON swarm.capability_urls
      AS PERMISSIVE FOR ALL TO swarm_command
      USING (true) WITH CHECK (true);
  END IF;

  -- RLS is enabled on audit_log, security_alerts and rate_buckets, so the
  -- table grants above are not sufficient on their own: swarm_capability
  -- needs its own policies. They are append-only inserts and one bucket
  -- upsert; the table grants remain the independent privilege boundary.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE p.polname = 'swarm_capability_insert'
      AND n.nspname = 'swarm'
      AND c.relname = 'audit_log'
  ) THEN
    CREATE POLICY swarm_capability_insert ON swarm.audit_log
      AS PERMISSIVE FOR INSERT TO swarm_capability
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE p.polname = 'swarm_capability_insert'
      AND n.nspname = 'swarm'
      AND c.relname = 'security_alerts'
  ) THEN
    CREATE POLICY swarm_capability_insert ON swarm.security_alerts
      AS PERMISSIVE FOR INSERT TO swarm_capability
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS p
    JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE p.polname = 'swarm_capability_all'
      AND n.nspname = 'swarm'
      AND c.relname = 'rate_buckets'
  ) THEN
    CREATE POLICY swarm_capability_all ON swarm.rate_buckets
      AS PERMISSIVE FOR ALL TO swarm_capability
      USING (true) WITH CHECK (true);
  END IF;
END
$$;
