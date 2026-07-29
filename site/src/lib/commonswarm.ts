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

export interface Deployment {
  url: string;
  anonKey: string;
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

  const url = import.meta.env.PUBLIC_SUPABASE_URL ?? meta("commonswarm:url");
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? meta("commonswarm:anon-key");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

let cached: SupabaseClient | null = null;

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

export async function currentSession(): Promise<Session | null> {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session ?? null;
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

/** The free-tier ceiling, refused server-side at 3 live workspaces per verified identity. */
export class WorkspaceLimitReached extends Error {
  override name = "WorkspaceLimitReached";
  constructor(readonly limit: number) {
    super(`You already have ${limit} workspaces, which is the limit for one account.`);
  }
}

interface CommandResult {
  status: number;
  body: Record<string, unknown>;
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
): Promise<CommandResult> {
  const d = deployment();
  if (!d) throw new NoDeployment();
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
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: "unreadable_response" };
  }
  return { status: response.status, body };
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
  kind: string;
  body: string;
  about: string | null;
  until: string | null;
  createdAt: string;
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
  const { data, error } = await c
    .schema("swarm_read")
    .from("signals")
    .select("id,from,from_kind,kind,body,about,until,created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    from: String(row.from ?? ""),
    fromKind: String(row.from_kind ?? ""),
    kind: String(row.kind ?? ""),
    body: String(row.body ?? ""),
    about: row.about === null || row.about === undefined ? null : String(row.about),
    until: row.until === null || row.until === undefined ? null : String(row.until),
    createdAt: String(row.created_at ?? ""),
  }));
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
  const { data, error } = await c
    .schema("swarm_read")
    .from("workspaces")
    .select("workspace_id,name,archived_at")
    .is("archived_at", null)
    .limit(50);
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
