/** Server wire validation for immutable signal attachment references. */
export const SIGNAL_ATTACHMENT_MAX = 8;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignalAttachmentRef {
  file_id: string;
  version_n: number;
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

/** Shape-only parsing; the transaction applies the count, tenancy, and live-state rules. */
export function parseSignalAttachmentRefs(
  value: unknown,
): SignalAttachmentRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SignalAttachmentRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      !exactKeys(row, ["file_id", "version_n"]) ||
      typeof row.file_id !== "string" || !UUID_RE.test(row.file_id) ||
      typeof row.version_n !== "number" ||
      !Number.isSafeInteger(row.version_n) || row.version_n < 1
    ) {
      return null;
    }
    refs.push({
      file_id: row.file_id.toLowerCase(),
      version_n: row.version_n,
    });
  }
  return refs;
}

/** Stable list-only refusals, kept pure so both cap and duplicate behavior are gated. */
export function signalAttachmentListRefusal(
  refs: readonly SignalAttachmentRef[],
): "signal_attachment_limit" | "signal_attachment_duplicate" | null {
  if (refs.length > SIGNAL_ATTACHMENT_MAX) return "signal_attachment_limit";
  const keys = refs.map((ref) => `${ref.file_id}:${ref.version_n}`);
  return new Set(keys).size === keys.length ? null : "signal_attachment_duplicate";
}
