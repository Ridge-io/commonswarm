-- Chat platform L2 follow-on: every AGENT recipient is woken, not only the one
-- at position 0.
--
-- WHAT 20260905000010 SAID, kept here verbatim because a reader may still meet
-- it in that file's section 4 and in the design plan:
--
--   "recipients 1..N can READ a signal and can REPLY to it. They are not
--    woken. swarm.enqueue_signal_delivery() reads the scalar column, so it
--    wakes the recipient at position 0, and only when that recipient is an
--    agent taking `ask` or `note`. A set whose position 0 is a PERSON wakes
--    nobody at all, even when it names agents later in the list."
--
-- THAT IS RETIRED BY THIS FILE. It is now: every AGENT recipient of an `ask`
-- or a `note` gets its own delivery row, whatever position it sits at, and a
-- set whose position 0 is a person wakes the agents named after that person.
--
-- The two reasons the fan-out was removed from 20260905000010 are both closed
-- in this lane, and BOTH have to be applied before this migration is useful:
--
--   1. supabase/functions/command/durable-delivery.ts, hydrateDeliveryRefs,
--      filtered on swarm.signals.to_agent_principal_id -- the scalar column,
--      which holds recipient 0. It now authorizes against the recipient SET,
--      and returns the DELIVERY ROW'S OWN recipient as the hydrated
--      signal's `to_agent`, so the listener that claimed the row sees itself.
--      The `expired` acknowledgement carried the same scalar filter and gets
--      the same treatment.
--   2. src/cloud/delivery.ts refuses a delivery whose signal.to_agent is not
--      its own principal. Because of (1) that check now PASSES for a recipient
--      at any position, unchanged. That is deliberate: it is what lets an
--      installed 0.1.55 listener take a position-1 delivery with no release.
--
-- APPLY ORDER, and it is not optional:
--   migration (this file) -> `command` edge -> `read` edge -> client release.
-- Applying this file alone writes delivery rows that the DEPLOYED edge cannot
-- hydrate: a row for recipient 1 would lease, fail to hydrate, answer 403 and
-- COMMIT, burning one of ten attempts each time until it terminalizes as
-- delivery_attempts_exhausted and raises a security alert. Push the migration
-- and deploy `command` in the same window.

-- ---------------------------------------------------------------------------
-- 1. One predicate, two callers
-- ---------------------------------------------------------------------------
-- Both enqueue paths -- the scalar column on swarm.signals and the recipient
-- rows beside it -- have to answer "does this signal wake this agent?" the same
-- way, or the ledger says one thing for position 0 and another for position 1.
-- So the question is asked in exactly one place.
--
-- Two of these three clauses close blind spots 20260905000010 recorded and did
-- not fix. They are stated as what they refuse:
--
--   kind        Only `ask` and `note` are ever delivered. Pre-existing, moved
--               here unchanged. tests/p1-local/chat-recipients-postgres.test.ts
--               inserts one signal per swarm signal kind and asserts the woken
--               set is exactly these two, so the list is measured rather than
--               read.
--   until       A signal whose TTL has already elapsed does not enqueue.
--               Before this, it did: the trigger checked `kind` and not
--               `until`. ITS REACH, measured rather than assumed: the
--               `signals_check` CHECK on swarm.signals enforces
--               `until > created_at`, and the edge always writes
--               created_at = now, so a signal posted through the edge is never
--               dead on arrival. Only a BACKDATED direct insert reaches this
--               clause, which is how
--               tests/p1-local/chat-recipients-postgres.test.ts measures it. So
--               this is a second wall on a shape the edge cannot produce, and
--               not a fix for a live defect. It is kept because it stops a
--               direct writer from filling a queue with rows step 3 of
--               claimAgentInbox would only acknowledge as `expired`.
--   revoked_at  A revoked agent does not enqueue. Before this, it did, and the
--               row was UNREACHABLE: claimAgentInbox step 1 returns null for a
--               revoked principal, so nothing ever claims the row, nothing ever
--               terminalizes it, and it counts in pending_delivery_count for
--               ever. This is the blind spot with no self-healing path.
--
-- A FOURTH CLAUSE WAS WRITTEN AND REMOVED, and the reason belongs here because
-- the idea comes back every time somebody reads the fan-out:
--
--   self        "An agent does not wake itself." A review arm refuted it. A
--               SELF-ADDRESSED NOTE IS A SUPPORTED FIRST-PARTY PATH:
--               runListenerAttendanceCanary in src/listener/attendance-canary.ts
--               posts `to_agent_principal_id: options.principalId` with the
--               agent's own credential, and `cswarm listen canary` is that path.
--               The clause stopped the canary's wake, so the canary would stall
--               before `claimed` and report a listener that is running as
--               absent. Applying it only to the recipient rows was rejected in
--               turn: the scalar shape and a one-entry `to` list must write the
--               same ledger, which is a measured claim in both suites.
--
--               So an agent CAN still wake itself, at any position, exactly as
--               before. What the fan-out adds is the accidental shape: an agent
--               posting to a group it belongs to wakes itself on every turn.
--               Nothing here prevents that, and closing it needs a rule that
--               can tell the canary apart from a group reply.
--
-- WHAT IT DOES NOT CLOSE, said plainly: revocation and expiry AFTER the insert.
-- A row enqueued to a live agent that is revoked a minute later is still
-- unreachable and still counted, and this predicate cannot see the future. The
-- durable fix is a claim-time sweep for revoked recipients, which is not in
-- this lane.
CREATE FUNCTION swarm.agent_delivery_is_wakeable(
  p_signal_id uuid,
  p_workspace_id uuid,
  p_agent_principal_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.signals AS s
    JOIN swarm.agent_principals AS recipient
      ON recipient.principal_id = p_agent_principal_id
     AND recipient.workspace_id = s.workspace_id
    WHERE s.id = p_signal_id
      AND s.workspace_id = p_workspace_id
      AND s.kind IN ('ask', 'note')
      AND s.until > statement_timestamp()
      AND recipient.revoked_at IS NULL
  );
$$;

ALTER FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid)
  FROM PUBLIC;
-- SECURITY INVOKER, so it runs as the calling role and reads only rows that
-- role can already read. swarm_command holds SELECT on swarm.signals
-- (20260724000003) and on swarm.agent_principals, and both triggers below are
-- SECURITY INVOKER too, so the whole enqueue path stays inside swarm_command's
-- own privileges. A SECURITY DEFINER helper here would read past RLS for no
-- reason.
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid)
  TO swarm_command;

COMMENT ON FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid) IS
  'Whether one agent principal is woken by one signal. The single source of '
  'truth for both enqueue triggers, so the scalar recipient and the recipient '
  'rows can never disagree about who gets a delivery row.';

-- ---------------------------------------------------------------------------
-- 2. The scalar path now asks that question instead of asking half of it
-- ---------------------------------------------------------------------------
-- Same shape as 20260731000001:119, with the kind test replaced by the shared
-- predicate. Position 0 keeps being woken by the trigger on swarm.signals, and
-- it fires FIRST -- the signal row is inserted before its recipient rows -- so
-- the ON CONFLICT DO NOTHING in section 3 is what keeps it from being woken
-- twice, not an ordering argument.
CREATE OR REPLACE FUNCTION swarm.enqueue_signal_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.to_agent_principal_id IS NOT NULL
     AND swarm.agent_delivery_is_wakeable(
       NEW.id, NEW.workspace_id, NEW.to_agent_principal_id
     )
  THEN
    INSERT INTO swarm.signal_deliveries (
      signal_id,
      workspace_id,
      recipient_agent_principal_id
    ) VALUES (
      NEW.id,
      NEW.workspace_id,
      NEW.to_agent_principal_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The fan-out, on the recipient rows
-- ---------------------------------------------------------------------------
-- THE CAP. There is no counting trigger here and none is needed: the position
-- CHECK on swarm.signal_recipients is `BETWEEN 0 AND 7` and position is half
-- the primary key, so a signal cannot hold more than 8 recipient rows and
-- therefore cannot write more than 8 delivery rows. 8 is SIGNAL_RECIPIENT_MAX
-- in supabase/functions/_shared/channels.ts, which the edge validator reads and
-- builds its refusal sentence from, and tests/chat-channel-constants.test.ts
-- fails when that constant and the CHECK drift apart. This is the same
-- argument 20260905000010 makes for the recipient rows themselves; the fan-out
-- inherits the bound rather than restating it.
CREATE FUNCTION swarm.enqueue_recipient_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.recipient_agent_principal_id IS NOT NULL
     AND swarm.agent_delivery_is_wakeable(
       NEW.signal_id, NEW.workspace_id, NEW.recipient_agent_principal_id
     )
  THEN
    -- ON CONFLICT DO NOTHING against the (signal_id,
    -- recipient_agent_principal_id) primary key. Position 0 already has its row
    -- from the trigger on swarm.signals, and a one-entry `to` list is exactly
    -- the scalar shape, so both write the same single row.
    INSERT INTO swarm.signal_deliveries (
      signal_id,
      workspace_id,
      recipient_agent_principal_id
    ) VALUES (
      NEW.signal_id,
      NEW.workspace_id,
      NEW.recipient_agent_principal_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.enqueue_recipient_delivery() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.enqueue_recipient_delivery() FROM PUBLIC;

CREATE TRIGGER signal_recipients_enqueue_delivery
  AFTER INSERT ON swarm.signal_recipients
  FOR EACH ROW
  EXECUTE FUNCTION swarm.enqueue_recipient_delivery();

COMMENT ON FUNCTION swarm.enqueue_recipient_delivery() IS
  'Wakes every AGENT recipient of an ask or a note, at any position. Position '
  '0 is already woken by the trigger on swarm.signals, so the ON CONFLICT is '
  'what keeps it from being woken twice.';

-- Retire the sentence 20260905000010 wrote on the table, which said the first
-- recipient is the only one a delivery-shaped reader learns about.
COMMENT ON TABLE swarm.signal_recipients IS
  'The full recipient set of an immutable signal, in order. Position 0 is also '
  'stored on swarm.signals.to_user_id / to_agent_principal_id, so a reader that '
  'knows only those columns is incomplete rather than wrong. Every AGENT in the '
  'set gets its own swarm.signal_deliveries row.';
