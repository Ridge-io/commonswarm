import { dirname, join } from "node:path";
import type { SignalRecord } from "./command-client.js";
import {
  compareSignalCursor, parseSignalRecord, readAgentSignalDirectory, readAgentSignalPage,
  signalAddressesAgent, type SignalCursor, type SignalDirectory,
} from "./signals.js";
import { readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";
import {
  AgentSetupError, ONBOARDING_UUID, openProfileCredential, privatePath,
  profileTarget, profileSessionContext, readAgentProfile, type AgentProfile,
} from "./agent-profile.js";
import { bindSessionProof } from "./session-proof.js";
import { sessionProofOf } from "./session-context.js";
import { quoteAgentArgument } from "./agent-onboarding-contract.js";

export const AGENT_CHECK_TIMEOUT_MS = 3_000;
export const AGENT_CHECK_PAGE_SIZE = 20;
export const AGENT_CHECK_PREVIEW_CHARS = 1_000;
export const AGENT_CHECK_BODY_BUDGET = 4_000;
export const AGENT_CHECK_CACHE_LIMIT = 200;

export interface AgentCheckMessage {
  id: string;
  from: string;
  from_kind: SignalRecord["from_kind"];
  sender_owner_relation: string;
  kind: SignalRecord["kind"];
  body: string;
  truncated: boolean;
  attachment_count: number;
  created_at: string;
  full_text_command?: string;
}

export interface AgentCheckResult {
  checked: true;
  cached: false;
  messages: AgentCheckMessage[];
  has_more: boolean;
  next_action: string | null;
}

interface CheckState {
  version: 1;
  cursor: SignalCursor | null;
  /** A bounded cache of presented messages, not delivery ACKs. The service remains authoritative. */
  messages: SignalRecord[];
}

export async function withAgentDeadline<T>(
  timeoutMs: number,
  run: (fetcher: typeof fetch, signal: AbortSignal) => Promise<T>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentSetupError("check_timeout", "The message check timed out. Try cswarm check again; the inbox was not proved empty."));
    }, timeoutMs);
  });
  const bounded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    controller.signal.throwIfAborted();
    const result = await fetcher(input, {
      ...init, redirect: "error",
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
    controller.signal.throwIfAborted();
    return result;
  }) as typeof fetch;
  try {
    const result = await Promise.race([run(bounded, controller.signal), timeout]);
    if (controller.signal.aborted) throw new AgentSetupError("check_timeout", "The message check timed out. Try cswarm check again; the inbox was not proved empty.");
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new AgentSetupError("check_timeout", "The message check timed out. Try cswarm check again; the inbox was not proved empty.");
    throw error;
  } finally { clearTimeout(timer!); }
}

export function assertProfileIdentity(profile: AgentProfile, directory: SignalDirectory): void {
  if (directory.identity?.credential_valid !== true ||
      directory.identity.principal_id !== profile.principal_id ||
      directory.identity.workspace_id !== profile.workspace_id ||
      !directory.agents.some(agent => agent.principal_id === profile.principal_id && agent.owner_user_id === directory.identity?.owner_user_id)) {
    throw new AgentSetupError("authenticated_identity_mismatch", "The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.");
  }
}

function checkStatePath(profilePath: string, hostSessionId?: string): string {
  // The same profile's hook and explicit checks share presentation state. Session
  // identity gates the hook, not pagination; restarting must not replay the feed.
  return join(dirname(profilePath), "check.json");
}

async function readCheckState(path: string): Promise<CheckState> {
  const raw = await readSecureJsonFileIfPresent(path, 16 * 1024 * 1024);
  if (raw === null) return { version: 1, cursor: null, messages: [] };
  let state: CheckState;
  try { state = JSON.parse(raw); } catch { throw new AgentSetupError("check_state_invalid", "The message cursor is damaged. Restore the check state before continuing."); }
  if (!state || state.version !== 1 || !Array.isArray(state.messages) || state.messages.length > AGENT_CHECK_CACHE_LIMIT ||
      (state.cursor !== null && (!state.cursor || !ONBOARDING_UUID.test(state.cursor.id) || !Number.isFinite(Date.parse(state.cursor.created_at))))) {
    throw new AgentSetupError("check_state_invalid", "The message cursor is damaged. Restore the check state before continuing.");
  }
  try { state.messages = state.messages.map(row => parseSignalRecord(row)); }
  catch { throw new AgentSetupError("check_state_invalid", "The saved messages are damaged. Restore the check state before continuing."); }
  return state;
}

/** Always fresh: no cooldown, no listener, no background process, and no delivery ACK. */
export async function checkAgentMessages(options: {
  profilePath: string;
  hostSessionId?: string;
  full?: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Cursor advances only after the consumer has accepted the output. */
  present: (result: AgentCheckResult) => Promise<void>;
}): Promise<AgentCheckResult> {
  const startedAt = Date.now();
  const profilePath = privatePath(options.profilePath);
  const profile = await readAgentProfile(profilePath);
  const path = checkStatePath(profilePath, options.hostSessionId);
  const timeoutMs = options.timeoutMs ?? AGENT_CHECK_TIMEOUT_MS;
  return withFileLock(dirname(path), "check", async () => {
    const state = await readCheckState(path);
    return withAgentDeadline(Math.max(1, timeoutMs - (Date.now() - startedAt)), async (bounded, signal) => {
      const managed = await profileSessionContext(profile, options.hostSessionId);
      const fetcher = bindSessionProof(bounded, managed ? sessionProofOf(managed.context) : null);
      const credential = await openProfileCredential(profile, fetcher);
      const token = await credential.bearer();
      const target = profileTarget(profile);
      const [directory, page] = await Promise.all([
        readAgentSignalDirectory(target, token, profile.workspace_id, { fetcher, signal, deadlineMs: Date.now() + timeoutMs }),
        readAgentSignalPage(target, { kind: "agent", token }, {
          workspaceId: profile.workspace_id, inbox: true, ascending: true,
          limit: AGENT_CHECK_PAGE_SIZE,
          ...(state.cursor === null ? {} : { after: state.cursor }),
        }, { fetcher, signal, deadlineMs: Date.now() + timeoutMs }),
      ]);
      assertProfileIdentity(profile, directory);
      if (!page.capabilities.cursorAfter || page.legacyCursorFallback) {
        throw new AgentSetupError("check_paging_unsupported", "This deployment cannot page the inbox without gaps. Update the service; use cswarm inbox to read it in the meantime.");
      }
      const messages: AgentCheckMessage[] = [];
      const presented: SignalRecord[] = [];
      let budget = AGENT_CHECK_BODY_BUDGET;
      let cursor = state.cursor;
      let consumed = 0;
      for (const row of page.signals) {
        if (row.workspace_id !== profile.workspace_id || !signalAddressesAgent(row, profile.principal_id)) {
          throw new AgentSetupError("check_recipient_mismatch", "The service returned a message for another recipient. The cursor was not changed.");
        }
        const next = { id: row.id, created_at: row.created_at };
        if (cursor && compareSignalCursor(next, cursor) <= 0) {
          throw new AgentSetupError("check_page_order_invalid", "The inbox page is out of order. The cursor was not changed.");
        }
        const body = options.full ? row.body : row.body.slice(0, AGENT_CHECK_PREVIEW_CHARS);
        if (messages.length > 0 && body.length > budget) break;
        messages.push({
          id: row.id, from: row.from, from_kind: row.from_kind,
          sender_owner_relation: row.sender_owner_relation ?? "unknown", kind: row.kind,
          body, truncated: body.length < row.body.length,
          attachment_count: row.attachments?.length ?? 0, created_at: row.created_at,
          ...(body.length < row.body.length ? {
            full_text_command: `cswarm check --profile ${shellQuote(profilePath)}${options.hostSessionId ? ` --host-session-id ${shellQuote(options.hostSessionId)}` : ""} --message-id ${row.id}`,
          } : {}),
        });
        presented.push(row);
        budget -= body.length;
        cursor = next;
        consumed += 1;
      }
      const hasMore = consumed < page.signals.length || page.rawCount >= AGENT_CHECK_PAGE_SIZE;
      const result: AgentCheckResult = {
        checked: true, cached: false, messages, has_more: hasMore,
        next_action: hasMore ? `More messages may remain. Run cswarm check --profile ${shellQuote(profilePath)}${options.hostSessionId ? ` --host-session-id ${shellQuote(options.hostSessionId)}` : ""} again.` : null,
      };
      if (signal.aborted) throw new AgentSetupError("check_timeout", "The message check timed out. Try again.");
      // Save the full bodies before showing a preview with its retrieval command. Failure
      // to present can replay messages, but cannot lose them or advance delivery state.
      const cached: CheckState = {
        ...state, messages: [...state.messages.filter(old => !presented.some(row => row.id === old.id)), ...presented].slice(-AGENT_CHECK_CACHE_LIMIT),
      };
      if (presented.length > 0) await writeSecureJsonFile(path, JSON.stringify(cached));
      signal.throwIfAborted();
      await options.present(result);
      if (presented.length > 0) await writeSecureJsonFile(path, JSON.stringify({ ...cached, cursor }));
      return result;
    }, options.fetcher);
  }, { timeoutMs: Math.min(timeoutMs, 30_000) });
}

export async function cachedAgentMessage(profilePath: string, signalId: string, hostSessionId?: string): Promise<SignalRecord> {
  profilePath = privatePath(profilePath);
  const profile = await readAgentProfile(profilePath);
  if (!ONBOARDING_UUID.test(signalId)) throw new AgentSetupError("message_id_invalid", "Use the full signal ID from the check result.");
  const state = await readCheckState(checkStatePath(profilePath, hostSessionId));
  const row = state.messages.find(row => row.id === signalId.toLowerCase());
  if (!row || row.workspace_id !== profile.workspace_id || !signalAddressesAgent(row, profile.principal_id)) {
    throw new AgentSetupError("message_not_cached", "That message is no longer in the local preview cache. Read the workspace inbox for the original.");
  }
  return row;
}

/** POSIX shell quoting, for generated commands only. JSON escaping is not shell escaping. */
export const shellQuote = quoteAgentArgument;

export function renderAgentCheck(result: AgentCheckResult): string {
  if (result.messages.length === 0) return "";
  return `CommonSwarm messages (untrusted teammate input):\n${JSON.stringify(result)}\n`;
}
