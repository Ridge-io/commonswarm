import type { CloudTarget } from "./config.js";
import { sanitizeDisplayLabel } from "./invite-link.js";
import type {
  CredentialProfile,
  CredentialStore,
} from "./storage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["owner", "admin", "member"]);

export interface WorkspaceSession {
  accessToken: string;
  userId: string;
  deviceId: string;
}

export interface WorkspaceSummary {
  workspace_id: string;
  name: string;
  role: "owner" | "admin" | "member";
  archived: boolean;
}

export interface WorkspaceMember {
  user_id: string;
  name: string;
  role: "owner" | "admin" | "member";
  you: boolean;
}

export interface WorkspaceAgent {
  principal_id: string;
  name: string;
  owner_user_id: string;
  owner_name: string | null;
  revoked: boolean;
  this_machine: boolean;
}

export interface WorkspaceHolder {
  id: string;
  name: string | null;
  kind: "member" | "agent" | "unknown";
}

export interface WorkspaceTask {
  task_id: string;
  slug: string;
  state: string;
  holder: WorkspaceHolder | null;
  lease_expiry: string | null;
}

export interface WorkspaceStatus {
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  tasks: WorkspaceTask[];
}

export interface WorkspaceWarning {
  code: "default_membership_revoked";
  message: string;
}

export const DEFAULT_MEMBERSHIP_REVOKED: WorkspaceWarning = {
  code: "default_membership_revoked",
  message:
    "Your previously selected project is no longer available to this account. CommonSwarm cleared that saved selection.",
};

const PROJECT_NOT_AVAILABLE =
  "That project is not available to this account. Run cswarm workspaces to see projects you can select.";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortWorkspaces(
  workspaces: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    compareText(left.name, right.name) ||
    compareText(left.workspace_id, right.workspace_id)
  );
}

export abstract class WorkspaceCliError extends Error {
  abstract readonly code: string;

  abstract structured(): Record<string, unknown>;
}

export class WorkspaceResolutionError extends WorkspaceCliError {
  readonly code: "project_membership_required" | "project_selection_required";
  readonly workspaces: WorkspaceSummary[];

  constructor(workspaces: readonly WorkspaceSummary[]) {
    const sorted = sortWorkspaces(workspaces);
    const none = sorted.length === 0;
    super(
      none
        ? "You're not in any projects yet. Ask a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin."
        : "More than one project is available and none is selected. Run cswarm workspaces, then cswarm use <full-id|exact-name>.",
    );
    this.name = "WorkspaceResolutionError";
    this.code = none
      ? "project_membership_required"
      : "project_selection_required";
    this.workspaces = sorted;
  }

  structured(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      projects: this.workspaces.map(({ workspace_id, name, role }) => ({
        workspace_id,
        name,
        role,
      })),
    };
  }
}

export class WorkspaceUnavailableError extends WorkspaceCliError {
  readonly code = "project_not_available";

  constructor() {
    super(PROJECT_NOT_AVAILABLE);
    this.name = "WorkspaceUnavailableError";
  }

  structured(): Record<string, unknown> {
    return { code: this.code, message: this.message };
  }
}

export class WorkspaceAmbiguousNameError extends WorkspaceCliError {
  readonly code = "project_name_ambiguous";
  readonly workspaces: WorkspaceSummary[];

  constructor(workspaces: readonly WorkspaceSummary[]) {
    super(
      "That project name matches more than one project. Choose one by full id with cswarm use <full-id>.",
    );
    this.name = "WorkspaceAmbiguousNameError";
    this.workspaces = sortWorkspaces(workspaces);
  }

  structured(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      projects: this.workspaces.map(({ workspace_id, name, role }) => ({
        workspace_id,
        name,
        role,
      })),
    };
  }
}

function checkedUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`project read returned a malformed ${field}`);
  }
  return value.toLowerCase();
}

function checkedRole(value: unknown): WorkspaceSummary["role"] {
  if (typeof value !== "string" || !ROLES.has(value)) {
    throw new Error("project read returned a malformed role");
  }
  return value as WorkspaceSummary["role"];
}

function checkedString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`project read returned a malformed ${field}`);
  }
  return value;
}

function checkedNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`project read returned a malformed ${field}`);
  }
  return value;
}

async function rows(
  target: CloudTarget,
  session: WorkspaceSession,
  resource: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(`/rest/v1/${resource}`, target.url);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        apikey: target.anonKey,
        "accept-profile": "swarm_read",
      },
    });
  } catch {
    throw new Error("project read could not reach the cloud service");
  }
  if (!response.ok) {
    throw new Error(`project read failed (HTTP ${response.status})`);
  }
  const body = await response.json().catch(() => null);
  if (
    !Array.isArray(body) ||
    body.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry),
    )
  ) {
    throw new Error("project read returned malformed JSON");
  }
  return body as Array<Record<string, unknown>>;
}

export interface WorkspaceDirectory {
  list(session: WorkspaceSession): Promise<WorkspaceSummary[]>;
  status(
    session: WorkspaceSession,
    workspaceId: string,
  ): Promise<WorkspaceStatus>;
}

export function cloudWorkspaceDirectory(
  target: CloudTarget,
  fetcher: typeof fetch = fetch,
): WorkspaceDirectory {
  return {
    async list(session) {
      const [membershipRows, workspaceRows] = await Promise.all([
        rows(
          target,
          session,
          "memberships",
          {
            select: "workspace_id,user_id,role",
            user_id: `eq.${session.userId}`,
            revoked_at: "is.null",
            order: "workspace_id.asc",
          },
          fetcher,
        ),
        rows(
          target,
          session,
          "workspaces",
          {
            select: "workspace_id,name,archived_at",
            order: "workspace_id.asc",
          },
          fetcher,
        ),
      ]);
      const names = new Map<string, { name: string; archived: boolean }>();
      for (const row of workspaceRows) {
        const workspaceId = checkedUuid(row.workspace_id, "workspace_id");
        const archivedAt = checkedNullableTimestamp(
          row.archived_at,
          "archived_at",
        );
        names.set(workspaceId, {
          name: sanitizeDisplayLabel(
            checkedString(row.name, "project name"),
            "Unnamed project",
          ),
          archived: archivedAt !== null,
        });
      }
      const result = membershipRows.map((row): WorkspaceSummary => {
        const workspaceId = checkedUuid(row.workspace_id, "workspace_id");
        const project = names.get(workspaceId);
        if (!project) {
          throw new Error(
            "project read omitted a project for a live membership",
          );
        }
        return {
          workspace_id: workspaceId,
          name: project.name,
          role: checkedRole(row.role),
          archived: project.archived,
        };
      });
      return sortWorkspaces(result);
    },

    async status(session, workspaceId) {
      const selected = checkedUuid(workspaceId, "workspace_id");
      const [memberRows, principalRows, taskRows] = await Promise.all([
        rows(
          target,
          session,
          "member_profiles",
          {
            select: "workspace_id,user_id,display_name,role",
            workspace_id: `eq.${selected}`,
            order: "user_id.asc",
          },
          fetcher,
        ),
        rows(
          target,
          session,
          "agent_principals",
          {
            select:
              "workspace_id,principal_id,owner_user_id,name,revoked_at",
            workspace_id: `eq.${selected}`,
            order: "principal_id.asc",
          },
          fetcher,
        ),
        rows(
          target,
          session,
          "tasks",
          {
            select:
              "workspace_id,task_id,slug,lifecycle,owner,lease_expiry",
            workspace_id: `eq.${selected}`,
            order: "task_id.asc",
          },
          fetcher,
        ),
      ]);
      const members = memberRows.map((row): WorkspaceMember => {
        if (checkedUuid(row.workspace_id, "workspace_id") !== selected) {
          throw new Error("project read returned a cross-project member");
        }
        const userId = checkedUuid(row.user_id, "user_id");
        return {
          user_id: userId,
          name: sanitizeDisplayLabel(
            checkedString(row.display_name, "member name"),
            "Unnamed member",
          ),
          role: checkedRole(row.role),
          you: userId === session.userId,
        };
      });
      const memberNames = new Map(
        members.map((member) => [member.user_id, member.name]),
      );
      const principals = principalRows.map((row) => {
        if (checkedUuid(row.workspace_id, "workspace_id") !== selected) {
          throw new Error("project read returned a cross-project agent");
        }
        const revokedAt = checkedNullableTimestamp(
          row.revoked_at,
          "revoked_at",
        );
        const ownerUserId = checkedUuid(row.owner_user_id, "owner_user_id");
        return {
          principal_id: checkedUuid(row.principal_id, "principal_id"),
          name: sanitizeDisplayLabel(
            checkedString(row.name, "agent name"),
            "Unnamed agent",
          ),
          owner_user_id: ownerUserId,
          owner_name: memberNames.get(ownerUserId) ?? null,
          revoked: revokedAt !== null,
        };
      });
      const principalIds = new Set(
        principals.map((principal) => principal.principal_id),
      );
      const runRows = principalIds.size === 0
        ? []
        : await rows(
          target,
          session,
          "agent_runs",
          {
            select: "principal_id,device_id",
            principal_id: `in.(${[...principalIds].join(",")})`,
            order: "principal_id.asc",
          },
          fetcher,
        );
      const machinePrincipals = new Set<string>();
      for (const row of runRows) {
        const principalId = checkedUuid(row.principal_id, "principal_id");
        if (!principalIds.has(principalId)) {
          throw new Error("project read returned a cross-project agent run");
        }
        if (checkedUuid(row.device_id, "device_id") === session.deviceId) {
          machinePrincipals.add(principalId);
        }
      }
      const agents: WorkspaceAgent[] = principals.map((principal) => ({
        ...principal,
        this_machine: machinePrincipals.has(principal.principal_id),
      }));
      const agentNames = new Map(
        agents.map((agent) => [agent.principal_id, agent.name]),
      );
      const tasks = taskRows.map((row): WorkspaceTask => {
        if (checkedUuid(row.workspace_id, "workspace_id") !== selected) {
          throw new Error("project read returned a cross-project task");
        }
        const owner = row.owner;
        if (owner !== null && typeof owner !== "string") {
          throw new Error("project read returned a malformed task holder");
        }
        const holderId = owner === null
          ? null
          : checkedUuid(owner, "task holder");
        const memberName = holderId === null
          ? undefined
          : memberNames.get(holderId);
        const agentName = holderId === null
          ? undefined
          : agentNames.get(holderId);
        return {
          task_id: checkedUuid(row.task_id, "task_id"),
          slug: sanitizeDisplayLabel(
            checkedString(row.slug, "task slug"),
            "Unnamed task",
          ),
          state: sanitizeDisplayLabel(
            checkedString(row.lifecycle, "task state"),
            "unknown",
          ).replace(/[_-]+/g, " "),
          holder: holderId === null
            ? null
            : memberName !== undefined
            ? { id: holderId, name: memberName, kind: "member" }
            : agentName !== undefined
            ? { id: holderId, name: agentName, kind: "agent" }
            : { id: holderId, name: null, kind: "unknown" },
          lease_expiry: checkedNullableTimestamp(
            row.lease_expiry,
            "lease_expiry",
          ),
        };
      });
      return { members, agents, tasks };
    },
  };
}

function profileForUser(
  profile: CredentialProfile,
  userId: string,
): CredentialProfile {
  return profile.userId === userId
    ? profile
    : {
      version: 1,
      userId,
      workspaceId: null,
      email: null,
      principalId: null,
      principalName: null,
      pendingCommands: {},
    };
}

export async function writeWorkspaceDefault(
  store: CredentialStore,
  userId: string,
  workspaceId: string,
): Promise<void> {
  await store.withLock(async () => {
    const profile = profileForUser(await store.readProfile(), userId);
    const sameWorkspace = profile.workspaceId === workspaceId;
    await store.writeProfile({
      ...profile,
      userId,
      workspaceId,
      principalId: sameWorkspace ? profile.principalId ?? null : null,
      principalName: sameWorkspace ? profile.principalName ?? null : null,
    });
  });
}

export async function clearWorkspaceDefault(
  store: CredentialStore,
  userId: string,
  expectedWorkspaceId: string,
): Promise<boolean> {
  return await store.withLock(async () => {
    const current = await store.readProfile();
    if (
      current.userId !== userId ||
      current.workspaceId !== expectedWorkspaceId
    ) {
      return false;
    }
    await store.writeProfile({
      ...current,
      workspaceId: null,
      principalId: null,
      principalName: null,
    });
    return true;
  });
}

export interface ResolveWorkspaceOptions {
  explicit?: string;
  environmental?: string;
  session: WorkspaceSession;
  store: CredentialStore;
  directory: WorkspaceDirectory;
  workspaces?: readonly WorkspaceSummary[];
  warn?: (warning: WorkspaceWarning) => void;
  validateOverride?: boolean;
}

export function workspaceOverride(
  explicit: string | undefined,
  environmental: string | undefined,
): string | null {
  if (explicit !== undefined) {
    if (!UUID_RE.test(explicit)) {
      throw new Error("--workspace-id must be a UUID");
    }
    return explicit.toLowerCase();
  }
  if (environmental) {
    if (!UUID_RE.test(environmental)) {
      throw new Error("SWARM_CLOUD_WORKSPACE_ID must be a UUID");
    }
    return environmental.toLowerCase();
  }
  return null;
}

export async function resolveWorkspace(
  options: ResolveWorkspaceOptions,
): Promise<string> {
  const override = workspaceOverride(
    options.explicit,
    options.environmental,
  );
  if (override !== null && !options.validateOverride) return override;

  const workspaces = sortWorkspaces(
    options.workspaces ?? await options.directory.list(options.session),
  );
  if (override !== null) {
    if (
      workspaces.some((workspace) => workspace.workspace_id === override)
    ) {
      return override;
    }
    throw new WorkspaceUnavailableError();
  }
  const profile = await options.store.withLock(
    () => options.store.readProfile(),
  );
  if (
    profile.userId === options.session.userId &&
    profile.workspaceId !== null
  ) {
    const selected = workspaces.find(
      (workspace) => workspace.workspace_id === profile.workspaceId,
    );
    if (selected) return selected.workspace_id;
    if (
      await clearWorkspaceDefault(
        options.store,
        options.session.userId,
        profile.workspaceId,
      )
    ) {
      options.warn?.(DEFAULT_MEMBERSHIP_REVOKED);
    }
  }
  if (workspaces.length === 1) {
    const workspaceId = workspaces[0]!.workspace_id;
    await writeWorkspaceDefault(
      options.store,
      options.session.userId,
      workspaceId,
    );
    return workspaceId;
  }
  throw new WorkspaceResolutionError(workspaces);
}

export async function selectWorkspace(
  selector: string,
  workspaces: readonly WorkspaceSummary[],
  store: CredentialStore,
  userId: string,
): Promise<WorkspaceSummary> {
  const sorted = sortWorkspaces(workspaces);
  let selected: WorkspaceSummary | undefined;
  if (UUID_RE.test(selector)) {
    const normalized = selector.toLowerCase();
    selected = sorted.find(
      (workspace) => workspace.workspace_id === normalized,
    );
  } else {
    const safeSelector = sanitizeDisplayLabel(selector, "");
    const matches = sorted.filter(
      (workspace) => workspace.name === safeSelector,
    );
    if (matches.length > 1) {
      throw new WorkspaceAmbiguousNameError(matches);
    }
    selected = matches[0];
  }
  if (!selected) throw new WorkspaceUnavailableError();
  await writeWorkspaceDefault(store, userId, selected.workspace_id);
  return selected;
}

function holderLabel(holder: WorkspaceHolder): string {
  return holder.name === null
    ? holder.id
    : `${holder.name} (${holder.id})`;
}

function relativeMagnitude(milliseconds: number): string {
  const magnitude = Math.abs(milliseconds);
  const amount = magnitude < 60_000
    ? "under 1m"
    : magnitude < 3_600_000
    ? `${Math.ceil(magnitude / 60_000)}m`
    : magnitude < 86_400_000
    ? `${Math.ceil(magnitude / 3_600_000)}h`
    : `${Math.ceil(magnitude / 86_400_000)}d`;
  return amount;
}

export function relativeAge(
  timestamp: string,
  now = Date.now(),
): string {
  return `${relativeMagnitude(Math.max(0, now - Date.parse(timestamp)))} ago`;
}

export function relativeExpiry(
  expiry: string,
  now = Date.now(),
): string {
  const remaining = Date.parse(expiry) - now;
  const amount = relativeMagnitude(remaining);
  return remaining >= 0 ? `expires in ${amount}` : `expired ${amount} ago`;
}

/**
 * ★ WHAT ARCHIVING DOES AND DOES NOT DO, SAID ONCE (D-006).
 *
 * The sentence this replaces — "Project archive enforcement is not available yet; archived
 * projects remain selectable while your membership is live" — was true and useless. It
 * described the SYSTEM'S state to someone asking about THEIR list, and left them with no
 * action, which is the D-004 failure in a different surface.
 *
 * The scoping is deliberate and it is the part most easily got wrong. Archiving is NOT
 * inert: the capability endpoint refuses an archived workspace outright
 * (capability_workspace_archived), so "archiving does not restrict access" would be false
 * as a flat claim. What is true, and all that is claimed here, is that it does not restrict
 * MEMBERS AND THEIR AGENTS — the command path loads archived_at and never consults it
 * (D-016). That is the audience of this list.
 *
 * "Yet" is also gone. It promised enforcement is coming, and whether archiving is meant to
 * be an authorization boundary at all is an open product question (D-016), so the old
 * wording asserted the outcome of a decision nobody has made.
 *
 * The remedy names no command because there is none: nothing in this CLI archives a project
 * or ends a membership. It points at the person who can instead of inventing a flag.
 */
export const ARCHIVE_NOT_ENFORCED_CODE = "workspace_archive_not_enforced";
export const ARCHIVE_NOT_ENFORCED_MESSAGE =
  "Archiving a project does not restrict what members or their agents can do in it: an archived project stays selectable, and commands against it still succeed while your membership is live. Removing a project from this list means ending your membership, which this CLI cannot do — ask whoever runs the project.";

/**
 * The `known_gaps` payload, built in ONE place because it is emitted from two.
 *
 * ★ WHY THIS IS A FUNCTION AND NOT TWO OBJECT LITERALS (D-006(b) review, Mica).
 *
 * The first version exported the code and message constants and let each CLI command build
 * its own `known_gaps` entry. My "text and JSON cannot drift" test then observed only
 * `renderWorkspaces`, never either payload — so Mica changed the message at ONE json site,
 * left the constant and the renderer alone, and all 9 tests passed while the two surfaces
 * said different things. The test named the property and could not see the thing it named.
 *
 * With the payload built here, the JSON surface is a function a test can call, and the human
 * surface reads the same constant. Neither can move without the other.
 */
export function archiveKnownGaps(): ReadonlyArray<{ code: string; message: string }> {
  return [{
    code: ARCHIVE_NOT_ENFORCED_CODE,
    message: ARCHIVE_NOT_ENFORCED_MESSAGE,
  }];
}

export function renderWorkspaces(
  workspaces: readonly WorkspaceSummary[],
  currentWorkspaceId: string | null,
): string {
  if (workspaces.length === 0) {
    return [
      "You're not in any projects yet.",
      "Ask a colleague to send you an invitation link, then accept it with cswarm accept --link-stdin.",
    ].join("\n");
  }
  const lines = ["Projects:"];
  for (const workspace of sortWorkspaces(workspaces)) {
    const current = workspace.workspace_id === currentWorkspaceId
      ? " — selected"
      : "";
    const archived = workspace.archived ? " (archived)" : "";
    lines.push(
      `- ${workspace.name}${archived} (${workspace.workspace_id}) — ${workspace.role}${current}`,
    );
  }
  if (!workspaces.some(
    (workspace) => workspace.workspace_id === currentWorkspaceId,
  )) {
    lines.push(
      "No project is selected. Run cswarm use <full-id|exact-name>.",
    );
  }
  /* Shown only when the list actually holds an archived project. The old line printed on
   * every run, to everyone, about a state most readers had nothing in — and today nobody
   * can be in it, because no command sets archived_at; only tests do. The machine-readable
   * `known_gaps` entry is NOT made conditional, because a contract that appears and
   * disappears with the data is worse for a consumer than one that is always there. */
  if (workspaces.some((workspace) => workspace.archived)) {
    lines.push(ARCHIVE_NOT_ENFORCED_MESSAGE);
  }
  return lines.join("\n");
}

export interface RenderStatusOptions {
  userId: string;
  identityLabel: string;
  projectCount: number;
  selected: WorkspaceSummary;
  status: WorkspaceStatus;
  now?: number;
}

export function renderStatus(options: RenderStatusOptions): string {
  const lines = [
    `You: ${options.identityLabel} (${options.userId})`,
    `You're in ${options.projectCount} ${
      options.projectCount === 1 ? "project" : "projects"
    } (selected: ${options.selected.name}).`,
    `Project: ${options.selected.name} (${options.selected.workspace_id})${
      options.selected.archived ? " — archived" : ""
    }`,
    "",
    "Members:",
  ];
  if (options.status.members.length === 0) {
    lines.push("No members are visible in this project.");
  } else {
    for (const member of options.status.members) {
      lines.push(
        `- ${member.name} (${member.user_id}) — ${member.role}${
          member.you ? " — you" : ""
        }`,
      );
    }
  }
  lines.push("", "Agents:");
  if (options.status.agents.length === 0) {
    lines.push("No agents yet.");
  } else {
    for (const agent of options.status.agents) {
      const owner = agent.owner_name === null
        ? agent.owner_user_id
        : `${agent.owner_name} (${agent.owner_user_id})`;
      lines.push(
        `- ${agent.name} (${agent.principal_id}) — ${agent.revoked ? "revoked" : "live"} — belongs to ${owner}${
          agent.this_machine ? " — this machine" : ""
        }`,
      );
    }
  }
  lines.push("", "Tasks:");
  if (options.status.tasks.length === 0) {
    lines.push(
      "No work yet — create a task with cswarm command create --task-id <uuid> --slug <slug>.",
    );
  } else {
    for (const task of options.status.tasks) {
      const holding = task.holder === null
        ? "not held"
        : `held by ${holderLabel(task.holder)}${
          task.lease_expiry === null
            ? ""
            : `, ${relativeExpiry(task.lease_expiry, options.now)}`
        }`;
      lines.push(
        `- ${task.slug} (${task.task_id}) — ${task.state} — ${holding}`,
      );
    }
  }
  return lines.join("\n");
}
