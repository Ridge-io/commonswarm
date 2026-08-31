-- Immutable signals can pin ordered versions from the existing file-artifact
-- subsystem. Bytes and signed URLs stay out of signals; Postgres stays the authority.

-- ★R14 applied one level further: signal_attachments carries denormalized
-- workspace_id for both parents, and both composite FKs keep that tenant field honest.
CREATE UNIQUE INDEX IF NOT EXISTS signals_id_workspace
  ON swarm.signals (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS file_versions_file_workspace_version
  ON swarm.file_versions (file_id, workspace_id, version_n);

CREATE TABLE swarm.signal_attachments (
  signal_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  file_id      uuid NOT NULL,
  version_n    integer NOT NULL CHECK (version_n >= 1),
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, position),
  UNIQUE (signal_id, file_id, version_n),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (file_id, workspace_id, version_n)
    REFERENCES swarm.file_versions (file_id, workspace_id, version_n)
);

CREATE INDEX signal_attachments_file_version
  ON swarm.signal_attachments (workspace_id, file_id, version_n);

ALTER TABLE swarm.signal_attachments OWNER TO swarm_admin;
ALTER TABLE swarm.signal_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.signal_attachments
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

-- An attachment insert is valid only while its parent signal still belongs to
-- the current transaction. This closes the subtle append-only gap: INSERTing a
-- new position tomorrow would otherwise mutate yesterday's signal without an
-- UPDATE. xmin is a 32-bit xid, while pg_current_xact_id is epoch-aware xid8;
-- the low 32 bits are the comparable on-row transaction id.
CREATE FUNCTION swarm.require_new_signal_for_attachment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.xmin::text::bigint =
        (pg_current_xact_id()::text::bigint & 4294967295)
  ) THEN
    RAISE EXCEPTION 'signal attachments can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.require_new_signal_for_attachment() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.require_new_signal_for_attachment() FROM PUBLIC;

CREATE TRIGGER signal_attachments_same_transaction
  BEFORE INSERT ON swarm.signal_attachments
  FOR EACH ROW EXECUTE FUNCTION swarm.require_new_signal_for_attachment();

-- No later API can update or delete a link either. Together, the two triggers
-- make the complete ordered attachment list immutable after signal commit.
CREATE TRIGGER signal_attachments_append_only
  BEFORE UPDATE OR DELETE ON swarm.signal_attachments
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

REVOKE ALL ON TABLE swarm.signal_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE swarm.signal_attachments TO swarm_command;

-- Human REST reads receive stable metadata only. A download still requires a
-- fresh audited file_download_url command, so no expiring capability is cached here.
CREATE OR REPLACE VIEW swarm_read.signals
WITH (security_barrier = true)
AS
  SELECT
    s.id,
    s.workspace_id,
    s.from_principal AS "from",
    s.from_kind,
    s.to_user_id AS "to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at,
    s.to_agent_principal_id AS to_agent,
    s.in_reply_to,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'file_id', attachment.file_id,
            'version_n', attachment.version_n,
            'name', file.name,
            'content_type', version.content_type,
            'size_bytes', version.size_bytes::double precision
          ) ORDER BY attachment.position
        )
        FROM swarm.signal_attachments AS attachment
        JOIN swarm.files AS file
          ON file.file_id = attachment.file_id
         AND file.workspace_id = attachment.workspace_id
        JOIN swarm.file_versions AS version
          ON version.file_id = attachment.file_id
         AND version.workspace_id = attachment.workspace_id
         AND version.version_n = attachment.version_n
        WHERE attachment.signal_id = s.id
          AND attachment.workspace_id = s.workspace_id
      ),
      '[]'::jsonb
    ) AS attachments
  FROM swarm.signals AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (
      (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL)
      OR s.to_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS principal
        WHERE principal.principal_id = s.to_agent_principal_id
          AND principal.workspace_id = s.workspace_id
          AND principal.owner_user_id = auth.uid()
      )
    );

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;
