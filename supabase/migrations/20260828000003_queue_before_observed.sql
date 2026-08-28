-- A routed interactive-session message is queued until the hook surfaces it.
-- This is a forward-only correction to the original closed outcome vocabulary.

ALTER TABLE swarm.signal_deliveries
  DROP CONSTRAINT signal_deliveries_ack_outcome_check;

ALTER TABLE swarm.signal_deliveries
  ADD CONSTRAINT signal_deliveries_ack_outcome_check
  CHECK (ack_outcome IS NULL OR ack_outcome IN
    ('replied', 'observed', 'queued', 'expired', 'failed_terminal'));

COMMENT ON COLUMN swarm.signal_deliveries.ack_outcome IS
  'queued means routed to an interactive session but not yet surfaced; observed means the agent actually saw it.';

DO $$
DECLARE
  outcome_constraint text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO outcome_constraint
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass
    AND conname = 'signal_deliveries_ack_outcome_check';

  IF outcome_constraint IS NULL
     OR outcome_constraint NOT LIKE '%queued%'
     OR outcome_constraint NOT LIKE '%observed%'
     OR outcome_constraint NOT LIKE '%replied%'
     OR outcome_constraint NOT LIKE '%expired%'
     OR outcome_constraint NOT LIKE '%failed_terminal%'
  THEN
    RAISE EXCEPTION 'signal_deliveries outcome constraint did not install completely';
  END IF;
END
$$;
