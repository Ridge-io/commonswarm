-- Standing grants: permanent agent authority without a permanent bearer.
-- Spec: docs/design/2026-08-31-STANDING-GRANTS.md.
--
-- The existing renewal_grants row is promoted rather than duplicated. Its
-- horizon and successor ceiling become nullable for standing grants:
--   timeboxed -> horizon_expires_at and max_successors are both present
--   standing  -> both are NULL (no horizon and unlimited successors)
-- Existing rows normalize to timeboxed and keep their current values.

ALTER TABLE swarm.renewal_grants
  ALTER COLUMN horizon_expires_at DROP NOT NULL,
  ALTER COLUMN max_successors DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'timeboxed',
  ADD COLUMN IF NOT EXISTS bound_device_id uuid,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_device_id uuid,
  ADD COLUMN IF NOT EXISTS last_used_from text,
  ADD COLUMN IF NOT EXISTS new_host_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

UPDATE swarm.renewal_grants
SET kind = 'timeboxed'
WHERE kind IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_bound_device_fkey'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_bound_device_fkey
      FOREIGN KEY (bound_device_id) REFERENCES swarm.devices (device_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'renewal_grants_last_used_device_fkey'
      AND conrelid = 'swarm.renewal_grants'::regclass
  ) THEN
    ALTER TABLE swarm.renewal_grants
      ADD CONSTRAINT renewal_grants_last_used_device_fkey
      FOREIGN KEY (last_used_device_id) REFERENCES swarm.devices (device_id);
  END IF;
END
$$;

-- Replace the old unconditional horizon/counter checks with kind-aware ones.
ALTER TABLE swarm.renewal_grants
  DROP CONSTRAINT IF EXISTS renewal_grants_horizon_positive,
  DROP CONSTRAINT IF EXISTS renewal_grants_horizon_ceiling,
  DROP CONSTRAINT IF EXISTS renewal_grants_max_successors_positive,
  DROP CONSTRAINT IF EXISTS renewal_grants_successors_bounded;

ALTER TABLE swarm.renewal_grants
  ADD CONSTRAINT renewal_grants_kind_valid
    CHECK (kind IN ('timeboxed', 'standing')),
  ADD CONSTRAINT renewal_grants_kind_shape
    CHECK (
      (kind = 'timeboxed' AND horizon_expires_at IS NOT NULL AND max_successors IS NOT NULL)
      OR
      (kind = 'standing' AND horizon_expires_at IS NULL AND max_successors IS NULL)
    ),
  ADD CONSTRAINT renewal_grants_horizon_positive
    CHECK (kind = 'standing' OR horizon_expires_at > created_at),
  ADD CONSTRAINT renewal_grants_horizon_ceiling
    CHECK (
      kind = 'standing'
      OR horizon_expires_at <= created_at + interval '90 days'
    ),
  ADD CONSTRAINT renewal_grants_max_successors_positive
    CHECK (kind = 'standing' OR max_successors > 0),
  ADD CONSTRAINT renewal_grants_successors_bounded
    CHECK (
      successors_used >= 0
      AND successors_stranded >= 0
      AND successors_stranded <= successors_used
      AND (
        max_successors IS NULL
        OR successors_used - successors_stranded <= max_successors
      )
    ),
  ADD CONSTRAINT renewal_grants_last_used_from_bounded
    CHECK (last_used_from IS NULL OR char_length(last_used_from) BETWEEN 1 AND 200);

COMMENT ON COLUMN swarm.renewal_grants.kind IS
  'timeboxed keeps the existing bounded horizon; standing has no horizon but still issues only short-lived successor bearers.';
COMMENT ON COLUMN swarm.renewal_grants.max_successors IS
  'Timeboxed successor ceiling. NULL means unlimited and is valid only for a standing grant.';
COMMENT ON COLUMN swarm.renewal_grants.horizon_expires_at IS
  'Timeboxed continuous-renewal horizon. NULL means no horizon and is valid only for a standing grant.';
COMMENT ON COLUMN swarm.renewal_grants.bound_device_id IS
  'Device binding for renewal. Standing mint binds to the minting run device by default; timeboxed grants remain portable.';
COMMENT ON COLUMN swarm.renewal_grants.last_used_at IS
  'Last successful authenticated use of a token under this grant. NULL means no measured use.';
COMMENT ON COLUMN swarm.renewal_grants.last_used_device_id IS
  'Device identity carried by agent_runs on the last measured use. It is not a hardware fingerprint.';
COMMENT ON COLUMN swarm.renewal_grants.last_used_from IS
  'Optional host fingerprint supplied by a trusted caller. Never an IP address; NULL when no honest fingerprint reaches the server.';
COMMENT ON COLUMN swarm.renewal_grants.new_host_at IS
  'First measured use from a device other than the binding or prior measured device.';
COMMENT ON COLUMN swarm.renewal_grants.suspended_at IS
  'One-way lazy idle suspension. Standing renewal sets it after more than 14 days without measured use.';

-- Grants may spend, record use, suspend, and revoke. Authority fields remain
-- immutable, counters and timestamps remain monotone, and one-way state cannot
-- be cleared.
CREATE OR REPLACE FUNCTION swarm.renewal_grants_spend_or_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNDELETABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.max_successors IS DISTINCT FROM OLD.max_successors
    OR NEW.horizon_expires_at IS DISTINCT FROM OLD.horizon_expires_at
    OR NEW.bound_device_id IS DISTINCT FROM OLD.bound_device_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.successors_used < OLD.successors_used THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_COUNTER_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.successors_stranded < OLD.successors_stranded THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_STRANDED_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.last_used_at IS NOT NULL
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LAST_USE_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.last_used_device_id IS DISTINCT FROM OLD.last_used_device_id
    OR NEW.last_used_from IS DISTINCT FROM OLD.last_used_from
  ) AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP' USING ERRCODE = '55000';
  END IF;
  IF OLD.new_host_at IS NOT NULL
     AND NEW.new_host_at IS DISTINCT FROM OLD.new_host_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_NEW_HOST_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNSUSPEND' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNREVOKE' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_spend_or_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() FROM PUBLIC;

-- Lazy checks that must leave state behind use a normal statement before the
-- successor INSERT. Raising inside the INSERT trigger would roll the suspension
-- or new-host stamp back with the refused statement.
CREATE OR REPLACE FUNCTION swarm.prepare_renewal_grant(
  p_renewal_grant_id uuid,
  p_device_id uuid
)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
BEGIN
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF grant_row.suspended_at IS NOT NULL THEN
    RETURN 'renewal_grant_suspended';
  END IF;

  IF grant_row.kind = 'standing'
     AND COALESCE(grant_row.last_used_at, grant_row.created_at)
       < statement_timestamp() - interval '14 days'
  THEN
    UPDATE swarm.renewal_grants
    SET suspended_at = statement_timestamp()
    WHERE renewal_grant_id = grant_row.renewal_grant_id
      AND suspended_at IS NULL;
    RETURN 'renewal_idle_suspended';
  END IF;

  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RETURN 'renewal_horizon_reached';
  END IF;

  IF grant_row.bound_device_id IS NOT NULL AND p_device_id IS NULL THEN
    RETURN 'renewal_device_unavailable';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
    RETURN 'renewal_device_mismatch';
  END IF;
  IF grant_row.last_used_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
  END IF;

  RETURN NULL;
END
$$;

ALTER FUNCTION swarm.prepare_renewal_grant(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) TO swarm_command;

-- Record a successful non-renewal use. The token id was already authenticated
-- by the calling edge; this function derives the grant and never accepts one.
CREATE OR REPLACE FUNCTION swarm.record_renewal_grant_use(
  p_token_id uuid,
  p_device_id uuid,
  p_last_used_from text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  UPDATE swarm.renewal_grants AS grant_row
  SET last_used_at = statement_timestamp(),
      last_used_device_id = p_device_id,
      last_used_from = COALESCE(p_last_used_from, grant_row.last_used_from),
      new_host_at = CASE
        WHEN grant_row.new_host_at IS NOT NULL THEN grant_row.new_host_at
        WHEN grant_row.bound_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
          THEN statement_timestamp()
        WHEN grant_row.last_used_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  FROM swarm.agent_tokens AS token
  WHERE token.token_id = p_token_id
    AND token.renewal_grant_id = grant_row.renewal_grant_id
    AND grant_row.revoked_at IS NULL
    AND grant_row.suspended_at IS NULL;
END;
$$;

ALTER FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  TO swarm_command, swarm_read;

-- Database backstop for every successor writer. The edge preflight above owns
-- persistent lazy-state changes; this trigger independently owns the issuance
-- invariants and the successful-use stamp in the same statement as the token.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_successor_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  pred swarm.agent_tokens%ROWTYPE;
  grant_row swarm.renewal_grants%ROWTYPE;
  owner_user uuid;
  run_device uuid;
  run_ended timestamptz;
  principal_revoked timestamptz;
  device_revoked timestamptz;
BEGIN
  NEW.issued_at := statement_timestamp();

  SELECT * INTO pred
  FROM swarm.agent_tokens
  WHERE token_id = NEW.predecessor_token_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM pred.principal_id
    OR NEW.run_id IS DISTINCT FROM pred.run_id
    OR NEW.task_id IS DISTINCT FROM pred.task_id
    OR NEW.epoch IS DISTINCT FROM pred.epoch
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TARGET_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NEW.lineage_id IS DISTINCT FROM pred.lineage_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.renewal_grant_id IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_UNGRANTED_PREDECESSOR' USING ERRCODE = '55000';
  END IF;
  IF NEW.renewal_grant_id IS DISTINCT FROM pred.renewal_grant_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF pred.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pred.surrender_only THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_SURRENDERED' USING ERRCODE = '55000';
  END IF;

  SELECT p.owner_user_id, p.revoked_at, r.device_id, r.ended_at, d.revoked_at
    INTO owner_user, principal_revoked, run_device, run_ended, device_revoked
  FROM swarm.agent_principals AS p
  JOIN swarm.agent_runs AS r ON r.run_id = pred.run_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE p.principal_id = pred.principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BINDING_MISSING' USING ERRCODE = '55000';
  END IF;
  IF principal_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PRINCIPAL_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF run_ended IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RUN_ENDED' USING ERRCODE = '55000';
  END IF;
  IF device_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.revocation_tombstones AS tombstone
    WHERE (tombstone.kind, tombstone.target_id) IN (
      ('token', pred.token_id),
      ('lineage', pred.lineage_id),
      ('family', pred.lineage_id),
      ('principal', pred.principal_id),
      ('run', pred.run_id),
      ('device', run_device),
      ('membership', owner_user),
      ('renewal_grant', pred.renewal_grant_id)
    )
  ) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.scopes) <> 'array'
     OR jsonb_typeof(pred.scopes) <> 'array'
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPES_MALFORMED' USING ERRCODE = '55000';
  END IF;
  IF NOT (pred.scopes @> NEW.scopes) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPE_WIDENED' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = pred.renewal_grant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISSING' USING ERRCODE = '55000';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_SUSPENDED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_HORIZON_REACHED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND run_device IS DISTINCT FROM grant_row.bound_device_id
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF grant_row.max_successors IS NOT NULL
     AND grant_row.successors_used - grant_row.successors_stranded >= grant_row.max_successors
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_EXHAUSTED' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at <= NEW.issued_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > NEW.issued_at + interval '8 hours' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_EXCEEDED'
      USING ERRCODE = '55000', CONSTRAINT = 'renewal_ttl_exceeded';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND NEW.expires_at > grant_row.horizon_expires_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BEYOND_HORIZON' USING ERRCODE = '55000';
  END IF;

  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1,
      last_used_at = statement_timestamp(),
      last_used_device_id = run_device,
      new_host_at = CASE
        WHEN new_host_at IS NOT NULL THEN new_host_at
        WHEN last_used_device_id IS NOT NULL
             AND run_device IS DISTINCT FROM last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_tokens_successor_fence() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_successor_fence() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_successor_fence() IS
  'Standing/timeboxed successor fence: validates predecessor lineage and liveness, grant revocation/suspension/horizon/device binding, scope attenuation, short bearer TTL, and atomically records spend plus use.';

-- Member-scoped dashboard/CLI read. SECURITY DEFINER uses the verified JWT
-- subject copied into request.jwt.claims by PostgREST or the read edge. It does
-- not call auth.uid(), which would read as the definer owner here.
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    grant_row.suspended_at,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at
  FROM swarm.agent_principals AS principal
  JOIN LATERAL (
    SELECT candidate.*
    FROM swarm.renewal_grants AS candidate
    WHERE candidate.workspace_id = p_workspace_id
      AND candidate.principal_id = principal.principal_id
    ORDER BY
      (candidate.revoked_at IS NULL) DESC,
      candidate.created_at DESC,
      candidate.renewal_grant_id DESC
    LIMIT 1
  ) AS grant_row ON true
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS token ON true
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

ALTER FUNCTION swarm_read.renewal_grant_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_roster(uuid)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_roster(uuid) IS
  'One current grant row per live principal for a verified live workspace member. Includes token ids and timestamps, never token hashes or bearer secrets.';

-- Agent bearer reads are narrower than the human roster: the read edge passes
-- the token id it already authenticated, and this function returns only that
-- token lineage's grant. A caller cannot select another principal or workspace.
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_for_token(
  p_workspace_id uuid,
  p_token_id uuid
)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    grant_row.suspended_at,
    grant_row.revoked_at,
    latest.token_id,
    latest.issued_at,
    latest.expires_at,
    latest.first_used_at,
    latest.revoked_at
  FROM swarm.agent_tokens AS presenting
  JOIN swarm.renewal_grants AS grant_row
    ON grant_row.renewal_grant_id = presenting.renewal_grant_id
  JOIN swarm.agent_principals AS principal
    ON principal.principal_id = grant_row.principal_id
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS latest ON true
  WHERE presenting.token_id = p_token_id
    AND grant_row.workspace_id = p_workspace_id
    AND principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL;
$$;

ALTER FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  TO swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) IS
  'The current renewal grant for one already-authenticated agent token. Never returns another principal or workspace.';

-- Catalogue controls: the standing shape is real, the old shape remains the
-- default, and anonymous callers did not inherit a new authority read.
DO $$
DECLARE
  horizon_nullable boolean;
  max_nullable boolean;
BEGIN
  SELECT NOT attnotnull INTO horizon_nullable
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'swarm.renewal_grants'::regclass
    AND attname = 'horizon_expires_at';
  SELECT NOT attnotnull INTO max_nullable
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'swarm.renewal_grants'::regclass
    AND attname = 'max_successors';

  IF horizon_nullable IS NOT TRUE OR max_nullable IS NOT TRUE THEN
    RAISE EXCEPTION 'standing grant nullable shape was not applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm.renewal_grants
    WHERE kind <> 'timeboxed'
      AND horizon_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pre-existing renewal grant did not normalize to timeboxed';
  END IF;
  IF has_function_privilege('anon', 'swarm_read.renewal_grant_roster(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the member-scoped grant roster';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'swarm_read.renewal_grant_for_token(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can execute the agent token-scoped grant read';
  END IF;
END
$$;
