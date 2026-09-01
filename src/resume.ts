import { execFile } from "node:child_process";
import type { BrainTopicSnapshot } from "./cloud/brain.js";
import type { CloudTarget } from "./cloud/config.js";
import {
  FileBrainDigestStore,
  listenerPaths,
  queryListenerControl,
  readListenerStatusIfPresent,
  type ListenerPaths,
  type ListenerStatus,
} from "./listener/index.js";

export interface ResumeIdentity {
  displayName: string;
  principalId: string;
}

export interface ProcessRow {
  pid: number;
  command: string;
}

export interface ProcessTableAdapter {
  list(): Promise<readonly ProcessRow[]>;
}

export type StdoutConsumerState =
  | "live_reader"
  | "orphaned"
  | "not_pipe"
  | "cannot_determine";

export interface StdoutConsumerAdapter {
  inspect(pid: number): Promise<StdoutConsumerState>;
}

export interface NotifyWatcher {
  pid: number;
  matchedBy: Array<"agent_token_file" | "principal_id">;
  stdout: StdoutConsumerState;
}

export interface ResumeListenerInspection {
  checkedDirectory: string;
  status: ListenerStatus | null;
  source: "live_process" | "recorded_file" | "not_found";
}

export interface ResumeInboxCount {
  count: number;
  exact: boolean;
}

export interface ResumeInspection {
  identity: ResumeIdentity;
  listener: ResumeListenerInspection;
  watchers: NotifyWatcher[];
  brain: {
    digest: string | null;
    highWaterFile: string;
  };
  inbox: ResumeInboxCount;
  target: CloudTarget;
  workspaceId: string;
  credentialFile: string;
  installedVersion: string;
}

export interface ResumeInspectionAdapters {
  readIdentity(): Promise<ResumeIdentity>;
  readBrainTopics(): Promise<readonly BrainTopicSnapshot[]>;
  readInboxCount(
    principalId: string,
    instanceDirectory: string,
  ): Promise<ResumeInboxCount>;
  processTable?: ProcessTableAdapter;
  stdoutConsumer?: StdoutConsumerAdapter;
  queryStatus?: (
    paths: ListenerPaths,
    command: "status",
  ) => Promise<ListenerStatus>;
  readStatus?: (paths: ListenerPaths) => Promise<ListenerStatus | null>;
}

export interface ResumeInspectionOptions {
  target: CloudTarget;
  workspaceId: string;
  credentialFile: string;
  credentialPathAliases?: readonly string[];
  installedVersion: string;
  stateDirectory?: string;
}

function execFileText(
  file: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Host process inventory without a shell, so command text is never executed. */
export function systemProcessTable(): ProcessTableAdapter {
  return {
    async list() {
      const output = await execFileText("ps", ["-axo", "pid=,command="]);
      return output.split("\n").flatMap((line): ProcessRow[] => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) return [];
        const pid = Number(match[1]);
        return Number.isSafeInteger(pid) && pid > 0
          ? [{ pid, command: match[2]! }]
          : [];
      });
    },
  };
}

/** macOS lsof can distinguish a live unix-pipe peer from `->(none)`. */
export function lsofStdoutConsumer(): StdoutConsumerAdapter {
  return {
    async inspect(pid) {
      let output: string;
      try {
        output = await execFileText(
          process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
          ["-nP", "-a", "-p", String(pid), "-d", "1", "-F", "pftan"],
        );
      } catch {
        return "cannot_determine";
      }
      const lines = output.split("\n");
      const type = lines.find((line) => line.startsWith("t"))?.slice(1) ?? "";
      const names = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1));
      if (type === "unix") {
        if (names.some((name) => name === "->(none)")) return "orphaned";
        if (names.some((name) => name.startsWith("->") && name !== "->(none)")) {
          return "live_reader";
        }
        return "cannot_determine";
      }
      if (type === "PIPE" || type === "FIFO") return "cannot_determine";
      return type.length === 0 ? "cannot_determine" : "not_pipe";
    },
  };
}

function commandHasFlagValue(
  command: string,
  flag: string,
  values: readonly string[],
): boolean {
  for (const value of values) {
    const marker = `${flag} ${value}`;
    let start = command.indexOf(marker);
    while (start !== -1) {
      const before = start === 0 ? " " : command[start - 1]!;
      const afterIndex = start + marker.length;
      const after = afterIndex >= command.length ? " " : command[afterIndex]!;
      if (/\s/.test(before) && /\s/.test(after)) return true;
      start = command.indexOf(marker, start + 1);
    }
  }
  return false;
}

function isNotifyCommand(command: string): boolean {
  return /(?:^|\s)inbox(?:\s|$)/.test(command) &&
    /(?:^|\s)--notify(?:\s|$)/.test(command);
}

/** Find only notify processes for this credential path or authenticated principal. */
export async function findNotifyWatchers(options: {
  credentialPaths: readonly string[];
  principalId: string;
  processTable?: ProcessTableAdapter;
  stdoutConsumer?: StdoutConsumerAdapter;
}): Promise<NotifyWatcher[]> {
  const processTable = options.processTable ?? systemProcessTable();
  const stdoutConsumer = options.stdoutConsumer ?? lsofStdoutConsumer();
  const rows = await processTable.list();
  const matches = rows.flatMap((row): Array<Omit<NotifyWatcher, "stdout">> => {
    if (!isNotifyCommand(row.command)) return [];
    const matchedBy: NotifyWatcher["matchedBy"] = [];
    if (commandHasFlagValue(row.command, "--agent-token-file", options.credentialPaths)) {
      matchedBy.push("agent_token_file");
    }
    if (commandHasFlagValue(row.command, "--principal-id", [options.principalId])) {
      matchedBy.push("principal_id");
    }
    return matchedBy.length === 0 ? [] : [{ pid: row.pid, matchedBy }];
  });
  const unique = [...new Map(matches.map((row) => [row.pid, row])).values()]
    .sort((left, right) => left.pid - right.pid);
  return await Promise.all(unique.map(async (row) => ({
    ...row,
    stdout: await stdoutConsumer.inspect(row.pid),
  })));
}

/** Query a live process, then read its file without rewriting stale state. */
export async function readOnlyListenerInspection(
  paths: ListenerPaths,
  adapters: Pick<ResumeInspectionAdapters, "queryStatus" | "readStatus"> = {},
): Promise<ResumeListenerInspection> {
  const query = adapters.queryStatus ?? queryListenerControl;
  const read = adapters.readStatus ?? readListenerStatusIfPresent;
  try {
    return {
      checkedDirectory: paths.instanceDirectory,
      status: await query(paths, "status"),
      source: "live_process",
    };
  } catch {
    const status = await read(paths);
    return {
      checkedDirectory: paths.instanceDirectory,
      status,
      source: status === null ? "not_found" : "recorded_file",
    };
  }
}

/** Collect the reconnect facts in the same order the command renders them. */
export async function inspectResume(
  options: ResumeInspectionOptions,
  adapters: ResumeInspectionAdapters,
): Promise<ResumeInspection> {
  const identity = await adapters.readIdentity();
  const principalId = identity.principalId.toLowerCase();
  const paths = listenerPaths({
    profileId: options.target.profileId,
    workspaceId: options.workspaceId,
    principalId,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
  });
  const listener = await readOnlyListenerInspection(paths, adapters);
  const watchers = await findNotifyWatchers({
    credentialPaths: options.credentialPathAliases ?? [options.credentialFile],
    principalId,
    ...(adapters.processTable ? { processTable: adapters.processTable } : {}),
    ...(adapters.stdoutConsumer ? { stdoutConsumer: adapters.stdoutConsumer } : {}),
  });
  const topics = await adapters.readBrainTopics();
  const digestStore = new FileBrainDigestStore(paths.instanceDirectory, principalId);
  const digest = await digestStore.preview(topics);
  const inbox = await adapters.readInboxCount(principalId, paths.instanceDirectory);
  return {
    identity: { ...identity, principalId },
    listener,
    watchers,
    brain: { digest, highWaterFile: digestStore.location },
    inbox,
    target: options.target,
    workspaceId: options.workspaceId,
    credentialFile: options.credentialFile,
    installedVersion: options.installedVersion,
  };
}

function safeText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 2_000);
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commonCommandArgs(report: ResumeInspection): string {
  return [
    "--agent-token-file",
    shellArg(report.credentialFile),
    "--url",
    shellArg(report.target.url),
    "--anon-key",
    shellArg(report.target.anonKey),
    "--workspace-id",
    report.workspaceId,
  ].join(" ");
}

function restartCommand(report: ResumeInspection, status: ListenerStatus): string {
  const common = commonCommandArgs(report);
  const route = status.routeMode ?? "worker";
  const start = [
    "cswarm listen start",
    common,
    `--provider ${status.provider}`,
    `--permissions ${status.permissionMode ?? "allow"}`,
    `--route ${route}`,
    ...(route === "split" && status.deferOverChars !== null &&
        status.deferOverChars !== undefined
      ? [`--defer-over ${status.deferOverChars}`]
      : []),
  ].join(" ");
  return `cswarm listen stop ${common} && ${start}`;
}

function watcherStateLine(watcher: NotifyWatcher): string {
  const matched = watcher.matchedBy.map((value) =>
    value === "agent_token_file" ? "credential path" : "principal id"
  ).join(" and ");
  const state = watcher.stdout === "live_reader"
    ? "stdout has a live pipe reader"
    : watcher.stdout === "orphaned"
    ? "ORPHAN: stdout pipe has no reader"
    : watcher.stdout === "not_pipe"
    ? "stdout is not a pipe; the dead-reader check does not apply"
    : "stdout reader cannot be determined on this host";
  return `- PID ${watcher.pid}: ${state}; matched ${matched}.`;
}

/** Stable human output: identity, listener, watchers, brain, then inbox. */
export function renderResume(report: ResumeInspection): string {
  const lines = [
    "Identity",
    `You are ${safeText(report.identity.displayName)} (${report.identity.principalId}).`,
    "Next: use this principal for every listener, watcher, brain, and inbox check below.",
    "",
    "Listener",
  ];
  const listener = report.listener;
  const status = listener.status;
  if (status === null) {
    lines.push(
      `No listener found under ${safeText(listener.checkedDirectory)} for profile ${report.target.profileId}.`,
      `Next: start one with the original provider: cswarm listen start ${commonCommandArgs(report)} --provider <provider>`,
    );
  } else {
    if (listener.source === "live_process") {
      lines.push(
        `Found under ${safeText(listener.checkedDirectory)}. State: ${status.state}, reported by running PID ${status.pid}.`,
      );
    } else {
      lines.push(
        `Found a status file under ${safeText(listener.checkedDirectory)}. Recorded state: ${status.state}; the control socket did not answer, so a running listener is not established.`,
      );
    }
    const runningVersion = status.cswarmVersion ?? null;
    if (listener.source !== "live_process") {
      lines.push(
        `Running listener cswarm version: cannot determine because the process did not answer; status file recorded ${runningVersion ?? "no version"}; installed CLI: ${report.installedVersion}.`,
        `Next: restart the listener because its process did not answer: ${restartCommand(report, status)}`,
      );
    } else if (runningVersion === null) {
      lines.push(
        `Listener cswarm version: cannot determine from this listener; installed CLI: ${report.installedVersion}.`,
        `Next: restart it to make the running version reportable: ${restartCommand(report, status)}`,
      );
    } else if (runningVersion !== report.installedVersion) {
      lines.push(
        `VERSION MISMATCH: listener runs ${runningVersion}; installed ${report.installedVersion} — restart it: ${restartCommand(report, status)}`,
      );
    } else {
      lines.push(
        `Listener-reported cswarm: ${runningVersion}; installed CLI: ${report.installedVersion}.`,
        "Next: no listener restart is needed for a version change.",
      );
    }
  }

  lines.push(
    "",
    "Notify watchers",
    `Checked process arguments for inbox --notify matching --agent-token-file ${safeText(report.credentialFile)} or --principal-id ${report.identity.principalId}.`,
  );
  if (report.watchers.length === 0) {
    lines.push(
      "Found: 0.",
      `Next: start one watcher under a live Monitor: cswarm inbox --notify ${commonCommandArgs(report)}`,
    );
  } else {
    lines.push(`Found: ${report.watchers.length}.`);
    lines.push(...report.watchers.map(watcherStateLine));
    const orphans = report.watchers.filter((watcher) => watcher.stdout === "orphaned");
    if (orphans.length > 0) {
      lines.push(
        `Next: stop only the orphan watcher${orphans.length === 1 ? "" : "s"}; CommonSwarm did not kill anything: kill ${orphans.map((watcher) => watcher.pid).join(" ")}`,
      );
    } else if (report.watchers.some((watcher) => watcher.stdout === "cannot_determine")) {
      lines.push(
        "Next: verify each unknown stdout reader in the host Monitor before you start another watcher.",
      );
    } else {
      lines.push("Next: keep one watcher with a live output surface; do not start a duplicate.");
    }
  }

  lines.push(
    "",
    "Brain digest",
    `Checked ${safeText(report.brain.highWaterFile)} without advancing it.`,
  );
  if (report.brain.digest === null) {
    lines.push(
      "No brain topic is new or changed since this principal's digest high-water.",
      "Next: no brain read is needed now.",
    );
  } else {
    lines.push(report.brain.digest, "Next: read any needed topic with the command above.");
  }

  const inboxCount = report.inbox.exact
    ? String(report.inbox.count)
    : `at least ${report.inbox.count}`;
  lines.push(
    "",
    "Unread inbox",
    `Unread directed asks and notes from the same read used by the hook: ${inboxCount}.`,
    report.inbox.count === 0
      ? "Next: no inbox action is needed now."
      : `Next: read them without acknowledging them first: cswarm inbox ${commonCommandArgs(report)}`,
    "",
    "Read-only check complete. No cursor, brain high-water, listener status, receipt, acknowledgement, or process was changed.",
  );
  return lines.join("\n");
}

/** Machine form mirrors the five human sections and keeps watcher commands out. */
export function resumeJson(report: ResumeInspection): Record<string, unknown> {
  return {
    identity: {
      display_name: report.identity.displayName,
      principal_id: report.identity.principalId,
    },
    listener: {
      found: report.listener.status !== null,
      checked_directory: report.listener.checkedDirectory,
      source: report.listener.source,
      state: report.listener.status?.state ?? null,
      pid: report.listener.status?.pid ?? null,
      running_cswarm_version: report.listener.source === "live_process"
        ? report.listener.status?.cswarmVersion ?? null
        : null,
      installed_cswarm_version: report.installedVersion,
      version_mismatch: report.listener.source === "live_process" &&
        report.listener.status?.cswarmVersion !== null &&
        report.listener.status?.cswarmVersion !== undefined &&
        report.listener.status.cswarmVersion !== report.installedVersion,
    },
    notify_watchers: report.watchers.map((watcher) => ({
      pid: watcher.pid,
      matched_by: watcher.matchedBy,
      stdout: watcher.stdout,
    })),
    brain: {
      high_water_file: report.brain.highWaterFile,
      high_water_advanced: false,
      digest: report.brain.digest,
    },
    unread_inbox: report.inbox,
    read_only: true,
  };
}
