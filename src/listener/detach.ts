import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { posix, win32 } from "node:path";
import { sanitizeChildEnv } from "../host/env.js";

export interface ListenerChildSpec {
  entrypoint: string;
  url: string;
  anonKey: string;
  workspaceId: string;
  principalId: string;
  cwd: string;
  permissionMode: "deny" | "allow";
  provider?: "grok" | "opencode" | "claude" | "codex";
  stateDirectory?: string;
  /** Grok binary override (provider grok). */
  executable?: string;
  /** OpenCode binary override (provider opencode). */
  opencodeExecutable?: string;
  /** Claude ACP bridge override (provider claude). */
  claudeExecutable?: string;
  /** Codex ACP bridge override (provider codex). */
  codexExecutable?: string;
  model?: string;
  /** Grok-only; must not be set for opencode, claude, or codex. */
  effort?: string;
  nodeExecArgv?: string[];
}

export type ListenerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Validate executable paths with the syntax of the platform that will spawn them. */
export function isNativeAbsolutePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    ? win32.isAbsolute(value)
    : posix.isAbsolute(value);
}

/** Keep only the dev loader needed for a TypeScript source entrypoint. */
export function listenerNodeExecArgv(values: readonly string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--enable-source-maps") {
      safe.push(value);
      continue;
    }
    if (value === "--import" && values[index + 1] === "tsx") {
      safe.push("--import", "tsx");
      index += 1;
      continue;
    }
    if (value === "--import=tsx") safe.push(value);
  }
  return safe;
}

/** Public-only argv; the credential is intentionally not accepted here. */
export function buildListenerChildArgs(spec: ListenerChildSpec): string[] {
  const provider = spec.provider ?? "grok";
  if (provider !== "grok" && spec.effort) {
    throw new Error(
      `--effort is not supported for --provider ${provider} (no measured mapping)`,
    );
  }
  if ((provider === "claude" || provider === "codex") && spec.model) {
    throw new Error(
      `--model is not supported for --provider ${provider} (no measured bridge mapping)`,
    );
  }
  const opencodeExe = spec.opencodeExecutable ??
    (provider === "opencode" ? spec.executable : undefined);
  const claudeExe = spec.claudeExecutable ??
    (provider === "claude" ? spec.executable : undefined);
  const codexExe = spec.codexExecutable ??
    (provider === "codex" ? spec.executable : undefined);
  if (provider === "opencode") {
    // Detached supervisors must not resolve ambiguous bare "opencode" on PATH.
    if (!opencodeExe || !opencodeExe.startsWith("/")) {
      throw new Error(
        "detached --provider opencode requires an absolute --opencode-executable path",
      );
    }
  }
  if (provider === "claude") {
    if (!claudeExe || !isNativeAbsolutePath(claudeExe)) {
      throw new Error(
        "detached --provider claude requires an absolute --claude-executable path",
      );
    }
  }
  if (provider === "codex") {
    if (!codexExe || !isNativeAbsolutePath(codexExe)) {
      throw new Error(
        "detached --provider codex requires an absolute --codex-executable path",
      );
    }
  }
  return [
    ...listenerNodeExecArgv(spec.nodeExecArgv ?? []),
    spec.entrypoint,
    "__listen-supervisor",
    "--url",
    spec.url,
    "--anon-key",
    spec.anonKey,
    "--workspace-id",
    spec.workspaceId,
    "--principal-id",
    spec.principalId,
    "--cwd",
    spec.cwd,
    "--permissions",
    spec.permissionMode,
    "--provider",
    provider,
    ...(spec.stateDirectory
      ? ["--state-dir", spec.stateDirectory]
      : []),
    ...(provider === "grok" && spec.executable
      ? ["--grok-executable", spec.executable]
      : []),
    ...(provider === "opencode" && opencodeExe
      ? ["--opencode-executable", opencodeExe]
      : []),
    ...(provider === "claude" && claudeExe
      ? ["--claude-executable", claudeExe]
      : []),
    ...(provider === "codex" && codexExe
      ? ["--codex-executable", codexExe]
      : []),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(provider === "grok" && spec.effort ? ["--effort", spec.effort] : []),
  ];
}

/**
 * Spawn a detached supervisor and hand the one-time credential through a pipe.
 * The token never enters argv or env; stdout/stderr are ignored because safe
 * metadata logging is owned by the supervisor.
 */
export async function spawnDetachedListener(options: {
  spec: ListenerChildSpec;
  credentialArtifact: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: ListenerSpawn;
}): Promise<ChildProcess> {
  if (
    options.credentialArtifact.length < 1 ||
    options.credentialArtifact.length > 4_096
  ) {
    throw new Error("listener credential artifact is outside the stdin bound");
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    buildListenerChildArgs(options.spec),
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: sanitizeChildEnv(options.env ?? process.env),
    },
  );
  if (!child.stdin) {
    child.kill();
    throw new Error("detached listener child has no credential pipe");
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.stdin!.end(options.credentialArtifact, "utf8", () => {
      child.off("error", onError);
      resolve();
    });
  });
  child.unref();
  return child;
}
