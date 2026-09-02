import { open } from "node:fs/promises";
import type { CloudTarget } from "../cloud/config.js";
import {
  ThinCommandClient,
} from "../cloud/command-client.js";
import {
  DeliveryReceiptReadError,
  deliveryReceiptState,
  readAgentDeliveryReceipts,
  type DeliveryReceipt,
  type DeliveryReceiptRow,
} from "../cloud/delivery-receipts.js";
import { SignalReadTimeoutError } from "../cloud/signals.js";
import type { ListenerPaths } from "./control.js";
import { FileHookSurfaceStore } from "./hook.js";

const LOG_TAIL_BYTES = 256 * 1024;

export type ListenerCanaryStalledHop =
  | "claimed"
  | "routed"
  | "surfaced"
  | "observed";

export interface ListenerAttendanceCanaryResult {
  signalId: string;
  acceptedAt: string;
  claimedAt: string | null;
  routeDecision: "main" | "worker" | null;
  routedAt: string | null;
  pendingForMainCount: number | null;
  surfacedAt: string | null;
  observedAt: string | null;
  receiptReadErrorCode: "transport" | "http" | "protocol" | "not_author" | "timeout" | null;
  stalledAt: ListenerCanaryStalledHop | null;
}

export interface ListenerAttendanceCanaryOptions {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  paths: ListenerPaths;
  credential: () => Promise<string>;
  waitMs: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
}

interface CanaryLogEvidence {
  claimedAt: string | null;
  routeDecision: "main" | "worker" | null;
  routedAt: string | null;
}

function agentReceipt(
  receipts: readonly DeliveryReceiptRow[],
  principalId: string,
): DeliveryReceipt | null {
  for (const receipt of receipts) {
    if (
      "recipient_agent_principal_id" in receipt &&
      receipt.recipient_agent_principal_id === principalId
    ) {
      return receipt;
    }
  }
  return null;
}

async function readLogTail(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function logEvidence(
  path: string,
  signalId: string,
): Promise<CanaryLogEvidence> {
  let claimedAt: string | null = null;
  let routeDecision: "main" | "worker" | null = null;
  let routedAt: string | null = null;
  for (const line of (await readLogTail(path)).split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.signal_id !== signalId || typeof row.ts !== "string") continue;
    if (row.event === "listener_delivery_claim") claimedAt = row.ts;
    if (
      row.event === "listener_routing_decision" &&
      (row.route_decision === "main" || row.route_decision === "worker")
    ) {
      routeDecision = row.route_decision;
      routedAt = row.ts;
    }
  }
  return { claimedAt, routeDecision, routedAt };
}

/** Post one self-note and measure every listener attendance hop before the deadline. */
export async function runListenerAttendanceCanary(
  options: ListenerAttendanceCanaryOptions,
): Promise<ListenerAttendanceCanaryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadlineMs = startedAt + options.waitMs;
  const client = new ThinCommandClient(options.target, options.fetcher, {
    signalRequestTimeoutMs: options.waitMs,
  });
  const posted = await client.sendSignal({
    workspaceId: options.workspaceId,
    credential: await options.credential(),
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "CommonSwarm listener attendance canary. No reply is needed.",
      to_user_id: null,
      to_agent_principal_id: options.principalId,
      in_reply_to: null,
      about: null,
      until_ms: 10 * 60_000,
    },
  });
  const signalId = posted.response.signal!.id;

  let claimedAt: string | null = null;
  let routeDecision: "main" | "worker" | null = null;
  let routedAt: string | null = null;
  let pendingForMainCount: number | null = null;
  let surfacedAt: string | null = null;
  let observedAt: string | null = null;
  let receiptReadErrorCode: ListenerAttendanceCanaryResult["receiptReadErrorCode"] = null;

  while (true) {
    const log = await logEvidence(options.paths.logPath, signalId);
    claimedAt ??= log.claimedAt;
    routeDecision ??= log.routeDecision;
    routedAt ??= log.routedAt;

    const hook = await new FileHookSurfaceStore(
      options.paths.instanceDirectory,
    ).evidence();
    if (hook.surfacedSignalIds.includes(signalId)) {
      surfacedAt ??= new Date(now()).toISOString();
    }

    if (now() >= deadlineMs) break;

    try {
      const report = await readAgentDeliveryReceipts(
        options.target,
        await options.credential(),
        options.workspaceId,
        signalId,
        {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          deadlineMs,
          now,
        },
      );
      receiptReadErrorCode = null;
      const receipt = agentReceipt(report.receipts, options.principalId);
      if (receipt !== null) {
        claimedAt ??= receipt.delivered_at;
        if (receipt.ack_outcome === "queued") {
          routeDecision ??= "main";
          routedAt ??= receipt.acked_at;
          pendingForMainCount = receipt.pending_for_main_count ?? null;
        }
        const state = deliveryReceiptState(receipt, now());
        if (state === "observed" || state === "replied") {
          observedAt = receipt.acked_at;
        }
      }
    } catch (error) {
      receiptReadErrorCode = error instanceof DeliveryReceiptReadError
        ? error.code
        : error instanceof SignalReadTimeoutError
        ? "timeout"
        : "transport";
    }

    const complete = claimedAt !== null && routeDecision !== null &&
      (routeDecision === "worker" || surfacedAt !== null) &&
      observedAt !== null;
    if (complete || now() >= deadlineMs) break;
    await sleep(Math.min(options.pollMs ?? 250, deadlineMs - now()));
  }

  const stalledAt = claimedAt === null
    ? "claimed"
    : routeDecision === null
    ? "routed"
    : routeDecision === "main" && surfacedAt === null
    ? "surfaced"
    : observedAt === null
    ? "observed"
    : null;
  return {
    signalId,
    acceptedAt: new Date(startedAt).toISOString(),
    claimedAt,
    routeDecision,
    routedAt,
    pendingForMainCount,
    surfacedAt,
    observedAt,
    receiptReadErrorCode,
    stalledAt,
  };
}

/** Render hop evidence and the exact next step for the first stalled hop. */
export function renderListenerAttendanceCanary(
  result: ListenerAttendanceCanaryResult,
  workspaceId: string,
  principalId: string,
): string {
  const statusCommand =
    `cswarm listen status --workspace-id ${workspaceId} --principal-id ${principalId}`;
  const route = result.routeDecision === "main"
    ? `queued for the interactive session${
      result.pendingForMainCount === null
        ? ""
        : ` (${result.pendingForMainCount} in queue)`
    }`
    : result.routeDecision === "worker"
    ? "sent to the worker"
    : "not measured";
  const lines = [
    `Canary note: ${result.signalId}.`,
    `ACCEPTED: yes at ${result.acceptedAt}.`,
    `CLAIMED: ${result.claimedAt === null ? "no" : `yes at ${result.claimedAt}`}.`,
    `QUEUED/WORKER: ${route}.`,
    `SURFACED: ${
      result.routeDecision === "worker"
        ? "not required for the worker route"
        : result.surfacedAt === null
        ? "no"
        : `yes at ${result.surfacedAt}`
    }.`,
    `OBSERVED: ${result.observedAt === null ? "no" : `yes at ${result.observedAt}`}.`,
  ];
  if (result.receiptReadErrorCode !== null) {
    lines.push(`RECEIPT READ: failed (${result.receiptReadErrorCode}).`);
  }
  if (result.stalledAt === null) {
    lines.push("Canary passed: every required hop was measured.");
  } else if (result.stalledAt === "surfaced") {
    lines.push(
      "STALLED: surfaced. Next: " +
        `cswarm hook install claude --principal-id ${principalId} --write, ` +
        "then start a fresh session. Or restart the listener with --route worker.",
    );
  } else {
    lines.push(`STALLED: ${result.stalledAt}. Next: ${statusCommand}`);
  }
  return lines.join("\n");
}
