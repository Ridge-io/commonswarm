/**
 * Server half of workspace file artifacts (S2).
 * Spec: docs/design/2026-08-18-FILE-ARTIFACTS.md — the ★R pins named below are
 * load-bearing review findings; do not remove one without reopening the review.
 *
 * These handlers run beside the reducer (durable-delivery.ts precedent). ★R9:
 * bypassing the reducer means the routed pipeline in index.ts plus this module
 * must re-implement, and here does re-implement, all six protections:
 *   1. revocation on every command      — index.ts `revoked()` on the shared path;
 *   2. written agent classification     — all five kinds are agent-allowed
 *      (FILE_COMMAND_KINDS is exempted from the per-scope gate the way delivery
 *      commands are, because existing minted tokens cannot carry new scopes);
 *      tombstone/restore additionally carry the §6 actor rule in their SQL;
 *   3. an audit row per command         — index.ts audits accept and refuse;
 *   4. command-id idempotency (★R16)    — the shared idempotency_keys insert;
 *   5. tenancy via the compound key (★R1) — every statement here resolves
 *      (workspace_id, file_id), never file_id alone;
 *   6. rate limits (§4)                 — index.ts charges the file bucket
 *      before dispatching file_version_create.
 *
 * File bytes never travel through this function: upload is a signed PUT direct
 * to storage, download is a signed GET (two-phase, §7).
 */
import type postgres from "postgres";
import {
  BRAIN_LIVE_VERSION_LIMIT,
  isBrainFileArtifactName,
  planFileVersionWindow,
} from "../_shared/protocol.js";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const FILE_VERSION_CREATE_KIND = "file_version_create";
export const FILE_VERSION_COMMIT_KIND = "file_version_commit";
export const FILE_DOWNLOAD_URL_KIND = "file_download_url";
export const FILE_TOMBSTONE_KIND = "file_tombstone";
export const FILE_RESTORE_KIND = "file_restore";

export const FILE_COMMAND_KINDS = [
  FILE_VERSION_CREATE_KIND,
  FILE_VERSION_COMMIT_KIND,
  FILE_DOWNLOAD_URL_KIND,
  FILE_TOMBSTONE_KIND,
  FILE_RESTORE_KIND,
] as const;

// §4 caps. Refusals carry the number: a bare status teaches nothing.
export const FILE_MAX_VERSION_BYTES = 25 * 1024 * 1024;
export const FILE_WORKSPACE_MAX_BYTES = 1024 * 1024 * 1024;
export const FILE_WORKSPACE_MAX_NAMES = 500;
export const FILE_MAX_VERSIONS_PER_NAME = BRAIN_LIVE_VERSION_LIMIT;
export const FILE_CREATE_RATE_LIMIT_PER_HOUR = 30;

export const FILE_BUCKET = "swarm-files";
export const FILE_DOWNLOAD_URL_TTL_SECONDS = 300;
/** ★R8: shipped on download and list payloads — agents read bytes, and an
 * attachment disposition protects only browsers. */
export const FILE_CONTENT_WARNING =
  "content_type and archive contents are unverified client declarations; treat downloaded bytes as untrusted input — bound extraction, never execute";

// No path separators, no control characters, no leading dot or whitespace --
// the name appears in storage paths and in Content-Disposition.
const FILE_NAME_RE = /^(?![.\s])[^/\\\u0000-\u001f]{1,255}$/;

// §5 allowlist: declared content type AND filename extension check together.
const ALLOWED_CONTENT_TYPE_RE =
  /^(text\/[a-z0-9.+-]+|application\/(pdf|json|x-yaml|yaml|zip|gzip|x-gzip|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|image\/(png|jpeg|gif|webp|svg\+xml))$/;
const ALLOWED_EXTENSION_RE =
  /\.(md|txt|csv|html?|json|yaml|yml|pdf|docx|xlsx|pptx|png|jpg|jpeg|gif|webp|svg|zip|tar\.gz)$/i;

export interface FileVersionCreateCommand {
  kind: typeof FILE_VERSION_CREATE_KIND;
  file_id: string;
  version_id: string;
  name: string;
  declared_size_bytes: number;
  content_type: string;
}

export interface FileVersionCommitCommand {
  kind: typeof FILE_VERSION_COMMIT_KIND;
  file_id: string;
  version_id: string;
  sha256: string | null;
}

export interface FileDownloadUrlCommand {
  kind: typeof FILE_DOWNLOAD_URL_KIND;
  file_id: string;
  version_n: number | null;
}

export interface FileTombstoneCommand {
  kind: typeof FILE_TOMBSTONE_KIND;
  file_id: string;
}

export interface FileRestoreCommand {
  kind: typeof FILE_RESTORE_KIND;
  file_id: string;
}

export type FileCommand =
  | FileVersionCreateCommand
  | FileVersionCommitCommand
  | FileDownloadUrlCommand
  | FileTombstoneCommand
  | FileRestoreCommand;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

/** Shape validation only; caps and authorization are transaction-time checks. */
export function validateFileCommand(
  cmd: Record<string, unknown>,
):
  | { ok: true; command: FileCommand }
  | { ok: false; status: number; reason: string } {
  if (cmd.kind === FILE_VERSION_CREATE_KIND) {
    const valid = exactKeys(cmd, [
      "kind",
      "file_id",
      "version_id",
      "name",
      "declared_size_bytes",
      "content_type",
    ]) &&
      typeof cmd.file_id === "string" && UUID_RE.test(cmd.file_id) &&
      typeof cmd.version_id === "string" && UUID_RE.test(cmd.version_id) &&
      typeof cmd.name === "string" && FILE_NAME_RE.test(cmd.name) &&
      typeof cmd.declared_size_bytes === "number" &&
      Number.isInteger(cmd.declared_size_bytes) &&
      cmd.declared_size_bytes >= 1 &&
      typeof cmd.content_type === "string" &&
      cmd.content_type.length <= 255;
    if (!valid) {
      return {
        ok: false,
        status: 400,
        reason: "file_version_create fields are malformed",
      };
    }
    return {
      ok: true,
      command: {
        kind: FILE_VERSION_CREATE_KIND,
        file_id: (cmd.file_id as string).toLowerCase(),
        version_id: (cmd.version_id as string).toLowerCase(),
        name: cmd.name as string,
        declared_size_bytes: cmd.declared_size_bytes as number,
        content_type: (cmd.content_type as string).toLowerCase(),
      },
    };
  }
  if (cmd.kind === FILE_VERSION_COMMIT_KIND) {
    const sha = Object.hasOwn(cmd, "sha256") ? cmd.sha256 : null;
    const valid = exactKeys(cmd, [
      "kind",
      "file_id",
      "version_id",
      ...(Object.hasOwn(cmd, "sha256") ? ["sha256"] : []),
    ]) &&
      typeof cmd.file_id === "string" && UUID_RE.test(cmd.file_id) &&
      typeof cmd.version_id === "string" && UUID_RE.test(cmd.version_id) &&
      (sha === null || (typeof sha === "string" && SHA256_RE.test(sha)));
    if (!valid) {
      return {
        ok: false,
        status: 400,
        reason: "file_version_commit fields are malformed",
      };
    }
    return {
      ok: true,
      command: {
        kind: FILE_VERSION_COMMIT_KIND,
        file_id: (cmd.file_id as string).toLowerCase(),
        version_id: (cmd.version_id as string).toLowerCase(),
        sha256: sha as string | null,
      },
    };
  }
  if (cmd.kind === FILE_DOWNLOAD_URL_KIND) {
    const version = Object.hasOwn(cmd, "version_n") ? cmd.version_n : null;
    const valid = exactKeys(cmd, [
      "kind",
      "file_id",
      ...(Object.hasOwn(cmd, "version_n") ? ["version_n"] : []),
    ]) &&
      typeof cmd.file_id === "string" && UUID_RE.test(cmd.file_id) &&
      (version === null ||
        (typeof version === "number" && Number.isInteger(version) &&
          version >= 1));
    if (!valid) {
      return {
        ok: false,
        status: 400,
        reason: "file_download_url fields are malformed",
      };
    }
    return {
      ok: true,
      command: {
        kind: FILE_DOWNLOAD_URL_KIND,
        file_id: (cmd.file_id as string).toLowerCase(),
        version_n: version as number | null,
      },
    };
  }
  if (cmd.kind === FILE_TOMBSTONE_KIND || cmd.kind === FILE_RESTORE_KIND) {
    const valid = exactKeys(cmd, ["kind", "file_id"]) &&
      typeof cmd.file_id === "string" && UUID_RE.test(cmd.file_id);
    if (!valid) {
      return {
        ok: false,
        status: 400,
        reason: `${cmd.kind} fields are malformed`,
      };
    }
    return {
      ok: true,
      command: {
        kind: cmd.kind as typeof FILE_TOMBSTONE_KIND | typeof FILE_RESTORE_KIND,
        file_id: (cmd.file_id as string).toLowerCase(),
      },
    };
  }
  return { ok: false, status: 400, reason: "unknown file command kind" };
}

/**
 * Checks the declared type and the filename extension together (§5). Exported
 * so the refusal copy and the tests share one authority.
 */
export function fileContentAllowed(name: string, contentType: string): boolean {
  return ALLOWED_CONTENT_TYPE_RE.test(contentType) &&
    ALLOWED_EXTENSION_RE.test(name);
}

export interface FileActor {
  kind: "user" | "agent";
  id: string;
}

export type FileRefusal = {
  status: number;
  error: string;
  message: string;
  reason: string;
};

export type FileOutcome<T> =
  | { ok: true; body: T }
  | { ok: false; refusal: FileRefusal }
  /* A concurrent request with the SAME command id won the ledger while this
   * one waited on the row locks; `stored` is that winner's ledgered response.
   * Without this recheck two same-id requests both pass the pre-dispatch
   * ledger SELECT, and the loser re-executes against changed state — measured
   * as a PK 500 on create before the id pre-checks, and as a divergent
   * refusal after them. */
  | { ok: "replay"; stored: Record<string, unknown> };

/**
 * Re-reads the idempotency ledger; handlers call it AFTER taking their locks.
 * "conflict" = a row exists for this command id with a DIFFERENT request hash
 * or route — replaying the winner's response as if it answered THIS request
 * would hand the caller someone else's result.
 */
export type LedgerRecheckResult =
  | { hit: "stored"; stored: Record<string, unknown> }
  | { hit: "conflict" }
  | null;
export type LedgerRecheck = () => Promise<LedgerRecheckResult>;

function refuse(
  status: number,
  error: string,
  message: string,
  reason: string,
): FileOutcome<never> {
  return { ok: false, refusal: { status, error, message, reason } };
}

/**
 * Storage operations the handlers need; index.ts binds them to the REST API.
 * Signed URLs are returned as RELATIVE paths (under /storage/v1) and clients
 * prepend their own deployment URL: the runtime's SUPABASE_URL is an internal
 * hostname under `supabase functions serve`, and in production the client may
 * be talking through the custom domain — the server does not know which host
 * the caller can reach, and must not guess.
 */
export interface FileStorage {
  /** Signed upload path bound to exactly one object, upsert OFF (★R1, ★R3). */
  signUpload(path: string): Promise<{ path: string; token: string }>;
  /** Measured object size, or null when the object does not exist (★R4). */
  objectSize(path: string): Promise<number | null>;
  /** Signed, expiring download path served as an attachment (§5). */
  signDownload(
    path: string,
    filename: string,
    expiresInSeconds: number,
  ): Promise<string>;
  /**
   * Batch object deletion for the purge-queue drain (S4). Must SUCCEED for
   * paths that hold no object — a pending row GC'd before its PUT queues a
   * path that was never written, and the drain still has to retire it.
   */
  removeObjects(paths: readonly string[]): Promise<void>;
}

export async function fileVersionCreate(
  tx: Sql,
  workspaceId: string,
  actor: FileActor,
  cmd: FileVersionCreateCommand,
  storage: FileStorage,
  ledgerRecheck: LedgerRecheck,
): Promise<FileOutcome<Record<string, unknown>>> {
  if (cmd.declared_size_bytes > FILE_MAX_VERSION_BYTES) {
    const mb = Math.round(cmd.declared_size_bytes / 1024 / 1024);
    return refuse(
      413,
      "file_too_large",
      `this file is ${mb} MB; the per-file limit is ${
        FILE_MAX_VERSION_BYTES / 1024 / 1024
      } MB`,
      "declared size over per-file cap",
    );
  }
  if (!fileContentAllowed(cmd.name, cmd.content_type)) {
    return refuse(
      415,
      "file_type_refused",
      "this name or content type is not on the allowlist: text (.md .txt .csv .json .yaml), documents (.pdf .docx .xlsx .pptx), images (.png .jpg .jpeg .gif .webp .svg), archives (.zip .tar.gz)",
      "content type or extension off allowlist",
    );
  }

  // ★R16: every cap check below runs while holding a row lock. The workspace
  // row serializes the byte sum and the name count; the file row (when the
  // name exists) serializes the version number and per-name cap. Without the
  // locks, two concurrent creates under READ COMMITTED both pass a cap they
  // jointly exceed.
  const workspaceLock = await tx<{ workspace_id: string }[]>`
    SELECT workspace_id FROM swarm.workspaces
    WHERE workspace_id = ${workspaceId}::uuid
    FOR UPDATE
  `;
  if (workspaceLock.length === 0) {
    return refuse(403, "forbidden", "workspace not found", "no such workspace");
  }
  const storedCreate = await ledgerRecheck();
  if (storedCreate?.hit === "conflict") {
    return refuse(
      409,
      "command_id_conflict",
      "this command id was already used with a different request",
      "command id conflict",
    );
  }
  if (storedCreate !== null) return { ok: "replay", stored: storedCreate.stored };

  // ★R5 byte cap: committed bytes (live OR retired) plus not-yet-expired
  // pending DECLARED bytes. Retiring a brain version keeps its object, so it
  // must not release workspace storage quota.
  const byteRows = await tx<{ total: string }[]>`
    SELECT coalesce(sum(size_bytes), 0)::text AS total
    FROM swarm.file_versions
    WHERE workspace_id = ${workspaceId}::uuid
      AND (
        state IN ('live', 'retired')
        OR (
          -- Same 3h window the GC claims on: URL validity plus margin.
          state = 'pending'
          AND created_at > statement_timestamp() - interval '3 hours'
        )
      )
  `;
  const usedBytes = Number(byteRows[0]?.total ?? "0");
  if (usedBytes + cmd.declared_size_bytes > FILE_WORKSPACE_MAX_BYTES) {
    return refuse(
      409,
      "workspace_quota_exceeded",
      `this workspace holds ${
        Math.round(usedBytes / 1024 / 1024)
      } MB of ${FILE_WORKSPACE_MAX_BYTES / 1024 / 1024} MB; this ${
        Math.round(cmd.declared_size_bytes / 1024 / 1024)
      } MB upload does not fit`,
      "workspace byte cap",
    );
  }

  const existing = await tx<
    {
      file_id: string;
      tombstoned_at: Date | null;
      current_version: number;
      live_version_count: string;
      in_flight_version_count: string;
    }[]
  >`
    SELECT
      f.file_id,
      f.tombstoned_at,
      f.current_version,
      (
        SELECT count(*)::text FROM swarm.file_versions AS v
        WHERE v.file_id = f.file_id
          AND v.workspace_id = f.workspace_id
          AND v.state = 'live'
      ) AS live_version_count,
      (
        -- Only unexpired pending uploads are in flight. For normal files they
        -- still share the fixed 20-slot cap with live versions. For brain
        -- topics they are the only create-time cap; commit rolls the live set.
        SELECT count(*)::text FROM swarm.file_versions AS v
        WHERE v.file_id = f.file_id
          AND v.workspace_id = f.workspace_id
          AND v.state = 'pending'
          AND v.created_at > statement_timestamp() - interval '3 hours'
      ) AS in_flight_version_count
    FROM swarm.files AS f
    WHERE f.workspace_id = ${workspaceId}::uuid
      AND lower(f.name) = lower(${cmd.name})
      -- A purged file (tombstone window ended, bytes claimed) releases its
      -- name; the row itself stays for audit. Item 6 of the S2 verify round.
      AND f.purged_at IS NULL
    FOR UPDATE OF f
  `;
  const file = existing[0];
  if (file !== undefined && file.tombstoned_at !== null) {
    return refuse(
      409,
      "file_tombstoned",
      "a tombstoned file holds this name; restore it or wait for its purge",
      "name held by tombstone",
    );
  }
  const windowPlan = planFileVersionWindow(
    cmd.name,
    Number(file?.live_version_count ?? "0"),
    Number(file?.in_flight_version_count ?? "0"),
  );
  if (!windowPlan.createAllowed) {
    if (windowPlan.brainTopic) {
      return refuse(
        409,
        "brain_version_in_flight_cap",
        `this topic already has ${BRAIN_LIVE_VERSION_LIMIT} uncommitted uploads in flight; wait for one to commit or for a pending upload to expire, then run cswarm brain put again`,
        "brain in-flight version cap",
      );
    }
    return refuse(
      409,
      "file_version_cap",
      `this file already has ${FILE_MAX_VERSIONS_PER_NAME} live or in-flight versions; no new version was started`,
      "per-name version cap",
    );
  }
  if (file === undefined) {
    const nameRows = await tx<{ total: string }[]>`
      SELECT count(*)::text AS total FROM swarm.files
      WHERE workspace_id = ${workspaceId}::uuid
        AND purged_at IS NULL
    `;
    if (Number(nameRows[0]?.total ?? "0") >= FILE_WORKSPACE_MAX_NAMES) {
      // Tombstoned names COUNT: the name stays reserved for restore until the
      // purge, so the refusal must not prescribe a recovery that cannot work.
      return refuse(
        409,
        "workspace_file_count",
        `this workspace already has ${FILE_WORKSPACE_MAX_NAMES} file names; the purge frees a name 30 days after its tombstone — tombstoning alone does not`,
        "workspace name cap",
      );
    }
  }

  // Uniform id-unavailable refusal (no oracle): the SAME shape whether the id
  // exists in this workspace under another name, in another tenant, or is a
  // random collision — hitting the PK instead was a 500 and an existence probe.
  if (file === undefined) {
    const idTaken = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM swarm.files
      WHERE file_id = ${cmd.file_id}::uuid
    `;
    if (idTaken[0]?.n !== "0") {
      return refuse(
        409,
        "file_id_unavailable",
        "this file_id is not available; generate a fresh UUID and retry",
        "file id unavailable",
      );
    }
  }
  const versionIdTaken = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.file_versions
    WHERE version_id = ${cmd.version_id}::uuid
  `;
  if (versionIdTaken[0]?.n !== "0") {
    return refuse(
      409,
      "version_id_unavailable",
      "this version_id is not available; generate a fresh UUID and retry",
      "version id unavailable",
    );
  }

  const fileId = file?.file_id ?? cmd.file_id;
  // current_version names the newest LIVE version and moves only at commit
  // (review: advancing it here hid live v1 behind a pending v2). Numbering
  // therefore comes from max(version_n) under the file/workspace locks above.
  const maxRows = await tx<{ n: string }[]>`
    SELECT coalesce(max(version_n), 0)::text AS n
    FROM swarm.file_versions
    WHERE file_id = ${fileId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  const versionN = Number(maxRows[0]?.n ?? "0") + 1;
  const storagePath = `${workspaceId}/${fileId}/${versionN}`;

  if (file === undefined) {
    await tx`
      INSERT INTO swarm.files (
        file_id, workspace_id, name, created_by_kind, created_by
      ) VALUES (
        ${fileId}::uuid, ${workspaceId}::uuid, ${cmd.name},
        ${actor.kind}, ${actor.id}::uuid
      )
    `;
  }
  await tx`
    INSERT INTO swarm.file_versions (
      version_id, file_id, workspace_id, version_n, state,
      size_bytes, content_type, storage_path, uploaded_by_kind, uploaded_by
    ) VALUES (
      ${cmd.version_id}::uuid, ${fileId}::uuid, ${workspaceId}::uuid,
      ${versionN}, 'pending', ${cmd.declared_size_bytes}, ${cmd.content_type},
      ${storagePath}, ${actor.kind}, ${actor.id}::uuid
    )
  `;

  const upload = await storage.signUpload(storagePath);
  return {
    ok: true,
    body: {
      file_id: fileId,
      version_id: cmd.version_id,
      version_n: versionN,
      name: cmd.name,
      // Relative to the deployment URL the caller already talks to.
      upload_path: upload.path,
      upload_token: upload.token,
      upload_expires_in_seconds: 7200,
      commit_deadline_note:
        "PUT the bytes to <your deployment URL> + upload_path, then send file_version_commit. The upload URL lasts two hours; the pending slot is swept three hours from now.",
    },
  };
}

export async function fileVersionCommit(
  tx: Sql,
  workspaceId: string,
  actor: FileActor,
  cmd: FileVersionCommitCommand,
  storage: FileStorage,
  ledgerRecheck: LedgerRecheck,
): Promise<FileOutcome<Record<string, unknown>>> {
  // Concurrent commits of two DIFFERENT pending versions lock different
  // version rows and would each pass the live-version count (review P1), so
  // commit serializes per FILE first — the same lock create takes.
  const fileLock = await tx<{ file_id: string }[]>`
    SELECT file_id FROM swarm.files
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
    FOR UPDATE
  `;
  if (fileLock.length === 0) {
    return refuse(404, "file_not_found", "no such file in this workspace", "compound key miss");
  }
  const storedCommitEarly = await ledgerRecheck();
  if (storedCommitEarly?.hit === "conflict") {
    return refuse(
      409,
      "command_id_conflict",
      "this command id was already used with a different request",
      "command id conflict",
    );
  }
  if (storedCommitEarly !== null) {
    return { ok: "replay", stored: storedCommitEarly.stored };
  }
  // ★R1 compound key; ★R2 one-time, creator-only. The row is locked so the
  // measured-size UPDATE below cannot race a second commit of the same version.
  const rows = await tx<
    {
      version_id: string;
      version_n: number;
      state: string;
      size_bytes: string;
      storage_path: string;
      uploaded_by: string;
      uploaded_by_kind: string;
      name: string;
    }[]
  >`
    SELECT
      v.version_id, v.version_n, v.state, v.size_bytes::text,
      v.storage_path, v.uploaded_by, v.uploaded_by_kind, f.name
    FROM swarm.file_versions AS v
    JOIN swarm.files AS f
      ON f.file_id = v.file_id AND f.workspace_id = v.workspace_id
    WHERE v.version_id = ${cmd.version_id}::uuid
      AND v.file_id = ${cmd.file_id}::uuid
      AND v.workspace_id = ${workspaceId}::uuid
    FOR UPDATE OF v
  `;
  const version = rows[0];
  if (version === undefined) {
    return refuse(404, "file_not_found", "no such pending version in this workspace", "compound key miss");
  }
  if (version.state !== "pending") {
    // ★R2: a replay against a live (or purged) row is refused, never rewritten.
    return refuse(
      409,
      "file_commit_conflict",
      `version ${version.version_n} is already ${version.state}; commit is one-time`,
      "commit replay",
    );
  }
  if (
    version.uploaded_by !== actor.id || version.uploaded_by_kind !== actor.kind
  ) {
    return refuse(
      403,
      "forbidden",
      "only the principal that created this pending version may commit it",
      "non-creator commit",
    );
  }
  const measured = await storage.objectSize(version.storage_path);
  if (measured === null) {
    return refuse(
      409,
      "file_bytes_missing",
      "no object was uploaded for this version; PUT the bytes to the upload URL, then commit",
      "commit before upload",
    );
  }
  if (measured > Number(version.size_bytes)) {
    return refuse(
      409,
      "file_size_exceeds_declaration",
      `the uploaded object is ${measured} bytes; the version declared ${version.size_bytes} — the declaration gated the quota, so the larger object is refused`,
      "measured size over declaration",
    );
  }
  // The file lock makes retirement plus commit one serial transaction. Brain
  // topics roll their live set here, after bytes exist; normal files retain
  // the fixed cap. All refusal checks stay before retirement: a normal return
  // from db.begin commits, so retirement must not precede a refusal. Ordering
  // by version_n is the durable oldest-first rule.
  const liveVersions = await tx<{ version_n: number }[]>`
    SELECT version_n FROM swarm.file_versions
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND state = 'live'
    ORDER BY version_n ASC
  `;
  const windowPlan = planFileVersionWindow(
    version.name,
    liveVersions.length,
    0,
  );
  const liveAfterPlannedRetirement = liveVersions.length - windowPlan.retireOnCommitCount;
  if (liveAfterPlannedRetirement >= FILE_MAX_VERSIONS_PER_NAME) {
    return refuse(
      409,
      "file_version_cap",
      windowPlan.brainTopic
        ? "the oldest live topic version could not be retired; nothing was committed — run cswarm brain put again"
        : `this name already has ${FILE_MAX_VERSIONS_PER_NAME} live versions; the commit is refused`,
      "per-name version cap at commit",
    );
  }
  // ★R4: the row states the MEASURED size; sha256 stays an unverified client
  // attestation and is labeled so wherever it is shown.
  // ★R2: the WHERE carries the WHOLE predicate — state, creator, compound key —
  // deliberately, so the SQL enforces what the checks above concluded and a
  // future edit to one check is not a silent bypass of the rule.
  const committed = await tx<{ version_id: string }[]>`
    UPDATE swarm.file_versions
    SET state = 'live',
        size_bytes = ${measured},
        sha256 = ${cmd.sha256},
        committed_at = statement_timestamp()
    WHERE version_id = ${cmd.version_id}::uuid
      AND file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND state = 'pending'
      AND uploaded_by = ${actor.id}::uuid
      AND uploaded_by_kind = ${actor.kind}
    RETURNING version_id
  `;
  if (committed.length === 0) {
    return refuse(
      409,
      "file_commit_conflict",
      "the commit predicate no longer matches this version; nothing was changed",
      "commit predicate mismatch",
    );
  }
  let retiredVersionNumbers: number[] = [];
  if (windowPlan.brainTopic && windowPlan.retireOnCommitCount > 0) {
    const retired = await tx<{ version_n: number }[]>`
      UPDATE swarm.file_versions
      SET state = 'retired', retired_at = statement_timestamp()
      WHERE version_id IN (
        SELECT version_id
        FROM swarm.file_versions
        WHERE file_id = ${cmd.file_id}::uuid
          AND workspace_id = ${workspaceId}::uuid
          AND state = 'live'
        ORDER BY version_n ASC
        LIMIT ${windowPlan.retireOnCommitCount}
      )
      RETURNING version_n
    `;
    if (retired.length !== windowPlan.retireOnCommitCount) {
      // This throw rolls the pending->live update back with the retirement.
      throw new Error("brain version retirement count changed under the file lock");
    }
    retiredVersionNumbers = retired.map((row) => row.version_n).sort((a, b) => a - b);
  }
  // Finding 1: current_version follows the newest LIVE version, at commit.
  await tx`
    UPDATE swarm.files
    SET current_version = GREATEST(current_version, ${version.version_n})
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
  `;
  return {
    ok: true,
    body: {
      file_id: cmd.file_id,
      version_id: cmd.version_id,
      version_n: version.version_n,
      name: version.name,
      size_bytes: measured,
      sha256: cmd.sha256,
      sha256_note: "unverified client attestation",
      reference: `file:${cmd.file_id}@v${version.version_n}`,
      ...(retiredVersionNumbers.length === 0
        ? {}
        : { retired_version_n: retiredVersionNumbers[0] }),
    },
  };
}

export async function fileDownloadUrl(
  tx: Sql,
  workspaceId: string,
  cmd: FileDownloadUrlCommand,
  storage: FileStorage,
): Promise<FileOutcome<Record<string, unknown>>> {
  // ★R1 compound key. Tombstoned files refuse new URLs (outstanding ones die
  // on their own 5-minute clock, which the tombstone response says).
  const rows = await tx<
    {
      version_n: number;
      storage_path: string;
      content_type: string;
      size_bytes: string;
      name: string;
      tombstoned_at: Date | null;
      version_state: string;
      live_version_count: string;
      retired_version_count: string;
    }[]
  >`
    SELECT v.version_n, v.storage_path, v.content_type, v.size_bytes::text,
           f.name, f.tombstoned_at, v.state AS version_state,
           (
             SELECT count(*)::text FROM swarm.file_versions AS live
             WHERE live.file_id = f.file_id
               AND live.workspace_id = f.workspace_id
               AND live.state = 'live'
           ) AS live_version_count,
           (
             SELECT count(*)::text FROM swarm.file_versions AS retired
             WHERE retired.file_id = f.file_id
               AND retired.workspace_id = f.workspace_id
               AND retired.state = 'retired'
           ) AS retired_version_count
    FROM swarm.files AS f
    JOIN swarm.file_versions AS v
      ON v.file_id = f.file_id AND v.workspace_id = f.workspace_id
    WHERE f.file_id = ${cmd.file_id}::uuid
      AND f.workspace_id = ${workspaceId}::uuid
      AND v.state IN ('live', 'retired')
      AND (
        (${cmd.version_n}::integer IS NULL AND v.version_n = f.current_version)
        OR v.version_n = ${cmd.version_n}::integer
      )
    LIMIT 1
  `;
  const version = rows[0];
  if (
    version === undefined ||
    (version.version_state === "retired" &&
      (cmd.version_n === null || !isBrainFileArtifactName(version.name)))
  ) {
    return refuse(
      404,
      "file_not_found",
      "no live version of that file exists in this workspace",
      "compound key miss or no live version",
    );
  }
  if (version.tombstoned_at !== null) {
    return refuse(
      409,
      "file_tombstoned",
      "this file is tombstoned; restore it to download again",
      "tombstoned",
    );
  }
  const path = await storage.signDownload(
    version.storage_path,
    version.name,
    FILE_DOWNLOAD_URL_TTL_SECONDS,
  );
  return {
    ok: true,
    body: {
      file_id: cmd.file_id,
      version_n: version.version_n,
      version_state: version.version_state,
      live_version_count: Number(version.live_version_count),
      retired_version_count: Number(version.retired_version_count),
      name: version.name,
      size_bytes: Number(version.size_bytes),
      content_type: version.content_type,
      // Relative to the deployment URL the caller already talks to.
      download_path: path,
      download_url_expires_in_seconds: FILE_DOWNLOAD_URL_TTL_SECONDS,
      // ★R8, addressed to the consumer that matters: the type is a client
      // declaration and archive contents are unverified.
      content_warning: FILE_CONTENT_WARNING,
    },
  };
}

/**
 * §6: tombstone/restore — the uploader (the agent principal that created the
 * file) or any human member. `restore` additionally refuses once the purge has
 * claimed the rows (★R6).
 */
export async function fileTombstone(
  tx: Sql,
  workspaceId: string,
  actor: FileActor,
  cmd: FileTombstoneCommand,
  ledgerRecheck: LedgerRecheck,
): Promise<FileOutcome<Record<string, unknown>>> {
  const rows = await tx<
    { name: string; tombstoned_at: Date | null; created_by: string; created_by_kind: string }[]
  >`
    SELECT name, tombstoned_at, created_by, created_by_kind
    FROM swarm.files
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
    FOR UPDATE
  `;
  const file = rows[0];
  if (file === undefined) {
    return refuse(404, "file_not_found", "no such file in this workspace", "compound key miss");
  }
  const storedTombstone = await ledgerRecheck();
  if (storedTombstone?.hit === "conflict") {
    return refuse(
      409,
      "command_id_conflict",
      "this command id was already used with a different request",
      "command id conflict",
    );
  }
  if (storedTombstone !== null) return { ok: "replay", stored: storedTombstone.stored };
  if (
    actor.kind === "agent" &&
    (file.created_by !== actor.id || file.created_by_kind !== "agent")
  ) {
    return refuse(
      403,
      "forbidden",
      "an agent may tombstone only files it uploaded; any human member may tombstone any file",
      "agent tombstoning another principal's file",
    );
  }
  if (file.tombstoned_at !== null) {
    return refuse(409, "file_tombstoned", "this file is already tombstoned", "already tombstoned");
  }
  const purgeAt = await tx<{ purge_at: string }[]>`
    UPDATE swarm.files
    SET tombstoned_at = statement_timestamp(), tombstoned_by = ${actor.id}::uuid
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
    RETURNING (statement_timestamp() + interval '30 days')::text AS purge_at
  `;
  return {
    ok: true,
    body: {
      file_id: cmd.file_id,
      name: file.name,
      restorable_until: purgeAt[0]?.purge_at ?? null,
      note:
        "Restorable with file_restore until the date above; existing download URLs expire on their own 5-minute clock.",
    },
  };
}

export async function fileRestore(
  tx: Sql,
  workspaceId: string,
  actor: FileActor,
  cmd: FileRestoreCommand,
  ledgerRecheck: LedgerRecheck,
): Promise<FileOutcome<Record<string, unknown>>> {
  const rows = await tx<
    {
      name: string;
      tombstoned_at: Date | null;
      created_by: string;
      created_by_kind: string;
      window_ended: boolean;
      purged: string;
    }[]
  >`
    SELECT
      f.name, f.tombstoned_at, f.created_by, f.created_by_kind,
      -- The DATABASE clock decides the window (review: Date.now() skew could
      -- refuse inside the announced window or allow a late restore).
      (
        f.tombstoned_at IS NOT NULL AND
        f.tombstoned_at < statement_timestamp() - interval '30 days'
      ) AS window_ended,
      (
        SELECT count(*)::text FROM swarm.file_versions AS v
        WHERE v.file_id = f.file_id
          AND v.workspace_id = f.workspace_id
          AND v.state = 'purged'
          AND v.committed_at IS NOT NULL
      ) AS purged
    FROM swarm.files AS f
    WHERE f.file_id = ${cmd.file_id}::uuid
      AND f.workspace_id = ${workspaceId}::uuid
    FOR UPDATE OF f
  `;
  const file = rows[0];
  if (file === undefined) {
    return refuse(404, "file_not_found", "no such file in this workspace", "compound key miss");
  }
  const storedRestore = await ledgerRecheck();
  if (storedRestore?.hit === "conflict") {
    return refuse(
      409,
      "command_id_conflict",
      "this command id was already used with a different request",
      "command id conflict",
    );
  }
  if (storedRestore !== null) return { ok: "replay", stored: storedRestore.stored };
  if (file.tombstoned_at === null) {
    return refuse(409, "file_not_tombstoned", "this file is not tombstoned", "not tombstoned");
  }
  // ★R6, strengthened: the WINDOW decides, under the file lock the purge claim
  // also takes — a restore racing the claim either commits first (the claim
  // then skips the file) or sees this refusal. No dependence on whether the
  // cron has run yet.
  if (file.window_ended) {
    return refuse(
      410,
      "file_purged",
      "the 30-day restore window has ended; this file cannot be restored",
      "restore window ended",
    );
  }
  if (
    actor.kind === "agent" &&
    (file.created_by !== actor.id || file.created_by_kind !== "agent")
  ) {
    return refuse(
      403,
      "forbidden",
      "an agent may restore only files it uploaded; any human member may restore any file",
      "agent restoring another principal's file",
    );
  }
  // ★R6: refuse a file whose committed versions the purge already claimed —
  // the bytes are gone and a "restored" name with no content would lie.
  if (Number(file.purged) > 0) {
    return refuse(
      410,
      "file_purged",
      "the purge already claimed this file's contents; it cannot be restored",
      "purge claimed first",
    );
  }
  await tx`
    UPDATE swarm.files
    SET tombstoned_at = NULL, tombstoned_by = NULL
    WHERE file_id = ${cmd.file_id}::uuid
      AND workspace_id = ${workspaceId}::uuid
  `;
  return {
    ok: true,
    body: { file_id: cmd.file_id, name: file.name, restored: true },
  };
}

/**
 * S4: the purge-queue consumer. swarm.purge_file_artifacts() (pg_cron) claims
 * rows and queues their storage paths — SQL cannot delete storage objects (the
 * storage schema trigger refuses; measured, see the migration comment) — and
 * THIS drains the queue through the Storage API. It runs best-effort after any
 * file command, in its own transaction: at-least-once with a durable queue, so
 * a failed drain simply leaves rows for the next one. removeObjects tolerates
 * paths that never had an object (a pending row GC'd before its PUT).
 */
export async function drainFilePurgeQueue(
  tx: Sql,
  storage: FileStorage,
  limit: number,
): Promise<number> {
  /* The attempt stamp rides the CLAIM update, before the storage call: a row
   * must record that it was tried even when the try fails, and a throw across
   * the transaction would roll the stamp back — so the failure branch writes
   * last_error and RETURNS instead of throwing (S4 review item 2; the D-090
   * family — a pending row must distinguish never-tried from failing). */
  const rows = await tx<{ storage_path: string }[]>`
    UPDATE swarm.file_purge_queue
    SET attempt_count = attempt_count + 1,
        last_attempt_at = statement_timestamp()
    WHERE storage_path IN (
      SELECT storage_path
      FROM swarm.file_purge_queue
      WHERE deleted_at IS NULL
      ORDER BY claimed_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING storage_path
  `;
  if (rows.length === 0) return 0;
  const paths = rows.map((row) => row.storage_path);
  try {
    await storage.removeObjects(paths);
  } catch (error) {
    const detail = String(
      error instanceof Error ? error.message : error,
    ).slice(0, 500);
    await tx`
      UPDATE swarm.file_purge_queue
      SET last_error = ${detail}
      WHERE storage_path = ANY(${paths})
    `;
    return 0;
  }
  await tx`
    UPDATE swarm.file_purge_queue
    SET deleted_at = statement_timestamp(), last_error = NULL
    WHERE storage_path = ANY(${paths})
  `;
  return paths.length;
}
