import {
  deliveryReceiptState,
  type AgentDeliveryReceiptResult,
  type DeliveryReceipt,
  type DeliveryReceiptRow,
  type HumanDeliveryReceipt,
  type UntrackedBroadcastAgentReceipt,
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
  | "queued"
  | "finished";

function humanReceipt(
  receipt: DeliveryReceiptRow,
): receipt is HumanDeliveryReceipt {
  return "recipient_user_id" in receipt;
}

function untrackedAgentReceipt(
  receipt: DeliveryReceiptRow,
): receipt is UntrackedBroadcastAgentReceipt {
  return "tracking_state" in receipt && receipt.tracking_state === "not_tracked";
}

function agentDeliveryReceipt(
  receipt: DeliveryReceiptRow,
): receipt is DeliveryReceipt {
  return !humanReceipt(receipt) && !untrackedAgentReceipt(receipt);
}

function signalReceiptCliState(
  receipt: DeliveryReceipt,
  nowMs: number,
): SignalReceiptCliState {
  const state = deliveryReceiptState(receipt, nowMs);
  if (state === "enqueued") return "not_delivered";
  if (state === "leased") return "working";
  if (state === "delivered") return "delivered";
  if (state === "queued") return "queued";
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
  const humanReceipts = report.receipts.filter(humanReceipt);
  const agentReceipts = report.receipts.filter(agentDeliveryReceipt);
  const untrackedAgents = report.receipts.filter(untrackedAgentReceipt);
  const humanSections = humanReceipts.map((receipt) =>
    receipt.seen_at === null
      ? `Not seen yet — the member's browser reports seen state when the message is viewed.`
      : [
        `Seen by ${receipt.recipient_user_id} at ${receipt.seen_at}.`,
        "This is a browser proxy: the message row was in view while the document had focus.",
      ].join("\n")
  );
  if (!report.addressed) {
    const seenMembers = humanReceipts.filter((receipt) => receipt.seen_at !== null);
    const notSeenMembers = humanReceipts.filter((receipt) => receipt.seen_at === null);
    const memberTotal = report.broadcast_roster?.members.total ?? humanReceipts.length;
    const seenTotal = report.broadcast_roster?.members.seen ?? seenMembers.length;
    const memberLabel = (receipt: HumanDeliveryReceipt): string =>
      receipt.display_name ?? receipt.recipient_user_id;
    const rosterSections = [
      `Seen by ${seenTotal} of ${memberTotal} workspace members.`,
      seenMembers.length === 0
        ? "Seen members: none."
        : [
          "Seen members:",
          ...seenMembers.map((receipt) =>
            `- ${memberLabel(receipt)} — ${relativeAge(receipt.seen_at!, nowMs)}.`
          ),
          "Seen is a browser proxy: the message row was in view while the document had focus.",
        ].join("\n"),
      notSeenMembers.length === 0
        ? "Not-seen members: none."
        : [
          "Not-seen members:",
          ...notSeenMembers.map((receipt) => `- ${memberLabel(receipt)}`),
        ].join("\n"),
      untrackedAgents.length === 0
        ? "Agents: none in this workspace."
        : [
          "Agents — not tracked:",
          ...untrackedAgents.map((receipt) => `- ${receipt.display_name}`),
          "Broadcasts do not wake agents, and CommonSwarm does not track whether an agent saw them.",
        ].join("\n"),
      report.broadcast_roster?.members.truncated
        ? `Member roster cut: showing ${report.broadcast_roster.members.returned} of ${report.broadcast_roster.members.total} members (limit ${report.broadcast_roster.members.limit}).`
        : null,
      report.broadcast_roster?.agents.truncated
        ? `Agent roster cut: showing ${report.broadcast_roster.agents.returned} of ${report.broadcast_roster.agents.total} agents (limit ${report.broadcast_roster.agents.limit}).`
        : null,
    ].filter((section): section is string => section !== null);
    return [
      "This was a broadcast; no agent was addressed and none was woken.",
      ...rosterSections,
      `To wake an agent, send a new ask with: cswarm ask "<text>" --to <agent> --workspace-id ${report.workspaceId}`,
    ].join("\n\n");
  }

  const sections = agentReceipts.map((receipt) => {
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

    if (state === "queued") {
      return [
        `Queued for agent ${receipt.recipient_agent_principal_id}'s interactive session ${relativeAge(receipt.acked_at!, nowMs)}. The agent has not seen it yet.`,
        "It will appear at the agent's next prompt.",
        `Check again with: ${receiptCheckCommand(report)}`,
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
        "The agent saw the signal without sending a reply.",
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
  return [...humanSections, ...sections].join("\n\n");
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
    ...(report.broadcast_roster === undefined
      ? {}
      : { broadcast_roster: report.broadcast_roster }),
    receipts: report.receipts.map((receipt) =>
      humanReceipt(receipt)
        ? {
          recipient_user_id: receipt.recipient_user_id,
          ...(receipt.display_name === undefined
            ? {}
            : { display_name: receipt.display_name }),
          state: receipt.seen_at === null ? "not_seen" : "seen",
          seen_at: receipt.seen_at,
        }
        : untrackedAgentReceipt(receipt)
        ? {
          recipient_agent_principal_id: receipt.recipient_agent_principal_id,
          display_name: receipt.display_name,
          state: "not_tracked",
          observed_at: null,
        }
        : {
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
        }
    ),
  };
}
