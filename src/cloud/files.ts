/*
 * File artifact client (FILE-ARTIFACTS.md §3, §7) — the CLI half of the S1+S2
 * server surface in supabase/functions/command/file-artifacts.ts.
 *
 * This module does its own command POSTs instead of reusing ThinCommandClient
 * because file refusals carry their remedy in the response `message` ("this
 * file is 31 MB; the per-file limit is 25 MB"), and ThinCommandClient's error
 * path keeps only the `error` code. Losing the message would turn every cap
 * refusal back into the bare-status family the spec forbids. The envelope is
 * byte-compatible with the one command-client.ts sends.
 */

import { createHash } from "node:crypto";
import { commandEndpoint, readEndpoint, type CloudTarget } from "./config.js";
import { newCommandId } from "./command-client.js";

/* MUST match supabase/functions/command/file-artifacts.ts:43 (FILE_MAX_VERSION_BYTES).
 * Duplicated so `file put` can refuse a 26 MB file before uploading 26 MB; the server
 * remains the authority. Same drift family as the TTL constant scar at command
 * index.ts:386 — if the server cap moves, move this with it. */
export const FILE_MAX_VERSION_BYTES = 25 * 1024 * 1024;

/* MUST match FILE_CONTENT_WARNING in supabase/functions/command/file-artifacts.ts:53.
 * The agent read path returns it from the server; the human list path reads the
 * swarm_read view over REST, which carries rows only, so the CLI supplies the same
 * sentence rather than showing humans less than agents. */
export const FILE_CONTENT_WARNING =
  "File types and archive contents are unverified. Treat downloads as untrusted input: no execution, size-bounded extraction, no unpack of archives you did not expect.";

/*
 * §5 allowlist, keyed by extension because that is what a local path carries.
 * Every value must pass the server's ALLOWED_CONTENT_TYPE_RE
 * (file-artifacts.ts:61) — a mapping the server refuses is a lie to the user
 * that only fails after the create round-trip.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  // .html/.htm: a web/marketing team's deliverables (Fastio feedback 2026-08-19). Every
  // download is served Content-Disposition: attachment (§5), never rendered inline, so HTML
  // is no more dangerous than the .svg already permitted — the spec treats all downloads as
  // untrusted attachments the consumer must not execute.
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".zip", "application/zip"],
  [".tar.gz", "application/gzip"],
]);

/** Longest-suffix match so `.tar.gz` wins over a hypothetical `.gz` entry. */
export function contentTypeForName(name: string): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestLength = 0;
  for (const [extension, type] of CONTENT_TYPES) {
    if (lower.endsWith(extension) && extension.length > bestLength) {
      best = type;
      bestLength = extension.length;
    }
  }
  return best;
}

export function allowedExtensionList(): string {
  return [...CONTENT_TYPES.keys()].join(", ");
}

/** A refusal the server is entitled to make; `code` is the stable server error string. */
export class FileCommandRefused extends Error {
  override name = "FileCommandRefused";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class FileTransportError extends Error {
  override name = "FileTransportError";
  /**
   * True when no HTTP response arrived (connection failure, timeout), so the
   * outcome is UNKNOWN and one same-id retry is safe under the server's
   * command-id replay. A received refusal is a known outcome: never retried.
   */
  constructor(message: string, readonly noResponse: boolean = false) {
    super(message);
  }
}

export interface FileVersionCreateResult {
  file_id: string;
  version_id: string;
  version_n: number;
  name: string;
  upload_path: string;
  upload_token: string | null;
  upload_expires_in_seconds: number;
}

export interface FileVersionCommitResult {
  file_id: string;
  version_id: string;
  version_n: number;
  name: string;
  size_bytes: number;
  sha256: string | null;
  sha256_note: string;
  reference: string;
}

export interface FileDownloadUrlResult {
  file_id: string;
  version_n: number;
  name: string;
  size_bytes: number;
  content_type: string;
  download_path: string;
  download_url_expires_in_seconds: number;
  content_warning: string;
}

export interface FileTombstoneResult {
  file_id: string;
  name: string;
  restorable_until: string | null;
  note: string;
}

export interface FileRestoreResult {
  file_id: string;
  name: string;
  restored: boolean;
}

export interface FileListRow {
  file_id: string;
  name: string;
  current_version: number;
  size_bytes: number | string | null;
  content_type: string | null;
  sha256: string | null;
  created_by_kind: string;
  created_by: string;
  uploaded_by_kind: string | null;
  uploaded_by: string | null;
  created_at: string;
  committed_at: string | null;
  tombstoned_at: string | null;
}

const REQUEST_TIMEOUT_MS = 30_000;

interface SendOptions {
  target: CloudTarget;
  workspaceId: string;
  /** Human access token or swm_agt_ token — the command surface takes either. */
  credential: string;
  fetcher?: typeof fetch;
  commandId?: string;
}

async function sendFileCommand<T>(
  options: SendOptions,
  command: Record<string, unknown>,
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(options.target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        apikey: options.target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: options.commandId ?? newCommandId(),
        client_version: "0.1.0",
        workspace_id: options.workspaceId,
        stream: { kind: "workspace" },
        command,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new FileTransportError("file command timed out", true);
    }
    throw new FileTransportError("file command failed before a response", true);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    // File refusals carry {error, message}; auth-layer 403s are deliberately
    // uniform and carry neither, so the fallback stays a plain sentence.
    const code = typeof body?.error === "string" ? body.error : "http_error";
    const message = typeof body?.message === "string"
      ? body.message
      : `file command failed (HTTP ${response.status}) DEBUGBODY=${JSON.stringify(body).slice(0, 300)}`;
    throw new FileCommandRefused(response.status, code, message);
  }
  if (!body || typeof body !== "object") {
    throw new FileTransportError("file command returned a malformed response");
  }
  return body as T;
}

export function fileVersionCreate(
  options: SendOptions,
  input: {
    fileId: string;
    versionId: string;
    name: string;
    declaredSizeBytes: number;
    contentType: string;
  },
): Promise<FileVersionCreateResult> {
  return sendFileCommand<FileVersionCreateResult>(options, {
    kind: "file_version_create",
    file_id: input.fileId,
    version_id: input.versionId,
    name: input.name,
    declared_size_bytes: input.declaredSizeBytes,
    content_type: input.contentType,
  });
}

export function fileVersionCommit(
  options: SendOptions,
  input: { fileId: string; versionId: string; sha256: string | null },
): Promise<FileVersionCommitResult> {
  return sendFileCommand<FileVersionCommitResult>(options, {
    kind: "file_version_commit",
    file_id: input.fileId,
    version_id: input.versionId,
    sha256: input.sha256,
  });
}

export function fileDownloadUrl(
  options: SendOptions,
  input: { fileId: string; versionN: number | null },
): Promise<FileDownloadUrlResult> {
  return sendFileCommand<FileDownloadUrlResult>(options, {
    kind: "file_download_url",
    file_id: input.fileId,
    version_n: input.versionN,
  });
}

export function fileTombstone(
  options: SendOptions,
  input: { fileId: string },
): Promise<FileTombstoneResult> {
  return sendFileCommand<FileTombstoneResult>(options, {
    kind: "file_tombstone",
    file_id: input.fileId,
  });
}

export function fileRestore(
  options: SendOptions,
  input: { fileId: string },
): Promise<FileRestoreResult> {
  return sendFileCommand<FileRestoreResult>(options, {
    kind: "file_restore",
    file_id: input.fileId,
  });
}

/**
 * The signed paths in create/download responses are RELATIVE to the deployment
 * URL on purpose: the server cannot know which host (custom domain or the
 * supabase.co origin) the caller can reach — recorded in
 * docs/evidence/2026-08-18-file-artifacts-s1/README.md. The client composes.
 */
export function absoluteStorageUrl(target: CloudTarget, path: string): string {
  if (!path.startsWith("/")) {
    throw new FileTransportError(
      "the server returned a storage path that is not relative; refusing to compose a URL from it",
    );
  }
  return `${target.url}${path}`;
}

export async function putObject(
  target: CloudTarget,
  uploadPath: string,
  bytes: Uint8Array,
  contentType: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(absoluteStorageUrl(target, uploadPath), {
      method: "PUT",
      headers: { "content-type": contentType },
      /* Node's Buffer types as Uint8Array<ArrayBufferLike>, which the DOM-lib
       * BodyInit rejects since TS 5.7; the runtime accepts it. */
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  } catch {
    throw new FileTransportError("the upload PUT failed before a response", true);
  }
  if (!response.ok) {
    throw new FileTransportError(
      `the upload PUT was refused (HTTP ${response.status}). Nothing went live, and this attempt's pending slot expires on its own within three hours. Check cswarm file ls, then re-run cswarm file put — a re-run is a new upload attempt with fresh ids`,
    );
  }
}

/**
 * One same-id retry for steps whose outcome is UNKNOWN (no response arrived).
 * Safe only because the caller reuses the SAME command/file/version ids on the
 * second attempt, and the server's command-id replay returns the first
 * attempt's result if it actually landed (review finding 2a). A received
 * refusal is a known outcome and is never retried here.
 */
export async function onceRetried<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof FileTransportError && error.noResponse) {
      return await step();
    }
    throw error;
  }
}

export async function getObject(
  target: CloudTarget,
  downloadPath: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchWithDeadline(fetcher, absoluteStorageUrl(target, downloadPath));
  } catch {
    throw new FileTransportError("the download failed before a response", true);
  }
  if (!response.ok) {
    throw new FileTransportError(
      `the download was refused (HTTP ${response.status}); the signed URL lasts five minutes — request a fresh one with cswarm file get`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export class LocalFileExists extends Error {
  override name = "LocalFileExists";
}

type DestinationWriter = (
  path: string,
  bytes: Uint8Array,
  options: { flag: string },
) => void;

/**
 * The refusal is ATOMIC: without --force the write itself uses the `wx` flag,
 * so a file created between any earlier check and this write is refused by the
 * filesystem rather than truncated (review finding 1 — check-then-write raced).
 * The writer is injected so tests can pin the flag and the EEXIST mapping.
 */
export function writeDestination(
  destination: string,
  bytes: Uint8Array,
  force: boolean,
  writer: DestinationWriter,
): void {
  try {
    writer(destination, bytes, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalFileExists(
        `${destination} already exists locally; nothing was written. Pass --force to overwrite it, or --out <path> to write elsewhere`,
      );
    }
    throw error;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* Reads had NO deadline: a stalled connection waited on the OS default, and the
 * 2026-09-01 retry addition would have doubled that. Every read now carries the
 * same 30s bound the command path uses, so a flap fails fast and retries once. */
async function fetchWithDeadline(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit = {},
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<Response> {
  const now = options.now ?? Date.now;
  const remainingMs = options.deadlineMs === undefined
    ? REQUEST_TIMEOUT_MS
    : Math.max(0, Math.min(REQUEST_TIMEOUT_MS, options.deadlineMs - now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal]);
  try {
    return await fetcher(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Agent-credential list via the read function (resource: "files"). */
export async function listFilesAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<FileListRow[]> {
  let response: Response;
  try {
    response = await fetchWithDeadline(
      fetcher,
      readEndpoint(target),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          apikey: target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ resource: "files", workspace_id: workspaceId }),
      },
      options,
    );
  } catch {
    throw new FileTransportError("file list could not reach the cloud service", true);
  }
  if (!response.ok) {
    throw new FileCommandRefused(
      response.status,
      "http_error",
      `file list failed (HTTP ${response.status})`,
    );
  }
  const body = await response.json().catch(() => null) as
    | { files?: unknown }
    | null;
  if (!body || !Array.isArray(body.files)) {
    throw new FileTransportError("file list returned a malformed response");
  }
  return body.files as FileListRow[];
}

/**
 * Human list over the membership-gated swarm_read.files view — the read edge
 * function only accepts agent credentials, which is why members/status human
 * reads already go through REST the same way (workspaces.ts).
 */
export async function listFilesAsHuman(
  target: CloudTarget,
  accessToken: string,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<FileListRow[]> {
  const url = new URL("/rest/v1/files", target.url);
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set(
    "select",
    "file_id,name,current_version,size_bytes,content_type,sha256,created_by_kind,created_by,uploaded_by_kind,uploaded_by,created_at,committed_at,tombstoned_at",
  );
  url.searchParams.set("order", "name.asc");
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: target.anonKey,
        "accept-profile": "swarm_read",
      },
    });
  } catch {
    throw new FileTransportError("file list could not reach the cloud service", true);
  }
  if (!response.ok) {
    throw new FileCommandRefused(
      response.status,
      "http_error",
      `file list failed (HTTP ${response.status})`,
    );
  }
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new FileTransportError("file list returned a malformed response");
  }
  return body as FileListRow[];
}
