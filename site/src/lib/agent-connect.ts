/*
 * Turning a signed-in human into an agent's credential issuer.
 *
 * WHY THIS IS A BROWSER FILE AT ALL. `create_agent_principal` and `mint_agent_token` are both
 * in HUMAN_ONLY_COMMANDS (src/protocol/workspace-commands.ts:106-116), and the reducer refuses
 * them outright when the presenting credential is an agent one. That rule was written for
 * security — a compromised worker must not be able to issue itself a successor — and it turns
 * out to be exactly the shape onboarding wants: the person mints in a browser, once, and hands
 * the result to whatever agent they already run. Nothing here may weaken that. In particular
 * this file never accepts an agent credential as its caller: every call takes the human's
 * GoTrue Session.
 *
 * THE SEQUENCE MIRRORS THE CLI, because the CLI is the working reference and the server has
 * one command surface, not two:
 *
 *   1. register_device      src/cloud/auth.ts:342 — pre-route, no workspace_id, no stream.
 *   2. create_agent_principal   src/cli.ts:1145 (`cswarm principal create`).
 *   3. mint_agent_token         src/cli.ts:1173 (`cswarm token mint`).
 *
 * Step 1 is not optional and is the step that is easy to miss from a browser. The command
 * function checks the mint's device binding against swarm.devices directly
 * (supabase/functions/command/index.ts:2950-2962): the device row must exist, be owned by the
 * calling human, and not be revoked, or the mint is a bare 403 with no explanation. So the
 * browser has to be a registered device before it can mint anything.
 *
 * WHAT THIS FILE MAY NOT DO. The minted credential is returned to the caller and never touched
 * again: it is not logged, not stored, not put in a URL or a query string, and never
 * interpolated into an Error message. A `swm_agt_` string exists in exactly one place in this
 * module — the return value of mintAgentCredential — and every failure path is constructed
 * before or without it.
 */

import type { Session } from "@supabase/supabase-js";
import { CLIENT_PROTOCOL_VERSION, NoDeployment, client, deployment, uuid } from "./commonswarm";

/**
 * Mirrors AGENT_TOKEN_DEFAULT_TTL_MS / AGENT_TOKEN_MAX_TTL_MS in
 * src/protocol/workspace-commands.ts. The reducer refuses anything above the maximum,
 * so a lifetime picker that offers more than it is offering a refusal.
 *
 * The DEFAULT stays 24h while the protocol max is 30d (operator ruling 2026-08-19: an
 * API-key-style lifetime picker — 24h / 7d / 30d; "never" refused because the 30-day
 * renewal horizon is the deliberate ceiling on any bearer credential). Context from
 * 2026-08-18: the connect-page credential crosses a human — pasted into another
 * machine's chat, often after environment fixes on that side — and the measured cost of
 * a short bootstrap was a sandboxed agent watching its window close while its listener
 * was stuck in "starting" and could not rotate. Rotation successors stay short.
 */
export const AGENT_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/* RETIRED 2026-09-04: this module used to export RENEWAL_HORIZON_DEFAULT_MS, a 30-day mirror
 * of src/cloud/renewal.ts, and add it to the mint's issue time to produce a horizon date.
 *
 * The rationale it carried is still true and now lives where it is enforced: a work session
 * runs for days while a bearer lives at most a day, so the token stays short and rotates
 * rather than becoming a month-long secret on a developer's machine (SWARM-CLOUD.md §2.3).
 * What was false was the DATE. This page never asked the server for that horizon and the
 * server never returned it here; the number was right only while the server's default
 * happened to agree, and the agent's prompt printed it as "rotate it until <date>".
 *
 * The horizon is now read off `horizon_expires_at` in the accepted response, for BOTH grant
 * kinds — see mintedHorizon. A standing grant returns null there
 * (supabase/functions/command/index.ts:8716-8721), so the two facts come from one place. */

/**
 * How this browser's device row is labelled, so a second visit reuses the row rather than
 * registering a new device on every mint. `cswarm-cli` is the CLI's label (src/cloud/auth.ts:360).
 */
export const WEB_DEVICE_LABEL = "cswarm-web";

/**
 * Byte-for-byte the string src/cloud/agent-credential-input.ts requires. The CLI accepts a minted credential on
 * stdin either as a bare `swm_agt_` token or as this JSON artifact, and it validates the
 * artifact by exact key set AND by this exact message. Reproducing it
 * here is what lets a credential minted in a browser be piped into `--agent-token-stdin` with
 * durable command ids instead of ephemeral ones. If the CLI's constant ever changes, this one
 * has to change with it — there is no shared module between site/ and src/.
 */
/* The wording here is a PROTOCOL CONSTANT, not copy. `src/cli.ts` validates it byte-for-byte
 * (`artifact.message !== AGENT_CREDENTIAL_MESSAGE`), so changing this string makes every credential
 * this site mints unreadable by every cswarm already installed.
 *
 * Measured 2026-08-12 against the SHIPPED v0.1.15 binary: the current wording passes the message
 * check and fails later on token format; the proposed replacement is rejected as "agent credential
 * JSON is malformed". Two different errors, so the probe discriminates — the first attempt returned
 * "malformed" for BOTH arms because the fixture had the wrong key set, and identical output from
 * both arms is a broken instrument, not a result.
 *
 * The claim it makes is still wrong and is tracked as D-088: the run binding and attribution are
 * real, the TASK SCOPE IS NOT — `task_id` is generated here (see below) because a person connecting
 * an agent has not picked a work item, nothing restricts the agent to it, and
 * `supabase/functions/_shared/agent-auth.ts` never reads it. Fixing it needs the CLI to accept both
 * spellings first, ship, and only then change this string. Doing it in one step trades a soft false
 * claim for a hard break. */
const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

const COMMAND_TIMEOUT_MS = 30_000;

/** Which step refused, so the UI can say what did and did not happen rather than "error". */
export type ConnectStep = "register-device" | "create-identity" | "mint-credential";

/**
 * A refusal the deployment is entitled to make, rendered as a state rather than a failure the
 * reader could think they caused. 403 on this path is deliberately uniform server-side, so the
 * message names every rule that produces it instead of guessing which one applied.
 */
export class AgentConnectRefused extends Error {
  override name = "AgentConnectRefused";
  constructor(
    readonly step: ConnectStep,
    detail: string,
  ) {
    super(detail);
  }
}

/** The workspace already has an agent identity with this name — including a revoked one. */
export class AgentNameTaken extends Error {
  override name = "AgentNameTaken";
  constructor(readonly agentName: string) {
    super(`This workspace already has an agent identity called “${agentName}”.`);
  }
}

/**
 * The mint was accepted on an earlier attempt and replayed. The server stores only a hash of
 * the credential, so a replay carries the ids and never the secret (src/cli.ts:1218-1222). The
 * only recovery is to mint a fresh one, which is why this is its own type: retrying blindly is
 * how you end up with two live credentials and only one of them written down.
 */
export class CredentialNotShown extends Error {
  override name = "CredentialNotShown";
  constructor(readonly tokenId: string | null) {
    super(
      "This credential was issued on an earlier attempt, and the deployment keeps only its " +
        "hash — so it cannot be shown a second time. Issue a new one.",
    );
  }
}

/** The deployment requires a newer protocol than this page speaks. */
export class ClientTooOld extends Error {
  override name = "ClientTooOld";
  constructor(readonly minimum: string | null) {
    super(
      `This page speaks protocol ${CLIENT_PROTOCOL_VERSION}${
        minimum === null ? "" : `, and the deployment requires at least ${minimum}`
      }. It needs to be rebuilt before it can mint a credential here.`,
    );
  }
}

/**
 * The request left the browser and no outcome came back. Named separately from a refusal
 * because the honest sentence is different: a refusal means nothing happened, this means
 * nobody knows. On the mint step that distinction is the whole point — an automatic retry
 * here is what mints a second live credential.
 */
export class MintOutcomeUnknown extends Error {
  override name = "MintOutcomeUnknown";
  constructor(readonly step: ConnectStep, detail: string) {
    super(detail);
  }
}

interface CommandOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Posts one command with the human's own JWT.
 *
 * NOT reusing commonswarm.ts's postCommand, and the reason is worth stating rather than
 * leaving as a style difference. That function is module-private, it sends no `workspace_id`
 * or `stream` (correct for create_workspace, which is pre-route, and wrong for these three,
 * which are routed), and it sends `client_version: WEB_CLIENT_VERSION` = "0.0.1". The command
 * function compares client_version against swarm.config's min_client_version, which the schema
 * migration seeds to "0.1.0" (supabase/migrations/20260723000001_p1_schema.sql:441), and
 * answers 426 upgrade_required when the client is lower. So "0.0.1" is below the seeded floor.
 * The CLI sends CLIENT_PROTOCOL_VERSION for this field (src/cloud/command-client.ts:505) and
 * so does this file. Measured against the migration in this repo, not against production —
 * a deployment may have raised or lowered that config row and this page cannot see it.
 */
async function postCommand(
  session: Session,
  commandId: string,
  command: Record<string, unknown>,
  routing: Record<string, unknown> = {},
): Promise<CommandOutcome> {
  const d = deployment();
  if (!d) throw new NoDeployment();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${d.url}/functions/v1/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: d.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        ...routing,
        command,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new MintOutcomeUnknown(
      "mint-credential",
      "The request did not reach the deployment, or the answer never came back.",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function refusalDetail(step: ConnectStep): string {
  if (step === "register-device") {
    return (
      "This deployment did not accept this browser as a device. That answer is the same one " +
      "it gives an account whose email address is not confirmed yet, so confirm your email " +
      "with the identity provider you signed in with and try again. Nothing was created."
    );
  }
  if (step === "create-identity") {
    return (
      "This deployment did not create the agent identity. Creating one needs current " +
      "membership of this workspace and a confirmed email address on your account. Nothing " +
      "was created."
    );
  }
  return (
    "This deployment did not issue the credential. Issuing one needs a signed-in person who " +
    "owns this agent identity in this workspace — an agent credential can never mint " +
    "another, by design. Nothing was issued."
  );
}

/** Turns a non-200, or an accepted-but-rejected 200, into the state that matches it. */
function assertAccepted(step: ConnectStep, outcome: CommandOutcome): Record<string, unknown> {
  const { status, body } = outcome;
  if (status === 403) throw new AgentConnectRefused(step, refusalDetail(step));
  if (status === 426) {
    const minimum = typeof body.min_client_version === "string" ? body.min_client_version : null;
    throw new ClientTooOld(minimum);
  }
  if (status === 401) {
    throw new AgentConnectRefused(
      step,
      "Your sign-in is no longer valid for this deployment. Sign in again, then try once more.",
    );
  }
  if (status === 400) {
    /* A validation refusal is decided before anything is written, so this one CAN say
     * "nothing happened" — which the unknown-outcome case below deliberately cannot.
     *
     * NAMES BOTH DIRECTIONS OF SKEW, from 2026-09-04. It used to say only that this page may
     * be OLDER than the deployment. The mint body now carries `renewal_kind`, and a command
     * function that predates that field rejects the whole request on its exact-key check
     * (supabase/functions/command/index.ts:2204-2212) — so the NEWER-page case is the one a
     * reader is most likely to meet, on a site deploy that outran the edge deploy, and the
     * old sentence sent them looking in the opposite direction. */
    throw new AgentConnectRefused(
      step,
      "The deployment did not accept the request. Nothing was created. This page and the " +
        "deployment it is talking to may be different versions.",
    );
  }
  if (status !== 200) {
    throw new MintOutcomeUnknown(
      step,
      `The deployment answered HTTP ${status}, which does not say whether anything was ` +
        `created. Reload this page and look at what already exists before trying again.`,
    );
  }
  if (body.status === "rejected") {
    const reason = typeof body.reason === "string" ? body.reason : "unknown";
    const detail = typeof body.detail === "string" ? body.detail : "";
    if (reason === "principal_name_taken") throw new AgentNameTaken("");
    throw new AgentConnectRefused(
      step,
      detail || `The deployment declined this step (${reason}). Nothing was created.`,
    );
  }
  if (body.status !== "accepted") {
    throw new MintOutcomeUnknown(
      step,
      "The deployment answered without saying whether it accepted the request.",
    );
  }
  return body;
}

/** One agent identity the signed-in person owns in this workspace. */
export interface AgentIdentity {
  principalId: string;
  name: string;
  model: string | null;
}

/**
 * The agent identities this person already owns here, so a second credential does not need a
 * second identity. It matters because an agent token is short-lived: re-minting is the
 * normal case, not the exception, and inventing "claude-2", "claude-3" is what happens without
 * this list. Reads through swarm_read.agent_principals, which applies the membership gate in
 * the database (supabase/migrations/20260723000001_p1_schema.sql:662).
 */
export async function myAgents(session: Session, workspaceId: string): Promise<AgentIdentity[]> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await c
    .schema("swarm_read")
    .from("agent_principals")
    .select("principal_id,name,model,owner_user_id,revoked_at,workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("owner_user_id", session.user.id)
    .is("revoked_at", null)
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    principalId: String(row.principal_id),
    name: String(row.name ?? ""),
    model: row.model === null ? null : String(row.model),
  }));
}

/**
 * The device row this browser mints under, reused across visits.
 *
 * Exported rather than folded into the mint so the caller's progress display can name the
 * three real commands in the order they happen. A mint that silently registered a device
 * inside itself would leave a UI claiming step 3 was running while step 1 was still in flight.
 *
 * A device id is an identifier, not a credential — it authorises nothing on its own, and the
 * server checks its ownership on every mint. It is still not written to localStorage here:
 * swarm_read.my_devices already answers "which of my devices are live", so the row itself is
 * the store and there is no second copy to go stale, leak into a backup, or survive a sign-out
 * into somebody else's session on a shared machine.
 */
export async function ensureBrowserDevice(session: Session): Promise<string> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await c
    .schema("swarm_read")
    .from("my_devices")
    .select("device_id,label,revoked_at")
    .eq("label", WEB_DEVICE_LABEL)
    .is("revoked_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  const existing = data?.[0];
  if (existing?.device_id) return String(existing.device_id);

  const deviceId = uuid();
  const outcome = await postCommand(session, `web_${uuid()}`, {
    kind: "register_device",
    device_id: deviceId,
    label: WEB_DEVICE_LABEL,
  });
  const body = assertAccepted("register-device", outcome);
  if (body.device_id !== deviceId) {
    throw new MintOutcomeUnknown(
      "register-device",
      "The deployment accepted a device registration for a different device than the one asked for.",
    );
  }
  return deviceId;
}

/**
 * Creates the agent identity. Separate from the mint because they are separate commands with
 * separate refusals, and because a name collision must not cost the caller a credential.
 *
 * `commandId` is generated by the CALLER, once per intent, and reused across retries — the
 * server replays the original outcome for a repeated id instead of acting twice.
 */
export async function createAgentIdentity(
  session: Session,
  commandId: string,
  workspaceId: string,
  name: string,
  model?: string,
): Promise<AgentIdentity> {
  const command = model === undefined
    ? { kind: "create_agent_principal" as const, name }
    : { kind: "create_agent_principal" as const, name, model };
  const outcome = await postCommand(
    session,
    commandId,
    command,
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  let body: Record<string, unknown>;
  try {
    body = assertAccepted("create-identity", outcome);
  } catch (error) {
    if (error instanceof AgentNameTaken) throw new AgentNameTaken(name);
    throw error;
  }
  const principalId = typeof body.principal_id === "string" ? body.principal_id : "";
  if (!principalId) {
    throw new MintOutcomeUnknown(
      "create-identity",
      "The deployment accepted the agent identity without naming it, so this page cannot mint against it.",
    );
  }
  return { principalId, name, model: model ?? null };
}

/** A live credential. It is shown once, by definition, and is never persisted anywhere. */
export interface AgentCredential {
  principalId: string;
  principalName: string;
  tokenId: string;
  runId: string;
  /** The secret. Read it once, put it on screen, do not keep it. */
  token: string;
  /** Milliseconds since the epoch, read off the AgentTokenMinted event; null if absent. */
  expiresAt: number | null;
  /** Whether the returned expiry lets the agent schedule renewal against its atomic grant. */
  renews: boolean;
  /** When the person is next asked to authorise. Null when there is no window. */
  horizonExpiresAt: number | null;
  /**
   * The grant kind the server actually created, read off its response rather
   * than assumed from what this page asked for. Null when the deployment did
   * not say — an older command function that ignored `renewal_kind` answers
   * that way, and callers must not print "does not expire" on a guess.
   */
  grantKind: "timeboxed" | "standing" | null;
}

/**
 * Mints one credential.
 *
 * THE RUN AND WORK-ITEM IDS ARE GENERATED HERE, and it is worth being exact about what that
 * does and does not mean. §3.4 binds every agent token to a run and a work item, and the
 * command function requires both as UUIDs. A person connecting their agent for the first time
 * has not picked a work item, so this generates the pair: the run id becomes a real
 * swarm.agent_runs row keyed to this browser's device, and the task id is recorded on the
 * token. swarm.agent_tokens.task_id carries no foreign key
 * (supabase/migrations/20260723000001_p1_schema.sql:196), so a generated id is accepted rather
 * than dangling. What this page did NOT establish is how that binding behaves for the lease
 * verbs — the only authorisation check on an agent credential that was read while writing this
 * is the scope check at supabase/functions/command/index.ts:7297-7302, which is what
 * `post_signal` needs.
 *
 * NO AUTOMATIC RETRY. The CLI's comment on command ids records what a blind retry cost once:
 * a fresh id on a 5xx minted a second live credential. So a failure here is reported, and
 * re-minting is a decision the person makes.
 */
export async function mintAgentCredential(
  session: Session,
  commandId: string,
  workspaceId: string,
  identity: AgentIdentity,
  deviceId: string,
  ttlMs: number = AGENT_TOKEN_DEFAULT_TTL_MS,
): Promise<AgentCredential> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > AGENT_TOKEN_MAX_TTL_MS) {
    throw new Error(
      `A credential may last at most ${AGENT_TOKEN_MAX_TTL_MS / 86_400_000} days.`,
    );
  }
  const runId = uuid();
  const outcome = await postCommand(
    session,
    commandId,
    {
      kind: "mint_agent_token",
      principal_id: identity.principalId,
      run_id: runId,
      task_id: uuid(),
      epoch: 0,
      device_id: deviceId,
      ttl_ms: ttlMs,
      /* ★ THE WEB FLOW ASKS FOR A STANDING GRANT, AND SAYING SO IS THE WHOLE FIX.
       *
       * The command function defaults an ABSENT renewal_kind to "timeboxed"
       * (supabase/functions/command/index.ts, prepareWorkspaceCommand), which is
       * why every agent added through this page used to stop working after 30
       * days: nobody chose that, it was the shape of the omission. The default a
       * person gets when they add an agent is now that it does not expire
       * (operator ruling 2026-09-04).
       *
       * IT IS SENT EXPLICITLY RATHER THAN BY FLIPPING THE SERVER DEFAULT. The
       * server default is also what `cswarm token mint` gets when it passes no
       * flag, and the CLI deliberately keeps standing behind --standing
       * --confirm-standing. Changing the default in one place would have moved
       * both, silently promoting every scripted mint in the field.
       *
       * DEVICE BINDING COMES WITH IT AND IS NOT OPTIONAL: for a standing mint the
       * command function stores bound_device_id = this request's device_id, so the
       * grant binds to the browser device registered above, and swarm.agent_runs
       * pins that same device on the run the agent inherits. */
      renewal_kind: "standing",
    },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  const body = assertAccepted("mint-credential", outcome);

  const tokenId = typeof body.token_id === "string" ? body.token_id : null;
  const token = typeof body.agent_token === "string" ? body.agent_token : "";
  if (!token) throw new CredentialNotShown(tokenId);
  const mintedRunId = typeof body.run_id === "string" ? body.run_id : "";
  if (!tokenId || !mintedRunId) {
    throw new MintOutcomeUnknown(
      "mint-credential",
      "A credential was issued but the deployment did not name its run or token, so this " +
      "page cannot hand your agent a complete artifact. Ask an owner to revoke it.",
    );
  }
  const times = mintedTimes(body);
  const renews = mintedRunId === runId && times.expiresAt !== null;
  /* MEASURED, NOT ASSUMED. This page asked for standing; what it reports is what
   * the mint said it created. A deployment whose command function predates
   * renewal_kind accepts the field, ignores it, and builds a timeboxed grant —
   * and then "does not expire" on screen would be a sentence about a request
   * rather than about the agent. Unknown reads as null and the horizon copy
   * below falls back to the timeboxed wording. */
  const grantKind = body.grant_kind === "standing" ||
      body.grant_kind === "timeboxed"
    ? body.grant_kind
    : null;
  return {
    principalId: identity.principalId,
    principalName: identity.name,
    tokenId,
    runId: mintedRunId,
    token,
    expiresAt: times.expiresAt,
    // Mint and grant are one server transaction. The returned expiry is the
    // remaining client-side condition because it is what lets the CLI schedule renewal.
    renews,
    grantKind,
    horizonExpiresAt: mintedHorizon(body),
  };
}

/**
 * When the person is next asked to reauthorise — MEASURED, for both grant kinds.
 *
 * A standing grant HAS no horizon, so there is no such date, and reporting one anyway is how
 * the prompt came to tell agents "the CLI can rotate it until <date>" about a grant with no
 * such date. But deriving null from the KIND only moved the invention: a timeboxed grant kept
 * a locally computed `issuedAt + 30 days`, which is a fabricated deadline whenever the server
 * used any other horizon. One field answers both cases, so the two can never disagree.
 *
 * `horizon_expires_at` is returned unconditionally on an accepted mint
 * (supabase/functions/command/index.ts:8716-8721) — an ISO string for timeboxed, null for
 * standing — and the idempotent replay path carries it through (index.ts:2421-2427).
 *
 * ABSENT READS AS UNKNOWN, NOT AS A GUESS. A deployment old enough to omit the field answers
 * null here, and `grantKind` reads null beside it; agent-prompt.ts then uses its wording for a
 * credential with no stated horizon, which is the honest sentence. That is the same
 * degrade-rather-than-assume rule the grantKind read above follows, and the reason this does
 * not throw.
 */
function mintedHorizon(body: Record<string, unknown>): number | null {
  const raw = body.horizon_expires_at;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mint times come off AgentTokenMinted; the response body has no top-level times. */
function mintedTimes(
  body: Record<string, unknown>,
): { issuedAt: number | null; expiresAt: number | null } {
  const events = Array.isArray(body.events) ? body.events : [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "AgentTokenMinted") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const issued = payload?.issued_at;
    const expires = payload?.expires_at;
    return {
      issuedAt: typeof issued === "number" && Number.isFinite(issued) ? issued : null,
      expiresAt: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
    };
  }
  return { issuedAt: null, expiresAt: null };
}

/**
 * The credential in the exact JSON shape `cswarm --agent-token-stdin` validates in
 * src/cloud/agent-credential-input.ts. One line, because the agent is going to pipe it, and a pretty-printed
 * secret is a secret that gets truncated when somebody copies half of it.
 */
export function credentialArtifact(credential: AgentCredential): string {
  return JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE,
    status: "accepted",
    principal_id: credential.principalId,
    token_id: credential.tokenId,
    run_id: credential.runId,
    agent_token: credential.token,
    // `expires_at` is what lets the agent's CLI renew this credential ON TIME rather than
    // eagerly on first use or late on a 401. It is omitted when the mint did not state one,
    // because the CLI accepts both shapes and a fabricated deadline would be worse than
    // none: it would schedule a renewal against a number nobody measured.
    ...(credential.expiresAt === null
      ? {}
      : { expires_at: new Date(credential.expiresAt).toISOString() }),
  });
}
