ALTER TABLE swarm.signals
  DROP CONSTRAINT signals_body_check;

ALTER TABLE swarm.signals
  ADD CONSTRAINT signals_body_check
  CHECK (char_length(body) BETWEEN 1 AND 8000);
