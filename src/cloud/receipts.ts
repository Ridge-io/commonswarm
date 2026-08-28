import {
  deliveryReceiptState,
  type AgentDeliveryReceiptResult,
  type DeliveryReceipt,
} from "./delivery-receipts.js";
import { relativeAge, relativeExpiry } from "./workspaces.js";

export interface SignalReceiptReport extends AgentDeliveryReceiptResult {
  workspaceId: string;
  signalId: string;
}

type SignalReceiptCliState =
  | "not_delivered"
  | "delivered"
  | "working"
  | "finished";

function signalReceiptCliState(
  receipt: DeliveryReceipt,
  nowMs: number,
): SignalReceiptCliState {
  const state = deliveryReceiptState(receipt, nowMs);
  if (state === "enqueued") return "not_delivered";
  if (state === "leased") return "working";
  if (state === "delivered") return "delivered";
  return "finished";
}

function receiptCheckCommand(report: SignalReceiptReport): string {
  return `cswarm receipt ${report.signalId} --workspace-id ${report.workspaceId}`;
}

function listenerStatusCommand(
  report: SignalReceiptReport,
  receipt: DeliveryReceipt,
): string {
  return `cswarm listen status --workspace-id ${report.workspaceId} --principal-id ${receipt.recipient_agent_principal_id}`;
}

function newAskCommand(
  report: SignalReceiptReport,
  receipt: DeliveryReceipt,
): string {
  return `cswarm ask "<question>" --to ${receipt.recipient_agent_principal_id} --workspace-id ${report.workspaceId}`;
}

/** Make each delivery state lead to the sender's next useful action. */
export function renderSignalReceiptReport(
  report: SignalReceiptReport,
  nowMs: number = Date.now(),
): string {
  if (!report.addressed) {
    return [
      "This was a broadcast; no agent was addressed and none was woken.",
      `To wake an agent, send a new ask with: cswarm ask "<text>" --to <agent> --workspace-id ${report.workspaceId}`,
    ].join("\n");
  }

  const sections = report.receipts.map((receipt) => {
    const state = deliveryReceiptState(receipt, nowMs);
    if (state === "enqueued") {
      return [
        `Not yet delivered to agent ${receipt.recipient_agent_principal_id}. CommonSwarm accepted it ${relativeAge(receipt.enqueued_at, nowMs)}.`,
        `Ask the agent's operator to check its listener with: ${listenerStatusCommand(report, receipt)}`,
        `Then check again with: ${receiptCheckCommand(report)}`,
      ].join("\n");
    }
    if (state === "delivered") {
      return [
        `Delivered to agent ${receipt.recipient_agent_principal_id} ${relativeAge(receipt.delivered_at!, nowMs)}, and the agent has not acted on it.`,
        `Check again with: ${receiptCheckCommand(report)}`,
      ].join("\n");
    }
    if (state === "leased") {
      return [
        `Agent ${receipt.recipient_agent_principal_id} is working on it right now; its current lease ${relativeExpiry(receipt.leased_until!, nowMs)}.`,
        `Check for the outcome with: ${receiptCheckCommand(report)}`,
      ].join("\n");
    }

    const finished = `Agent ${receipt.recipient_agent_principal_id} finished with outcome ${state} ${relativeAge(receipt.acked_at!, nowMs)}.`;
    if (state === "replied") {
      return [
        finished,
        `Read the reply with: cswarm inbox --workspace-id ${report.workspaceId} --include-stale`,
      ].join("\n");
    }
    if (state === "observed") {
      return [
        finished,
        "The agent acknowledged the signal without sending a reply.",
        `If you need an answer, send a new ask with: ${newAskCommand(report, receipt)}`,
      ].join("\n");
    }
    if (state === "expired") {
      return [
        finished,
        "The signal expired before the agent completed it.",
        `Send a new ask with: ${newAskCommand(report, receipt)}`,
      ].join("\n");
    }
    return [
      finished,
      `Delivery will not retry${receipt.last_error_code === null ? "." : `; the last error code was ${receipt.last_error_code}.`}`,
      `Ask the agent's operator to check its listener with: ${listenerStatusCommand(report, receipt)}`,
    ].join("\n");
  });
  return sections.join("\n\n");
}

/** Keep the CLI's machine state explicit while retaining every ledger field. */
export function signalReceiptJsonPayload(
  report: SignalReceiptReport,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  return {
    workspace_id: report.workspaceId,
    signal_id: report.signalId,
    broadcast: !report.addressed,
    receipts: report.receipts.map((receipt) => ({
      recipient_agent_principal_id: receipt.recipient_agent_principal_id,
      state: signalReceiptCliState(receipt, nowMs),
      outcome: receipt.ack_outcome,
      enqueued_at: receipt.enqueued_at,
      delivered_at: receipt.delivered_at,
      leased_until: receipt.leased_until,
      acked_at: receipt.acked_at,
      attempt_count: receipt.attempt_count,
      lease_expiry_count: receipt.lease_expiry_count,
      last_error_code: receipt.last_error_code,
    })),
  };
}
