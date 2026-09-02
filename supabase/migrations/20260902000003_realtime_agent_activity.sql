-- Structured listener activity is ephemeral Realtime state (SWARM-CLOUD §2.13).
-- This policy stores no product data. It authorizes only live workspace members
-- to join the one private Broadcast topic derived from that workspace.
CREATE POLICY "workspace members receive agent activity"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND swarm.is_member(
    substring(
      (SELECT realtime.topic())
      FROM '^cswarm-activity:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
    )::uuid,
    (SELECT auth.uid())
  )
);
