import { newCommandId, type SignalRecord } from "./command-client.js";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";

export const AGENT_SEEN_BATCH_MAX = 50;
const AGENT_SEEN_TIMEOUT_MS = 5_000;

export type AgentSeenFailureCode = "transport" | "http" | "protocol";

/** Stable receipt-write failure classification; callers never inspect prose. */
export class AgentSeenReportError extends Error {
  constructor(
    readonly code: AgentSeenFailureCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AgentSeenReportError";
  }
}

export interface AgentSeenReportResult {
  attempted: number;
  reported: number;
  failures: AgentSeenFailureCode[];
}

/** Return only broadcasts present in the page the caller actually rendered. */
export function renderedBroadcastIds(rows: readonly SignalRecord[]): string[] {
  return [...new Set(rows.filter((row) =>
    row.to === null && row.to_agent === null
  ).map((row) => row.id))];
}

export function agentSeenBatches(
  ids: readonly string[],
): string[][] {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += AGENT_SEEN_BATCH_MAX) {
    batches.push(unique.slice(offset, offset + AGENT_SEEN_BATCH_MAX));
  }
  return batches;
}

async function postAgentSeenBatch(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  signalIds: readonly string[],
  fetcher: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_SEEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        apikey: target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: newCommandId(),
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: workspaceId,
        stream: { kind: "workspace" },
        command: { kind: "signals_seen", signal_ids: signalIds },
      }),
      signal: controller.signal,
    });
  } catch {
    throw new AgentSeenReportError(
      "transport",
      "agent seen report did not reach the command service",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AgentSeenReportError(
      "http",
      `agent seen report was refused with HTTP ${response.status}`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentSeenReportError(
      "protocol",
      "agent seen report returned malformed JSON",
      response.status,
    );
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    (body as Record<string, unknown>).ok !== true
  ) {
    throw new AgentSeenReportError(
      "protocol",
      "agent seen report returned a malformed acknowledgement",
      response.status,
    );
  }
}

/**
 * Best-effort append-only attestation. Every batch is tried, and no failure is
 * allowed to turn a successful feed/inbox read into a failed command.
 */
export async function reportRenderedBroadcasts(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  signalIds: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<AgentSeenReportResult> {
  const batches = agentSeenBatches(signalIds);
  const failures: AgentSeenFailureCode[] = [];
  let reported = 0;
  for (const batch of batches) {
    try {
      await postAgentSeenBatch(target, token, workspaceId, batch, fetcher);
      reported += batch.length;
    } catch (error) {
      failures.push(
        error instanceof AgentSeenReportError ? error.code : "transport",
      );
    }
  }
  return { attempted: new Set(signalIds).size, reported, failures };
}
