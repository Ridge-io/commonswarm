import {
  brainRowsFromFiles,
  type BrainTopicRow,
} from "./brain.js";
import type { CloudTarget } from "./config.js";
import {
  listFilesAsAgent,
  onceRetried,
  type ReadDeadlineOptions,
} from "./files.js";

/** Reuse the retrying `brain ls` file-list path for an agent listener. */
export async function listBrainRowsAsAgent(
  target: CloudTarget,
  credential: string,
  workspaceId: string,
  options: ReadDeadlineOptions & {
    fetcher?: typeof fetch;
  } = {},
): Promise<BrainTopicRow[]> {
  const rows = await onceRetried(
    (attempt) =>
      listFilesAsAgent(
        target,
        credential,
        workspaceId,
        options.fetcher,
        {
          ...attempt,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.schedule ? { schedule: options.schedule } : {}),
          ...(options.cancel ? { cancel: options.cancel } : {}),
        },
      ),
    {
      ...(options.deadlineMs === undefined
        ? {}
        : { deadlineMs: options.deadlineMs }),
      ...(options.now ? { now: options.now } : {}),
    },
  );
  return brainRowsFromFiles(rows);
}
