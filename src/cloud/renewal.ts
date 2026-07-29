/*
 * Silent worker-token renewal (SWARM-CLOUD.md §2.3, "Worker-token renewal is a fenced
 * SUCCESSOR operation, not a mint").
 *
 * THE PROBLEM THIS SOLVES, AND THE FIX IT REFUSES TO MAKE. An agent work session now runs
 * for days or weeks. An agent token lives one hour by default and eight hours at the
 * absolute most, and until this file existed there was no renewal path at all — the eight
 * hours were a wall, not a ceiling, and a person had to re-mint by hand. The tempting fix
 * is a longer TTL. A month-long bearer token sitting on a developer machine is precisely
 * the trade §2.3 was written to refuse, so the TTL numbers here are UNCHANGED (1h default,
 * 8h maximum) and this file makes renewal happen so often that nobody notices it.
 *
 * WHAT MAKES IT SAFE, restated so a future edit cannot quietly drop one:
 *
 *   - The command object carries NO TARGET FIELDS — it is `{ kind }` and nothing else. Not
 *     principal, not run, not task, not epoch, not scopes, not a TTL. renewalCommand() is
 *     the only place it is built and it is asserted to hold exactly one key, because "we
 *     simply never send that field" is a convention and an assertion is a mechanism. The
 *     command function refuses any other key at the wire (validateCommand's exactKeys
 *     check) before authorization runs, so both sides hold the same line.
 *   - The server derives principal, run, task, epoch and scopes from the predecessor row it
 *     authenticated. Nothing this file sends can point renewal at another run.
 *   - Attenuation is the server's job, measured against the PREDECESSOR. This file never
 *     asks for a scope, so it cannot ask for a broader one.
 *   - The client refuses a successor whose lifetime exceeds AGENT_TOKEN_MAX_TTL_MS. A
 *     deployment answering "here, have thirty days" is the failure mode this whole design
 *     exists to prevent, and it should be refused on both sides of the wire.
 *
 * ★ NOT RENEWING TWICE. src/cloud/pending-command.ts records what a blind retry cost once:
 * a 5xx answered AFTER the mint transaction committed, the retry generated a fresh command
 * id, missed the idempotency ledger, and issued a SECOND live credential. Renewal has the
 * same shape and two more racers — concurrent requests inside one process, and two CLI
 * invocations sharing a lineage on one machine. All three are closed here:
 *
 *   in-process   one shared promise; a second caller awaits the first renewal.
 *   cross-process  the lineage's file lock is held across read-decide-write.
 *   ambiguity    the command id is PERSISTED before the request and kept on a 5xx or a
 *                transport failure, so the next attempt is a replay and not a second mint.
 *
 * WHEN RENEWAL FAILS, THE COMMAND STILL RUNS. Renewal happens ahead of expiry, so a
 * refusal usually arrives while the predecessor is still perfectly good. Turning that into
 * a user-visible failure would trade a silent success for a loud one. So a failed renewal
 * on a live predecessor is a warning; it is fatal only once the predecessor is actually
 * unusable, and then it is a sentence naming the command a person should run.
 */
import { randomBytes } from "node:crypto";
import {
  CLIENT_PROTOCOL_VERSION,
  commandEndpoint,
  type CloudTarget,
} from "./config.js";
import type {
  AgentCredentialRecord,
  AgentCredentialStore,
} from "./agent-credential.js";

/* THE NUMBERS. Decided centrally so the CLI, the site and the server cannot drift.
 * TTL is deliberately absent from that list: renewal does not change it. */

/** Unchanged from src/protocol/workspace-commands.ts. Restated so this file can refuse. */
export const AGENT_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1_000;
export const AGENT_TOKEN_MAX_TTL_MS = 8 * 60 * 60 * 1_000;

/** How long a run auto-renews before a person is asked again. */
export const RENEWAL_HORIZON_DEFAULT_MS = 30 * 24 * 60 * 60 * 1_000;
export const RENEWAL_HORIZON_MAX_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Successors one grant authorises.
 *
 * 800 is not a round number picked for comfort — it is the 30-day horizon expressed in
 * renewals. A 1h token renewed at 10% remaining turns over every 54 minutes, and 30 days
 * is 43,200 minutes: 43,200 / 54 = 800 exactly. The successor budget and the horizon
 * therefore run out at the same moment for a continuously-working agent, which is the
 * property worth having — whichever bound bites first, the answer a person gets is the
 * same one, and neither expires embarrassingly early.
 */
export const RENEWAL_MAX_SUCCESSORS_DEFAULT = 800;

/** Renew once this fraction of the token's own lifetime remains. See the 800 above. */
export const RENEWAL_LEAD_FRACTION = 0.1;
/** Never cut it finer than this, however short the token. */
export const RENEWAL_LEAD_FLOOR_MS = 5 * 60_000;
/** Never renew this far ahead, however long the token; an 8h token would waste half of it. */
export const RENEWAL_LEAD_CEILING_MS = 15 * 60_000;

/** How long an interrupted renewal stays replayable before its command id is abandoned. */
export const RENEWAL_PENDING_RECOVERY_MS = 60 * 60_000;

const RENEW_TIMEOUT_MS = 30_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;

/**
 * When a credential issued at `issuedAt` and expiring at `expiresAt` should be renewed.
 * Pure so the schedule is reviewable without a clock or a deployment.
 */
export function renewalDueAt(issuedAt: number, expiresAt: number): number {
  const lifetime = Math.max(0, expiresAt - issuedAt);
  const lead = Math.min(
    RENEWAL_LEAD_CEILING_MS,
    Math.max(RENEWAL_LEAD_FLOOR_MS, Math.round(lifetime * RENEWAL_LEAD_FRACTION)),
  );
  // A token shorter than the floor is renewed immediately rather than never.
  return expiresAt - Math.min(lead, lifetime);
}

/* Refusals. Each one is a distinct class because each one has a different true sentence,
 * and because "403" tells the person holding the terminal nothing they can act on. */

/**
 * The run reached its continuous-renewal horizon, or spent its successor budget. This is
 * not a failure — it is the periodic human checkpoint §2.3 asks for, arriving on schedule.
 */
export class RenewalReauthorisationRequired extends Error {
  override name = "RenewalReauthorisationRequired";
  constructor(
    readonly reason: "horizon_reached" | "grant_exhausted",
    readonly principalId: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** The lineage was revoked, or the predecessor no longer authenticates. Fail closed. */
export class RenewalRevoked extends Error {
  override name = "RenewalRevoked";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The deployment has no successor path, or this credential has no renewal window. */
export class RenewalUnsupported extends Error {
  override name = "RenewalUnsupported";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Another process renewed this predecessor first. Not a failure — the successor exists and
 * is on disk; this process simply lost the race and re-reads rather than asking again.
 */
export class RenewalSuperseded extends Error {
  override name = "RenewalSuperseded";
  constructor(message: string) {
    super(message);
  }
}

/**
 * The request left and no outcome came back, or a 5xx arrived. Named separately because
 * the honest sentence differs: a refusal means nothing was issued, this means nobody
 * knows, and it is the case whose command id must be kept.
 */
export class RenewalOutcomeUnknown extends Error {
  override name = "RenewalOutcomeUnknown";
  constructor(message: string) {
    super(message);
  }
}

/** Anything else the deployment said. */
export class RenewalRefused extends Error {
  override name = "RenewalRefused";
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface SuccessorCredential {
  token: string;
  tokenId: string;
  principalId: string;
  runId: string;
  issuedAt: number;
  expiresAt: number;
  horizonExpiresAt: number | null;
  successorsRemaining: number | null;
}

/**
 * The renewal command, in the only place it is built.
 *
 * There is nothing here to select. That is the entire security property of §2.3's fenced
 * successor: a compromised worker cannot renew a different run, a different task, a
 * different epoch, or a broader scope, because the wire format gives it no way to name
 * one. The key set is asserted rather than merely written, so a future field added "just
 * to help the server" fails here instead of on a security review — and the command
 * function refuses the same thing independently, so neither side is the only guard.
 */
export function renewalCommand(): { kind: "renew_agent_token" } {
  const command = { kind: "renew_agent_token" as const };
  const keys = Object.keys(command);
  if (keys.length !== 1 || keys[0] !== "kind") {
    throw new Error(
      "renew_agent_token accepts no caller-selected fields (SWARM-CLOUD.md §2.3)",
    );
  }
  return command;
}

export function newRenewalCommandId(): string {
  return `ren_${randomBytes(18).toString("base64url")}`;
}

/** Accepts either an epoch-milliseconds number or an ISO-8601 string; null otherwise. */
function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function reauthorisationMessage(
  reason: "horizon_reached" | "grant_exhausted",
  principalId: string | null,
): string {
  const who = principalId === null
    ? "this agent"
    : `agent principal ${principalId}`;
  const cause = reason === "horizon_reached"
    ? "reached the end of the window a person authorised it to keep renewing for"
    : "used every renewal that window allowed";
  return [
    `CommonSwarm stopped renewing the credential for ${who}: it ${cause}.`,
    "Nothing is lost or broken. Renewing forever without asking anyone is the thing this deliberately does not do, so a person confirms the agent should keep working.",
    "Whoever set this agent up issues a new credential — in the browser on the connect page, or with:",
    `  cswarm token mint --principal-id ${
      principalId ?? "<the agent principal id>"
    } --run-id <a fresh uuid> --task-id <a fresh uuid> --epoch 0`,
    "Pipe the JSON it prints to this agent the same way the first one was handed over. Everything already posted, and the work item itself, are untouched.",
  ].join("\n");
}

/**
 * One successor request. Does no storage and no scheduling — the caller owns both, so this
 * stays a reviewable statement of what goes on the wire and what comes back.
 */
export async function requestSuccessor(options: {
  target: CloudTarget;
  workspaceId: string;
  /** The active predecessor. Presented as a bearer, never placed in the body. */
  predecessor: string;
  commandId: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<SuccessorCredential | null> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENEW_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(commandEndpoint(options.target), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.predecessor}`,
        apikey: options.target.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: options.commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: options.workspaceId,
        stream: { kind: "workspace" },
        command: renewalCommand(),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new RenewalOutcomeUnknown(
        "the renewal request timed out before an outcome came back",
      );
    }
    throw new RenewalOutcomeUnknown(
      "the renewal request failed before an outcome came back",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    throw new RenewalOutcomeUnknown(
      `the deployment answered HTTP ${response.status}, which does not say whether a successor was issued`,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await response.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const principalId = typeof body.principal_id === "string" &&
      UUID_RE.test(body.principal_id)
    ? body.principal_id.toLowerCase()
    : null;

  if (response.status === 400 || response.status === 404) {
    // A deployment that predates renewal refuses `renew_agent_token` as an unknown
    // command kind. That is the state of every deployment until this ships, so it is a
    // supported outcome and not a failure: the credential keeps working for its hour.
    throw new RenewalUnsupported(
      "this deployment does not offer credential renewal yet, so a credential here still has to be re-issued by hand when it expires",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new RenewalRevoked(
      "forbidden",
      "This agent credential is no longer accepted, and renewal cannot bring it back — that is deliberate: revoking a credential, a device, or a person's membership revokes everything descended from it. Ask whoever runs this workspace what was revoked and why, then get a new credential from them.",
    );
  }
  if (response.status === 426) {
    const minimum = typeof body.min_client_version === "string"
      ? body.min_client_version
      : null;
    throw new RenewalRefused(
      response.status,
      "upgrade_required",
      `This copy of cswarm is older than the deployment accepts${
        minimum === null ? "" : ` (minimum ${minimum})`
      }. Update cswarm; until then this credential cannot renew itself.`,
    );
  }
  if (!response.ok) {
    throw new RenewalRefused(
      response.status,
      typeof body.error === "string" ? body.error : "unknown",
      `The deployment did not renew this credential (HTTP ${response.status}).`,
    );
  }

  /* A REFUSED RENEWAL ARRIVES AS HTTP 200. The command function answers a domain refusal
   * with 200 and `status: "rejected"`, exactly as it does for every other command — the
   * status code describes the request, the body describes the decision. Reading only the
   * HTTP status here would score every named fence in §2.3 as a success and then fail on
   * the missing token with a shrug. The reason strings are the reducer's
   * RenewalRejectionReason union. */
  if (body.status === "rejected") {
    const reason = typeof body.reason === "string" ? body.reason : "unknown";
    if (reason === "renewal_horizon_reached") {
      throw new RenewalReauthorisationRequired(
        "horizon_reached",
        principalId,
        reauthorisationMessage("horizon_reached", principalId),
      );
    }
    if (reason === "renewal_successors_exhausted") {
      throw new RenewalReauthorisationRequired(
        "grant_exhausted",
        principalId,
        reauthorisationMessage("grant_exhausted", principalId),
      );
    }
    if (reason === "renewal_grant_not_found" || reason === "renewal_unsupported") {
      throw new RenewalUnsupported(
        "this credential was issued without a renewal window, so it cannot renew itself. Ask whoever issued it for a new one — credentials issued since renewal shipped carry a window automatically",
      );
    }
    if (reason === "predecessor_superseded") {
      throw new RenewalSuperseded(
        "another cswarm process renewed this credential first",
      );
    }
    if (
      reason === "renewal_lineage_revoked" ||
      reason === "renewal_grant_revoked" ||
      reason === "predecessor_revoked" ||
      reason === "predecessor_not_found" ||
      reason === "predecessor_not_owned"
    ) {
      throw new RenewalRevoked(
        reason,
        "This agent credential is no longer accepted, and renewal cannot bring it back — that is deliberate: revoking a credential, a device, or a person's membership revokes everything descended from it. Ask whoever runs this workspace what was revoked and why, then get a new credential from them.",
      );
    }
    if (reason === "predecessor_expired") {
      throw new RenewalRevoked(
        reason,
        "This agent credential expired before it could renew itself. Ask whoever set this agent up for a new one; nothing that was already posted is affected.",
      );
    }
    throw new RenewalRefused(
      200,
      reason,
      `The deployment refused to renew this credential (${reason}).`,
    );
  }

  const token = typeof body.agent_token === "string" ? body.agent_token : "";
  if (!token) {
    // A replay. The server keeps only a hash, so the successor it already issued cannot
    // be handed over a second time. Not an error here — the caller decides.
    return null;
  }
  if (!AGENT_TOKEN_RE.test(token)) {
    throw new RenewalRefused(
      response.status,
      "malformed_successor",
      "The deployment returned a credential that is not shaped like one. It was not stored.",
    );
  }
  const tokenId = typeof body.token_id === "string" ? body.token_id : "";
  const runId = typeof body.run_id === "string" ? body.run_id : "";
  if (!UUID_RE.test(tokenId) || !UUID_RE.test(runId) || principalId === null) {
    throw new RenewalRefused(
      response.status,
      "incomplete_successor",
      "A successor credential was issued but the deployment did not name its principal, run, or token. It was not stored; ask an owner to revoke it.",
    );
  }
  const issuedAt = timestamp(body.issued_at) ?? now();
  const expiresAt = timestamp(body.expires_at);
  if (expiresAt === null) {
    throw new RenewalRefused(
      response.status,
      "successor_expiry_missing",
      "A successor credential was issued without an expiry. It was not stored, because a credential whose lifetime is unknown cannot be renewed on time.",
    );
  }
  if (expiresAt - issuedAt > AGENT_TOKEN_MAX_TTL_MS) {
    // The whole point of renewal is that the token stays short. A deployment offering a
    // long one is the failure this design exists to prevent, so refuse it here too.
    throw new RenewalRefused(
      response.status,
      "successor_ttl_too_long",
      "The deployment issued a successor credential that lasts longer than eight hours. cswarm refused to store it. Agent credentials stay short on purpose; renewal is what makes that survivable.",
    );
  }
  return {
    token,
    tokenId: tokenId.toLowerCase(),
    principalId,
    runId: runId.toLowerCase(),
    issuedAt,
    expiresAt,
    horizonExpiresAt: timestamp(body.horizon_expires_at),
    successorsRemaining: count(body.successors_remaining),
  };
}

/** What the caller handed us on stdin, before any renewal has happened. */
export interface PresentedCredential {
  token: string;
  tokenId: string | null;
  principalId: string | null;
  runId: string | null;
  /**
   * Epoch ms, when the artifact stated one. Null for a bare token or an artifact minted
   * before renewal existed — and a null here means this credential is never renewed. See
   * due() for why that is the safe answer rather than the lazy one.
   */
  expiresAt: number | null;
}

export interface AgentCredentialSessionOptions {
  target: CloudTarget;
  /** Renewal routes on the workspace stream like every other workspace command. */
  workspaceId: string;
  presented: PresentedCredential;
  /** Null when the lineage cannot be persisted; renewal then lasts one invocation. */
  store: AgentCredentialStore | null;
  fetcher?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
}

interface PendingRenewal {
  commandId: string;
  startedAt: number;
}

/**
 * Holds whichever credential is currently live for one lineage, and replaces it before it
 * expires. Every caller that needs a bearer asks this rather than reading a token, so
 * there is exactly one place that decides whether a renewal is due.
 */
export class AgentCredentialSession {
  private token: string;
  private tokenId: string | null;
  private principalId: string | null;
  private runId: string | null;
  private issuedAt: number;
  private expiresAt: number | null;
  private horizonExpiresAt: number | null;
  private successorsRemaining: number | null = null;
  private pending: PendingRenewal | null = null;
  private inFlight: Promise<void> | null = null;
  private unsupported = false;
  private renewals = 0;
  /**
   * Whether `token` is a SUCCESSOR rather than the credential piped in.
   *
   * Tracked separately from `renewals` because the two answer different questions and
   * conflating them deletes other people's work: a session that adopted a successor another
   * process wrote has renewed zero times but does hold one, and keying the store write off
   * the renewal count would make it erase that record as "nothing worth keeping".
   */
  private successor = false;
  /** Monotonic across processes: continues the adopted record's count, never restarts it. */
  private generation = 0;
  private readonly rootTokenId: string | null;

  private constructor(
    private readonly options: AgentCredentialSessionOptions,
    private readonly clock: () => number,
    private readonly warn: (message: string) => void,
    adopted: AgentCredentialRecord | null,
  ) {
    this.rootTokenId = options.presented.tokenId;
    if (adopted && adopted.token !== null && adopted.expiresAt !== null) {
      this.token = adopted.token;
      this.tokenId = adopted.tokenId;
      this.principalId = adopted.principalId;
      this.runId = adopted.runId;
      this.issuedAt = adopted.issuedAt;
      this.expiresAt = adopted.expiresAt;
      this.horizonExpiresAt = adopted.horizonExpiresAt;
      this.successorsRemaining = adopted.successorsRemaining;
      this.successor = true;
      this.generation = adopted.generation;
    } else {
      this.token = options.presented.token;
      this.tokenId = options.presented.tokenId;
      this.principalId = options.presented.principalId;
      this.runId = options.presented.runId;
      this.expiresAt = options.presented.expiresAt;
      // The artifact states an expiry but not an issue time. Assuming the default TTL is
      // the conservative reading: it can only make the computed lead SHORTER than the real
      // one (a longer-lived token gets renewed nearer its end, never past it), and the
      // floor below keeps it from ever collapsing to zero.
      this.issuedAt = this.expiresAt === null
        ? clock()
        : this.expiresAt - AGENT_TOKEN_DEFAULT_TTL_MS;
      this.horizonExpiresAt = null;
    }
  }

  /**
   * Opens the session, adopting a stored successor when one belongs to this lineage.
   *
   * A record whose rootTokenId names a different credential is a leftover from a lineage a
   * person has since replaced. It is deleted rather than used: presenting a superseded
   * lineage's token would look, from the server, exactly like a stolen one.
   */
  static async open(
    options: AgentCredentialSessionOptions,
  ): Promise<AgentCredentialSession> {
    const clock = options.now ?? Date.now;
    const warn = options.warn ??
      ((message: string) => process.stderr.write(`cswarm: ${message}\n`));
    let adopted: AgentCredentialRecord | null = null;
    let pending: PendingRenewal | null = null;
    if (options.store) {
      await options.store.withLock(async () => {
        const record = await options.store!.read().catch(() => null);
        if (!record) return;
        /* The principal is compared only when BOTH sides name one. A pending-only record
         * — written before any successor exists, to hold the replay id — deliberately
         * carries nulls where the credential goes, and an earlier version of this check
         * read that null as "belongs to a different agent", deleted the record, and lost
         * the very command id that makes an interrupted renewal replayable. The lineage
         * key in the filename is already derived from the presented credential; rootTokenId
         * is the second check, and the principal is a third only where it exists. */
        const sameLineage = record.rootTokenId === options.presented.tokenId &&
          (options.presented.principalId === null ||
            record.principalId === null ||
            record.principalId === options.presented.principalId);
        if (!sameLineage) {
          await options.store!.delete().catch(() => undefined);
          return;
        }
        // A pending-only record (no successor yet) contributes its command id and nothing
        // else — there is no credential in it to adopt.
        if (record.token !== null && record.expiresAt !== null) adopted = record;
        if (
          record.pendingRenewal !== null &&
          clock() - record.pendingRenewal.startedAt < RENEWAL_PENDING_RECOVERY_MS
        ) {
          pending = record.pendingRenewal;
        }
      });
    }
    const session = new AgentCredentialSession(options, clock, warn, adopted);
    session.pending = pending;
    return session;
  }

  /** True once this session has replaced the credential it was opened with. */
  get renewed(): boolean {
    return this.renewals > 0;
  }

  /** When a person is next asked to re-authorise, if the deployment has said. */
  get horizon(): number | null {
    return this.horizonExpiresAt;
  }

  get expiry(): number | null {
    return this.expiresAt;
  }

  /**
   * ★ RENEWAL REQUIRES SOMEWHERE TO KEEP THE SUCCESSOR, AND THAT IS A SAFETY RULE, NOT A
   * CONVENIENCE. A successful renewal SUPERSEDES the predecessor server-side — the fence
   * sets its expires_at to now, so exactly one live token exists per lineage. Renewing
   * without being able to write the successor down would therefore kill the credential the
   * caller handed us and lose its replacement when the process exits: the agent would be
   * bricked by the feature meant to keep it alive. So with no store, this never renews.
   */
  private due(): boolean {
    if (this.unsupported) return false;
    if (this.options.store === null) return false;
    /* ★ AN UNKNOWN EXPIRY MEANS NO RENEWAL, AND THE ALTERNATIVE IS WORSE THAN IT LOOKS.
     * The obvious move for a credential whose deadline is unknown is to renew on first use
     * and learn it. But a successful renewal SUPERSEDES the predecessor server-side, so
     * that would end a credential that may have had fifty-nine good minutes left, spend one
     * of the grant's successors on every fresh lineage, and — if the same artifact is in
     * use on two machines — brick the second one. A bare token or a pre-renewal artifact
     * therefore behaves exactly as it did before this file existed, and the fix is to
     * re-issue it: `cswarm token mint` and the connect page both state the expiry now. */
    if (this.expiresAt === null) return false;
    return this.clock() >= renewalDueAt(this.issuedAt, this.expiresAt);
  }

  private expired(): boolean {
    return this.expiresAt !== null && this.clock() >= this.expiresAt;
  }

  /**
   * The credential to present, renewed first if it is close to expiring.
   *
   * Renewal happens AHEAD of expiry rather than on a 401, so the common path never shows a
   * person a failure. A refusal while the predecessor is still live is therefore a warning
   * and the command proceeds; it becomes fatal only when there is nothing valid left to
   * present, which is the one case where continuing would fail anyway.
   */
  async bearer(): Promise<string> {
    if (!this.due()) return this.token;
    try {
      await this.renew();
    } catch (error) {
      if (error instanceof RenewalSuperseded) {
        // The winner wrote its successor before releasing the lock, so re-reading is all
        // that is needed. If it somehow is not there, the predecessor is spent and the
        // next line reports that rather than presenting a token the server has ended.
        await this.adoptStored();
        if (this.expired() || this.token === this.options.presented.token) {
          throw new RenewalRevoked(
            "predecessor_superseded",
            "Another process renewed this agent credential, and this one no longer has a live copy. Run the command again; if it keeps happening, two agents are sharing one credential and each needs its own.",
          );
        }
        return this.token;
      }
      if (this.expired() || error instanceof RenewalRevoked) throw error;
      if (error instanceof RenewalUnsupported) {
        this.unsupported = true;
        this.warn(`${(error as Error).message}.`);
      } else if (error instanceof RenewalReauthorisationRequired) {
        throw error;
      } else {
        this.warn(
          `${
            (error as Error).message
          }. The credential in hand is still valid, so this command went ahead; renewal is retried on the next one.`,
        );
      }
    }
    return this.token;
  }

  /** Single-flight: a second caller inside this process awaits the first renewal. */
  private async renew(): Promise<void> {
    if (this.inFlight) return await this.inFlight;
    const work = this.renewOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = work;
    return await work;
  }

  private async renewOnce(): Promise<void> {
    const store = this.options.store;
    // due() already refuses without a store; this is the second half of the same rule,
    // stated where the write would happen rather than only where it is scheduled.
    if (!store) return;
    // The lock spans read-decide-write. Two invocations racing here is the read-rotate-
    // write race pending-command.ts documents, and the loser must adopt the winner's
    // successor rather than spend a second one from the grant.
    await store.withLock(async () => {
      const record = await store.read().catch(() => null);
      if (
        record &&
        record.token !== null &&
        record.expiresAt !== null &&
        record.rootTokenId === this.rootTokenId &&
        record.token !== this.token &&
        record.expiresAt > (this.expiresAt ?? 0)
      ) {
        this.adopt(record);
        if (!this.due()) return;
      }
      const replayable = this.pending !== null &&
        this.clock() - this.pending.startedAt < RENEWAL_PENDING_RECOVERY_MS;
      const commandId = replayable ? this.pending!.commandId : newRenewalCommandId();
      await this.exchange(commandId);
    });
  }

  /**
   * One exchange, with the command id persisted BEFORE the request and kept if the outcome
   * is unknown. That is what makes the next attempt a replay rather than a second mint.
   */
  private async exchange(commandId: string): Promise<void> {
    const store = this.options.store;
    this.pending = { commandId, startedAt: this.clock() };
    if (store) await this.persist(store);
    let successor: SuccessorCredential | null;
    try {
      successor = await requestSuccessor({
        target: this.options.target,
        workspaceId: this.options.workspaceId,
        predecessor: this.token,
        commandId,
        ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
        now: this.clock,
      });
    } catch (error) {
      if (!(error instanceof RenewalOutcomeUnknown)) {
        // A decided refusal is not replayable; drop the id so it is not reused.
        this.pending = null;
        if (store) await this.persist(store).catch(() => undefined);
      }
      throw error;
    }
    this.pending = null;
    if (successor === null) {
      /* ★ A REPLAY CARRIES NO CREDENTIAL, AND ASKING AGAIN CANNOT FIX IT.
       *
       * The deployment stores only a hash of a credential, so a replayed renewal returns
       * the successor's ids and never its secret — the same rule that makes a replayed
       * mint unusable (src/cli.ts, "fresh-response-only"). The instinct is to spend one
       * more successor and get a usable one. IT DOES NOT WORK, and it is worth writing
       * down why so nobody re-adds it: the renewal that committed ALSO superseded this
       * predecessor server-side, so a second attempt presenting the same predecessor is
       * refused `predecessor_superseded`. There is no credential to be had on this path.
       *
       * What is actually true: exactly one successor exists, nobody holds it, it expires
       * within the hour on its own, and a lineage revocation would reach it. The lineage
       * is finished and a person has to issue a new credential — so that is what this
       * says, rather than a retry loop that spends the grant to arrive at the same place.
       * The record is cleared so the next invocation does not replay this id forever. */
      this.pending = null;
      if (store) await this.persist(store).catch(() => undefined);
      throw new RenewalRevoked(
        "successor_not_recoverable",
        [
          "This agent credential renewed itself, but the answer was lost in transit and the replacement cannot be shown a second time — CommonSwarm keeps only a hash of it.",
          "Nothing is wrong with the workspace and nothing that was already posted is affected. The unclaimed credential expires on its own within the hour.",
          "Ask whoever set this agent up to issue a new one, and pipe it to this agent the way the first one was handed over.",
        ].join("\n"),
      );
    }
    this.token = successor.token;
    this.tokenId = successor.tokenId;
    this.principalId = successor.principalId;
    this.runId = successor.runId;
    this.issuedAt = successor.issuedAt;
    this.expiresAt = successor.expiresAt;
    this.horizonExpiresAt = successor.horizonExpiresAt;
    this.successorsRemaining = successor.successorsRemaining;
    this.successor = true;
    this.generation += 1;
    this.renewals += 1;
    if (store) await this.persist(store);
  }

  /** Re-reads the store and takes whatever the winner of a race left there. */
  private async adoptStored(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    const record = await store.withLock(async () => await store.read().catch(() => null))
      .catch(() => null);
    if (record && record.rootTokenId === this.rootTokenId) this.adopt(record);
  }

  /** Only ever called with a record that holds a successor; callers check `token` first. */
  private adopt(record: AgentCredentialRecord): void {
    if (record.token === null || record.expiresAt === null) return;
    this.successor = true;
    this.generation = record.generation;
    this.token = record.token;
    this.tokenId = record.tokenId;
    this.principalId = record.principalId;
    this.runId = record.runId;
    this.issuedAt = record.issuedAt;
    this.expiresAt = record.expiresAt;
    this.horizonExpiresAt = record.horizonExpiresAt;
    this.successorsRemaining = record.successorsRemaining;
  }

  /**
   * Writes the lineage's state. Called only with the lineage lock held.
   *
   * ★ THE SECRET WRITTEN HERE IS ONLY EVER A SUCCESSOR. Until this session has renewed at
   * least once, `this.token` is still the credential the caller piped in — writing it would
   * copy a secret the caller already holds onto the disk to no purpose, and would break the
   * one sentence this module's header promises. So before the first successor the record
   * carries nulls where the credential goes, and exists ONLY to hold the pending command
   * id, which is what makes an interrupted first renewal replayable rather than a second
   * mint. There is nothing else to keep at that point, so there is nothing else in it.
   */
  private async persist(store: AgentCredentialStore): Promise<void> {
    const haveSuccessor = this.successor && this.tokenId !== null &&
      this.expiresAt !== null;
    if (!haveSuccessor && this.pending === null) {
      // Nothing left to remember: no successor, and no interrupted renewal to replay.
      // DELETED rather than left alone — a decided refusal clears the pending id, and
      // returning here would strand the previous record's id on disk to be replayed later
      // against a command the deployment already refused.
      await store.delete().catch(() => undefined);
      return;
    }
    await store.write({
      version: 1,
      token: haveSuccessor ? this.token : null,
      tokenId: haveSuccessor ? this.tokenId : null,
      principalId: haveSuccessor ? this.principalId : null,
      runId: haveSuccessor ? this.runId : null,
      rootTokenId: this.rootTokenId,
      generation: this.generation,
      issuedAt: this.issuedAt,
      expiresAt: haveSuccessor ? this.expiresAt : null,
      horizonExpiresAt: haveSuccessor ? this.horizonExpiresAt : null,
      successorsRemaining: haveSuccessor ? this.successorsRemaining : null,
      pendingRenewal: this.pending,
    });
  }
}
