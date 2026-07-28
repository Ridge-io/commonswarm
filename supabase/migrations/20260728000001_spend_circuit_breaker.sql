-- Global spend circuit breaker (spec section 8 abuse taxonomy; section 9 P5
-- names it launch-blocking for free-tier signup). Additive only: no applied
-- migration is edited and no existing object is replaced or dropped.
--
-- WHAT THIS IS, AND WHAT IT IS NOT.
--
-- Section 8 asks for a breaker that "caps aggregate Supabase/function/email
-- budget and trips to a degraded, signup-paused mode before a bill runs away".
-- NO DOLLAR FIGURE APPEARS ANYWHERE IN THIS FILE, and none may be added until
-- something in this system actually receives one. There is no billing API here,
-- no metering, no cost telemetry (section 8: "billing infrastructure is
-- deferred"), so a threshold written in dollars would be a number nobody
-- measured, wearing the costume of a budget.
--
-- What the database does hold is the COUNT of the operations that spend money.
-- The breaker is built on those PROXIES - workspaces created, invitations
-- issued, signals posted, agent tokens minted, capability reads served -
-- counted globally in a fixed hourly window. (Invitations are counted as
-- ISSUED, not delivered: nothing in this repo sends mail today, so the email
-- line item section 8 names is a cost this proxy anticipates rather than one it
-- currently observes.) A proxy crossing its
-- ceiling means "something is generating cost at a rate nobody planned for",
-- which is the question the breaker exists to answer. It does not mean, and
-- must never be reported as, "the bill has reached $N".
--
-- The counters themselves are swarm.rate_buckets rows written by the command
-- function under 'spend:<proxy>:<shard>' keys: the same fixed-window mechanism
-- enforceSignalRate already uses, sharded so the breaker's own counter cannot
-- become the lock contention it exists to bound (the single hot bucket row was
-- already found and fixed once, on the capability read path - see the sharding
-- note in supabase/functions/capability/index.ts).
--
-- This migration therefore adds only the two parts that must OUTLIVE those
-- counters: the latch, and the operator controls. swarm.rate_buckets is swept
-- of everything older than two hours (purge_expired_rate_buckets, migration
-- 20260723000001), so a trip recorded there would erase itself overnight and a
-- "paused" state would silently un-pause. The latch below does not expire.

-- ---------------------------------------------------------------------------
-- The latch: at most one open trip, and only a human closes it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swarm.spend_breaker (
  trip_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tripped_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- 'automatic' rows are written by the command function when a proxy crosses
  -- its ceiling; 'operator' rows come from swarm.trip_spend_breaker() below, so
  -- a human who sees cost moving for a reason these proxies do not measure can
  -- pause signup without waiting for a deploy.
  tripped_by text NOT NULL DEFAULT 'automatic',
  proxy text NOT NULL,
  observed bigint,
  ceiling bigint,
  window_start timestamptz NOT NULL,
  cleared_at timestamptz,
  cleared_by text,
  note text,
  CONSTRAINT spend_breaker_tripped_by CHECK (
    tripped_by IN ('automatic', 'operator')
  ),
  CONSTRAINT spend_breaker_proxy CHECK (proxy ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- An automatic trip is a measurement and must carry the numbers it was made
  -- on; an operator trip is a judgement and carries none, so that nobody later
  -- reads a placeholder zero as an observation.
  CONSTRAINT spend_breaker_automatic_counts CHECK (
    tripped_by <> 'automatic'
    OR (observed IS NOT NULL AND ceiling IS NOT NULL)
  ),
  -- Who cleared it is not optional. A breaker that reopened the front door with
  -- no name against the act is not an operator control, it is an accident.
  CONSTRAINT spend_breaker_cleared_pair CHECK (
    (cleared_at IS NULL) = (cleared_by IS NULL)
  ),
  CONSTRAINT spend_breaker_cleared_by_named CHECK (
    cleared_by IS NULL OR length(btrim(cleared_by)) > 0
  )
);

-- THIS INDEX IS THE LATCH, and it is doing three jobs.
--
-- 1. At most one trip is open at a time, so "is signup paused?" is one row, not
--    an aggregate a reader can get wrong.
-- 2. It makes INSERT ... ON CONFLICT DO NOTHING the whole trip protocol: the
--    first transaction to cross owns the row and therefore owns the single
--    alert, and every concurrent crosser is a silent no-op. That is the same
--    latch discipline the capability function's global surge alert uses, and it
--    is why the trip path cannot become a hot row either - a committed
--    conflicting row does not block the next inserter.
-- 3. It is partial on cleared_at IS NULL, so the open-trip lookup on the signup
--    path is an index probe over a table that holds one row at most.
--
-- The predicate is written as an expression index rather than a constant so
-- that it is unambiguously indexable; inside the partial set the expression is
-- always true, so uniqueness is over all open rows.
CREATE UNIQUE INDEX IF NOT EXISTS spend_breaker_one_open
  ON swarm.spend_breaker ((cleared_at IS NULL))
  WHERE cleared_at IS NULL;

ALTER TABLE swarm.spend_breaker OWNER TO swarm_admin;
ALTER TABLE swarm.spend_breaker ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Privileges: the command function may trip it and read it. It may not clear
-- it, and holds no privilege that could.
-- ---------------------------------------------------------------------------

-- No UPDATE and no DELETE. Clearing the breaker is an operator act, and the
-- role that runs the surface being throttled must not be able to un-pause
-- itself - not by bug, not by injection, not by a later handler that "just
-- needed to reset the state". The two functions below are the only way out,
-- and they are owner-only.
GRANT SELECT, INSERT ON swarm.spend_breaker TO swarm_command;
GRANT USAGE ON SEQUENCE swarm.spend_breaker_trip_id_seq TO swarm_command;

DROP POLICY IF EXISTS swarm_command_select ON swarm.spend_breaker;
CREATE POLICY swarm_command_select ON swarm.spend_breaker
  AS PERMISSIVE FOR SELECT TO swarm_command
  USING (true);

-- The command role writes automatic trips and nothing else: it cannot forge an
-- operator judgement, and it cannot insert a row that arrives pre-cleared.
DROP POLICY IF EXISTS swarm_command_insert ON swarm.spend_breaker;
CREATE POLICY swarm_command_insert ON swarm.spend_breaker
  AS PERMISSIVE FOR INSERT TO swarm_command
  WITH CHECK (
    tripped_by = 'automatic'
    AND cleared_at IS NULL
    AND cleared_by IS NULL
  );

-- ---------------------------------------------------------------------------
-- Operator controls. Both are callable without a deploy - they are SQL, run
-- from the SQL editor by a role that is a member of swarm_admin (the migration
-- runner is granted it in 20260723000001). Neither is reachable from any edge
-- function: EXECUTE is revoked from PUBLIC.
-- ---------------------------------------------------------------------------

-- Reopens signup. Returns how many open trips were closed, so a caller can tell
-- "I cleared the pause" from "there was nothing to clear" - those are different
-- facts and the difference matters when you are deciding whether the thing you
-- were paged about is still happening.
--
-- Clearing does NOT reset the counters. The hourly rate_buckets window rolls on
-- its own; if the load that tripped the breaker is still arriving, the next
-- crossing trips it again. That is deliberate - clearing is "I have looked at
-- this", not "make the reading go away".
CREATE OR REPLACE FUNCTION swarm.reset_spend_breaker(
  p_by text,
  p_note text DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  WITH cleared AS (
    UPDATE swarm.spend_breaker
    SET
      cleared_at = statement_timestamp(),
      cleared_by = p_by,
      note = coalesce(p_note, note)
    WHERE cleared_at IS NULL
    RETURNING trip_id
  )
  SELECT count(*)::integer FROM cleared;
$$;

-- Pauses signup by hand. The proxies below are the operations this system can
-- count, which is not the same set as the operations that cost money - a
-- storage bill, an egress bill, or a provider invoice arriving by email is
-- invisible here. This function is the seam for exactly that case: it does not
-- pretend to a measurement, which is why observed and ceiling stay NULL.
-- Returns the trip_id, or NULL when a trip was already open (the latch held).
CREATE OR REPLACE FUNCTION swarm.trip_spend_breaker(
  p_by text,
  p_note text DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  INSERT INTO swarm.spend_breaker (
    tripped_by, proxy, window_start, note
  )
  VALUES (
    'operator',
    'operator_manual',
    date_trunc('hour', statement_timestamp()),
    coalesce(nullif(btrim(p_note), ''), 'paused by ' || p_by)
  )
  ON CONFLICT DO NOTHING
  RETURNING trip_id;
$$;

ALTER FUNCTION swarm.reset_spend_breaker(text, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.trip_spend_breaker(text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.reset_spend_breaker(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION swarm.trip_spend_breaker(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The state a human reads. Two views, deliberately separate: one answers "is it
-- paused, and why", the other answers "what is the load doing right now".
-- ---------------------------------------------------------------------------

-- Empty means signup is not paused. One row means it is, with the proxy and the
-- numbers the trip was made on.
CREATE OR REPLACE VIEW swarm.spend_breaker_status AS
SELECT
  trip_id,
  tripped_at,
  tripped_by,
  proxy,
  observed,
  ceiling,
  window_start,
  note
FROM swarm.spend_breaker
WHERE cleared_at IS NULL;

-- Live per-proxy totals for the current and previous hour, summed across the
-- shards. Reading it costs a sequential scan of a table the purge job keeps
-- tiny; nothing on a request path reads this view.
--
-- The capability arm is a different key namespace because a different edge
-- function owns those counters (supabase/functions/capability/index.ts writes
-- 'capability:read:global:<n>'). Its alert latch shares the prefix and is NOT a
-- count, so it is excluded by name - summing it would inflate the reading by
-- one per window.
CREATE OR REPLACE VIEW swarm.spend_window_totals AS
SELECT
  split_part(bucket_key, ':', 2) AS proxy,
  window_start,
  sum(count)::bigint AS observed
FROM swarm.rate_buckets
WHERE bucket_key LIKE 'spend:%'
GROUP BY 1, 2
UNION ALL
SELECT
  'capability_read' AS proxy,
  window_start,
  sum(count)::bigint AS observed
FROM swarm.rate_buckets
WHERE bucket_key LIKE 'capability:read:global:%'
  AND bucket_key <> 'capability:read:global:alerted'
GROUP BY 2;

ALTER VIEW swarm.spend_breaker_status OWNER TO swarm_admin;
ALTER VIEW swarm.spend_window_totals OWNER TO swarm_admin;

-- No grants to anon, authenticated, swarm_read or swarm_command. Aggregate
-- platform load is operator information: it is not tenant data, and section 4's
-- no-cross-tenant-inference rule is a poor thing to weaken for a dashboard
-- nobody asked for. The owner (and the migration runner, which is a member of
-- swarm_admin) can read both.

COMMENT ON TABLE swarm.spend_breaker IS
  'Global spend circuit breaker latch (spec section 8 / section 9 P5). A row with cleared_at IS NULL means self-serve workspace creation is PAUSED; everything else in the product - signals, invites, agent tokens, existing workspaces - is unaffected by design, because a breaker that takes the product down is worse than the bill it was protecting. Trips are counted on PROXIES for cost (operation counts per hour), never on a dollar figure: this system has no billing API and no cost telemetry. Rows are kept after clearing as the record of what happened. Clear with swarm.reset_spend_breaker(who, why).';

COMMENT ON COLUMN swarm.spend_breaker.observed IS
  'The window total that crossed the ceiling, for automatic trips. NULL on an operator trip, because an operator pausing signup has made a judgement and not a measurement - a zero here would read as one.';

COMMENT ON VIEW swarm.spend_breaker_status IS
  'Is signup paused, and why. Empty = not paused.';

COMMENT ON VIEW swarm.spend_window_totals IS
  'Per-proxy operation counts in the current fixed hourly window, summed across shards. Load, not cost.';
