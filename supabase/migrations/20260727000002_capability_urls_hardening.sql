-- Capability URLs, hardening pass (spec section 7). Closes four findings raised
-- against 20260727000001_capability_urls.sql by the attack phase. That migration
-- is already applied and is NOT edited; everything here is additive or replaces
-- an object by name.
--
-- The four, in the order they are fixed below:
--   1. Revocation was not terminal. The revoke-only trigger compared columns but
--      never the DIRECTION, so an UPDATE could set revoked_at back to NULL and
--      bring an already-distributed anonymous credential back to life.
--   2. The 7-day TTL ceiling was measured from a CALLER-SUPPLIED created_at.
--      created_at only had a DEFAULT, and a DEFAULT is not a guarantee: any
--      INSERT that names the column chooses its own zero point and can satisfy
--      CHECK (expires_at <= created_at + interval '7 days') with an expires_at
--      arbitrarily far in the future.
--   3. swarm_capability - the role behind the only unauthenticated endpoint in
--      the product - held unrestricted INSERT on swarm.audit_log, so a caller
--      who reached SQL there could forge or drown the record that exists to
--      catch them.
--   4. The immutability trigger was a column DENYLIST. A denylist silently
--      permits every column a later migration adds.
--
-- The IDOR composite FK, the token_hash digest rule, the UNIQUE constraint, the
-- status precedence order and the projection allowlist are all unchanged: they
-- were correct and nothing here weakens them.

-- ---------------------------------------------------------------------------
-- (1 + 4) Revocation is terminal, and the immutability rule is an ALLOWLIST.
-- ---------------------------------------------------------------------------

-- Replaces the body from 20260727000001. Two changes:
--
-- * ALLOWLIST, NOT DENYLIST. The old body enumerated the nine columns that may
--   not change, which meant column ten - added by some migration next quarter -
--   would be freely mutable on an already-distributed credential, silently and
--   by default. The comparison is now "everything except the two revocation
--   columns must be byte-identical", expressed over to_jsonb(OLD)/to_jsonb(NEW)
--   so that it holds for columns that do not exist yet. This is the same
--   positive-scoping discipline section 7 applies to the field projection: name
--   what is permitted, and let everything else be denied by construction. A
--   future migration that genuinely needs a third mutable column has to come
--   here and say so.
--
-- * REVOCATION IS TERMINAL. Checking only that revoked_at/revoked_by "are the
--   columns that changed" permits the change that matters most: NOT NULL back
--   to NULL. A capability URL is a bearer credential that has already been
--   pasted into a chat window by the time anyone revokes it, so un-revoking is
--   not an edit, it is re-issuing a credential to whoever kept the link. Once
--   revoked_at IS NOT NULL the pair is frozen - not merely non-NULL, frozen -
--   which also stops a second revoker overwriting the first revoker's
--   attribution and rewriting who killed the link.
--
-- Pair consistency ((revoked_at IS NULL) = (revoked_by IS NULL)) is NOT
-- re-implemented here: it is a table CHECK from 20260727000001 and CHECKs are
-- re-evaluated on UPDATE. Repeating it in the trigger would be ceremony.
--
-- The two rejection paths carry DISTINCT reason strings, because "the update
-- was refused" and "the update was refused because someone tried to un-revoke
-- a live-in-the-wild credential" want different responses from a human.
CREATE OR REPLACE FUNCTION swarm.capability_urls_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  frozen_old jsonb;
  frozen_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_CAPABILITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  frozen_old := to_jsonb(OLD) - 'revoked_at' - 'revoked_by';
  frozen_new := to_jsonb(NEW) - 'revoked_at' - 'revoked_by';

  IF frozen_new IS DISTINCT FROM frozen_old THEN
    RAISE EXCEPTION 'SWARM_CAPABILITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF OLD.revoked_at IS NOT NULL
    AND (
      NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    )
  THEN
    RAISE EXCEPTION 'SWARM_CAPABILITY_REVOCATION_TERMINAL' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.capability_urls_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.capability_urls_revoke_only() FROM PUBLIC;

COMMENT ON FUNCTION swarm.capability_urls_revoke_only() IS
  'Section 7: the only legal mutation of a capability URL is its first revocation. Frozen-column set is an allowlist over to_jsonb(), so a column added by a later migration is immutable by default rather than mutable by default; and revocation is terminal because a bearer credential that has already been distributed cannot be un-revoked, only re-issued. TRUNCATE bypasses row triggers, which is why no role holding INSERT/UPDATE here is ever granted TRUNCATE.';

-- The trigger itself (BEFORE UPDATE OR DELETE) is unchanged and still bound by
-- 20260727000001; CREATE OR REPLACE FUNCTION above swaps the body underneath it.

-- ---------------------------------------------------------------------------
-- (2) The TTL ceiling now measures from the server clock, not from the caller.
-- ---------------------------------------------------------------------------

-- CHECK (expires_at <= created_at + interval '7 days') is a correct constraint
-- pointed at an untrusted origin. It is not fixable as a CHECK - PostgreSQL
-- refuses non-IMMUTABLE functions in a CHECK expression, so statement_timestamp()
-- cannot appear in one - so the zero point is pinned in a BEFORE INSERT trigger
-- instead. created_at is overwritten unconditionally: a BEFORE trigger cannot
-- distinguish "the DEFAULT filled this in" from "the INSERT named this column",
-- so the only safe reading of a supplied value is to discard it.
--
-- Both existing CHECKs are then re-evaluated against the forced value, which is
-- what makes the ceiling real. It closes a second hole in passing: the mint rate
-- limit counts rows through capability_urls_by_issuer (created_by, created_at),
-- so a caller who could backdate created_at could also mint past the per-identity
-- window while every constraint stayed green.
--
-- statement_timestamp(), NOT clock_timestamp(), and that is load-bearing. The
-- mint writes expires_at = statement_timestamp() + ttl and the maximum legal ttl
-- is exactly 7 days, so a max-TTL link sits exactly on the ceiling. Both calls
-- see the same value only because statement_timestamp() is fixed for the whole
-- client statement, trigger included; clock_timestamp() here would advance a few
-- microseconds and refuse every 7-day mint.
--
-- CONSEQUENCE FOR TESTS, stated here so nobody rediscovers it at 1am: you can no
-- longer fabricate an already-expired link by inserting created_at 8 days ago and
-- expires_at yesterday, because expires_at > created_at now measures from now().
-- Mint with a sub-second TTL and wait, or, as swarm_admin in a fixture,
-- ALTER TABLE swarm.capability_urls DISABLE TRIGGER capability_urls_server_clock
-- for the duration of the setup. Do not relax the trigger to make a test easier.
CREATE OR REPLACE FUNCTION swarm.capability_urls_server_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.capability_urls_server_clock() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.capability_urls_server_clock() FROM PUBLIC;

COMMENT ON FUNCTION swarm.capability_urls_server_clock() IS
  'Envelope rule 4 (TTL <= 7 days): pins created_at to the server clock so the ceiling CHECK beside it measures from something the inserting statement cannot choose. Without this the ceiling is self-referential - supply a created_at far enough in the future and an arbitrarily long-lived anonymous credential satisfies every constraint on the table.';

-- PostgreSQL has no CREATE TRIGGER IF NOT EXISTS. Guarded, as 20260727000001 is.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'capability_urls_server_clock'
      AND tgrelid = 'swarm.capability_urls'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER capability_urls_server_clock
      BEFORE INSERT ON swarm.capability_urls
      FOR EACH ROW EXECUTE FUNCTION swarm.capability_urls_server_clock();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- (3) The anonymous-serving role's write privileges, narrowed to its job.
-- ---------------------------------------------------------------------------

-- swarm_capability is reachable from the open internet (the capability function
-- is registered verify_jwt=false). Its READ side was already positively scoped -
-- SELECT on no table, EXECUTE on one projection - but its WRITE side was not:
-- table-wide INSERT plus a WITH CHECK (true) policy let it write ANY audit row,
-- which is the one table whose integrity the whole anonymous surface depends on.
-- Forging a row attributed to a human, or flooding rows with a different
-- command_kind, drowns exactly the evidence the audit log exists to preserve.
--
-- Two independent narrowings, deliberately not redundant with each other:
--   * COLUMN-LEVEL GRANT - the privilege boundary. audit_id and occurred_at are
--     excluded, so this role cannot override the identity column or backdate a
--     row. The remaining fourteen are exactly the columns insertAudit() names in
--     supabase/functions/capability/index.ts; a column-level grant refuses any
--     INSERT that names a column outside the list, whatever the value.
--   * RLS WITH CHECK - the shape boundary. Every row this role writes must be a
--     capability read, unattributed, about one capability, with a reason drawn
--     from the capability namespace.
--
-- COUPLING, and it is deliberate: the reason regex means a new audit reason on
-- the anonymous path MUST stay capability_-prefixed, or its INSERT fails and the
-- request 500s. That is the allowlist working, not a bug. Widen it here, in a
-- migration, if the namespace ever legitimately changes.
REVOKE INSERT ON swarm.audit_log FROM swarm_capability;
GRANT INSERT (
  actor_user, actor_agent_principal, actor_run,
  credential_kind, credential_id, device_id,
  command_kind, workspace_id, stream_id,
  outcome, reason, detail, request_hash, ip
) ON swarm.audit_log TO swarm_capability;

REVOKE INSERT ON swarm.security_alerts FROM swarm_capability;
GRANT INSERT (kind, subject, detail) ON swarm.security_alerts TO swarm_capability;

DROP POLICY IF EXISTS swarm_capability_insert ON swarm.audit_log;
CREATE POLICY swarm_capability_insert ON swarm.audit_log
  AS PERMISSIVE FOR INSERT TO swarm_capability
  WITH CHECK (
    command_kind = 'read_capability_url'
    AND credential_kind = 'capability'
    -- An anonymous read has no actor, no device and no stream, and section 7
    -- rule 5 redacts the credential, so request_hash stays NULL too. Pinning
    -- them here is what stops a forged row implicating a human.
    AND actor_user IS NULL
    AND actor_agent_principal IS NULL
    AND actor_run IS NULL
    AND device_id IS NULL
    AND stream_id IS NULL
    AND request_hash IS NULL
    AND detail IS NULL
    AND ip IS NULL
    -- The audit outcome vocabulary, enumerated rather than pattern-matched.
    AND outcome IN (
      'accepted', 'authz', 'quota', 'rate_limit', 'revocation', 'validation'
    )
    -- NULL is the accepted path; every refusal carries a distinct
    -- capability_-prefixed reason.
    AND (reason IS NULL OR reason ~ '^capability_[a-z0-9_]{1,52}$')
  );

DROP POLICY IF EXISTS swarm_capability_insert ON swarm.security_alerts;
CREATE POLICY swarm_capability_insert ON swarm.security_alerts
  AS PERMISSIVE FOR INSERT TO swarm_capability
  WITH CHECK (
    kind ~ '^capability_[a-z0-9_]{1,52}$'
    AND subject IN ('capability', 'global')
  );

-- Same family of finding, one table over: ALL ... USING (true) on a SHARED
-- limiter table let the anonymous role read and rewrite rate buckets belonging
-- to the authenticated command path - including zeroing the counter that limits
-- capability-URL minting. The capability function only ever touches three keys,
-- all 'capability:read:'-prefixed (the per-token bucket, the per-origin bucket
-- and the global surge bucket), so the prefix is the whole of its legitimate
-- reach. USING and WITH CHECK must agree: the upsert's ON CONFLICT DO UPDATE
-- needs the conflicting row visible under USING.
DROP POLICY IF EXISTS swarm_capability_all ON swarm.rate_buckets;
CREATE POLICY swarm_capability_all ON swarm.rate_buckets
  AS PERMISSIVE FOR ALL TO swarm_capability
  USING (bucket_key LIKE 'capability:read:%')
  WITH CHECK (bucket_key LIKE 'capability:read:%');

COMMENT ON TABLE swarm.capability_urls IS
  'Section 7 zero-install capability URLs: one bearer credential scoped to exactly one work item. Every column here is either the tenant pin, the credential digest, the TTL, or the attribution needed for revocation; nothing about the projection served to an anonymous caller is decided in this table, only in swarm.capability_projection(). created_at is forced to the server clock on INSERT (20260727000002) because the TTL ceiling is measured from it, and revocation is terminal.';

COMMENT ON COLUMN swarm.capability_urls.created_at IS
  'Server clock, always. The BEFORE INSERT trigger overwrites whatever the inserting statement supplies, because both the 7-day ceiling CHECK and the per-identity mint rate window are measured from this column - a caller-chosen value would make both self-certifying.';
