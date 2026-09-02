import {
  broadcastRosterHiddenCounts,
  deliveryReceiptState,
  type AgentDeliveryReceiptResult,
  type DeliveryReceipt,
  type DeliveryReceiptRow,
  type HumanDeliveryReceipt,
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
  | "observed"
  | "finished";

function humanReceipt(
  receipt: DeliveryReceiptRow,
): receipt is HumanDeliveryReceipt {
  return "recipient_user_id" in receipt;
}

function agentDeliveryReceipt(
  receipt: DeliveryReceiptRow,
): receipt is DeliveryReceipt {
  return !humanReceipt(receipt);
}

/**
 * The line that replaces "none" when the server cut the list. "none" is a
 * claim about the whole roster; a cut section can only speak for what it shows.
 */
function rosterCutLine(hidden: number, shown: number): string | null {
  if (hidden === 0) return null;
  return `${hidden}${shown === 0 ? "" : " more"} not shown (roster cut).`;
}

function rosterSection(
  title: string,
  rows: readonly string[],
  hidden: number,
  emptyLine: string,
  trailer: string | null,
): string {
  if (rows.length === 0 && hidden === 0) return emptyLine;
  return [
    `${title}:`,
    ...rows,
    rosterCutLine(hidden, rows.length),
    trailer,
  ].filter((line): line is string => line !== null).join("\n");
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
  if (state === "observed") return "observed";
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
    const agents = report.broadcast_roster?.agents.principals ?? [];
    const seenAgents = agents.filter((receipt) => receipt.seen_at !== null);
    const notSeenAgents = agents.filter((receipt) => receipt.seen_at === null);
    const memberTotal = report.broadcast_roster?.members.total ?? humanReceipts.length;
    const seenTotal = report.broadcast_roster?.members.seen ?? seenMembers.length;
    const agentTotal = report.broadcast_roster?.agents.total ?? agents.length;
    const agentSeenTotal = report.broadcast_roster?.agents.seen ?? seenAgents.length;
    // Per-section remainder from the uncapped totals. With 100 members and 60
    // seen the capped list is 50 seen and 0 not-seen; "Not-seen members: none"
    // would be false, so the section says how many the cut hid instead.
    const hidden = broadcastRosterHiddenCounts(report);
    const memberLabel = (receipt: HumanDeliveryReceipt): string =>
      receipt.display_name ?? receipt.recipient_user_id;
    const rosterSections = [
      `Seen by ${seenTotal} of ${memberTotal} workspace members.`,
      rosterSection(
        "Seen members",
        seenMembers.map((receipt) =>
          `- ${memberLabel(receipt)} — ${relativeAge(receipt.seen_at!, nowMs)}.`
        ),
        hidden.seen,
        "Seen members: none.",
        "Seen is a browser proxy: the message row was in view while the document had focus.",
      ),
      rosterSection(
        "Not-seen members",
        notSeenMembers.map((receipt) => `- ${memberLabel(receipt)}`),
        hidden.notSeen,
        "Not-seen members: none.",
        null,
      ),
      rosterSection(
        `Agents — seen ${agentSeenTotal} of ${agentTotal}`,
        [
          ...seenAgents.map((receipt) =>
            `- ${receipt.display_name} — ${relativeAge(receipt.seen_at!, nowMs)}.`
          ),
          ...notSeenAgents.map((receipt) =>
            `- ${receipt.display_name} — not yet seen`
          ),
        ],
        hidden.seenAgents + hidden.notSeenAgents,
        "Agents: none in this workspace.",
        "Seen means the agent's CLI rendered it, or its listener's model consumed it in a completed turn.",
      ),
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
      const queueCount = receipt.pending_for_main_count;
      return [
        `Queued for agent ${receipt.recipient_agent_principal_id}'s interactive session ${relativeAge(receipt.acked_at!, nowMs)}; waiting for the recipient's session hook${
          typeof queueCount === "number" ? ` (${queueCount} in queue)` : ""
        }.`,
        `Ask the agent's operator to check its listener with: ${listenerStatusCommand(report, receipt)}`,
        `Check again with: ${receiptCheckCommand(report)}`,
      ].join("\n");
    }

    /*
     * Directed ACK label matrix, derived from the producers rather than from
     * the outcome names:
     *
     *                    queued            replied             observed                         expired             failed_terminal
     * ASK                session queue     reply posted        session hook surfaced it         TTL ended           listener/server stopped
     * NOTE               session queue     defensive only      worker consumed or hook surfaced server TTL ended    server attempt ceiling
     *
     * The listener selects ackable records and maps their exact outcomes at
     * src/listener/runtime.ts:413-465; recovered and fresh deliveries prepare
     * those ACKs at runtime.ts:1213-1224 and 1542-1555. Its queued row follows
     * the durable queue write at runtime.ts:824-867. The engine produces ASK
     * expiry at src/listener/engine.ts:403-409, 484-490, 594-600, and 693-699;
     * failure at engine.ts:391-397, 415-421, 501-565, 602-616, and 701-711; and
     * a posted reply at engine.ts:625-638. Worker NOTE observed is produced at
     * runtime.ts:613-641 and 1449-1473; unreadable NOTE repair and ASK failure
     * are runtime.ts:644-680.
     * The other ASK observed producer writes hook output before promotion in
     * src/listener/hook.ts:930-964 and sends that promotion through
     * src/cloud/delivery.ts:778-806. Server-owned expiry and attempt exhaustion
     * are supabase/functions/command/durable-delivery.ts:162-204. There is no
     * honest NOTE replied producer: runtime.ts:417-418 guards replied with ASK.
     */
    if (state === "observed") {
      return [
        `Agent ${receipt.recipient_agent_principal_id} reported outcome observed ${relativeAge(receipt.acked_at!, nowMs)}.`,
        "The signal was surfaced to the agent's session or handled by its listener.",
        "If it was an ask, an answer may still be posted.",
        `If you need an answer, send a new ask with: ${newAskCommand(report, receipt)}`,
      ].join("\n");
    }

    const finished = `Agent ${receipt.recipient_agent_principal_id} finished with outcome ${state} ${relativeAge(receipt.acked_at!, nowMs)}.`;
    if (state === "replied") {
      return [
        finished,
        `Read the reply with: cswarm inbox --workspace-id ${report.workspaceId} --include-stale`,
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
          pending_for_main_count: receipt.pending_for_main_count ?? null,
        }
    ),
  };
}
