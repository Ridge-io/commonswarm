-- Slice 2b-2 connect loop: retain the verified login email as bookkeeping so
-- invite issuance can best-effort detect an already-present member. Invitation
-- acceptance remains capability-only and MUST NOT authorize by email.

ALTER TABLE swarm.users
  ADD COLUMN IF NOT EXISTS email text;

CREATE INDEX IF NOT EXISTS users_by_normalized_email
  ON swarm.users (lower(email))
  WHERE email IS NOT NULL;

COMMENT ON COLUMN swarm.users.email IS
  'Lowercase verified-login email for invite bookkeeping only; never an invitation acceptance authorization input.';
