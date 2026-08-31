/** Small enough for one signal to stay readable in every receive surface. */
export const SIGNAL_ATTACHMENT_MAX = 8;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignalAttachmentRef {
  file_id: string;
  version_n: number;
}

export interface SignalAttachment extends SignalAttachmentRef {
  name: string;
  content_type: string;
  size_bytes: number;
}

/** Parses optional attachment metadata while ignoring additive fields from newer servers. */
export function parseSignalAttachments(
  value: unknown,
  options: { enabled?: boolean } = {},
): SignalAttachment[] {
  if (options.enabled === false || value === undefined) return [];
  if (!Array.isArray(value) || value.length > SIGNAL_ATTACHMENT_MAX) {
    throw new Error("signal read returned malformed attachments");
  }
  const attachments: SignalAttachment[] = [];
  const seen = new Set<string>();
  for (const valueAtPosition of value) {
    if (
      !valueAtPosition || typeof valueAtPosition !== "object" ||
      Array.isArray(valueAtPosition)
    ) {
      throw new Error("signal read returned a malformed attachment");
    }
    const row = valueAtPosition as Record<string, unknown>;
    if (
      typeof row.file_id !== "string" || !UUID_RE.test(row.file_id) ||
      typeof row.version_n !== "number" ||
      !Number.isSafeInteger(row.version_n) || row.version_n < 1 ||
      typeof row.name !== "string" || row.name.length < 1 || row.name.length > 255 ||
      typeof row.content_type !== "string" || row.content_type.length < 1 ||
      typeof row.size_bytes !== "number" ||
      !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0
    ) {
      throw new Error("signal read returned malformed attachment metadata");
    }
    const fileId = row.file_id.toLowerCase();
    const key = `${fileId}:${row.version_n}`;
    if (seen.has(key)) {
      throw new Error("signal read returned duplicate attachment metadata");
    }
    seen.add(key);
    attachments.push({
      file_id: fileId,
      version_n: row.version_n,
      name: row.name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
    });
  }
  return attachments;
}

/** Uses a file id so untrusted names never need shell quoting in agent instructions. */
export function attachmentRetrievalCommand(
  workspaceId: string,
  attachment: SignalAttachmentRef,
): string {
  if (!UUID_RE.test(workspaceId) || !UUID_RE.test(attachment.file_id)) {
    throw new Error("attachment retrieval command needs UUID identifiers");
  }
  if (!Number.isSafeInteger(attachment.version_n) || attachment.version_n < 1) {
    throw new Error("attachment retrieval command needs a positive version");
  }
  return `cswarm file get ${attachment.file_id.toLowerCase()} --version ${attachment.version_n} --workspace-id ${workspaceId.toLowerCase()}`;
}

/** Compact binary-size copy shared by signal receive surfaces. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
