You are an ADVERSARIAL reviewer. Your previous reply on this exact patch was rejected: it praised the
patch, found nothing, and omitted the mandatory verdict line. A review with no findings and no
verdict line is not a review. Do not repeat that.

Rules for this reply:
- Your LAST line must be exactly `VERDICT: PASS` or exactly `VERDICT: FAIL`. Nothing after it.
- Do not summarize what the patch claims to do. Try to BREAK it.
- For each of the seven checks below, state concretely what you tried in order to refute it, and
  either the reachable failing sequence you found, or why every path you tried holds. "It is
  correct" without the attempted refutation is worth zero.
- Cite code by symbol and the exact text in the diff, not by intent.
- Reachable means reachable in production through real events (delivery_ack, effect, main_queue,
  ready, restart, corrupt or partial status files). Hypotheticals that require editing source are
  not findings.
- Adjectives such as "flawless", "beautiful", "meticulous", "excellent" are banned.

You are reviewing a patch to CommonSwarm, a coordination service for AI agents. Be adversarial:
find what is WRONG. An empty PASS is not a review. Everything you need is in this message; you do
not need to read any files.

## ROUND 8 — what changed since your review of 4992dd8

Grok's FAIL held and is fixed: a pre-0.1.51 status (every fleet listener at upgrade, and any
running 0.1.50 listener read by the new CLI) has `lastAckAt` and no `lastAckOutcome`; the
last-signal line said "No delivery acknowledgement is recorded" beside a recorded `lastAckAt`.
That sentence is now keyed on `lastAckAt`; the outcome-less shape prints "An acknowledgement was
recorded at <ts>; its outcome was not recorded." New control writes a 0.1.50-shaped file, reads it
with the new CLI, restarts on it, asserts both renders; mutation-tested.

Gemini's PASS on 4992dd8 stands for everything else. Re-run all seven checks on THIS diff. Same
rules: attempted refutation per check, reachable sequences only, last line exactly
`VERDICT: PASS` or `VERDICT: FAIL`.

## The complete patch (git diff <merge-base>..HEAD, the branch's own changes only)

diff --git a/docs/design/2026-07-30-AGENT-RECEIVE-MVP.md b/docs/design/2026-07-30-AGENT-RECEIVE-MVP.md
index 012f352..524f3c3 100644
--- a/docs/design/2026-07-30-AGENT-RECEIVE-MVP.md
+++ b/docs/design/2026-07-30-AGENT-RECEIVE-MVP.md
@@ -53,6 +53,15 @@ cswarm listen status --workspace-id <uuid> --principal-id <uuid>
 cswarm listen stop --workspace-id <uuid> --principal-id <uuid>
 ```
 
+For worker-route health checks, read `handledState`, `consecutiveAckFailureCount` and
+`listenerLapseCodes` from `cswarm listen status --json`. `state: "ready"` proves only that the
+listener transport is up: it stays `ready` through a provider that answers nothing. `handledState`
+reads `not_handled` whenever the newest acknowledgement was `failed_terminal`, and ALSO once the
+terminal-failure run reaches its threshold even when the newest acknowledgement was an `observed`
+note, because observing a note starts no provider session and so cannot prove this agent is
+answering. `listenerLapseCodes` carries `listener_delivery_failing` only at the threshold, so the
+two fields disagree between the first failure and the third; that is the intended reading.
+
 - An exact UUID identifies one member or agent.
 - An exact name is accepted only when it identifies exactly one live member or
   agent. A collision refuses and lists typed UUID choices.
diff --git a/docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md b/docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md
index e6ba726..74ad20e 100644
--- a/docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md
+++ b/docs/design/contracts/RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md
@@ -134,7 +134,10 @@ reducer must:
 - persist mode plus exact/null pending count on `delivery_mode`;
 - persist `lastClaimAt` plus exact pending count on `delivery_claim`, without calling it handled;
 - require a positive terminal-failure count and persist the latest count/timestamp;
-- persist `lastAckAt`, set pending count to null, and update last handled signal on ACK; and
+- persist `lastAckAt`, the ack outcome, and the signal ID on ACK; increment the
+  terminal-failure run for `failed_terminal`, clear it only for an outcome in
+  `DELIVERY_PROVIDER_PROVEN_OUTCOMES`, and leave it unchanged for `observed`, `queued`,
+  or `expired`; and
 - translate only to B's closed snake-case fields, never lease/command IDs or content.
 
 ## Frozen constants and budgets
@@ -230,10 +233,14 @@ Inside `runConfiguredListener`:
 Correct the delivery comment: transport never logs or persists the lease; the secure listener
 journal intentionally may persist it for exact ACK recovery.
 
-Status JSON normalizes all six omitted legacy fields to null and adds no duplicate snake-case
-aliases. Human output distinguishes durable/fallback, prints pending only when non-null, never
-renders unknown as zero, and emits one bounded last-claim failure sentence only for positive count.
-It must contain no sender, body, lease, command, bearer, prompt, or reply content.
+Status JSON normalizes every omitted legacy delivery field to null and adds no duplicate
+snake-case aliases. It reports the newest ack outcome and the terminal-failure run. Human output
+distinguishes durable/fallback, prints pending only when non-null, never renders unknown as zero,
+calls a signal handled only for an outcome in `DELIVERY_HANDLED_OUTCOMES` AND a
+terminal-failure run below `LISTENER_DELIVERY_FAILING_THRESHOLD` (observing a note starts no
+provider session, so it cannot prove the agent answers while a run stands), and emits one bounded
+last-claim failure sentence only for positive count. It must contain no sender, body, lease,
+command, bearer, prompt, or reply content.
 
 Goal-D causal process tests prove the complete fake read-capability -> claim -> reply -> ACK flow,
 one UUID across every layer, losing concurrent startup without journal rotation, distinct mode
diff --git a/src/cli.ts b/src/cli.ts
index 8f86f64..963819d 100755
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -221,6 +221,7 @@ import {
   DeliveryReceiptReadError,
   readAgentDeliveryReceipts,
 } from "./cloud/delivery-receipts.js";
+import { DELIVERY_HANDLED_OUTCOMES } from "./cloud/delivery.js";
 import {
   renderedBroadcastIds,
   reportRenderedBroadcasts,
@@ -268,6 +269,7 @@ import {
   renderListenerAttendanceCanary,
   runListenerAttendanceCanary,
   writeListenerCredentialState,
+  LISTENER_DELIVERY_FAILING_THRESHOLD,
   LISTENER_DEFER_OVER_MAX,
   LISTENER_DEFER_OVER_MIN,
   emptyListenerReadHealth,
@@ -4268,10 +4270,27 @@ function listenerAttendanceState(
     : attendanceState === "unattended"
     ? false
     : null;
+  const lastAckOutcome = status.lastAckOutcome ?? null;
+  // An acknowledgement that never reaches the service emits no delivery_ack.
+  // The stored outcome therefore describes only the newest acknowledgement
+  // the service accepted; it says nothing about an acknowledgement that failed.
+  // A run of terminal failures outranks the newest outcome. `observed` proves a
+  // note was dealt with; it starts no provider session, so it cannot prove this
+  // agent is answering. Reading it as handled is what reported a signed-out
+  // provider healthy at 18:47 on 2026-09-03.
+  const deliveryFailing =
+    (status.consecutiveAckFailureCount ?? 0) >=
+      LISTENER_DELIVERY_FAILING_THRESHOLD;
   const handled = pending > 0
     ? false
-    : routeMode === "worker" && status.lastAckAt !== null
+    : routeMode !== "worker" || lastAckOutcome === null
+    ? null
+    : deliveryFailing
+    ? false
+    : DELIVERY_HANDLED_OUTCOMES.has(lastAckOutcome)
     ? true
+    : lastAckOutcome === "failed_terminal"
+    ? false
     : null;
   return {
     connected,
@@ -4294,7 +4313,8 @@ interface ListenerLapseNotice {
   code:
     | "listener_host_ports_exhausted"
     | "listener_read_retry_persisting"
-    | "listener_claim_throughput_lapse";
+    | "listener_claim_throughput_lapse"
+    | "listener_delivery_failing";
   message: string;
   nextStep: string;
 }
@@ -4345,6 +4365,29 @@ function listenerLapseNotices(
         "This host is starving the listener — check load/memory pressure (sysctl kern.memorystatus_vm_pressure_level), or move the listener.",
     });
   }
+  const consecutive = status.consecutiveAckFailureCount ?? 0;
+  if (consecutive >= LISTENER_DELIVERY_FAILING_THRESHOLD) {
+    notices.push({
+      code: "listener_delivery_failing",
+      message:
+        // Do not assert "messages are not being answered": a notes-only listener
+        // acks `observed` and is fine. State only what the run records.
+        `The listener recorded ${consecutive} terminal delivery ${
+          consecutive === 1 ? "failure" : "failures"
+        } with no reply since. The newest acknowledgement was ${status.lastAckOutcome ?? "not recorded"} at ${status.lastAckAt ?? "an unknown time"}. The most recent listener error code is ${status.lastErrorCode ?? "not recorded"}.`,
+      nextStep:
+        // `failed_terminal` covers a refusing-but-healthy provider, a dead host
+        // session, and a local post failure, and the run alone cannot tell them
+        // apart — so name the check, not a diagnosis. The command needs the
+        // credential on stdin, and the listener is still running here.
+        // `stop` takes --principal-id and needs no credential, so it must not
+        // read stdin: one pipe cannot feed both halves of a chained command.
+        // `listen stop` returns while the state is still `stopping` (D-074), and
+        // `listen start` refuses a listener that is stopping, so the two verbs
+        // race unless the confirm step sits between them.
+        `Read the failure codes in ${status.logPath}, then stop the listener with: cswarm listen stop --workspace-id ${status.workspaceId} --principal-id ${status.principalId}. Wait until it is no longer running -- state stopped or failed, not stopping -- confirming with: cswarm listen status --workspace-id ${status.workspaceId} --principal-id ${status.principalId}. Then restart it by piping the same agent credential into: ${listenerRestartCommand(status)}`,
+    });
+  }
   return notices;
 }
 
@@ -4490,6 +4533,9 @@ export function listenerStatusJson(
       status.lastTerminalDeliveryFailureAt ?? null,
     lastClaimAt: status.lastClaimAt ?? null,
     lastAckAt: status.lastAckAt ?? null,
+    lastAckOutcome: status.lastAckOutcome ?? null,
+    consecutiveAckFailureCount: status.consecutiveAckFailureCount ?? null,
+    lastAckSignalId: status.lastAckSignalId ?? null,
     routeMode: status.routeMode ?? "worker",
     deferOverChars: status.deferOverChars ?? null,
     pendingForMainCount: status.pendingForMainCount ?? 0,
@@ -4531,6 +4577,7 @@ export function renderListenerStatus(
   installed: ListenerProviderInstallEvidence | null = null,
 ): string {
   const routeMode = status.routeMode ?? "worker";
+  const deliveryFailureRun = status.consecutiveAckFailureCount ?? 0;
   const pendingForMainCount = status.pendingForMainCount ?? 0;
   const droppedForMainCount = status.droppedForMainCount ?? 0;
   const unattendedCount = `${pendingForMainCount} ${
@@ -4558,9 +4605,17 @@ export function renderListenerStatus(
     }.`,
     `HANDLED: ${
       attendance.handledState === "handled"
-        ? "yes. A delivery acknowledgement is recorded"
+        ? `yes. The newest delivery acknowledgement was ${status.lastAckOutcome}`
         : attendance.handledState === "not_handled"
-        ? "no. Queued messages have not reached the session hook"
+        ? routeMode === "worker"
+          ? deliveryFailureRun >= LISTENER_DELIVERY_FAILING_THRESHOLD
+            ? `no. ${deliveryFailureRun} ${
+              deliveryFailureRun === 1 ? "delivery has" : "deliveries have"
+            } failed since the last reply; the newest delivery acknowledgement was ${
+              status.lastAckOutcome ?? "not recorded"
+            }${status.lastErrorCode ? ` (${status.lastErrorCode})` : ""}`
+            : `no. The newest delivery acknowledgement was ${status.lastAckOutcome ?? "not recorded"}${status.lastErrorCode ? ` (${status.lastErrorCode})` : ""}`
+          : "no. Queued messages have not reached the session hook"
         : "not yet measured"
     }.`,
     `Provider: ${status.provider}; process: ${status.pid}; started: ${status.startedAt}.`,
@@ -4579,7 +4634,28 @@ export function renderListenerStatus(
       ? pendingForMainCount > 0
         ? `Last claimed and queued signal: ${status.lastSignalId}. It is not handled yet.`
         : routeMode === "worker"
-        ? `Last handled signal: ${status.lastSignalId}.`
+        // Keyed on the OUTCOME, never on handledState: an `observed` note is not
+        // a failed delivery, and during a failure run it is not evidence of
+        // handling either, so it gets the neutral sentence naming its outcome.
+        // The outcome sentences name lastAckSignalId, the signal the outcome
+        // belongs to. lastSignalId is also advanced by `effect`, so after an
+        // effect for a newer signal it would attribute the older ack to it.
+        // "No acknowledgement" is keyed on lastAckAt, not on the outcome. A status
+        // written by a listener older than this CLI carries lastAckAt with no
+        // outcome -- every fleet listener at the 0.1.51 upgrade, and any new CLI
+        // reading a running 0.1.50 listener -- and DID acknowledge something.
+        ? status.lastAckAt === null
+          ? `Last listener signal: ${status.lastSignalId}. No delivery acknowledgement is recorded.`
+          : status.lastAckOutcome === null
+          ? `Last listener signal: ${status.lastSignalId}. An acknowledgement was recorded at ${status.lastAckAt}; its outcome was not recorded.`
+          : !status.lastAckSignalId
+          ? `Last listener signal: ${status.lastSignalId}. The newest acknowledgement was ${status.lastAckOutcome}; which signal it belonged to was not recorded.`
+          : status.lastAckOutcome === "failed_terminal"
+          ? `Last failed delivery signal: ${status.lastAckSignalId}.`
+          : DELIVERY_HANDLED_OUTCOMES.has(status.lastAckOutcome) &&
+              deliveryFailureRun < LISTENER_DELIVERY_FAILING_THRESHOLD
+          ? `Last handled signal: ${status.lastAckSignalId}.`
+          : `Last acknowledged signal: ${status.lastAckSignalId}. Its outcome was ${status.lastAckOutcome}.`
         : `Last listener signal: ${status.lastSignalId}. Local status does not prove its final observed receipt.`
       : "No signal has been handled yet.",
     status.lastErrorCode
@@ -4727,7 +4803,7 @@ export function renderListenerStatus(
     status.lastTerminalDeliveryFailureCount > 0
   ) {
     lines.push(
-      `The last claim reported ${status.lastTerminalDeliveryFailureCount} terminal delivery failures; they remain recorded, and the listener will keep receiving.`,
+      `The last claim reported ${status.lastTerminalDeliveryFailureCount} ${status.lastTerminalDeliveryFailureCount === 1 ? "delivery the service gave up on because this listener never acknowledged it. It remains" : "deliveries the service gave up on because this listener never acknowledged them. They remain"} recorded, and the listener will keep receiving.`,
     );
   }
   /* D-074. `stopping` and `starting` are TRANSITIONAL: the verb returns before teardown or
diff --git a/src/cloud/delivery.ts b/src/cloud/delivery.ts
index 00f0577..87d13ea 100644
--- a/src/cloud/delivery.ts
+++ b/src/cloud/delivery.ts
@@ -20,7 +20,8 @@ const SENDER_OWNER_RELATIONS = new Set<SenderOwnerRelation>([
   "cross_owner",
   "unknown",
 ]);
-const DELIVERY_ACK_OUTCOMES = new Set<DeliveryOutcome>([
+/** Outcomes accepted by the delivery acknowledgement endpoint. */
+export const DELIVERY_ACK_OUTCOMES: ReadonlySet<DeliveryOutcome> = new Set([
   "replied",
   "observed",
   "queued",
@@ -28,6 +29,26 @@ const DELIVERY_ACK_OUTCOMES = new Set<DeliveryOutcome>([
   "failed_terminal",
 ]);
 
+/** Ack outcomes that prove this delivery was dealt with. */
+export const DELIVERY_HANDLED_OUTCOMES: ReadonlySet<DeliveryOutcome> = new Set(
+  [...DELIVERY_ACK_OUTCOMES].filter((outcome) =>
+    outcome === "replied" || outcome === "observed"
+  ),
+);
+
+/** Ack outcomes that prove the provider produced a response. */
+export const DELIVERY_PROVIDER_PROVEN_OUTCOMES: ReadonlySet<DeliveryOutcome> =
+  new Set(
+    [...DELIVERY_ACK_OUTCOMES].filter((outcome) => outcome === "replied"),
+  );
+
+/** Render a set as "a, b, or c" so a generated enumeration still reads as English. */
+function orList(values: readonly string[]): string {
+  return values.length <= 1
+    ? values.join("")
+    : `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
+}
+
 /** Per-request deadline covering fetch and the response body read. */
 export const DELIVERY_REQUEST_TIMEOUT_MS = 30_000;
 
@@ -544,7 +565,7 @@ function assertAckRequest(request: DeliveryAckRequest): void {
   checkedUuidRequest(request.listenerInstanceId, "listenerInstanceId");
   if (!DELIVERY_ACK_OUTCOMES.has(request.outcome as DeliveryOutcome)) {
     throw new Error(
-      "a delivery outcome must be replied, observed, queued, expired, or failed_terminal",
+      `a delivery outcome must be ${orList([...DELIVERY_ACK_OUTCOMES])}`,
     );
   }
   if (request.outcome === "failed_terminal") {
@@ -553,7 +574,9 @@ function assertAckRequest(request: DeliveryAckRequest): void {
       !FAILED_TERMINAL_CODES_SET.has(request.lastErrorCode)
     ) {
       throw new Error(
-        "a failed_terminal acknowledgement requires one of provider_refused, local_effect_failed, host_session_failed, credential_unavailable",
+        `a failed_terminal acknowledgement requires one of ${
+          orList([...FAILED_TERMINAL_CODES_SET])
+        }`,
       );
     }
   } else if (request.lastErrorCode !== null) {
diff --git a/src/listener/control.ts b/src/listener/control.ts
index 63ff010..9ab0225 100644
--- a/src/listener/control.ts
+++ b/src/listener/control.ts
@@ -22,6 +22,10 @@ import {
   parseListenerReadHealth,
   type ListenerReadHealth,
 } from "./read-health.js";
+import {
+  DELIVERY_ACK_OUTCOMES,
+  type DeliveryOutcome,
+} from "../cloud/delivery.js";
 
 const UUID_RE =
   /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@@ -46,6 +50,9 @@ export type ListenerStatusState =
 
 export type ListenerProviderId = "grok" | "opencode" | "claude" | "codex";
 
+/** Consecutive terminal ack failures that make a listener hard-down. */
+export const LISTENER_DELIVERY_FAILING_THRESHOLD = 3;
+
 export interface ListenerStatus {
   version: 1;
   instanceId: string;
@@ -89,13 +96,21 @@ export interface ListenerStatus {
   // in-memory producer; readListenerStatus normalizes old version-1 disk JSON
   // that omits them to null without rewriting bytes, and writeListenerStatus
   // refuses a write that omits any of them, so every new status file carries
-  // all six keys.
+  // all keys in STATUS_DELIVERY_KEYS.
   deliveryMode: "durable_claim" | "cursor_fallback" | null;
   pendingDeliveryCount: number | null;
   lastTerminalDeliveryFailureCount: number | null;
   lastTerminalDeliveryFailureAt: string | null;
   lastClaimAt: string | null;
   lastAckAt: string | null;
+  /** What the newest delivery acknowledgement concluded. */
+  lastAckOutcome: DeliveryOutcome | null;
+  /** Terminal ack failures since the last provider-proven ack; null before any ack. */
+  consecutiveAckFailureCount: number | null;
+  /** The signal `lastAckOutcome` belongs to. `lastSignalId` is also written by
+      `effect` and `main_queue`, so between an effect and its ack it names a newer
+      signal than the one the outcome describes. Optional: absent in older files. */
+  lastAckSignalId?: string | null;
   routeMode?: ListenerRouteMode;
   deferOverChars?: number | null;
   pendingForMainCount?: number;
@@ -201,6 +216,9 @@ const STATUS_ALLOWED_KEYS = new Set([
   "lastTerminalDeliveryFailureAt",
   "lastClaimAt",
   "lastAckAt",
+  "lastAckOutcome",
+  "consecutiveAckFailureCount",
+  "lastAckSignalId",
   "routeMode",
   "deferOverChars",
   "pendingForMainCount",
@@ -236,15 +254,21 @@ const STATUS_SENSITIVE_KEYS = new Set([
   "ownerId",
   "owner_id",
 ]);
-const STATUS_DELIVERY_KEYS = [
+export const STATUS_DELIVERY_KEYS = [
   "deliveryMode",
   "pendingDeliveryCount",
   "lastTerminalDeliveryFailureCount",
   "lastTerminalDeliveryFailureAt",
   "lastClaimAt",
   "lastAckAt",
+  "lastAckOutcome",
+  "consecutiveAckFailureCount",
 ] as const;
 
+// This is the former appendListenerEvent-local set, hoisted so status and event
+// validation read the same delivery vocabulary as the command client.
+const deliveryOutcomes = DELIVERY_ACK_OUTCOMES;
+
 function parseStatus(raw: string, rejectUnknownKeys = false): ListenerStatus {
   let value: unknown;
   try {
@@ -366,6 +390,14 @@ function parseStatus(raw: string, rejectUnknownKeys = false): ListenerStatus {
       nullableTimestamp(row.lastClaimAt)) ||
     !(row.lastAckAt === undefined ||
       nullableTimestamp(row.lastAckAt)) ||
+    !(row.lastAckOutcome === undefined ||
+      row.lastAckOutcome === null ||
+      (typeof row.lastAckOutcome === "string" &&
+        deliveryOutcomes.has(row.lastAckOutcome as DeliveryOutcome))) ||
+    !(row.consecutiveAckFailureCount === undefined ||
+      nullableCount(row.consecutiveAckFailureCount)) ||
+    !(row.lastAckSignalId === undefined || row.lastAckSignalId === null ||
+      (typeof row.lastAckSignalId === "string" && UUID_RE.test(row.lastAckSignalId))) ||
     !(row.routeMode === undefined ||
       row.routeMode === "worker" || row.routeMode === "main" || row.routeMode === "split") ||
     !(row.deferOverChars === undefined || row.deferOverChars === null ||
@@ -421,6 +453,15 @@ function parseStatus(raw: string, rejectUnknownKeys = false): ListenerStatus {
       (row.lastTerminalDeliveryFailureAt ?? null) as string | null,
     lastClaimAt: (row.lastClaimAt ?? null) as string | null,
     lastAckAt: (row.lastAckAt ?? null) as string | null,
+    lastAckOutcome:
+      (row.lastAckOutcome ?? null) as DeliveryOutcome | null,
+    consecutiveAckFailureCount:
+      (row.consecutiveAckFailureCount ?? null) as number | null,
+    // Optional key: present only when the file carried it, so a status written
+    // without it round-trips byte-for-byte (the routeMode pattern).
+    ...(row.lastAckSignalId === undefined
+      ? {}
+      : { lastAckSignalId: (row.lastAckSignalId ?? null) as string | null }),
     lastErrorDetail: (row.lastErrorDetail ?? null) as string | null,
     lastWorkerStderrTail: (row.lastWorkerStderrTail ?? null) as string | null,
     providerVersion: (row.providerVersion ?? null) as string | null,
@@ -445,7 +486,7 @@ export async function writeListenerStatus(
   if (Buffer.byteLength(serialized, "utf8") > MAX_STATUS_BYTES) {
     throw new Error("listener status is too large");
   }
-  // New writes always carry all six delivery fields, even when null.
+  // New writes always carry all STATUS_DELIVERY_KEYS fields, even when null.
   const parsed = JSON.parse(serialized) as Record<string, unknown>;
   for (const key of STATUS_DELIVERY_KEYS) {
     if (!(key in parsed)) {
@@ -520,13 +561,6 @@ export async function appendListenerEvent(
     "dropped_count",
   ]);
   const deliveryModes = new Set(["durable_claim", "cursor_fallback"]);
-  const deliveryOutcomes = new Set([
-    "replied",
-    "observed",
-    "queued",
-    "expired",
-    "failed_terminal",
-  ]);
   const routeModes = new Set(["worker", "main", "split"]);
   const routeDecisions = new Set(["worker", "main"]);
   for (const [key, value] of Object.entries(event)) {
@@ -607,7 +641,8 @@ export async function appendListenerEvent(
     if (
       key === "outcome" &&
       !(value === null ||
-        (typeof value === "string" && deliveryOutcomes.has(value)))
+        (typeof value === "string" &&
+          deliveryOutcomes.has(value as DeliveryOutcome)))
     ) {
       throw new Error("listener event outcome is not allowed");
     }
diff --git a/src/listener/supervisor.ts b/src/listener/supervisor.ts
index ca54b45..b2b9c2c 100644
--- a/src/listener/supervisor.ts
+++ b/src/listener/supervisor.ts
@@ -1,4 +1,5 @@
 import { randomUUID } from "node:crypto";
+import { DELIVERY_PROVIDER_PROVEN_OUTCOMES } from "../cloud/delivery.js";
 import { AcpPermissionCanaryError } from "../host/types.js";
 import {
   appendListenerEvent,
@@ -250,6 +251,12 @@ export async function runListenerSupervisor(
   const startedAt = iso(now);
   const controller = new AbortController();
   const proposedInstanceId = randomUUID();
+  /* The failure run is operator-read state, so a restart must not delete it. The
+     lapse notice tells the operator to stop and start; seeding nulls here made
+     following that advice erase the evidence, and the next `observed` note then
+     printed `HANDLED: yes` again on a provider that was still dead. Only a
+     `replied` ack clears the run. A missing or unreadable file carries nothing. */
+  const carried = await readListenerStatus(options.paths).catch(() => null);
   let status: ListenerStatus = {
     version: 1,
     instanceId: proposedInstanceId,
@@ -265,7 +272,7 @@ export async function runListenerSupervisor(
     readyAt: null,
     updatedAt: startedAt,
     stoppedAt: null,
-    lastSignalId: null,
+    lastSignalId: carried?.lastSignalId ?? null,
     lastErrorCode: null,
     lastErrorDetail: null,
     lastErrorReasonCode: null,
@@ -281,7 +288,14 @@ export async function runListenerSupervisor(
     lastTerminalDeliveryFailureCount: null,
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
-    lastAckAt: null,
+    /* The ack record is carried WHOLE. Carrying the outcome and the run without
+       their timestamp and signal id rendered a screen whose own sentences
+       disagreed -- "the newest delivery acknowledgement was replied" above
+       "No signal has been handled yet." */
+    lastAckAt: carried?.lastAckAt ?? null,
+    lastAckOutcome: carried?.lastAckOutcome ?? null,
+    consecutiveAckFailureCount: carried?.consecutiveAckFailureCount ?? null,
+    lastAckSignalId: carried?.lastAckSignalId ?? null,
     routeMode: options.routeMode ?? "worker",
     deferOverChars: options.deferOverChars ?? null,
     pendingForMainCount: 0,
@@ -382,6 +396,17 @@ export async function runListenerSupervisor(
       const versionNotice = options.getProviderVersionNotice?.() ?? null;
       transition("ready", {
         readyAt: event.ts,
+        // Deliberately does NOT clear consecutiveAckFailureCount. Reaching
+        // `ready` is not provider proof: the permission canary is its own
+        // prompt, and a provider can answer it and fail every real one --
+        // tests/listener-cli-process.test.ts builds such a child, whose
+        // `failPrompts` trips only non-canary prompts (that test does not
+        // restart it, so it does not by itself exercise this path). Clearing
+        // the run here while `lastAckOutcome` still held a stale `observed`
+        // put `HANDLED: yes` back on the incident screen after any restartable
+        // blip. Only a `replied` ack clears the run; the pin is in
+        // tests/listener-runtime.test.ts, which fires `ready` after the
+        // measured incident and asserts the run survives it.
         lastErrorCode: null,
         lastErrorDetail: null,
         lastErrorReasonCode: null,
@@ -578,9 +603,18 @@ export async function runListenerSupervisor(
       return;
     }
     if (event.type === "delivery_ack") {
+      const failed = event.outcome === "failed_terminal";
+      const providerProven = DELIVERY_PROVIDER_PROVEN_OUTCOMES.has(event.outcome);
       status = {
         ...status,
         lastAckAt: event.ts,
+        lastAckOutcome: event.outcome,
+        lastAckSignalId: event.signalId,
+        consecutiveAckFailureCount: failed
+          ? (status.consecutiveAckFailureCount ?? 0) + 1
+          : providerProven
+          ? 0
+          : status.consecutiveAckFailureCount,
         pendingDeliveryCount: null,
         lastSignalId: event.signalId,
         updatedAt: event.ts,
diff --git a/tests/delivery-client.test.ts b/tests/delivery-client.test.ts
index 1e51243..35dbe58 100644
--- a/tests/delivery-client.test.ts
+++ b/tests/delivery-client.test.ts
@@ -43,6 +43,26 @@ const FUTURE = "2030-01-02T03:04:05.000Z";
 
 const target = cloudTarget("https://cloud.example.test", "anon-key");
 
+test("handled and provider-proven outcomes are accepted acknowledgement outcomes", () => {
+  const subsets = [
+    deliveryModule.DELIVERY_HANDLED_OUTCOMES,
+    deliveryModule.DELIVERY_PROVIDER_PROVEN_OUTCOMES,
+  ];
+  for (const subset of subsets) {
+    for (const outcome of subset) {
+      assert.ok(deliveryModule.DELIVERY_ACK_OUTCOMES.has(outcome));
+    }
+  }
+  assert.deepEqual(
+    [...deliveryModule.DELIVERY_HANDLED_OUTCOMES],
+    ["replied", "observed"],
+  );
+  assert.deepEqual(
+    [...deliveryModule.DELIVERY_PROVIDER_PROVEN_OUTCOMES],
+    ["replied"],
+  );
+});
+
 function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
   return {
     id: SIGNAL,
diff --git a/tests/host-version-floor.test.ts b/tests/host-version-floor.test.ts
index be6e7ed..bd74f66 100644
--- a/tests/host-version-floor.test.ts
+++ b/tests/host-version-floor.test.ts
@@ -261,6 +261,8 @@ test("Claude status/start rendering pins the resolved bridge and exact bundled v
       deliveryMode: null,
       pendingDeliveryCount: null,
       lastTerminalDeliveryFailureCount: null,
+      lastAckOutcome: null,
+      consecutiveAckFailureCount: null,
       routeMode: "worker",
     } as ListenerStatus;
     const rendered = renderListenerStatus(status);
@@ -280,6 +282,7 @@ test("Claude status/start rendering pins the resolved bridge and exact bundled v
     assert.equal(json.providerBundledAgentSdkVersion, "0.3.257");
     assert.equal(json.connectionsOpened, null);
     assert.equal(json.connectionReuseRatio, null);
+    assert.equal(json.handledState, "not_yet_measured");
 
     const oldProcess = {
       ...status,
@@ -450,10 +453,13 @@ test("newer version reports exactly once to the startup status path", () => {
     deliveryMode: null,
     pendingDeliveryCount: null,
     lastTerminalDeliveryFailureCount: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "worker",
   } as ListenerStatus);
   assert.equal(output.match(/unverified but allowed/g)?.length, 1);
   assert.match(output, /Next: verify this provider release/);
+  assert.match(output, /HANDLED: not yet measured/);
 });
 
 test("an exactly measured Codex version renders without an unverified warning", () => {
@@ -473,10 +479,13 @@ test("an exactly measured Codex version renders without an unverified warning",
     deliveryMode: null,
     pendingDeliveryCount: null,
     lastTerminalDeliveryFailureCount: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "worker",
   } as ListenerStatus);
   assert.match(output, /Provider version: 1\.8\.0 \(last measured: 1\.8\.0\)/);
   assert.doesNotMatch(output, /unverified|newer than/);
+  assert.match(output, /HANDLED: not yet measured/);
 });
 
 test("a comfortably newer version cannot bypass a failing permission canary", async () => {
diff --git a/tests/listener-cli-process.test.ts b/tests/listener-cli-process.test.ts
index e94faec..5b08c2f 100644
--- a/tests/listener-cli-process.test.ts
+++ b/tests/listener-cli-process.test.ts
@@ -549,12 +549,17 @@ test("listener HTTP client closes an idle socket and opens one replacement", asy
   }
 });
 
-function fakeGrokSource(): string {
+function fakeGrokSource(
+  options: { failPrompts?: boolean } = {},
+): string {
+  const failPrompts = options.failPrompts === true ? "true" : "false";
   return `#!/usr/bin/env node
 import { appendFileSync } from "node:fs";
 import { fileURLToPath } from "node:url";
 import { dirname, join } from "node:path";
 
+const failPrompts = ${failPrompts};
+
 if (process.argv.includes("--version")) {
   process.stdout.write("grok 0.2.117 (fake)\\n");
   process.exit(0);
@@ -612,6 +617,17 @@ function finishPrompt(hostId, text, optionId) {
       },
     },
   });
+  if (!canary && failPrompts) {
+    send({
+      jsonrpc: "2.0",
+      id: hostId,
+      error: {
+        code: -32000,
+        message: "provider session is unavailable",
+      },
+    });
+    return;
+  }
   if (!canary) {
     send({
       jsonrpc: "2.0",
@@ -1189,6 +1205,274 @@ test("detached CLI completes durable claim reply ACK with one startup UUID and n
   }
 });
 
+test("detached listener keeps a provider failure lapse in its status file", async () => {
+  const root = await mkdtemp(join(tmpdir(), "cswarm-cli-provider-lapse-"));
+  const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-cli-provider-worker-"));
+  const grokPath = join(root, "failing-grok.mjs");
+  const providerHome = join(root, "provider-home");
+  await writeFile(grokPath, fakeGrokSource({ failPrompts: true }), {
+    mode: 0o700,
+  });
+  await chmod(grokPath, 0o700);
+  await mkdir(providerHome, { mode: 0o700 });
+  await writeFile(
+    join(providerHome, "auth.json"),
+    JSON.stringify({ access_token: "fake-local-login" }),
+    { mode: 0o600 },
+  );
+
+  const workspaceId = randomUUID();
+  const principalId = randomUUID();
+  const senderId = randomUUID();
+  const ownerId = randomUUID();
+  const token = `swm_agt_${"L".repeat(43)}`;
+  const artifact = JSON.stringify({
+    message: AGENT_MESSAGE,
+    status: "accepted",
+    principal_id: principalId,
+    token_id: randomUUID(),
+    run_id: randomUUID(),
+    agent_token: token,
+    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
+  });
+  const asks = Array.from({ length: 3 }, (_, index) => ({
+    id: randomUUID(),
+    workspace_id: workspaceId,
+    from: senderId,
+    from_kind: "agent",
+    to: null,
+    to_agent: principalId,
+    in_reply_to: null,
+    about: null,
+    kind: "ask",
+    body: `provider failure control ${index + 1}`,
+    until: new Date(Date.now() + 10 * 60_000).toISOString(),
+    created_at: new Date(Date.now() - (3 - index) * 1_000).toISOString(),
+    sender_owner_relation: "same_owner",
+  }));
+  const leaseIds = asks.map(() => randomUUID());
+  const acknowledgedSignalIds = new Set<string>();
+  const acknowledgements: Array<Record<string, unknown>> = [];
+  const posts: Array<Record<string, unknown>> = [];
+  const server = createServer(async (request, response) => {
+    let body = "";
+    for await (const chunk of request) body += chunk.toString();
+    if (request.url === "/functions/v1/read") {
+      const parsed = JSON.parse(body) as Record<string, unknown>;
+      response.writeHead(200, { "content-type": "application/json" });
+      if (parsed.resource === "members") {
+        response.end(JSON.stringify({
+          members: [{ user_id: ownerId, display_name: "Local Operator" }],
+          agents: [{
+            principal_id: senderId,
+            name: "Local Sender",
+            owner_user_id: ownerId,
+          }],
+        }));
+        return;
+      }
+      response.end(JSON.stringify({
+        signals: [],
+        capabilities: {
+          sender_owner_relation: 1,
+          cursor_after: 1,
+          delivery_claim: 1,
+          delivery_ack: 1,
+        },
+        pending_delivery_count: asks.length - acknowledgedSignalIds.size,
+      }));
+      return;
+    }
+    if (request.url === "/functions/v1/command") {
+      const parsed = JSON.parse(body) as Record<string, unknown>;
+      const command = parsed.command as Record<string, unknown>;
+      if (command.kind === "claim_agent_inbox") {
+        const index = asks.findIndex((ask) =>
+          !acknowledgedSignalIds.has(ask.id)
+        );
+        response.writeHead(200, { "content-type": "application/json" });
+        response.end(JSON.stringify({
+          status: "accepted",
+          ok: true,
+          capabilities: {
+            delivery_claim: 1,
+            delivery_ack: 1,
+            sender_owner_relation: 1,
+          },
+          deliveries: index === -1
+            ? []
+            : [{
+              signal: asks[index],
+              lease_id: leaseIds[index],
+              leased_until: new Date(Date.now() + 10 * 60_000).toISOString(),
+              sender_owner_relation: "same_owner",
+            }],
+          pending_delivery_count: asks.length - acknowledgedSignalIds.size,
+          terminal_delivery_failure_count: 0,
+          event_ids: [],
+          events: [],
+          min_client_version: "0.1.0",
+        }));
+        return;
+      }
+      if (command.kind === "ack_agent_delivery") {
+        acknowledgements.push(parsed);
+        acknowledgedSignalIds.add(String(command.signal_id));
+        response.writeHead(200, { "content-type": "application/json" });
+        response.end(JSON.stringify({
+          status: "accepted",
+          ok: true,
+          event_ids: [],
+          events: [],
+          signal_id: command.signal_id,
+          outcome: command.outcome,
+        }));
+        return;
+      }
+      if (command.kind === "declare_agent_model") {
+        response.writeHead(200, { "content-type": "application/json" });
+        response.end(JSON.stringify({
+          status: "accepted",
+          ok: true,
+          event_ids: [],
+          events: [],
+        }));
+        return;
+      }
+      posts.push(parsed);
+      response.writeHead(200, { "content-type": "application/json" });
+      response.end(JSON.stringify({
+        status: "accepted",
+        ok: true,
+        event_ids: [],
+        events: [],
+      }));
+      return;
+    }
+    if (request.url === "/functions/v1/activity") {
+      response.writeHead(204);
+      response.end();
+      return;
+    }
+    response.writeHead(404);
+    response.end();
+  });
+  await new Promise<void>((resolveListen) =>
+    server.listen(0, "127.0.0.1", resolveListen)
+  );
+  const address = server.address();
+  assert.ok(address && typeof address === "object");
+  const url = `http://127.0.0.1:${address.port}`;
+  const common = [
+    "--url",
+    url,
+    "--anon-key",
+    "public-anon",
+    "--workspace-id",
+    workspaceId,
+    "--state-dir",
+    root,
+  ];
+  const paths = listenerPaths({
+    profileId: cloudTarget(url, "public-anon").profileId,
+    workspaceId,
+    principalId,
+    stateDirectory: root,
+  });
+
+  try {
+    const started = await runCli([
+      "listen",
+      "start",
+      "--provider",
+      "grok",
+      "--agent-token-stdin",
+      ...common,
+      "--cwd",
+      workerCwd,
+      "--permissions",
+      "allow",
+      "--grok-executable",
+      grokPath,
+      "--json",
+    ], {
+      stdin: artifact,
+      env: { GROK_HOME: providerHome },
+    });
+    assert.equal(started.code, 0, started.stderr);
+    await waitFor(() => acknowledgements.length === asks.length);
+    assert.equal(posts.length, 0);
+    assert.deepEqual(
+      acknowledgements.map((entry) => {
+        const command = entry.command as Record<string, unknown>;
+        return [command.outcome, command.last_error_code];
+      }),
+      Array.from({ length: 3 }, () => [
+        "failed_terminal",
+        "host_session_failed",
+      ]),
+    );
+
+    const statusJsonResult = await runCli([
+      "listen",
+      "status",
+      ...common,
+      "--principal-id",
+      principalId,
+      "--json",
+    ]);
+    assert.equal(statusJsonResult.code, 0, statusJsonResult.stderr);
+    const statusJson = JSON.parse(statusJsonResult.stdout) as Record<
+      string,
+      unknown
+    >;
+    assert.equal(statusJson.state, "ready");
+    assert.equal(statusJson.lastAckOutcome, "failed_terminal");
+    assert.equal(statusJson.consecutiveAckFailureCount, 3);
+    assert.equal(statusJson.handledState, "not_handled");
+    assert.equal(statusJson.listenerLapse, true);
+    assert.deepEqual(statusJson.listenerLapseCodes, [
+      "listener_delivery_failing",
+    ]);
+
+    const statusHumanResult = await runCli([
+      "listen",
+      "status",
+      ...common,
+      "--principal-id",
+      principalId,
+    ]);
+    assert.equal(statusHumanResult.code, 0, statusHumanResult.stderr);
+    assert.match(statusHumanResult.stdout, /^Listener LAPSE/);
+    assert.match(statusHumanResult.stdout, /HANDLED: no\./);
+    assert.match(
+      statusHumanResult.stdout,
+      /WARNING \[listener_delivery_failing\]/,
+    );
+
+    const statusFile = await readFile(paths.statusPath, "utf8");
+    const statusOnDisk = JSON.parse(statusFile) as Record<string, unknown>;
+    assert.equal(statusOnDisk.state, "ready");
+    assert.equal(statusOnDisk.lastAckOutcome, "failed_terminal");
+    assert.equal(statusOnDisk.consecutiveAckFailureCount, 3);
+  } finally {
+    try {
+      await stopAndWaitForDetachedListener([
+        "listen",
+        "stop",
+        ...common,
+        "--principal-id",
+        principalId,
+        "--json",
+      ], paths);
+    } finally {
+      await closeTestServer(server);
+    }
+    await rm(root, { recursive: true, force: true });
+    await rm(workerCwd, { recursive: true, force: true });
+  }
+});
+
 test("detached CLI cursor fallback still receives and replies", async () => {
   const root = await mkdtemp(join(tmpdir(), "cswarm-cli-cursor-fallback-"));
   const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-cli-cursor-worker-"));
@@ -1389,6 +1673,8 @@ test("listen status distinguishes delivery modes and null zero positive counts",
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     logPath: paths.logPath,
   };
   const args = [
@@ -1412,7 +1698,7 @@ test("listen status distinguishes delivery modes and null zero positive counts",
     assert.equal(unknown.code, 0, unknown.stderr);
     assert.match(unknown.stdout, /Delivery mode: durable claim and acknowledgement\./);
     assert.doesNotMatch(unknown.stdout, /Pending deliveries reported by the service:/);
-    assert.doesNotMatch(unknown.stdout, /terminal delivery failures/);
+    assert.doesNotMatch(unknown.stdout, /service gave up on/);
 
     await writeListenerStatus(paths, {
       ...base,
@@ -1422,7 +1708,7 @@ test("listen status distinguishes delivery modes and null zero positive counts",
     const zero = await runCli(args);
     assert.equal(zero.code, 0, zero.stderr);
     assert.match(zero.stdout, /Pending deliveries reported by the service: 0\./);
-    assert.doesNotMatch(zero.stdout, /terminal delivery failures/);
+    assert.doesNotMatch(zero.stdout, /service gave up on/);
 
     await writeListenerStatus(paths, {
       ...base,
@@ -1436,10 +1722,10 @@ test("listen status distinguishes delivery modes and null zero positive counts",
     assert.match(positive.stdout, /Pending deliveries reported by the service: 2\./);
     assert.match(
       positive.stdout,
-      /The last claim reported 3 terminal delivery failures; they remain recorded, and the listener will keep receiving\./,
+      /The last claim reported 3 deliveries the service gave up on because this listener never acknowledged them\. They remain recorded, and the listener will keep receiving\./,
     );
     assert.equal(
-      positive.stdout.match(/terminal delivery failures/g)?.length,
+      positive.stdout.match(/service gave up on/g)?.length,
       1,
     );
 
@@ -1455,7 +1741,7 @@ test("listen status distinguishes delivery modes and null zero positive counts",
     assert.equal(fallback.code, 0, fallback.stderr);
     assert.match(fallback.stdout, /Delivery mode: cursor fallback\./);
     assert.doesNotMatch(fallback.stdout, /Pending deliveries reported by the service:/);
-    assert.doesNotMatch(fallback.stdout, /terminal delivery failures/);
+    assert.doesNotMatch(fallback.stdout, /service gave up on/);
   } finally {
     await rm(root, { recursive: true, force: true });
   }
diff --git a/tests/listener-control.test.ts b/tests/listener-control.test.ts
index 888b123..6fd6861 100644
--- a/tests/listener-control.test.ts
+++ b/tests/listener-control.test.ts
@@ -26,6 +26,7 @@ import {
   readListenerStatus,
   runListenerSupervisor,
   startListenerControlServer,
+  STATUS_DELIVERY_KEYS,
   stopListener,
   waitForListenerReady,
   writeListenerStatus,
@@ -113,6 +114,8 @@ function statusFor(paths: ListenerPaths, state: ListenerStatus["state"]): Listen
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "worker",
     deferOverChars: null,
     pendingForMainCount: 0,
@@ -1108,7 +1111,7 @@ test("prepare failure rejects cleanly, releases the startup lock, and allows one
   }
 });
 
-test("old status without delivery fields reads as six nulls and is never rewritten", async () => {
+test("old status without delivery fields reads as nulls and is never rewritten", async () => {
   const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
   const target = paths(root);
   const ts = "2026-07-30T00:00:00.000Z";
@@ -1143,6 +1146,8 @@ test("old status without delivery fields reads as six nulls and is never rewritt
   assert.equal(read.lastTerminalDeliveryFailureAt, null);
   assert.equal(read.lastClaimAt, null);
   assert.equal(read.lastAckAt, null);
+  assert.equal(read.lastAckOutcome, null);
+  assert.equal(read.consecutiveAckFailureCount, null);
   assert.equal(read.state, "ready");
 
   // Reading never rewrites the old file.
@@ -1150,7 +1155,7 @@ test("old status without delivery fields reads as six nulls and is never rewritt
   assert.equal(afterBytes, beforeBytes);
 });
 
-test("new status with delivery metadata round-trips exactly and writes require all six fields", async () => {
+test("new status with delivery metadata round-trips exactly and writes require every field", async () => {
   const root = await mkdtemp(join(tmpdir(), "cswarm-control-test-"));
   const target = paths(root);
   const ts = "2026-07-31T12:00:00.000Z";
@@ -1162,6 +1167,8 @@ test("new status with delivery metadata round-trips exactly and writes require a
     lastTerminalDeliveryFailureAt: ts,
     lastClaimAt: ts,
     lastAckAt: ts,
+    lastAckOutcome: "failed_terminal",
+    consecutiveAckFailureCount: 3,
   };
   await writeListenerStatus(target, status);
   assert.deepEqual(await readListenerStatus(target), status);
@@ -1169,27 +1176,19 @@ test("new status with delivery metadata round-trips exactly and writes require a
     string,
     unknown
   >;
-  for (const key of [
-    "deliveryMode",
-    "pendingDeliveryCount",
-    "lastTerminalDeliveryFailureCount",
-    "lastTerminalDeliveryFailureAt",
-    "lastClaimAt",
-    "lastAckAt",
-  ]) {
+  for (const key of STATUS_DELIVERY_KEYS) {
     assert.ok(key in raw, `new status write contains ${key}`);
   }
 
-  // A write that omits any delivery field fails closed.
-  const incomplete = { ...statusFor(target, "ready") } as Record<
-    string,
-    unknown
-  >;
-  delete incomplete.lastAckAt;
-  await assert.rejects(
-    writeListenerStatus(target, incomplete as unknown as ListenerStatus),
-    /missing delivery metadata/,
-  );
+  // Each required field reaches the delivery-metadata gate when omitted.
+  for (const key of STATUS_DELIVERY_KEYS) {
+    const incomplete = { ...status } as Record<string, unknown>;
+    delete incomplete[key];
+    await assert.rejects(
+      writeListenerStatus(target, incomplete as unknown as ListenerStatus),
+      /missing delivery metadata/,
+    );
+  }
 });
 
 test("status ignores unknown keys, renders old counters as unmeasured, and rejects malformed known keys", async () => {
@@ -1287,6 +1286,11 @@ test("status ignores unknown keys, renders old counters as unmeasured, and rejec
     await assert.rejects(readListenerStatus(target), /malformed/);
   }
 
+  await writeRaw((row) => {
+    row.lastAckOutcome = "nope";
+  });
+  await assert.rejects(readListenerStatus(target), /malformed/);
+
   // Malformed counts fail closed.
   for (const bad of [-1, 1.5, "3", 2 ** 53]) {
     await writeRaw((row) => {
@@ -1297,6 +1301,10 @@ test("status ignores unknown keys, renders old counters as unmeasured, and rejec
       row.lastTerminalDeliveryFailureCount = bad;
     });
     await assert.rejects(readListenerStatus(target), /malformed/);
+    await writeRaw((row) => {
+      row.consecutiveAckFailureCount = bad;
+    });
+    await assert.rejects(readListenerStatus(target), /malformed/);
   }
 
   // Malformed timestamps fail closed.
diff --git a/tests/listener-host-limits.test.ts b/tests/listener-host-limits.test.ts
index 09b5c80..f7dac40 100644
--- a/tests/listener-host-limits.test.ts
+++ b/tests/listener-host-limits.test.ts
@@ -118,6 +118,8 @@ test("listenerStatusJson emits host_limits as a structured object, not a string"
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     logPath: "/tmp/log",
   };
   const json = listenerStatusJson(status, "deny");
@@ -154,6 +156,8 @@ function readHealthStatus(readHealth: ListenerStatus["readHealth"]): ListenerSta
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "worker",
     deferOverChars: null,
     pendingForMainCount: 0,
diff --git a/tests/listener-runtime.test.ts b/tests/listener-runtime.test.ts
index 6f199cd..abf64f3 100644
--- a/tests/listener-runtime.test.ts
+++ b/tests/listener-runtime.test.ts
@@ -3,6 +3,7 @@ import { createHash, randomUUID } from "node:crypto";
 import { mkdtemp, rm, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
+import { writeSecureJsonFile } from "../src/cloud/storage.js";
 import test from "node:test";
 import {
   CommandHttpError,
@@ -16,8 +17,10 @@ import {
   DeliveryTransportError,
   DELIVERY_REQUEST_TIMEOUT_MS,
   type DeliveryClaimResult,
+  type DeliveryOutcome,
   type DeliveryRow,
 } from "../src/cloud/delivery.js";
+import { listenerStatusJson, renderListenerStatus } from "../src/cli.js";
 import {
   RenewalReauthorisationRequired,
   RenewalRevoked,
@@ -38,6 +41,8 @@ import {
   LISTENER_HOST_PORTS_PROBE_MS,
   LISTENER_PROMPT_START_MINIMUM_MS,
   listenerPaths,
+  readListenerStatus,
+  queryListenerControl,
   runListenerSupervisor,
   claimCommandId,
   ackCommandId,
@@ -50,6 +55,7 @@ import {
   type ListenerEffectStore,
   type ListenerPromptMode,
   type ListenerRuntimeEvent,
+  type ListenerStatus,
   type ListenerRuntimeModel,
 } from "../src/listener/index.js";
 
@@ -762,6 +768,12 @@ test("delivery events reduce into the closed supervisor status fields", async ()
     stateDirectory: root,
   });
   const ts = "2026-07-30T00:00:01.000Z";
+  const ackSnapshots: Array<{
+    outcome: string | null;
+    failures: number | null;
+    human: string;
+    json: Record<string, unknown>;
+  }> = [];
   const status = await runListenerSupervisor({
     paths,
     profileId: "profile-test",
@@ -778,6 +790,55 @@ test("delivery events reduce into the closed supervisor status fields", async ()
         ts,
       });
       onEvent({ type: "delivery_terminal_failures", count: 1, ts });
+      const ack = async (
+        signalId: string,
+        outcome: DeliveryOutcome,
+        ackTs: string,
+      ) => {
+        onEvent({ type: "delivery_ack", signalId, outcome, ts: ackTs });
+        const snapshot = await queryListenerControl(paths, "status");
+        ackSnapshots.push({
+          outcome: snapshot.lastAckOutcome,
+          failures: snapshot.consecutiveAckFailureCount,
+          human: renderListenerStatus(snapshot),
+          json: listenerStatusJson(snapshot),
+        });
+      };
+      const incident: Array<[string, DeliveryOutcome, string]> = [
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13", "failed_terminal", "2026-09-03T17:06:52.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14", "observed", "2026-09-03T17:12:52.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15", "failed_terminal", "2026-09-03T17:23:15.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16", "failed_terminal", "2026-09-03T17:24:30.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17", "failed_terminal", "2026-09-03T17:52:30.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18", "failed_terminal", "2026-09-03T18:36:28.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19", "failed_terminal", "2026-09-03T18:37:12.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20", "failed_terminal", "2026-09-03T18:37:35.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21", "observed", "2026-09-03T18:38:24.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22", "failed_terminal", "2026-09-03T18:44:31.000Z"],
+        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23", "observed", "2026-09-03T18:45:38.000Z"],
+      ];
+      for (const event of incident) await ack(...event);
+      /* Reaching `ready` again (a restartable blip, canary passed) must NOT clear
+         the run. The permission canary is its own prompt: a provider can answer
+         it and fail every real message, so `ready` is not provider proof. Without
+         this pin, restoring `consecutiveAckFailureCount: 0` on `ready` leaves
+         every other assertion in this file green. */
+      onEvent({
+        type: "ready",
+        workspaceId: WORKSPACE_ID,
+        principalId: PRINCIPAL_ID,
+        ts: "2026-09-03T18:46:00.000Z",
+      });
+      const afterReady = await queryListenerControl(paths, "status");
+      assert.equal(afterReady.consecutiveAckFailureCount, 8);
+      assert.equal(afterReady.lastAckOutcome, "observed");
+      const afterReadyHuman = renderListenerStatus(afterReady);
+      assert.doesNotMatch(afterReadyHuman, /HANDLED: yes/);
+      /* A negative alone passes if the line vanishes; pin the positive too. */
+      assert.match(afterReadyHuman, /HANDLED: no\. 8 deliveries have failed since the last reply/);
+      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24", "queued", "2026-09-03T18:46:00.000Z");
+      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa25", "expired", "2026-09-03T18:46:30.000Z");
+      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa26", "replied", "2026-09-03T18:47:00.000Z");
       onEvent({
         type: "main_queue",
         signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
@@ -786,12 +847,6 @@ test("delivery events reduce into the closed supervisor status fields", async ()
         droppedCount: 7,
         ts,
       });
-      onEvent({
-        type: "delivery_ack",
-        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
-        outcome: "replied",
-        ts,
-      });
       return { reason: "cancelled" };
     },
   });
@@ -800,7 +855,69 @@ test("delivery events reduce into the closed supervisor status fields", async ()
   assert.equal(status.lastTerminalDeliveryFailureCount, 1);
   assert.equal(status.lastTerminalDeliveryFailureAt, ts);
   assert.equal(status.lastClaimAt, ts);
-  assert.equal(status.lastAckAt, ts);
+  assert.equal(status.lastAckAt, "2026-09-03T18:47:00.000Z");
+  assert.equal(status.lastAckOutcome, "replied");
+  assert.equal(status.consecutiveAckFailureCount, 0);
+  assert.deepEqual(
+    ackSnapshots.map(({ outcome, failures }) => ({ outcome, failures })),
+    [
+      { outcome: "failed_terminal", failures: 1 },
+      { outcome: "observed", failures: 1 },
+      { outcome: "failed_terminal", failures: 2 },
+      { outcome: "failed_terminal", failures: 3 },
+      { outcome: "failed_terminal", failures: 4 },
+      { outcome: "failed_terminal", failures: 5 },
+      { outcome: "failed_terminal", failures: 6 },
+      { outcome: "failed_terminal", failures: 7 },
+      { outcome: "observed", failures: 7 },
+      { outcome: "failed_terminal", failures: 8 },
+      { outcome: "observed", failures: 8 },
+      { outcome: "queued", failures: 8 },
+      { outcome: "expired", failures: 8 },
+      { outcome: "replied", failures: 0 },
+    ],
+  );
+  const belowThreshold = ackSnapshots[2]!;
+  assert.doesNotMatch(belowThreshold.human, /listener_delivery_failing/);
+  assert.equal(belowThreshold.json.listenerLapse, false);
+  const atThreshold = ackSnapshots[3]!;
+  assert.match(atThreshold.human, /Listener LAPSE/);
+  assert.match(atThreshold.human, /WARNING \[listener_delivery_failing\]/);
+  assert.deepEqual(atThreshold.json.listenerLapseCodes, [
+    "listener_delivery_failing",
+  ]);
+  const afterMeasuredIncident = ackSnapshots[10]!;
+  assert.match(afterMeasuredIncident.human, /^Listener LAPSE/);
+  assert.match(afterMeasuredIncident.human, /WARNING \[listener_delivery_failing\]/);
+  /* The 18:47 state of the measured 2026-09-03 incident: the newest ack is the
+     18:45:38 `observed` note. Observing a note starts no provider session, so it
+     must NOT read as handled while the terminal-failure run stands. This assertion
+     replaces one that required `HANDLED: yes` here — a green control pinning the
+     exact false claim the lane exists to remove. */
+  assert.doesNotMatch(afterMeasuredIncident.human, /HANDLED: yes/);
+  assert.match(
+    afterMeasuredIncident.human,
+    /HANDLED: no\. 8 deliveries have failed since the last reply; the newest delivery acknowledgement was observed\./,
+  );
+  assert.equal(afterMeasuredIncident.json.handledState, "not_handled");
+  assert.equal(afterMeasuredIncident.json.lastAckOutcome, "observed");
+  assert.equal(afterMeasuredIncident.json.consecutiveAckFailureCount, 8);
+  /* An observed note must not be renamed a failed delivery, and must not be
+     called handled while the run stands. Both halves are pinned: without the
+     second, restoring `Last handled signal:` here would still pass. */
+  assert.doesNotMatch(afterMeasuredIncident.human, /Last failed delivery signal/);
+  assert.doesNotMatch(afterMeasuredIncident.human, /Last handled signal/);
+  assert.match(
+    afterMeasuredIncident.human,
+    /Last acknowledged signal: [0-9a-f-]+\. Its outcome was observed\./,
+  );
+  assert.equal(afterMeasuredIncident.json.listenerLapse, true);
+  assert.deepEqual(afterMeasuredIncident.json.listenerLapseCodes, [
+    "listener_delivery_failing",
+  ]);
+  const afterReply = ackSnapshots.at(-1)!;
+  assert.doesNotMatch(afterReply.human, /listener_delivery_failing/);
+  assert.equal(afterReply.json.listenerLapse, false);
   assert.equal(status.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13");
   assert.equal(status.pendingForMainCount, 200);
   assert.equal(status.droppedForMainCount, 7);
@@ -3482,3 +3599,231 @@ test("an already-aborted runtime caller never starts the reply fetch and stays r
   assert.ok(record);
   assert.equal(record.state, "reply_ready", "the effect must remain resumable");
 });
+
+test("a restart carries the failure run, so the printed remedy cannot erase the alarm", async () => {
+  /* The lapse notice tells the operator to stop and start the listener. Seeding a
+     fresh run on start made following that advice delete the evidence: the next
+     `observed` note then printed `HANDLED: yes` on a provider that was still dead
+     -- the 17:12:52 state of the measured 2026-09-03 incident, reached by doing
+     exactly what the notice said. Operator-read state is durable by default. */
+  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-carry-"));
+  const paths = listenerPaths({
+    profileId: `profile-${randomUUID()}`,
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    stateDirectory: root,
+  });
+  const ts = "2026-09-03T18:00:00.000Z";
+  const runOnce = async (
+    body: (
+      onEvent: (event: ListenerRuntimeEvent) => void,
+    ) => Promise<void>,
+  ) =>
+    await runListenerSupervisor({
+      paths,
+      profileId: "profile-test",
+      workspaceId: WORKSPACE_ID,
+      principalId: PRINCIPAL_ID,
+      run: async (_signal, onEvent) => {
+        onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
+        await body(onEvent);
+        return { reason: "cancelled" };
+      },
+    });
+
+  const first = await runOnce(async (onEvent) => {
+    for (const [signalId, at] of [
+      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01", "2026-09-03T18:10:00.000Z"],
+      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02", "2026-09-03T18:11:00.000Z"],
+      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03", "2026-09-03T18:12:00.000Z"],
+    ] as const) {
+      onEvent({ type: "delivery_ack", signalId, outcome: "failed_terminal", ts: at });
+    }
+  });
+  assert.equal(first.consecutiveAckFailureCount, 3);
+  assert.match(renderListenerStatus(first), /WARNING \[listener_delivery_failing\]/);
+
+  /* The restart the notice recommends, observed BEFORE any new ack. A later ack
+     would set these fields itself, so asserting them after one would not reach
+     the carry at all -- measured: dropping lastAckAt from the carry left that
+     version of this test green. */
+  const restarted = await runOnce(async () => {});
+  assert.equal(restarted.consecutiveAckFailureCount, 3);
+  assert.equal(restarted.lastAckOutcome, "failed_terminal");
+  assert.equal(restarted.lastAckAt, "2026-09-03T18:12:00.000Z");
+  assert.equal(restarted.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03");
+  const restartedHuman = renderListenerStatus(restarted);
+  assert.doesNotMatch(restartedHuman, /at an unknown time/);
+  assert.doesNotMatch(restartedHuman, /No signal has been handled yet/);
+
+  /* Then one incoming note. */
+  const second = await runOnce(async (onEvent) => {
+    onEvent({
+      type: "delivery_ack",
+      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
+      outcome: "observed",
+      ts: "2026-09-03T18:20:00.000Z",
+    });
+  });
+  assert.equal(second.lastAckOutcome, "observed");
+  assert.equal(second.consecutiveAckFailureCount, 3);
+  const human = renderListenerStatus(second);
+  assert.doesNotMatch(human, /HANDLED: yes/);
+  assert.match(human, /WARNING \[listener_delivery_failing\]/);
+  /* The ack record must carry WHOLE. Carrying the outcome without its timestamp
+     printed "the newest delivery acknowledgement was ..." above "No signal has
+     been handled yet." on one screen. */
+  assert.equal(second.lastAckAt, "2026-09-03T18:20:00.000Z");
+  assert.doesNotMatch(human, /at an unknown time/);
+  assert.doesNotMatch(human, /No signal has been handled yet/);
+  /* The remedy is three verbs and is untested elsewhere: `listen stop` returns
+     while `stopping`, and `listen start` refuses a stopping listener, so a
+     printed `stop && start` pair races. It must also not name a terminal state
+     the listener may never reach -- an unclean exit lands on `failed`. */
+  assert.match(human, /Next: Read the failure codes in /);
+  assert.match(human, /cswarm listen stop --workspace-id [0-9a-f-]+ --principal-id [0-9a-f-]+/);
+  assert.match(human, /no longer running -- state stopped or failed, not stopping/);
+  assert.match(human, /confirming with: cswarm listen status --workspace-id /);
+  assert.doesNotMatch(human, /listen stop[^\n]*&&[^\n]*listen start/);
+
+  /* A real reply still clears it across the same restart boundary. */
+  const third = await runOnce(async (onEvent) => {
+    onEvent({
+      type: "delivery_ack",
+      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab05",
+      outcome: "replied",
+      ts: "2026-09-03T18:30:00.000Z",
+    });
+  });
+  assert.equal(third.consecutiveAckFailureCount, 0);
+  assert.doesNotMatch(renderListenerStatus(third), /listener_delivery_failing/);
+  await rm(root, { recursive: true, force: true });
+});
+
+test("the outcome sentence names the acknowledged signal, not a newer effect", async () => {
+  /* lastSignalId is advanced by `effect` before the ack for that signal lands, so
+     for the whole prompt window the status held an older ack's outcome beside a
+     newer signal id, and printed "Last failed delivery signal: <the newer one>".
+     Found by a Gemini arm on 3b245ed. */
+  const root = await mkdtemp(join(tmpdir(), "cswarm-ack-signal-"));
+  const paths = listenerPaths({
+    profileId: `profile-${randomUUID()}`,
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    stateDirectory: root,
+  });
+  const ts = "2026-09-04T10:00:00.000Z";
+  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac01";
+  const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac02";
+  let midWindow: ListenerStatus | undefined;
+  const status = await runListenerSupervisor({
+    paths,
+    profileId: "profile-test",
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    run: async (_signal, onEvent) => {
+      onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
+      onEvent({ type: "delivery_ack", signalId: A, outcome: "failed_terminal", ts: "2026-09-04T10:01:00.000Z" });
+      /* B's effect runs before B's ack: the window the sentence used to lie in. */
+      onEvent({
+        type: "effect",
+        signalId: B,
+        status: "done",
+        failureCode: null,
+        ts: "2026-09-04T10:02:00.000Z",
+      });
+      midWindow = await queryListenerControl(paths, "status");
+      return { reason: "cancelled" };
+    },
+  });
+  assert.ok(midWindow);
+  assert.equal(midWindow.lastSignalId, B);
+  assert.equal(midWindow.lastAckSignalId, A);
+  assert.equal(midWindow.lastAckOutcome, "failed_terminal");
+  const human = renderListenerStatus(midWindow);
+  assert.match(human, new RegExp(`Last failed delivery signal: ${A}\\.`));
+  assert.doesNotMatch(human, new RegExp(`Last failed delivery signal: ${B}`));
+  /* A restart carries the ack's own signal id with the rest of the ack record. */
+  assert.equal(status.lastAckSignalId, A);
+  const carried = await runListenerSupervisor({
+    paths,
+    profileId: "profile-test",
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    run: async () => ({ reason: "cancelled" }),
+  });
+  assert.equal(carried.lastAckSignalId, A);
+  assert.match(renderListenerStatus(carried), new RegExp(`Last failed delivery signal: ${A}\\.`));
+  await rm(root, { recursive: true, force: true });
+});
+
+test("a status written before lastAckOutcome existed is not called unacknowledged", async () => {
+  /* Every fleet listener at the 0.1.51 upgrade has lastAckAt and lastSignalId
+     from 0.1.50 and no lastAckOutcome. Restarting it carries the timestamp and
+     not the outcome, and a new CLI reading a still-running 0.1.50 listener sees
+     the same shape live. Both DID acknowledge something. Found by a Grok arm on
+     4992dd8. */
+  const root = await mkdtemp(join(tmpdir(), "cswarm-legacy-ack-"));
+  const paths = listenerPaths({
+    profileId: `profile-${randomUUID()}`,
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    stateDirectory: root,
+  });
+  const ackedAt = "2026-09-02T22:00:00.000Z";
+  const signal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaad01";
+  /* A 0.1.50-shaped file: the shape the repo's own legacy-read test uses, plus
+     the six delivery keys that version wrote, and none of the new ones. */
+  const legacy = {
+    version: 1,
+    instanceId: randomUUID(),
+    provider: "claude",
+    profileId: "profile-test",
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    pid: 4242,
+    state: "stopped",
+    startedAt: "2026-09-02T21:00:00.000Z",
+    readyAt: "2026-09-02T21:00:05.000Z",
+    updatedAt: ackedAt,
+    stoppedAt: "2026-09-02T23:00:00.000Z",
+    lastSignalId: signal,
+    lastErrorCode: null,
+    lastErrorDetail: null,
+    lastWorkerStderrTail: null,
+    logPath: paths.logPath,
+    deliveryMode: "durable_claim",
+    pendingDeliveryCount: null,
+    lastTerminalDeliveryFailureCount: null,
+    lastTerminalDeliveryFailureAt: null,
+    lastClaimAt: ackedAt,
+    lastAckAt: ackedAt,
+    routeMode: "worker",
+  };
+  await writeSecureJsonFile(paths.statusPath, JSON.stringify(legacy));
+
+  /* The new CLI reading the old file, no restart. */
+  const asRead = await readListenerStatus(paths);
+  assert.ok(asRead);
+  assert.equal(asRead.lastAckAt, ackedAt);
+  assert.equal(asRead.lastAckOutcome, null);
+  const readHuman = renderListenerStatus(asRead);
+  assert.doesNotMatch(readHuman, /No delivery acknowledgement is recorded/);
+  assert.match(readHuman, new RegExp(`An acknowledgement was recorded at ${ackedAt}; its outcome was not recorded\\.`));
+  assert.match(readHuman, /HANDLED: not yet measured/);
+
+  /* The restart the upgrade implies: the carry brings lastAckAt, not an outcome. */
+  const restarted = await runListenerSupervisor({
+    paths,
+    profileId: "profile-test",
+    workspaceId: WORKSPACE_ID,
+    principalId: PRINCIPAL_ID,
+    run: async () => ({ reason: "cancelled" }),
+  });
+  assert.equal(restarted.lastAckAt, ackedAt);
+  assert.equal(restarted.lastAckOutcome, null);
+  const restartedHuman = renderListenerStatus(restarted);
+  assert.doesNotMatch(restartedHuman, /No delivery acknowledgement is recorded/);
+  assert.match(restartedHuman, /its outcome was not recorded\./);
+  await rm(root, { recursive: true, force: true });
+});
diff --git a/tests/p1-cli/d080-stale-start-status.test.ts b/tests/p1-cli/d080-stale-start-status.test.ts
index 7ae51e1..9e9c127 100644
--- a/tests/p1-cli/d080-stale-start-status.test.ts
+++ b/tests/p1-cli/d080-stale-start-status.test.ts
@@ -50,13 +50,15 @@ const status = (over: Partial<ListenerStatus>): ListenerStatus => ({
   lastErrorCode: "permission_canary_failed",
   lastErrorDetail: null,
   lastWorkerStderrTail: null,
-  /* All six delivery keys are required by writeListenerStatus, even when null. */
+  /* All STATUS_DELIVERY_KEYS entries are required, even when null. */
   deliveryMode: "cursor_fallback",
   pendingDeliveryCount: null,
   lastTerminalDeliveryFailureCount: null,
   lastTerminalDeliveryFailureAt: null,
   lastClaimAt: null,
   lastAckAt: null,
+  lastAckOutcome: null,
+  consecutiveAckFailureCount: null,
   ...over,
 });
 
diff --git a/tests/p1-cli/hook-routing.test.ts b/tests/p1-cli/hook-routing.test.ts
index f30fd71..f21cc14 100644
--- a/tests/p1-cli/hook-routing.test.ts
+++ b/tests/p1-cli/hook-routing.test.ts
@@ -117,6 +117,8 @@ async function writeStatus(
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "main",
     deferOverChars: null,
     pendingForMainCount: options.pendingForMainCount ?? 0,
@@ -1899,6 +1901,8 @@ test("listen status names the route and the next step for waiting main asks", ()
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: "2026-08-26T00:00:02.000Z",
     lastAckAt: "2026-08-26T00:00:02.000Z",
+    lastAckOutcome: "queued",
+    consecutiveAckFailureCount: null,
     routeMode: "split",
     deferOverChars: 240,
     pendingForMainCount: 2,
@@ -1944,6 +1948,8 @@ test("listen status calls dead-listener asks stranded and gives the restart comm
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "main",
     deferOverChars: null,
     pendingForMainCount: 2,
diff --git a/tests/p1-cli/listen-attendance.test.ts b/tests/p1-cli/listen-attendance.test.ts
index e59b55f..202d8e8 100644
--- a/tests/p1-cli/listen-attendance.test.ts
+++ b/tests/p1-cli/listen-attendance.test.ts
@@ -8,6 +8,7 @@ import { dirname, join, resolve } from "node:path";
 import { fileURLToPath } from "node:url";
 import test from "node:test";
 import { cloudTarget } from "../../src/cloud/config.js";
+import type { DeliveryOutcome } from "../../src/cloud/delivery.js";
 import {
   appendListenerEvent,
   FileHookSurfaceStore,
@@ -108,6 +109,11 @@ async function statusFixture(
     state: "ready" | "stopped";
     pending: number;
     lastAckAt?: string | null;
+    lastAckOutcome?: DeliveryOutcome | null;
+    lastAckSignalId?: string | null;
+    consecutiveAckFailureCount?: number | null;
+    lastErrorCode?: string | null;
+    routeMode?: "worker" | "main" | "split";
   },
 ): Promise<ListenerStatus> {
   const status: ListenerStatus = {
@@ -124,7 +130,7 @@ async function statusFixture(
     updatedAt: "2026-09-01T12:00:02.000Z",
     stoppedAt: options.state === "stopped" ? "2026-09-01T12:00:02.000Z" : null,
     lastSignalId: SIGNAL_ID,
-    lastErrorCode: null,
+    lastErrorCode: options.lastErrorCode ?? null,
     lastErrorDetail: null,
     lastWorkerStderrTail: null,
     deliveryMode: "durable_claim",
@@ -133,7 +139,11 @@ async function statusFixture(
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: "2026-09-01T12:00:02.000Z",
     lastAckAt: options.lastAckAt ?? null,
-    routeMode: "main",
+    lastAckOutcome: options.lastAckOutcome ?? null,
+    lastAckSignalId: options.lastAckSignalId ?? null,
+    consecutiveAckFailureCount:
+      options.consecutiveAckFailureCount ?? null,
+    routeMode: options.routeMode ?? "main",
     deferOverChars: null,
     pendingForMainCount: options.pending,
     droppedForMainCount: 0,
@@ -221,7 +231,7 @@ test("listen status separates connected, attended, and handled across the fixtur
     assert.match(readyQueued.stdout, /Listener WARNING/);
     assert.match(readyQueued.stdout, /CONNECTED: yes/);
     assert.match(readyQueued.stdout, /ATTENDED: no/);
-    assert.match(readyQueued.stdout, /HANDLED: no/);
+    assert.match(readyQueued.stdout, /HANDLED: no\./);
     assert.match(readyQueued.stdout, /WARNING \[listener_unattended_main_queue\]/);
     assert.match(readyQueued.stdout, /queued at 2026-09-01T12:00:03\.000Z/);
     assert.match(
@@ -264,6 +274,152 @@ test("listen status separates connected, attended, and handled across the fixtur
   }
 });
 
+test("worker status shows terminal delivery failure runs and clears them after an answer", async () => {
+  const root = await mkdtemp(join(tmpdir(), "cswarm-worker-delivery-status-"));
+  const home = await mkdtemp(join(tmpdir(), "cswarm-worker-delivery-home-"));
+  let activeControl: { close(): Promise<void> } | null = null;
+  try {
+    const failedRoot = join(root, "failed");
+    const failedPaths = paths(failedRoot);
+    const failedStatus = await statusFixture(failedPaths, {
+      state: "ready",
+      pending: 0,
+      routeMode: "worker",
+      lastAckAt: "2026-09-01T12:00:04.000Z",
+      lastAckOutcome: "failed_terminal",
+      lastAckSignalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
+      consecutiveAckFailureCount: 3,
+      lastErrorCode: "acpprotocolerror",
+    });
+    activeControl = await startListenerControlServer({
+      paths: failedPaths,
+      status: () => failedStatus,
+      stop: () => {},
+    });
+
+    const failedHuman = await runCliAsync(statusArgs(failedRoot), {
+      cwd: root,
+      home,
+    });
+    assert.equal(failedHuman.status, 0, failedHuman.stderr);
+    assert.match(failedHuman.stdout, /HANDLED: no\./);
+    assert.match(
+      failedHuman.stdout,
+      /newest delivery acknowledgement was failed_terminal \(acpprotocolerror\)/,
+    );
+    assert.match(failedHuman.stdout, /Last failed delivery signal:/);
+    assert.doesNotMatch(failedHuman.stdout, /Last handled signal:/);
+    assert.match(failedHuman.stdout, /Listener LAPSE/);
+    assert.match(failedHuman.stdout, /WARNING \[listener_delivery_failing\]/);
+    assert.match(
+      failedHuman.stdout,
+      /recorded 3 terminal delivery failures with no reply since/,
+    );
+    assert.doesNotMatch(failedHuman.stdout, /last answered delivery/);
+
+    const failedJson = await runCliAsync(
+      [...statusArgs(failedRoot), "--json"],
+      { cwd: root, home },
+    );
+    assert.equal(failedJson.status, 0, failedJson.stderr);
+    const failedParsed = JSON.parse(failedJson.stdout) as Record<string, unknown>;
+    assert.equal(failedParsed.handledState, "not_handled");
+    assert.equal(failedParsed.listenerLapse, true);
+    assert.deepEqual(failedParsed.listenerLapseCodes, [
+      "listener_delivery_failing",
+    ]);
+    assert.equal(failedParsed.lastAckOutcome, "failed_terminal");
+    assert.equal(failedParsed.consecutiveAckFailureCount, 3);
+    await activeControl.close();
+    activeControl = null;
+
+    for (const outcome of ["queued", "expired"] as const) {
+      const incompleteRoot = join(root, outcome);
+      const incompletePaths = paths(incompleteRoot);
+      const incompleteStatus = await statusFixture(incompletePaths, {
+        state: "ready",
+        pending: 0,
+        routeMode: "worker",
+        lastAckAt: "2026-09-01T12:00:04.500Z",
+        lastAckOutcome: outcome,
+        lastAckSignalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
+      });
+      activeControl = await startListenerControlServer({
+        paths: incompletePaths,
+        status: () => incompleteStatus,
+        stop: () => {},
+      });
+      const incompleteHuman = await runCliAsync(statusArgs(incompleteRoot), {
+        cwd: root,
+        home,
+      });
+      assert.equal(incompleteHuman.status, 0, incompleteHuman.stderr);
+      assert.match(incompleteHuman.stdout, /HANDLED: not yet measured/);
+      assert.match(
+        incompleteHuman.stdout,
+        new RegExp(`Last acknowledged signal: .* Its outcome was ${outcome}\\.`),
+      );
+      assert.doesNotMatch(incompleteHuman.stdout, /outcome is not known/);
+      const incompleteJson = await runCliAsync(
+        [...statusArgs(incompleteRoot), "--json"],
+        { cwd: root, home },
+      );
+      assert.equal(incompleteJson.status, 0, incompleteJson.stderr);
+      const incompleteParsed = JSON.parse(incompleteJson.stdout) as Record<
+        string,
+        unknown
+      >;
+      assert.equal(incompleteParsed.lastAckOutcome, outcome);
+      assert.equal(incompleteParsed.handledState, "not_yet_measured");
+      await activeControl.close();
+      activeControl = null;
+    }
+
+    const answeredRoot = join(root, "answered");
+    const answeredPaths = paths(answeredRoot);
+    const answeredStatus = await statusFixture(answeredPaths, {
+      state: "ready",
+      pending: 0,
+      routeMode: "worker",
+      lastAckAt: "2026-09-01T12:00:05.000Z",
+      lastAckOutcome: "replied",
+      lastAckSignalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
+      consecutiveAckFailureCount: 0,
+    });
+    activeControl = await startListenerControlServer({
+      paths: answeredPaths,
+      status: () => answeredStatus,
+      stop: () => {},
+    });
+
+    const answeredHuman = await runCliAsync(statusArgs(answeredRoot), {
+      cwd: root,
+      home,
+    });
+    assert.equal(answeredHuman.status, 0, answeredHuman.stderr);
+    assert.match(answeredHuman.stdout, /HANDLED: yes/);
+    assert.match(answeredHuman.stdout, /newest delivery acknowledgement was replied/);
+    assert.match(answeredHuman.stdout, /Last handled signal:/);
+    assert.doesNotMatch(answeredHuman.stdout, /listener_delivery_failing/);
+
+    const answeredJson = await runCliAsync(
+      [...statusArgs(answeredRoot), "--json"],
+      { cwd: root, home },
+    );
+    assert.equal(answeredJson.status, 0, answeredJson.stderr);
+    const answeredParsed = JSON.parse(answeredJson.stdout) as Record<string, unknown>;
+    assert.equal(answeredParsed.handledState, "handled");
+    assert.equal(answeredParsed.listenerLapse, false);
+    assert.deepEqual(answeredParsed.listenerLapseCodes, []);
+    assert.equal(answeredParsed.lastAckOutcome, "replied");
+    assert.equal(answeredParsed.consecutiveAckFailureCount, 0);
+  } finally {
+    if (activeControl !== null) await activeControl.close();
+    await rm(root, { recursive: true, force: true });
+    await rm(home, { recursive: true, force: true });
+  }
+});
+
 test("listen start refuses unattended main routes unless the operator accepts the risk", async () => {
   const root = await mkdtemp(join(tmpdir(), "cswarm-attendance-start-"));
   const home = await mkdtemp(join(tmpdir(), "cswarm-attendance-start-home-"));
diff --git a/tests/p1-cli/listener-provider.test.ts b/tests/p1-cli/listener-provider.test.ts
index d366fb4..e02eecc 100644
--- a/tests/p1-cli/listener-provider.test.ts
+++ b/tests/p1-cli/listener-provider.test.ts
@@ -113,6 +113,8 @@ test("Grok canary guidance points to the local detail rendered by listen status"
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "worker",
     deferOverChars: null,
     pendingForMainCount: 0,
diff --git a/tests/p1-cli/resume.test.ts b/tests/p1-cli/resume.test.ts
index 496fdcf..ada41df 100644
--- a/tests/p1-cli/resume.test.ts
+++ b/tests/p1-cli/resume.test.ts
@@ -74,6 +74,8 @@ function listenerStatus(logPath: string): ListenerStatus {
     lastTerminalDeliveryFailureAt: null,
     lastClaimAt: null,
     lastAckAt: null,
+    lastAckOutcome: null,
+    consecutiveAckFailureCount: null,
     routeMode: "main",
     deferOverChars: null,
     pendingForMainCount: 0,
diff --git a/tests/support/agent-receive-cli.test.ts b/tests/support/agent-receive-cli.test.ts
index e818644..43ef5b1 100644
--- a/tests/support/agent-receive-cli.test.ts
+++ b/tests/support/agent-receive-cli.test.ts
@@ -18,6 +18,7 @@ import { cloudTarget } from "../../src/cloud/config.js";
 import {
   listenerPaths,
   runListenerSupervisor,
+  STATUS_DELIVERY_KEYS,
   type ListenerRuntimeEvent,
   type ListenerStatus,
 } from "../../src/listener/index.js";
@@ -1241,7 +1242,7 @@ test("describeMintRenewal states process and local-state conditions, not uncondi
   assert.match(noExpiry, /does not renew itself/);
 });
 
-test("legacy listener status JSON normalizes exactly six delivery fields to null", () => {
+test("legacy listener status JSON normalizes all delivery fields to null", () => {
   const status = {
     version: 1,
     instanceId: randomUUID(),
@@ -1261,17 +1262,9 @@ test("legacy listener status JSON normalizes exactly six delivery fields to null
   } as unknown as ListenerStatus;
 
   const json = listenerStatusJson(status);
-  const deliveryFields = [
-    "deliveryMode",
-    "pendingDeliveryCount",
-    "lastTerminalDeliveryFailureCount",
-    "lastTerminalDeliveryFailureAt",
-    "lastClaimAt",
-    "lastAckAt",
-  ];
   assert.deepEqual(
-    Object.fromEntries(deliveryFields.map((field) => [field, json[field]])),
-    Object.fromEntries(deliveryFields.map((field) => [field, null])),
+    Object.fromEntries(STATUS_DELIVERY_KEYS.map((field) => [field, json[field]])),
+    Object.fromEntries(STATUS_DELIVERY_KEYS.map((field) => [field, null])),
   );
   assert.equal(Object.hasOwn(json, "delivery_mode"), false);
   assert.equal(Object.hasOwn(json, "pending_delivery_count"), false);
