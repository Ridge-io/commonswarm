/*
 * The browser client. This file is the whole of the web app's contact with the backend.
 *
 * WHY THIS EXISTS AT ALL. Until now the only way into CommonSwarm was `cswarm login` in a
 * terminal, and the web surface was a static picture of a product. The operator's decision
 * is that the web UI is the PRIMARY onboarding path for both humans and agents — a human
 * signs in here, gets a workspace, and hands their agent a credential — with the CLI
 * becoming what agents run rather than what humans install.
 *
 * STATIC OUTPUT IS NOT A BLOCKER, WHICH IS THE NON-OBVIOUS PART. astro.config.mjs sets
 * `output: "static"` and that stays. Supabase Auth, PostgREST and the edge functions are all
 * callable from the browser with an anon key and a user JWT, so the entire app runs
 * client-side against the same API the CLI uses. No SSR, no adapter, no server to operate,
 * and the deploy remains a folder of files on a CDN.
 *
 * THE ANON KEY IS NOT A SECRET. It is a public identifier that says which project to talk
 * to; every Supabase browser app ships one. Authorisation is the user's JWT plus row-level
 * security plus the edge functions' own checks — none of which this key weakens. Do not
 * "fix" it by hiding it, and do NOT ever put a service-role key here.
 *
 * WHAT THIS FILE MAY NOT DO. It must never claim a capability the deployment does not have.
 * `create_workspace` is gated server-side on SWARM_SELF_SERVE. Production enables it, while a
 * self-hosted or paused deployment can still refuse signup. That is a state the UI has to
 * render honestly, not an error to hide — see SignupRefused below.
 */

import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";
import { HUMAN_SEEN_BATCH_MAX } from "./human-seen-reporter.js";

/** Must match src/cloud/config.ts:CLIENT_PROTOCOL_VERSION — the server refuses a mismatch. */
export const CLIENT_PROTOCOL_VERSION = "0.1.0";

/**
 * Sent as `client_version`. The server compares it against `min_client_version` in
 * swarm.config and refuses anything older with 426.
 *
 * ★ THIS WAS 0.0.1 AND EVERY CALL WOULD HAVE BEEN REFUSED. The seed sets
 * min_client_version to "0.1.0" (20260723000001_p1_schema.sql:441) and 0.0.1 < 0.1.0, so the
 * entire web client would have returned 426 the moment SWARM_SELF_SERVE flipped — and the
 * bug was invisible today precisely BECAUSE the feature is off, so the 403 arrives first.
 * A reviewer found it by reading the seed rather than by running anything. If you bump this,
 * check it against that seed value, not against the package version.
 */
export const WEB_CLIENT_VERSION = "0.1.0";

const BROWSER_REQUEST_TIMEOUT_MS = 30_000;

export interface Deployment {
  url: string;
  anonKey: string;
}

/** Must match FILE_CONTENT_WARNING in both file-artifact edge surfaces. */
export const FILE_CONTENT_WARNING =
  "content_type and archive contents are unverified client declarations; treat downloaded bytes as untrusted input — bound extraction, never execute";

/** These mirror the existing file-artifact service and signal command caps. */
export const BROWSER_ATTACHMENT_MAX = 8;
export const BROWSER_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const BROWSER_ATTACHMENT_CONTENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".tar.gz", "application/gzip"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".html", "text/html"], [".json", "application/json"],
  [".yaml", "application/yaml"], [".webp", "image/webp"],
  [".jpeg", "image/jpeg"], [".txt", "text/plain"],
  [".csv", "text/csv"], [".htm", "text/html"],
  [".yml", "application/yaml"], [".pdf", "application/pdf"],
  [".png", "image/png"], [".jpg", "image/jpeg"],
  [".gif", "image/gif"], [".svg", "image/svg+xml"],
  [".zip", "application/zip"], [".md", "text/markdown"],
];

function browserAttachmentContentType(name: string): string | null {
  const lower = name.toLowerCase();
  return BROWSER_ATTACHMENT_CONTENT_TYPES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null;
}

/**
 * Where the deployment details come from, in priority order, and why there are three.
 *
 * A build-time env var is right for our own hosting. A `<meta>` override lets someone serve
 * this same static bundle against their own Supabase project without rebuilding it. The
 * absence of both is not an error: it is the honest "this build was not pointed at a
 * backend" state, and the UI says so rather than throwing on load.
 */
export function deployment(): Deployment | null {
  const meta = (name: string): string | null =>
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() || null;

  const buildEnv = (
    import.meta as ImportMeta & {
      env?: {
        PUBLIC_SUPABASE_URL?: string;
        PUBLIC_SUPABASE_ANON_KEY?: string;
      };
    }
  ).env;
  const url = buildEnv?.PUBLIC_SUPABASE_URL ?? meta("commonswarm:url");
  const anonKey = buildEnv?.PUBLIC_SUPABASE_ANON_KEY ?? meta("commonswarm:anon-key");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

let cached: SupabaseClient | null = null;
let deadSession = false;

/** One client per page. Returns null when the build has no backend configured. */
export function client(): SupabaseClient | null {
  if (cached) return cached;
  const d = deployment();
  if (!d) return null;
  cached = createClient(d.url, d.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}

/** Signals that the saved login no longer names a server-side session. */
export class SessionExpired extends Error {
  override name = "SessionExpired";
  constructor() {
    super("Your session expired — sign in again.");
  }
}

async function clearDeadSession(c: SupabaseClient): Promise<void> {
  deadSession = true;
  await c.auth.signOut({ scope: "local" });
}

export async function currentSession(): Promise<Session | null> {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  const session = data.session ?? null;
  if (!session) {
    if (deadSession) throw new SessionExpired();
    return null;
  }
  const { data: userData, error } = await c.auth.getUser();
  if (error || !userData.user || userData.user.id !== session.user.id) {
    await clearDeadSession(c);
    throw new SessionExpired();
  }
  deadSession = false;
  return session;
}

/**
 * GitHub matches the CLI (src/cloud/auth.ts sets provider=github), so the two surfaces
 * resolve the same account for the same person. See signInWithEmail below for the door that
 * does not require a developer account at all.
 */
export async function signInWithGitHub(redirectTo: string): Promise<void> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { error } = await c.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo },
  });
  if (error) throw new Error(error.message);
}

/**
 * Too many links asked for too quickly — the address is fine, the pace is not.
 *
 * ★ TODAY THIS IS ALMOST ALWAYS OUR FAULT RATHER THAN THE CALLER'S. With no custom SMTP
 * configured, the built-in sender permits 2 emails per hour for the ENTIRE PROJECT, and the
 * Management API refuses to raise the limit without SMTP credentials. A first-time visitor
 * can therefore be rate limited by somebody else's signup. Whatever message is shown for this
 * must not imply the user did anything, and must offer the other door.
 */
export class EmailRateLimited extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "EmailRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The address was refused as unroutable or malformed before anything was sent. */
export class EmailAddressRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailAddressRejected";
  }
}

/**
 * Sign in with a link sent to an email address — no password, no developer account.
 *
 * WHY THIS EXISTS ALONGSIDE GITHUB. CommonSwarm is a product about agents talking to each
 * other, and requiring a GitHub account to use one excludes exactly the people the consumer
 * shape is for. GitHub stays because it is what the CLI uses and it is one press for the
 * people who have it; this is the door for everyone else.
 *
 * ONE CALL, TWO MEANINGS, AND THAT IS THE POINT. `signInWithOtp` creates the user if the
 * address is new and signs them in if it is not, so the page never has to ask "do you already
 * have an account?" — a question a first-time visitor cannot answer and should not be asked.
 * `shouldCreateUser` is left at its default of true deliberately: passing false makes an
 * unknown address fail with `otp_disabled` / "Signups not allowed for otp", which reads like
 * the FEATURE is off rather than like the user is new. That exact response sent one
 * investigation down the wrong path.
 *
 * NO ENUMERATION SIGNAL. Whether the address was already registered is never returned, and
 * the caller must not infer it: the response is the same either way, which is what stops this
 * form becoming a way to test which addresses have accounts.
 *
 * `emailRedirectTo` must be inside the project's redirect allow-list or GoTrue silently sends
 * the user to the project's Site URL instead. Both were pointed at localhost in production
 * until 2026-07-28, which broke the RETURN leg of every sign-in while the outbound redirect
 * looked perfect.
 */
export async function signInWithEmail(
  email: string,
  redirectTo: string,
): Promise<void> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { error } = await c.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });
  if (!error) return;
  const status = (error as { status?: number }).status ?? 0;
  const code = (error as { code?: string }).code ?? "";
  if (status === 429 || code === "over_email_send_rate_limit") {
    throw new EmailRateLimited(error.message);
  }
  if (status === 400 || status === 422) {
    throw new EmailAddressRejected(error.message);
  }
  throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  deadSession = false;
  await client()?.auth.signOut();
}

export class NoDeployment extends Error {
  override name = "NoDeployment";
  constructor() {
    super("This build is not pointed at a CommonSwarm deployment.");
  }
}

/**
 * This deployment refused signup. A distinct type rather than a generic error because the UI
 * must render it as a deployment state, never as a failure the reader could mistake for
 * something they did wrong. A self-host can produce this by leaving SWARM_SELF_SERVE unset;
 * production enables self-serve but can still pause signup at its usage ceiling.
 */
export class SignupRefused extends Error {
  override name = "SignupRefused";
  constructor(readonly detail: string) {
    super(detail);
  }
}

/**
 * Their email is not confirmed yet. A FIXABLE state, not a wall — the UI must offer the fix
 * (confirm the address, then retry) rather than reporting a refusal. This is the difference
 * between a thirty-second detour and someone deciding the product is broken and leaving.
 */
export class EmailNotVerified extends Error {
  override name = "EmailNotVerified";
  constructor() {
    super("Confirm your email address, then try again.");
  }
}

/** This build predates the deployment's minimum client version. Nothing was created. */
export class ClientTooOld extends Error {
  override name = "ClientTooOld";
  constructor(readonly minimum: string) {
    super(
      `This page is older than the deployment accepts (it wants ${minimum}). ` +
        `Reload to pick up the current version — nothing was created.`,
    );
  }
}

/** A disposable-inbox domain. Also fixable: sign in with a different address. */
export class EmailDomainNotAccepted extends Error {
  override name = "EmailDomainNotAccepted";
  constructor() {
    super("That email provider isn't accepted. Use a different address.");
  }
}

/** The free-tier ceiling, refused server-side at 10 live workspaces per verified identity. */
export class WorkspaceLimitReached extends Error {
  override name = "WorkspaceLimitReached";
  constructor(readonly limit: number) {
    super(`You already have ${limit} workspaces, which is the limit for one account.`);
  }
}

/**
 * A create request crossed the network, but its durable outcome did not come back.
 *
 * Unlike a read timeout, retry is not automatically safe with a newly-minted intent: the
 * first command may already have committed. The signup page displays this sentence verbatim.
 */
export class WorkspaceOutcomeUnknown extends Error {
  override name = "WorkspaceOutcomeUnknown";
  constructor(detail: string) {
    super(detail);
  }
}

/** A non-workspace mutation crossed the network but its durable outcome did not return. */
export class CommandOutcomeUnknown extends Error {
  override name = "CommandOutcomeUnknown";
}

/** A read stopped at the application deadline. Reads change nothing and are safe to retry. */
export class BrowserReadTimedOut extends Error {
  override name = "BrowserReadTimedOut";
  constructor(readonly operation: string) {
    super(
      `CommonSwarm stopped waiting for ${operation} after 30 seconds. ` +
        "Nothing changed; try again.",
    );
  }
}

interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

export class FreshLoginRequired extends Error {
  constructor(
    message = "Sign in again, then press Remove once more. CommonSwarm did not remove anyone.",
  ) {
    super(message);
    this.name = "FreshLoginRequired";
  }
}

interface RequestDeadline {
  controller: AbortController;
  clear(): void;
}

/** One bounded timer per request, always cleared when that request settles. */
function requestDeadline(): RequestDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSER_REQUEST_TIMEOUT_MS);
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

async function readWithDeadline<T>(
  operation: string,
  request: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const deadline = requestDeadline();
  try {
    const result = await request(deadline.controller.signal);
    if (deadline.controller.signal.aborted) {
      throw new BrowserReadTimedOut(operation);
    }
    return result;
  } catch (error) {
    if (deadline.controller.signal.aborted) {
      throw new BrowserReadTimedOut(operation);
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

/**
 * Posts to the command edge function with the caller's own JWT.
 *
 * `command_id` is a client-generated idempotency key: if the network fails and the caller
 * retries with the SAME id, the server replays the original outcome instead of performing
 * the action twice. The CLI learned this the hard way — a 5xx retry that generated a fresh
 * id once minted a second live credential — so the id is generated ONCE per intent by the
 * caller and reused across retries, never regenerated inside this function.
 */
async function postCommand(
  session: Session,
  commandId: string,
  command: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  unknownOutcome?: string,
): Promise<CommandResult> {
  const d = deployment();
  if (!d) throw new NoDeployment();

  const deadline = requestDeadline();
  try {
    const response = await fetch(`${d.url}/functions/v1/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: d.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command_id: commandId,
        client_version: WEB_CLIENT_VERSION,
        command,
        ...extra,
      }),
      signal: deadline.controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { error: "unreadable_response" };
    }
    if (response.status === 401 && body.error === "unauthenticated") {
      const c = client();
      if (c) await clearDeadSession(c);
      throw new SessionExpired();
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof SessionExpired) throw error;
    if (unknownOutcome) throw new CommandOutcomeUnknown(unknownOutcome);
    if (deadline.controller.signal.aborted) {
      throw new WorkspaceOutcomeUnknown(
        "CommonSwarm stopped waiting after 30 seconds, so it cannot tell whether the " +
          "workspace was created. Reload before trying again — retrying with a new request " +
          "could create a second one.",
      );
    }
    throw new WorkspaceOutcomeUnknown(
      "CommonSwarm lost contact before it could read the result, so it cannot tell whether " +
        "the workspace was created. Reload before trying again — retrying with a new request " +
        "could create a second one.",
    );
  } finally {
    deadline.clear();
  }
}

export interface CreatedMemberInvite {
  invitationId: string;
  invitationToken: string;
  workspaceId: string;
  workspaceName: string;
  inviterDisplayName: string;
  inviterUserId: string | null;
}

/** Keeps invite input failures distinct from authentication failures. */
export function inviteEmailValidationMessage(email: string): string | null {
  const value = email.trim();
  if (!value) return "Enter the teammate’s email first.";
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
    return "Enter a valid email address for your teammate.";
  }
  return null;
}

/** Creates one fresh, one-use teammate invitation; its token exists only in this response. */
export async function inviteWorkspaceMember(
  session: Session,
  commandId: string,
  workspaceId: string,
  email: string,
): Promise<CreatedMemberInvite> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "invite_member", email, ttl_ms: 7 * 24 * 60 * 60 * 1_000 },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the invitation result. Check Pending access before creating another link.",
  );
  if (status === 401 && body.error === "fresh_auth_required") {
    throw new FreshLoginRequired(
      "Sign in again, then create the invitation once more. CommonSwarm did not create a link.",
    );
  }
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      status === 403
        ? "Only a workspace Owner or Admin can invite a teammate."
        : `CommonSwarm did not create the invitation (${String(body.reason ?? body.error ?? status)}).`,
    );
  }
  const invitationId = String(body.invitation_id ?? "");
  const invitationToken = String(body.invitation_token ?? "");
  if (!invitationId || !invitationToken) {
    throw new CommandOutcomeUnknown(
      "CommonSwarm accepted the invitation without returning its one-use link. Check Pending access.",
    );
  }
  return {
    invitationId,
    invitationToken,
    workspaceId: String(body.workspace_id ?? workspaceId),
    workspaceName: String(body.workspace_name ?? ""),
    inviterDisplayName: String(body.inviter_display_name ?? "A teammate"),
    inviterUserId: typeof body.inviter_user_id === "string" ? body.inviter_user_id : null,
  };
}

export interface AcceptedMemberInvite {
  workspaceId: string;
  workspaceName: string;
}

/** Consumes one invitation capability and joins the authenticated person to its workspace. */
export async function acceptWorkspaceInvitation(
  session: Session,
  commandId: string,
  token: string,
): Promise<AcceptedMemberInvite> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "accept_invitation", token },
    {},
    "CommonSwarm lost the join result. Reload this invitation before trying again.",
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      status === 403
        ? "This invitation is no longer usable. Ask the sender for a new link."
        : `CommonSwarm could not join this workspace (${String(body.reason ?? body.error ?? status)}).`,
    );
  }
  return {
    workspaceId: String(body.workspace_id ?? ""),
    workspaceName: String(body.workspace_name ?? ""),
  };
}

/** Cancels a pending teammate invitation by id; the raw invitation is not required. */
export async function revokeWorkspaceInvitation(
  session: Session,
  commandId: string,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "revoke_invitation", invitation_id: invitationId },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the cancellation result. Refresh Pending access before trying again.",
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      `Invitation cancellation was refused: ${String(body.reason ?? body.error ?? status)}.`,
    );
  }
}

/** Cancels one pending agent credential without removing its agent identity. */
export async function revokeAgentToken(
  session: Session,
  commandId: string,
  workspaceId: string,
  tokenId: string,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "revoke_agent_token", token_id: tokenId },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the cancellation result. Refresh Pending access before trying again.",
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      `Agent access cancellation was refused: ${String(body.reason ?? body.error ?? status)}.`,
    );
  }
}

export interface PendingMemberInvite {
  workspaceId: string;
  invitationId: string;
  email: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/** Live teammate invitations visible to workspace Owners and Admins. */
export async function pendingMemberInvites(workspaceId: string): Promise<PendingMemberInvite[]> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await readWithDeadline(
    "pending teammate invitations",
    (signal) =>
      c
        .schema("swarm_read")
        .from("pending_invitations")
        .select("workspace_id,invitation_id,email,created_by,created_at,expires_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(50)
        .abortSignal(signal),
  );
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    workspaceId: String(row.workspace_id),
    invitationId: String(row.invitation_id),
    email: String(row.email ?? "Teammate"),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  }));
}

export interface AgentAccessStatus {
  workspaceId: string;
  principalId: string;
  ownerUserId: string;
  agentName: string;
  model: string | null;
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
  firstUsedAt: string | null;
  revokedAt: string | null;
  grantId: string;
  grantKind: "timeboxed" | "standing";
  horizonExpiresAt: string | null;
  boundDeviceId: string | null;
  lastUsedAt: string | null;
  lastUsedDeviceId: string | null;
  lastUsedFrom: string | null;
  newHostAt: string | null;
  suspendedAt: string | null;
  grantRevokedAt: string | null;
}

/** Member-scoped grant status through the read edge; no direct table query. */
export async function agentAccessStatuses(
  workspaceId: string,
  tokenId?: string,
): Promise<AgentAccessStatus[]> {
  const d = deployment();
  if (!d) throw new NoDeployment();
  const session = await currentSession();
  if (!session) throw new SessionExpired();
  const deadline = requestDeadline();
  try {
    const response = await fetch(`${d.url}/functions/v1/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: d.anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resource: "renewal_grants",
        workspace_id: workspaceId,
      }),
      signal: deadline.controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Grant status read failed (${response.status}).`);
    }
    const body = await response.json() as { grants?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.grants)) {
      throw new Error("Grant status read returned malformed data.");
    }
    return body.grants
      .map((row): AgentAccessStatus => ({
        workspaceId,
        principalId: String(row.principal_id),
        ownerUserId: String(row.owner_user_id),
        agentName: String(row.agent_name),
        model: row.model === null ? null : String(row.model),
        tokenId: String(row.token_id),
        issuedAt: String(row.issued_at),
        expiresAt: String(row.token_expires_at),
        firstUsedAt: row.first_used_at === null ? null : String(row.first_used_at),
        revokedAt: row.token_revoked_at === null ? null : String(row.token_revoked_at),
        grantId: String(row.renewal_grant_id),
        grantKind: row.kind === "standing" ? "standing" : "timeboxed",
        horizonExpiresAt: row.horizon_expires_at === null
          ? null
          : String(row.horizon_expires_at),
        boundDeviceId: row.bound_device_id === null ? null : String(row.bound_device_id),
        lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
        lastUsedDeviceId: row.last_used_device_id === null
          ? null
          : String(row.last_used_device_id),
        lastUsedFrom: row.last_used_from === null ? null : String(row.last_used_from),
        newHostAt: row.new_host_at === null ? null : String(row.new_host_at),
        suspendedAt: row.suspended_at === null ? null : String(row.suspended_at),
        grantRevokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      }))
      .filter((row) => tokenId === undefined || row.tokenId === tokenId);
  } finally {
    deadline.clear();
  }
}

export async function removeWorkspaceMember(
  session: Session,
  commandId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "remove_member", user_id: userId },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status === 401 && body.error === "fresh_auth_required") {
    throw new FreshLoginRequired();
  }
  if (status === 403) {
    throw new Error(
      "Your current project role cannot remove this member. CommonSwarm did not change access.",
    );
  }
  if (status !== 200) {
    throw new Error(
      `Member removal failed (HTTP ${status}). CommonSwarm did not confirm a change.`,
    );
  }
  if (body.status !== "accepted") {
    if (body.reason === "landing_authority_unresolved") {
      throw new Error(
        "Transfer this member's repository landing authority with the separate audited transfer command, then try again.",
      );
    }
    if (body.reason === "last_owner") {
      throw new Error("Promote another Owner before removing the last Owner.");
    }
    throw new Error(
      `Member removal was refused: ${String(body.reason ?? "required condition not met")}.`,
    );
  }
}

/** Closes a workspace through the human session; the server keeps it restorable. */
export async function archiveWorkspace(
  session: Session,
  commandId: string,
  workspaceId: string,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "archive_workspace" },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status === 403) {
    throw new Error(
      "CommonSwarm could not close this workspace. Your credential may not own it, or the workspace may no longer be available. Nothing changed.",
    );
  }
  if (status !== 200) {
    throw new Error(
      `Workspace close failed (HTTP ${status}). CommonSwarm did not confirm a change.`,
    );
  }
  if (body.status !== "accepted") {
    throw new Error(
      `Workspace close was refused: ${String(body.reason ?? "required condition not met")}. The workspace is still open.`,
    );
  }
}

/**
 * Ends an agent identity in this workspace: the principal and every live credential.
 * Browser surface is principal-only — there is no per-token UI.
 */
export async function revokeAgentPrincipal(
  session: Session,
  commandId: string,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "revoke_agent_principal", principal_id: principalId },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status === 403) {
    throw new Error(
      "Your current project role cannot remove this agent. CommonSwarm did not change anything.",
    );
  }
  if (status !== 200) {
    throw new Error(
      `Agent removal failed (HTTP ${status}). CommonSwarm did not confirm a change.`,
    );
  }
  if (body.status !== "accepted") {
    throw new Error(
      `Agent removal was refused: ${String(body.reason ?? "required condition not met")}. The identity and credentials are unchanged.`,
    );
  }
}

/**
 * Human relabeling of an agent's model identity (the mirror of the agent's own
 * declare_agent_model). Empty or whitespace clears — the server normalizes to
 * null and the rail shows the neutral glyph. Same gate as removal: owner/admin
 * any agent, member their own.
 */
export async function setAgentModel(
  session: Session,
  commandId: string,
  workspaceId: string,
  principalId: string,
  model: string | null,
): Promise<void> {
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "set_agent_model", principal_id: principalId, model },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status === 403) {
    throw new Error(
      "Your current project role cannot change this agent's model. CommonSwarm did not change anything.",
    );
  }
  if (status === 429) {
    throw new Error(
      "Model changes are limited to a few per hour. Nothing was changed; try again later.",
    );
  }
  if (status !== 200) {
    throw new Error(
      `Model change failed (HTTP ${status}). CommonSwarm did not confirm a change.`,
    );
  }
  if (body.status !== "accepted") {
    throw new Error(
      `Model change was refused: ${String(body.reason ?? "required condition not met")}. The agent is unchanged.`,
    );
  }
}

export interface WorkspaceFile {
  fileId: string;
  name: string;
  currentVersion: number;
  sizeBytes: number;
  uploadedByKind: "user" | "agent";
  uploadedBy: string;
  committedAt: string;
  tombstonedAt: string | null;
}

/** Lists every unpurged workspace file through the membership-gated read view. */
export async function workspaceFiles(workspaceId: string): Promise<WorkspaceFile[]> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await readWithDeadline(
    "workspace files",
    (signal) =>
      c
        .schema("swarm_read")
        .from("files")
        .select(
          "file_id,name,current_version,size_bytes,uploaded_by_kind,uploaded_by,committed_at,tombstoned_at",
        )
        .eq("workspace_id", workspaceId)
        .gt("current_version", 0)
        .order("name", { ascending: true })
        .limit(500)
        .abortSignal(signal),
  );
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => ({
      fileId: String(row.file_id ?? ""),
      name: String(row.name ?? ""),
      currentVersion: Number(row.current_version ?? 0),
      sizeBytes: Number(row.size_bytes ?? 0),
      uploadedByKind: row.uploaded_by_kind === "agent" ? "agent" as const : "user" as const,
      uploadedBy: String(row.uploaded_by ?? ""),
      committedAt: String(row.committed_at ?? ""),
      tombstonedAt: row.tombstoned_at === null || row.tombstoned_at === undefined
        ? null
        : String(row.tombstoned_at),
    }))
    .filter((file) =>
      file.fileId.length > 0 &&
      file.name.length > 0 &&
      file.currentVersion >= 1 &&
      Number.isFinite(file.sizeBytes) &&
      file.committedAt.length > 0
    );
}

export interface FileDownload {
  url: string;
  contentWarning: string;
}

export interface BrowserSignalAttachmentRef {
  file_id: string;
  version_n: number;
}

export interface BrowserSignalAttachment extends BrowserSignalAttachmentRef {
  name: string;
  content_type: string;
  size_bytes: number;
}

interface BrowserFileCreateResult {
  fileId: string;
  versionId: string;
  versionN: number;
  uploadPath: string;
}

/** One staged browser File plus stable ids retained across a send retry. */
export interface BrowserAttachmentUploadIntent {
  file: File;
  name: string;
  contentType: string;
  fileId: string;
  versionId: string;
  createCommandId: string;
  commitCommandId: string;
  created?: BrowserFileCreateResult;
  uploaded?: true;
  committed?: BrowserSignalAttachmentRef;
}

/** Validates a whole staged batch before any file command or storage PUT starts. */
export function prepareBrowserAttachments(
  files: readonly File[],
  existingCount = 0,
): BrowserAttachmentUploadIntent[] {
  if (existingCount + files.length > BROWSER_ATTACHMENT_MAX) {
    throw new Error(`You can attach up to ${BROWSER_ATTACHMENT_MAX} files to one message.`);
  }
  return files.map((file) => {
    if (file.size < 1) throw new Error(`${file.name || "This file"} is empty.`);
    if (file.size > BROWSER_ATTACHMENT_MAX_BYTES) {
      throw new Error(`${file.name || "This file"} is larger than the 25 MB file limit.`);
    }
    if (file.name.length < 1 || file.name.length > 255) {
      throw new Error("Each attached file needs a name of 1 to 255 characters.");
    }
    const contentType = browserAttachmentContentType(file.name);
    if (contentType === null) {
      throw new Error(`${file.name} does not use a file type this workspace accepts.`);
    }
    return {
      file,
      name: file.name,
      contentType,
      fileId: uuid(),
      versionId: uuid(),
      createCommandId: uuid(),
      commitCommandId: uuid(),
    };
  });
}

function browserFileRefusal(
  status: number,
  body: Record<string, unknown>,
  fallback: string,
): Error {
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  const message = typeof body.message === "string" ? body.message : fallback;
  return new Error(`${message} (${code})`);
}

async function browserSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Uses the existing create → storage PUT → commit path and returns a pinned version ref. */
export async function uploadBrowserAttachment(
  session: Session,
  workspaceId: string,
  intent: BrowserAttachmentUploadIntent,
): Promise<BrowserSignalAttachmentRef> {
  if (intent.committed) return intent.committed;
  if (!intent.created) {
    const created = await postCommand(
      session,
      intent.createCommandId,
      {
        kind: "file_version_create",
        file_id: intent.fileId,
        version_id: intent.versionId,
        name: intent.name,
        declared_size_bytes: intent.file.size,
        content_type: intent.contentType,
      },
      { workspace_id: workspaceId, stream: { kind: "workspace" } },
      `CommonSwarm lost the upload-slot result for ${intent.name}. Retry this message to check the same request.`,
    );
    if (created.status !== 200 || created.body.status !== "accepted") {
      throw browserFileRefusal(created.status, created.body, `CommonSwarm did not start ${intent.name}.`);
    }
    const uploadPath = typeof created.body.upload_path === "string"
      ? created.body.upload_path
      : "";
    if (!uploadPath.startsWith("/storage/v1/")) {
      throw new CommandOutcomeUnknown(`CommonSwarm did not return a safe upload path for ${intent.name}.`);
    }
    intent.created = {
      fileId: String(created.body.file_id ?? intent.fileId),
      versionId: String(created.body.version_id ?? intent.versionId),
      versionN: Number(created.body.version_n ?? 0),
      uploadPath,
    };
  }

  const d = deployment();
  if (!d) throw new NoDeployment();
  if (!intent.uploaded) {
    let putResponse: Response;
    try {
      putResponse = await fetch(
        new URL(intent.created.uploadPath, `${d.url.replace(/\/+$/, "")}/`).href,
        { method: "PUT", headers: { "content-type": intent.contentType }, body: intent.file },
      );
    } catch {
      throw new CommandOutcomeUnknown(`The upload of ${intent.name} lost contact. Retry the message; its text and files are still here.`);
    }
    if (putResponse.ok) {
      intent.uploaded = true;
    }
    /* A retry PUT can honestly return "already exists" when the first response
     * was lost. Continue to the idempotent commit, which is the authority for
     * whether the object is present; branch on its stable code, not PUT copy. */
  }

  const committed = await postCommand(
    session,
    intent.commitCommandId,
    {
      kind: "file_version_commit",
      file_id: intent.created.fileId,
      version_id: intent.created.versionId,
      sha256: await browserSha256(intent.file),
    },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
    `CommonSwarm lost the commit result for ${intent.name}. Retry this message to check the same request.`,
  );
  if (committed.status !== 200 || committed.body.status !== "accepted") {
    throw browserFileRefusal(committed.status, committed.body, `CommonSwarm did not commit ${intent.name}.`);
  }
  intent.committed = {
    file_id: String(committed.body.file_id ?? intent.created.fileId),
    version_n: Number(committed.body.version_n ?? intent.created.versionN),
  };
  return intent.committed;
}

/** Gets a short-lived signed download URL for one live workspace file. */
export async function fileDownloadUrl(
  session: Session,
  commandId: string,
  workspaceId: string,
  fileId: string,
  version: number | null = null,
): Promise<FileDownload> {
  const { status, body } = await postCommand(
    session,
    commandId,
    {
      kind: "file_download_url",
      file_id: fileId,
      ...(version === null ? {} : { version_n: version }),
    },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      `File download was refused: ${String(body.error ?? status)}.`,
    );
  }
  const path = typeof body.download_path === "string" ? body.download_path : "";
  if (!path.startsWith("/storage/v1/")) {
    throw new CommandOutcomeUnknown(
      "CommonSwarm accepted the download without returning a usable storage path.",
    );
  }
  const d = deployment();
  if (!d) throw new NoDeployment();
  return {
    // S1 returns a path relative to the deployment the browser already trusts.
    url: new URL(path, `${d.url.replace(/\/+$/, "")}/`).href,
    contentWarning: typeof body.content_warning === "string"
      ? body.content_warning
      : FILE_CONTENT_WARNING,
  };
}

export interface CreatedWorkspace {
  workspaceId: string;
  streamId: string;
  name: string;
}

/**
 * Creates the caller's own workspace — the one command in the product that a caller with no
 * membership may issue, dispatched ahead of route resolution for exactly that reason.
 *
 * `workspaceId` is generated by the CALLER and passed in, not minted here, so a retry after
 * a timeout reuses it and cannot produce a second workspace.
 */
export async function createWorkspace(
  session: Session,
  commandId: string,
  workspaceId: string,
  name: string,
): Promise<CreatedWorkspace> {
  const { status, body } = await postCommand(session, commandId, {
    kind: "create_workspace",
    workspace_id: workspaceId,
    name,
  });

  if (status === 200) {
    return {
      workspaceId: String(body.workspace_id ?? workspaceId),
      streamId: String(body.stream_id ?? ""),
      name,
    };
  }
  if (status === 403 && body.error === "workspace_limit_reached") {
    throw new WorkspaceLimitReached(Number(body.limit ?? 3));
  }
  // ACTIONABLE REFUSALS COME BACK NAMED, so the UI can offer the fix instead of a shrug.
  // These are only reachable once the feature gate has passed and the caller is
  // authenticated as themselves, so naming them discloses nothing about anyone else.
  if (status === 403 && body.error === "email_not_verified") {
    throw new EmailNotVerified();
  }
  if (status === 403 && body.error === "email_domain_not_accepted") {
    throw new EmailDomainNotAccepted();
  }
  if (status === 403) {
    // The remaining 403 is the uniform one, and it stays uniform on purpose: when self-serve
    // is disabled the server answers identically whatever is wrong, so this message must not
    // guess which cause applies.
    throw new SignupRefused(
      "Creating a workspace is not enabled on this deployment. Nothing was created. Ask " +
        "the deployment operator to enable self-serve signup.",
    );
  }
  if (status === 503) {
    throw new SignupRefused(
      "Signup is paused on this deployment while usage is above its ceiling. Existing " +
        "workspaces are unaffected.",
    );
  }
  /* THE STATUSES BELOW ALL MEAN "NOTHING WAS CREATED", AND SAYING OTHERWISE IS WORSE THAN
   * SAYING NOTHING. They used to fall through to the ambiguous message at the bottom, which
   * warns that retrying "could create a second one" — actively wrong for a request the
   * server rejected before it did any work, and the sort of warning that makes someone
   * afraid to press the button that would have fixed their problem. */
  if (status === 426) {
    throw new ClientTooOld(String(body.min_client_version ?? "a newer version"));
  }
  if (status === 400) {
    throw new Error(
      "CommonSwarm rejected that request as malformed and created nothing. This is a bug " +
        "on our side, not something you did.",
    );
  }
  if (status === 429) {
    throw new SignupRefused(
      "Too many attempts from here just now. Nothing was created. Wait a few minutes and " +
        "try again.",
    );
  }
  /* Only genuinely ambiguous outcomes reach here: a 5xx or a dropped connection can land
   * AFTER the row committed, so a fresh attempt really could produce a second workspace.
   * That is why the copy says reload rather than retry. */
  throw new Error(
    `CommonSwarm could not tell whether the workspace was created (HTTP ${status}). ` +
      `Reload before trying again — retrying with a new request could create a second one.`,
  );
}

export interface Signal {
  id: string;
  from: string;
  fromKind: string;
  to: string | null;
  toAgent: string | null;
  kind: string;
  body: string;
  attachments?: BrowserSignalAttachment[];
  about: string | null;
  until: string | null;
  createdAt: string;
}

/** Optional and additive: legacy rows become empty, and newer metadata fields are ignored. */
export function parseBrowserSignalAttachments(value: unknown): BrowserSignalAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > BROWSER_ATTACHMENT_MAX) {
    throw new Error("CommonSwarm returned malformed message attachments.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("CommonSwarm returned a malformed message attachment.");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.file_id !== "string" ||
      typeof row.version_n !== "number" || !Number.isSafeInteger(row.version_n) || row.version_n < 1 ||
      typeof row.name !== "string" || row.name.length < 1 ||
      typeof row.content_type !== "string" ||
      typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0
    ) {
      throw new Error("CommonSwarm returned malformed message attachment metadata.");
    }
    return {
      file_id: row.file_id,
      version_n: row.version_n,
      name: row.name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
    };
  });
}

export type BrowserSignalRecipient =
  | { kind: "everyone" }
  | { kind: "person"; id: string }
  | { kind: "agent"; id: string };

/** Keeps the browser's single visible recipient and the two nullable wire fields in lockstep. */
export function browserSignalAddress(recipient: BrowserSignalRecipient): {
  toUserId: string | null;
  toAgentPrincipalId: string | null;
} {
  return {
    toUserId: recipient.kind === "person" ? recipient.id : null,
    toAgentPrincipalId: recipient.kind === "agent" ? recipient.id : null,
  };
}

export interface BrowserDeliveryReceipt {
  recipientAgentPrincipalId: string;
  enqueuedAt: string;
  deliveredAt: string | null;
  leasedUntil: string | null;
  ackedAt: string | null;
  ackOutcome: "replied" | "observed" | "queued" | "expired" | "failed_terminal" | null;
  attemptCount: number;
  leaseExpiryCount: number;
  lastErrorCode: string | null;
  /** Null when the server predates queued interactive-session counts. */
  pendingForMainCount?: number | null;
}

export interface BrowserHumanDeliveryReceipt {
  recipientUserId: string;
  /** Present on broadcast roster rows; directed rows keep their old shape. */
  displayName?: string;
  /** Null is the authoritative "not seen yet" state for a directed member. */
  seenAt: string | null;
}

/**
 * A live agent listed on a broadcast. Never a `receipts` row: a cached bundle's
 * parser treats every non-human `receipts` row as a delivery ledger row, so this
 * lives only under `broadcastRoster.agents.principals` (20260902000001, the folded roster migration).
 */
export interface BrowserUntrackedAgentReceipt {
  recipientAgentPrincipalId: string;
  displayName: string;
  trackingState: "not_tracked";
  observedAt: null;
}

export interface BrowserRosterSection {
  total: number;
  returned: number;
  /** The server's display cap. The server owns the value; the client checks returned <= limit. */
  limit: number;
  truncated: boolean;
}

export interface BrowserBroadcastRecipientRoster {
  members: BrowserRosterSection & { seen: number };
  agents: BrowserRosterSection & {
    trackingState: "not_tracked";
    principals: BrowserUntrackedAgentReceipt[];
  };
}

/** `receipts` carries only the two row kinds every shipped bundle parses. */
export type BrowserReceiptRow = BrowserDeliveryReceipt | BrowserHumanDeliveryReceipt;

export interface BrowserDeliveryReceiptResult {
  /** Null means the caller cannot inspect a matching signal or the endpoint could not answer. */
  addressed: boolean | null;
  receipts: BrowserReceiptRow[];
  /** Present only after the server returns a broadcast recipient roster. */
  broadcastRoster?: BrowserBroadcastRecipientRoster;
}

export interface BrowserDeliveryReceiptCacheEntry {
  result: BrowserDeliveryReceiptResult | null;
  checkedAt: number;
  phase?: "posting" | "accepted";
}

export type BrowserDeliveryIndicatorState =
  | "pending"
  | "unavailable"
  | "no-recipient"
  | "sent"
  | "delivered"
  | "working"
  | "queued"
  | "seen"
  | "done"
  | "stuck";

export interface BrowserDeliveryIndicator {
  state: BrowserDeliveryIndicatorState;
  outcome: BrowserDeliveryReceipt["ackOutcome"] | "mixed";
  glyph: string;
  label: string;
  detail: string;
  terminal: boolean;
}

export const BROWSER_RECEIPT_ACTIVE_REFRESH_MS = 4_000;
export const BROWSER_RECEIPT_UNAVAILABLE_REFRESH_MS = 30_000;
export const BROWSER_RECEIPT_REQUESTS_PER_TICK = 8;

const deliveryAge = (timestamp: string, now: number): string => {
  const elapsed = Math.max(0, now - new Date(timestamp).getTime());
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "less than a minute ago";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const receiptIsWorking = (receipt: BrowserDeliveryReceipt, now: number): boolean =>
  receipt.ackedAt === null &&
  receipt.leasedUntil !== null &&
  new Date(receipt.leasedUntil).getTime() > now;

const receiptIsStuck = (receipt: BrowserDeliveryReceipt): boolean =>
  receipt.ackedAt === null && (
    receipt.attemptCount > 1 ||
    receipt.leaseExpiryCount > 0 ||
    receipt.lastErrorCode !== null
  );

const isBrowserHumanDeliveryReceipt = (
  receipt: BrowserReceiptRow,
): receipt is BrowserHumanDeliveryReceipt => "recipientUserId" in receipt;

const isBrowserAgentDeliveryReceipt = (
  receipt: BrowserReceiptRow,
): receipt is BrowserDeliveryReceipt => !isBrowserHumanDeliveryReceipt(receipt);

export interface BrowserBroadcastRosterView {
  seenMembers: BrowserHumanDeliveryReceipt[];
  notSeenMembers: BrowserHumanDeliveryReceipt[];
  agents: BrowserUntrackedAgentReceipt[];
  /** Seen members the capped list left out, from the server's uncapped count. */
  seenHidden: number;
  /** Not-seen members the capped list left out: total - seen - shown. */
  notSeenHidden: number;
  /** Agents the capped list left out. */
  agentsHidden: number;
}

/**
 * Splits one broadcast result into the three honest detail sections, each with
 * the count its cut hid. With 100 members and 60 seen the capped list is 50 seen
 * and 0 not-seen; without the remainder the not-seen section would read "None".
 */
export function browserBroadcastRosterView(
  result: BrowserDeliveryReceiptResult,
): BrowserBroadcastRosterView {
  const members = result.receipts.filter(isBrowserHumanDeliveryReceipt);
  const seenMembers = members.filter((receipt) => receipt.seenAt !== null);
  const notSeenMembers = members.filter((receipt) => receipt.seenAt === null);
  const agents = result.broadcastRoster?.agents.principals ?? [];
  const roster = result.broadcastRoster;
  return {
    seenMembers,
    notSeenMembers,
    agents,
    seenHidden: roster ? Math.max(0, roster.members.seen - seenMembers.length) : 0,
    notSeenHidden: roster
      ? Math.max(0, roster.members.total - roster.members.seen - notSeenMembers.length)
      : 0,
    agentsHidden: roster ? Math.max(0, roster.agents.total - agents.length) : 0,
  };
}

/**
 * The list items for one roster detail section. "None" is a claim about the
 * whole roster, so it appears only when the server's totals say the section is
 * empty; a cut section names how many it did not show.
 */
export function browserRosterSectionLines(
  rows: readonly string[],
  hidden: number,
): string[] {
  if (rows.length === 0 && hidden === 0) return ["None"];
  if (hidden === 0) return [...rows];
  return [...rows, `${hidden}${rows.length === 0 ? "" : " more"} not shown (roster cut)`];
}

/** Turns ledger facts into compact copy without claiming that a model read a message. */
export function browserDeliveryIndicator(
  result: BrowserDeliveryReceiptResult | null,
  now = Date.now(),
): BrowserDeliveryIndicator {
  if (result === null || result.addressed === null) {
    return {
      state: "unavailable",
      outcome: null,
      glyph: "?",
      label: "Receipt unavailable",
      detail: "Delivery status is unavailable. CommonSwarm cannot confirm what happened.",
      terminal: false,
    };
  }
  /* `addressed` is the authority. An empty receipt array must never turn a broadcast into
   * a pending or failed delivery. */
  if (result.addressed === false) {
    const roster = result.broadcastRoster;
    if (roster !== undefined) {
      const cut = [
        roster.members.truncated
          ? ` Showing ${roster.members.returned} of ${roster.members.total} members.`
          : "",
        roster.agents.truncated
          ? ` Showing ${roster.agents.returned} of ${roster.agents.total} agents.`
          : "",
      ].join("");
      return {
        state: roster.members.seen > 0 ? "seen" : "no-recipient",
        outcome: null,
        glyph: roster.members.seen > 0 ? "✓✓" : "○",
        label: `Seen by ${roster.members.seen} of ${roster.members.total}`,
        detail:
          `Broadcast — nobody was addressed or woken. Member seen state is a focused-viewport browser report. Broadcasts do not wake or track agents.${cut}`,
        terminal: roster.members.seen >= roster.members.total,
      };
    }
    return {
      state: "no-recipient",
      outcome: null,
      glyph: "○",
      label: "No recipient",
      detail: "Broadcast — nobody was addressed or woken.",
      terminal: true,
    };
  }
  if (result.receipts.length === 0) {
    return {
      state: "unavailable",
      outcome: null,
      glyph: "?",
      label: "Receipt unavailable",
      detail: "This message was addressed, but CommonSwarm returned no delivery record.",
      terminal: false,
    };
  }

  const humanReceipts = result.receipts.filter(isBrowserHumanDeliveryReceipt);
  const agentReceipts = result.receipts.filter(
    isBrowserAgentDeliveryReceipt,
  );
  if (humanReceipts.length === 1 && agentReceipts.length === 0) {
    const human = humanReceipts[0]!;
    return human.seenAt === null
      ? {
        state: "sent",
        outcome: null,
        glyph: "✓",
        label: "Sent",
        detail: "Delivered to the workspace — not seen yet.",
        terminal: false,
      }
      : {
        state: "seen",
        outcome: null,
        glyph: "✓✓",
        label: "Seen",
        detail:
          "The member's browser reported this message as seen when the row was in view and the document had focus.",
        terminal: true,
      };
  }
  if (humanReceipts.length > 0) {
    return {
      state: "unavailable",
      outcome: null,
      glyph: "?",
      label: "Receipt unavailable",
      detail: "CommonSwarm returned incompatible recipient receipt types.",
      terminal: false,
    };
  }

  const total = agentReceipts.length;
  const terminalRows = agentReceipts.filter(
    (receipt) => receipt.ackedAt !== null && receipt.ackOutcome !== null,
  );
  const workingRows = agentReceipts.filter((receipt) => receiptIsWorking(receipt, now));
  const stuckRows = agentReceipts.filter(
    (receipt) => !receiptIsWorking(receipt, now) && receiptIsStuck(receipt),
  );
  const deliveredRows = agentReceipts.filter((receipt) => receipt.deliveredAt !== null);
  const deliveredOnlyRows = agentReceipts.filter(
    (receipt) =>
      receipt.ackedAt === null &&
      !receiptIsWorking(receipt, now) &&
      !receiptIsStuck(receipt) &&
      receipt.deliveredAt !== null,
  );
  const sentRows = agentReceipts.filter(
    (receipt) =>
      receipt.ackedAt === null &&
      !receiptIsWorking(receipt, now) &&
      !receiptIsStuck(receipt) &&
      receipt.deliveredAt === null,
  );

  if (total === 1) {
    const receipt = agentReceipts[0]!;
    if (receipt.ackedAt !== null && receipt.ackOutcome !== null) {
      if (receipt.ackOutcome === "queued") {
        const queueCount = receipt.pendingForMainCount;
        return {
          state: "queued",
          outcome: "queued",
          glyph: "…",
          label: "Queued",
          detail: `Queued for the agent's interactive session; waiting for the recipient's session hook${
            typeof queueCount === "number" ? ` (${queueCount} in queue)` : ""
          }.`,
          terminal: false,
        };
      }
      if (receipt.ackOutcome === "replied") {
        return {
          state: "done",
          outcome: "replied",
          glyph: "↩",
          label: "Replied",
          detail: "The agent completed this delivery with a reply.",
          terminal: true,
        };
      }
      if (receipt.ackOutcome === "observed") {
        return {
          state: "done",
          outcome: "observed",
          glyph: "◎",
          label: "Observed",
          detail: "The agent saw this delivery without replying.",
          terminal: true,
        };
      }
      if (receipt.ackOutcome === "expired") {
        return {
          state: "done",
          outcome: "expired",
          glyph: "⌛",
          label: "Expired",
          detail: "The delivery expired before the agent completed it.",
          terminal: true,
        };
      }
      return {
        state: "done",
        outcome: "failed_terminal",
        glyph: "!",
        label: "Failed",
        detail: receipt.lastErrorCode
          ? `Delivery stopped with error ${receipt.lastErrorCode}.`
          : "Delivery stopped after its attempts were exhausted.",
        terminal: true,
      };
    }
    if (receiptIsWorking(receipt, now)) {
      return {
        state: "working",
        outcome: null,
        glyph: "●",
        label: "Working",
        detail: "The agent has an active delivery lease. Work is in progress.",
        terminal: false,
      };
    }
    if (receiptIsStuck(receipt)) {
      const reasons = [
        receipt.attemptCount > 1
          ? `${receipt.attemptCount} delivery attempts`
          : null,
        receipt.leaseExpiryCount > 0
          ? `${receipt.leaseExpiryCount} expired lease${receipt.leaseExpiryCount === 1 ? "" : "s"}`
          : null,
        receipt.lastErrorCode ? `error ${receipt.lastErrorCode}` : null,
      ].filter((reason): reason is string => reason !== null);
      return {
        state: "stuck",
        outcome: null,
        glyph: "!",
        label: "Needs attention",
        detail: `Delivery is stuck: ${reasons.join(", ")}.`,
        terminal: false,
      };
    }
    if (receipt.deliveredAt !== null) {
      return {
        state: "delivered",
        outcome: null,
        glyph: "✓✓",
        label: "Delivered",
        detail: `Handed to the agent's listener ${deliveryAge(receipt.deliveredAt, now)}. No response yet.`,
        terminal: false,
      };
    }
    return {
      state: "sent",
      outcome: null,
      glyph: "✓",
      label: "Sent",
      detail: "Accepted by CommonSwarm. Not delivered to the agent's listener yet.",
      terminal: false,
    };
  }

  const queuedRows = terminalRows.filter((receipt) => receipt.ackOutcome === "queued");
  const finishedRows = terminalRows.filter((receipt) => receipt.ackOutcome !== "queued");
  const outcomeCounts = new Map<Exclude<NonNullable<BrowserDeliveryReceipt["ackOutcome"]>, "queued">, number>();
  for (const receipt of finishedRows) {
    const outcome = receipt.ackOutcome as Exclude<NonNullable<BrowserDeliveryReceipt["ackOutcome"]>, "queued">;
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
  }
  const outcomeLabels: Record<Exclude<NonNullable<BrowserDeliveryReceipt["ackOutcome"]>, "queued">, string> = {
    replied: "replied",
    observed: "observed without reply",
    expired: "expired",
    failed_terminal: "failed",
  };
  const detailParts = [
    ...Array.from(outcomeCounts, ([outcome, count]) => `${count} ${outcomeLabels[outcome]}`),
    queuedRows.length > 0
      ? `${queuedRows.length} queued waiting for recipient session hooks`
      : null,
    workingRows.length > 0 ? `${workingRows.length} working` : null,
    stuckRows.length > 0 ? `${stuckRows.length} need attention` : null,
    deliveredOnlyRows.length > 0
      ? `${deliveredOnlyRows.length} delivered with no response`
      : null,
    sentRows.length > 0 ? `${sentRows.length} sent but not delivered` : null,
  ].filter((part): part is string => part !== null);
  const detail = `${detailParts.join("; ")}. Delivery is tracked for each recipient.`;
  if (stuckRows.length > 0) {
    return {
      state: "stuck",
      outcome: null,
      glyph: "!",
      label: `${stuckRows.length} of ${total} need attention`,
      detail,
      terminal: false,
    };
  }
  if (workingRows.length > 0) {
    return {
      state: "working",
      outcome: null,
      glyph: "●",
      label: `${workingRows.length} of ${total} working`,
      detail,
      terminal: false,
    };
  }
  if (queuedRows.length > 0) {
    return {
      state: "queued",
      outcome: queuedRows.length === total ? "queued" : "mixed",
      glyph: "…",
      label: `${queuedRows.length} of ${total} queued`,
      detail,
      terminal: false,
    };
  }
  if (finishedRows.length === total) {
    const outcomes = new Set(finishedRows.map((receipt) => receipt.ackOutcome));
    return {
      state: "done",
      outcome: outcomes.size === 1 ? finishedRows[0]!.ackOutcome! : "mixed",
      glyph: "✓✓",
      label: `${total} of ${total} done`,
      detail,
      terminal: true,
    };
  }
  if (deliveredRows.length > 0 || terminalRows.length > 0) {
    const progressed = new Set([
      ...deliveredRows.map((receipt) => receipt.recipientAgentPrincipalId),
      ...terminalRows.map((receipt) => receipt.recipientAgentPrincipalId),
    ]).size;
    return {
      state: "delivered",
      outcome: null,
      glyph: "✓✓",
      label: `${progressed} of ${total} delivered`,
      detail,
      terminal: false,
    };
  }
  return {
    state: "sent",
    outcome: null,
    glyph: "✓",
    label: `Sent to ${total}`,
    detail,
    terminal: false,
  };
}

/**
 * Keep a known human-directed row at Sent until the RPC returns the server's
 * seen timestamp. Missing or failed reads may withhold Seen, never invent it.
 */
export function browserHumanDeliveryIndicator(
  recipientUserId: string,
  result: BrowserDeliveryReceiptResult | null,
): BrowserDeliveryIndicator {
  const human = result?.receipts.find((receipt) =>
    isBrowserHumanDeliveryReceipt(receipt) &&
    receipt.recipientUserId === recipientUserId
  );
  return browserDeliveryIndicator({
    addressed: true,
    receipts: [human && isBrowserHumanDeliveryReceipt(human)
      ? human
      : { recipientUserId, seenAt: null }],
  });
}

/** Bounds receipt reads while favoring visible and newly-arrived directed messages. */
export function browserDeliveryReceiptCandidates(
  signals: readonly Signal[],
  cache: ReadonlyMap<string, BrowserDeliveryReceiptCacheEntry>,
  visibleSignalIds: ReadonlySet<string>,
  now = Date.now(),
  limit = BROWSER_RECEIPT_REQUESTS_PER_TICK,
): Signal[] {
  return signals
    .filter((signal) => {
      const cached = cache.get(signal.id);
      if (cached?.phase === "posting") return false;
      if (!cached) return true;
      const indicator = signal.to !== null && signal.toAgent === null
        ? browserHumanDeliveryIndicator(signal.to, cached.result)
        : browserDeliveryIndicator(cached.result, now);
      if (indicator.terminal) return false;
      const cadence = indicator.state === "unavailable"
        ? BROWSER_RECEIPT_UNAVAILABLE_REFRESH_MS
        : BROWSER_RECEIPT_ACTIVE_REFRESH_MS;
      return now - cached.checkedAt >= cadence;
    })
    .sort((left, right) => {
      const visibleDifference = Number(visibleSignalIds.has(right.id)) -
        Number(visibleSignalIds.has(left.id));
      if (visibleDifference !== 0) return visibleDifference;
      const leftCached = cache.get(left.id);
      const rightCached = cache.get(right.id);
      const missingDifference = Number(leftCached !== undefined) -
        Number(rightCached !== undefined);
      if (missingDifference !== 0) return missingDifference;
      if (leftCached && rightCached && leftCached.checkedAt !== rightCached.checkedAt) {
        return leftCached.checkedAt - rightCached.checkedAt;
      }
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .slice(0, Math.max(0, limit));
}

/** Keeps pre-receipt post progress inside the same indicator model as delivery receipts. */
export function browserPostingDeliveryIndicator(): BrowserDeliveryIndicator {
  return {
    state: "pending",
    outcome: null,
    glyph: "…",
    label: "Sending",
    detail: "Posting to CommonSwarm. This is still in progress; delivery is not confirmed yet.",
    terminal: false,
  };
}

/** Shows only what the accepted post established while its delivery receipt is loading. */
export function browserAcceptedDeliveryIndicator(
  recipient: BrowserSignalRecipient,
): BrowserDeliveryIndicator {
  if (recipient.kind === "everyone") {
    return browserDeliveryIndicator({ addressed: false, receipts: [] });
  }
  if (recipient.kind === "person") {
    return browserHumanDeliveryIndicator(recipient.id, null);
  }
  return {
    state: "sent",
    outcome: null,
    glyph: "✓",
    label: "Sent",
    detail: "Accepted by CommonSwarm. The delivery receipt is loading; delivery is not confirmed yet.",
    terminal: false,
  };
}

/** Posts one browser-authored note with either broadcast or one direct addressee. */
export async function postBrowserSignal(
  session: Session,
  commandId: string,
  workspaceId: string,
  bodyText: string,
  recipient: BrowserSignalRecipient,
  attachments: readonly BrowserSignalAttachmentRef[] = [],
): Promise<Signal> {
  const address = browserSignalAddress(recipient);
  const { status, body } = await postCommand(
    session,
    commandId,
    {
      kind: "post_signal",
      signal_kind: "note",
      body: bodyText,
      to_user_id: address.toUserId,
      to_agent_principal_id: address.toAgentPrincipalId,
      in_reply_to: null,
      about: null,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the signal result. Refresh the feed before posting it again.",
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error(
      status === 403
        ? "That person or agent is no longer available here. Nothing was posted."
        : String(body.message ?? `CommonSwarm did not post the signal (HTTP ${status}).`),
    );
  }
  const row = body.signal as Record<string, unknown> | undefined;
  if (!row || typeof row.id !== "string") {
    throw new CommandOutcomeUnknown(
      "CommonSwarm accepted the signal without returning its row. Refresh the feed before posting it again.",
    );
  }
  return {
    id: row.id,
    from: String(row.from ?? ""),
    fromKind: String(row.from_kind ?? "user"),
    to: row.to === null || row.to === undefined ? null : String(row.to),
    toAgent: row.to_agent === null || row.to_agent === undefined
      ? null
      : String(row.to_agent),
    kind: String(row.kind ?? "note"),
    body: String(row.body ?? bodyText),
    attachments: parseBrowserSignalAttachments(row.attachments),
    about: row.about === null || row.about === undefined ? null : String(row.about),
    until: row.until === null || row.until === undefined ? null : String(row.until),
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

/** Best-effort command write for focused-viewport human receipt attestations. */
export async function reportBrowserSignalsSeen(
  session: Session,
  commandId: string,
  workspaceId: string,
  signalIds: readonly string[],
): Promise<void> {
  if (signalIds.length < 1 || signalIds.length > HUMAN_SEEN_BATCH_MAX) {
    throw new Error(
      `A seen report must contain 1..${HUMAN_SEEN_BATCH_MAX} signal ids.`,
    );
  }
  const { status, body } = await postCommand(
    session,
    commandId,
    { kind: "signals_seen", signal_ids: [...signalIds] },
    { workspace_id: workspaceId, stream: { kind: "workspace" } },
  );
  if (status !== 200 || body.status !== "accepted") {
    throw new Error("CommonSwarm did not record the seen report.");
  }
}

/**
 * Reads the shared feed through the swarm_read views, which apply the membership gate in the
 * database. A caller who is not a member of the workspace gets an empty set rather than an
 * error, which is the no-enumeration posture the rest of the product keeps: a stranger
 * cannot learn whether a workspace id exists by watching this call fail differently.
 */
export async function feed(workspaceId: string, limit = 50): Promise<Signal[]> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await readWithDeadline(
    "workspace activity",
    (signal) =>
      c
        .schema("swarm_read")
        .from("signals")
        .select("id,from,from_kind,to,to_agent,kind,body,about,until,created_at,attachments")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(limit)
        .abortSignal(signal),
  );
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    from: String(row.from ?? ""),
    fromKind: String(row.from_kind ?? ""),
    to: row.to === null || row.to === undefined ? null : String(row.to),
    toAgent: row.to_agent === null || row.to_agent === undefined ? null : String(row.to_agent),
    kind: String(row.kind ?? ""),
    body: String(row.body ?? ""),
    attachments: parseBrowserSignalAttachments(row.attachments),
    about: row.about === null || row.about === undefined ? null : String(row.about),
    until: row.until === null || row.until === undefined ? null : String(row.until),
    createdAt: String(row.created_at ?? ""),
  }));
}

/** Reads receipts for any signal visible to the signed-in workspace member. */
export async function browserDeliveryReceipts(
  workspaceId: string,
  signalId: string,
): Promise<BrowserDeliveryReceiptResult> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await readWithDeadline(
    "message delivery receipts",
    (signal) =>
      c
        .schema("swarm_read")
        .rpc("signal_delivery_receipts", {
          p_workspace_id: workspaceId,
          p_signal_id: signalId,
        })
        .abortSignal(signal),
  );
  if (error) throw new Error(error.message);
  if (data === null) return { addressed: null, receipts: [] };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Delivery receipts returned malformed data.");
  }
  const result = data as Record<string, unknown>;
  if (typeof result.addressed !== "boolean" || !Array.isArray(result.receipts)) {
    throw new Error("Delivery receipts returned malformed data.");
  }
  const outcomes = new Set(["replied", "observed", "queued", "expired", "failed_terminal"]);
  const receipts: BrowserReceiptRow[] = result.receipts.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Delivery receipts returned a malformed row.");
      }
      const row = value as Record<string, unknown>;
      if (Object.hasOwn(row, "recipient_user_id")) {
        const recipientUserId = row.recipient_user_id;
        const seenAt = row.seen_at;
        const displayName = row.display_name;
        if (
          typeof recipientUserId !== "string" || recipientUserId.length === 0 ||
          !(displayName === undefined ||
            (typeof displayName === "string" && displayName.length > 0)) ||
          !(seenAt === null ||
            (typeof seenAt === "string" && Number.isFinite(Date.parse(seenAt))))
        ) {
          throw new Error("Delivery receipts returned a malformed human row.");
        }
        return {
          recipientUserId,
          ...(displayName === undefined ? {} : { displayName }),
          seenAt: seenAt as string | null,
        };
      }
      if (Object.hasOwn(row, "tracking_state")) {
        // 20260902000001 put these rows here and blanked every cached bundle's
        // indicator; the folded 20260902000001 keeps them under broadcast_roster.agents.
        throw new Error("Delivery receipts returned an agent tracking row inside receipts.");
      }
      const outcome = row.ack_outcome;
      if (!(outcome === null || (typeof outcome === "string" && outcomes.has(outcome)))) {
        throw new Error("Delivery receipts returned a malformed outcome.");
      }
      const pendingForMainCount = row.pending_for_main_count;
      if (!(
        pendingForMainCount === undefined || pendingForMainCount === null ||
        (typeof pendingForMainCount === "number" &&
          Number.isSafeInteger(pendingForMainCount) && pendingForMainCount >= 0)
      )) {
        throw new Error("Delivery receipts returned a malformed main queue count.");
      }
      return {
        recipientAgentPrincipalId: String(row.recipient_agent_principal_id ?? ""),
        enqueuedAt: String(row.enqueued_at ?? ""),
        deliveredAt: row.delivered_at === null ? null : String(row.delivered_at ?? ""),
        leasedUntil: row.leased_until === null ? null : String(row.leased_until ?? ""),
        ackedAt: row.acked_at === null ? null : String(row.acked_at ?? ""),
        ackOutcome: outcome as BrowserDeliveryReceipt["ackOutcome"],
        attemptCount: Number(row.attempt_count),
        leaseExpiryCount: Number(row.lease_expiry_count),
        lastErrorCode: row.last_error_code === null
          ? null
          : String(row.last_error_code ?? ""),
        pendingForMainCount: pendingForMainCount === undefined
          ? null
          : pendingForMainCount as number | null,
      };
    });
  let broadcastRoster: BrowserBroadcastRecipientRoster | undefined;
  if (result.addressed === false) {
    // A broadcast's `receipts` holds member rows only; agents are listed under
    // broadcast_roster.agents.principals. The same invariant the pre-roster
    // bundle enforced, and what keeps that bundle's indicator alive.
    const memberRows = receipts.filter(isBrowserHumanDeliveryReceipt);
    if (memberRows.length !== receipts.length) {
      throw new Error("Delivery receipts returned an agent recipient for a broadcast.");
    }
    const rawRoster = result.broadcast_roster;
    if (!rawRoster || typeof rawRoster !== "object" || Array.isArray(rawRoster)) {
      throw new Error("Delivery receipts returned a malformed broadcast roster.");
    }
    const roster = rawRoster as Record<string, unknown>;
    const section = (value: unknown): BrowserRosterSection & Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Delivery receipts returned a malformed broadcast roster.");
      }
      const row = value as Record<string, unknown>;
      // The server owns the cap; only its shape is checked here. Pinning the
      // value turned a server tuning knob into a client release blocker.
      if (
        !Number.isSafeInteger(row.total) || Number(row.total) < 0 ||
        !Number.isSafeInteger(row.returned) || Number(row.returned) < 0 ||
        !Number.isSafeInteger(row.limit) || Number(row.limit) < 1 ||
        Number(row.returned) > Number(row.limit) ||
        Number(row.returned) > Number(row.total) ||
        typeof row.truncated !== "boolean" ||
        row.truncated !== (Number(row.returned) < Number(row.total))
      ) {
        throw new Error("Delivery receipts returned a malformed broadcast roster.");
      }
      return {
        ...row,
        total: Number(row.total),
        returned: Number(row.returned),
        limit: Number(row.limit),
        truncated: row.truncated,
      };
    };
    const members = section(roster.members);
    const agents = section(roster.agents);
    if (
      !Number.isSafeInteger(members.seen) || Number(members.seen) < 0 ||
      Number(members.seen) > members.total ||
      agents.tracking_state !== "not_tracked" ||
      !Array.isArray(agents.principals)
    ) {
      throw new Error("Delivery receipts returned a malformed broadcast roster.");
    }
    const principals: BrowserUntrackedAgentReceipt[] = agents.principals.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Delivery receipts returned a malformed untracked agent row.");
      }
      const row = value as Record<string, unknown>;
      if (
        typeof row.recipient_agent_principal_id !== "string" ||
        row.recipient_agent_principal_id.length === 0 ||
        typeof row.display_name !== "string" || row.display_name.length === 0 ||
        row.tracking_state !== "not_tracked" || row.observed_at !== null
      ) {
        throw new Error("Delivery receipts returned a malformed untracked agent row.");
      }
      return {
        recipientAgentPrincipalId: row.recipient_agent_principal_id,
        displayName: row.display_name,
        trackingState: "not_tracked",
        observedAt: null,
      };
    });
    const seenShown = memberRows.filter((receipt) => receipt.seenAt !== null).length;
    if (
      seenShown > Number(members.seen) ||
      memberRows.length !== members.returned ||
      principals.length !== agents.returned ||
      new Set(principals.map((agent) => agent.recipientAgentPrincipalId)).size !==
        principals.length
    ) {
      throw new Error("Delivery receipts returned a malformed broadcast roster.");
    }
    broadcastRoster = {
      members: {
        total: members.total,
        returned: members.returned,
        limit: members.limit,
        truncated: members.truncated,
        seen: Number(members.seen),
      },
      agents: {
        total: agents.total,
        returned: agents.returned,
        limit: agents.limit,
        truncated: agents.truncated,
        trackingState: "not_tracked",
        principals,
      },
    };
  } else if (Object.hasOwn(result, "broadcast_roster")) {
    throw new Error("Delivery receipts returned a broadcast roster for a direct message.");
  }
  return {
    addressed: result.addressed,
    receipts,
    ...(broadcastRoster === undefined ? {} : { broadcastRoster }),
  };
}

/**
 * Workspaces the signed-in user is a live member of.
 *
 * ★ THIS QUERIED A COLUMN THAT DOES NOT EXIST. It selected `workspace_name` from
 * swarm_read.member_profiles, whose columns are workspace_id, user_id and display_name
 * (20260724000002_status_workspaces.sql:18-21). The name lives on swarm_read.workspaces,
 * which is the view this should have used all along. PostgREST answers an unknown column
 * with an error rather than silently omitting it, so every call threw — and the signup
 * flow uses this as its duplicate-workspace guard, meaning the guard could never have run.
 *
 * The membership gate is in the view (`WHERE swarm.is_member(...)`), so a non-member gets
 * an empty set rather than an error: no one can probe whether a workspace id exists.
 * archived_at is filtered here because an archived workspace is not somewhere you can work.
 */
export async function myWorkspaces(): Promise<{ id: string; name: string }[]> {
  const c = client();
  if (!c) throw new NoDeployment();
  const { data, error } = await readWithDeadline(
    "your workspaces",
    (signal) =>
      c
        .schema("swarm_read")
        .from("workspaces")
        .select("workspace_id,name,archived_at")
        .is("archived_at", null)
        .limit(50)
        .abortSignal(signal),
  );
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => ({
      id: String(row.workspace_id ?? ""),
      name: String(row.name ?? row.workspace_id ?? ""),
    }))
    .filter((w) => w.id.length > 0);
}

/** A v4 uuid from the platform CSPRNG; used for both workspace ids and command ids. */
export function uuid(): string {
  return crypto.randomUUID();
}
