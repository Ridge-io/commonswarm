import {
  brainRowsFromFiles,
  type BrainTopicRow,
} from "./brain.js";
import type { CloudTarget } from "./config.js";
import { listFilesAsAgent, onceRetried } from "./files.js";

/** Reuse the retrying `brain ls` file-list path for an agent listener. */
export async function listBrainRowsAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<BrainTopicRow[]> {
  const rows = await onceRetried(() =>
    listFilesAsAgent(
      target,
      credential,
      workspaceId,
      options.fetcher,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.deadlineMs === undefined
          ? {}
          : { deadlineMs: options.deadlineMs }),
        ...(options.now ? { now: options.now } : {}),
      },
    )
  );
  return brainRowsFromFiles(rows);
}
