#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [
  roundRaw, uxtestDir, miniRoot, setupPath, outputDir, human1, human2,
] = process.argv.slice(2);
const round = Number(roundRaw);
if (!Number.isSafeInteger(round) || round < 1) throw new Error("invalid round");

let remoteRaw = "";
for await (const chunk of process.stdin) remoteRaw += chunk.toString();
const remote = JSON.parse(remoteRaw);
const setup = JSON.parse(readFileSync(setupPath, "utf8"));
const preflightPath = join(outputDir, "preflight.json");
if (!existsSync(preflightPath)) {
  throw new Error("round is missing its authoritative preflight membership snapshot");
}
const preflight = JSON.parse(readFileSync(preflightPath, "utf8"));
if (
  preflight.round !== round ||
  !Number.isInteger(preflight.current_live_memberships) ||
  preflight.current_live_memberships < 0 ||
  !Number.isInteger(preflight.projected_live_memberships) ||
  preflight.projected_live_memberships < preflight.current_live_memberships ||
  preflight.projected_live_memberships > preflight.current_live_memberships + 1 ||
  typeof preflight.multi_project_path !== "boolean" ||
  preflight.multi_project_path !== (preflight.projected_live_memberships > 1)
) {
  throw new Error("preflight membership snapshot is invalid or inconsistent");
}
const localCwd = join(miniRoot, "human1", "workspace");

const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : null;
const readJsonl = (path) => {
  const raw = read(path);
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
};

const local = {
  feedback: read(join(localCwd, "FEEDBACK.md")),
  journal: read(join(localCwd, "JOURNAL.md")),
  result: read(join(localCwd, "RESULT.md")),
  isolationVoid: read(join(localCwd, "ISOLATION_VOID.md")),
  commands: readJsonl(join(miniRoot, "logs", `r${round}`, "human1.jsonl")),
  isolationEvents: readJsonl(
    join(miniRoot, "logs", `r${round}`, "isolation-events.jsonl"),
  ).filter((event) => event.role === "human1"),
};

if (!local.feedback || !remote.feedback) {
  throw new Error(
    "both personas must write FEEDBACK.md before collect; no debrief was sent",
  );
}
if (!local.journal || !remote.journal) {
  throw new Error("both personas must write JOURNAL.md before collect");
}

function parseInvitePayload(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16 * 1024) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return null;
    const parsed = JSON.parse(decoded.toString("utf8"));
    if (
      parsed?.v !== 1 ||
      typeof parsed.url !== "string" ||
      typeof parsed.anon_key !== "string" ||
      typeof parsed.workspace_id !== "string" ||
      typeof parsed.invitation_token !== "string" ||
      typeof parsed.workspace_name !== "string" ||
      typeof parsed.inviter_display_name !== "string"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function capabilityForms(value) {
  const forms = [];
  if (/coswarm:\/\/accept\/[A-Za-z0-9_-]+/.test(value)) forms.push("uri");
  if (/\bswm_inv_[A-Za-z0-9_-]{43}\b/.test(value)) forms.push("token");
  const withoutUris = value.replace(
    /coswarm:\/\/accept\/[A-Za-z0-9_-]+/g,
    " ",
  );
  for (const candidate of withoutUris.match(/\b[A-Za-z0-9_-]{20,16384}\b/g) ?? []) {
    if (parseInvitePayload(candidate)) forms.push("bare");
  }
  return [...new Set(forms)];
}

function redact(value) {
  if (value === null || value === undefined) return value;
  let redacted = String(value)
    .replace(
      /coswarm:\/\/accept\/[A-Za-z0-9_-]+/g,
      "[INVITE LINK REDACTED]",
    )
    .replace(
      /\bswm_inv_[A-Za-z0-9_-]{43}\b/g,
      "[INVITE TOKEN REDACTED]",
    )
    .replace(
      /\bswm_agt_[A-Za-z0-9_-]+\b/g,
      "[AGENT TOKEN REDACTED]",
    );
  redacted = redacted.replace(
    /\b[A-Za-z0-9_-]{20,16384}\b/g,
    (candidate) => parseInvitePayload(candidate)
      ? "[INVITE LINK REDACTED]"
      : candidate,
  );
  return redacted.replace(
    /\beyJ[A-Za-z0-9._-]{20,}\b/g,
    "[TOKEN REDACTED]",
  );
}

const messages = remote.messages.map((message) => ({
  ...message,
  forms: capabilityForms(message.body),
}));
const capabilityMessages = messages.filter((message) => message.forms.length > 0);
const linkDelivery = capabilityMessages.find(
  (message) => message.from_agent === human1 && message.to_agent === human2,
);
const linkReceivedMs = linkDelivery
  ? Date.parse(`${linkDelivery.created_at}`)
  : null;
const linkForms = [...new Set(capabilityMessages.flatMap((message) => message.forms))];

const commands = [...local.commands, ...remote.commands]
  .map((event) => ({
    ...event,
    stdout: redact(event.stdout ?? ""),
    stderr: redact(event.stderr ?? ""),
  }))
  .sort((left, right) => left.started_at_ms - right.started_at_ms);
const firstCommandMs = commands[0]?.started_at_ms ?? null;
const firstByRole = Object.fromEntries(
  ["human1", "human2"].map((role) => [
    role,
    commands.find((event) => event.role === role)?.started_at_ms ?? null,
  ]),
);
const firstAccept = commands.find(
  (event) => event.role === "human2" && event.accept_attempt,
);
const connected = commands.find(
  (event) =>
    event.role === "human2" &&
    event.accept_attempt &&
    event.exit_code === 0,
);

const requestPattern =
  /\b(?:stuck|help|confused|not sure|what should|how do|can't figure|cannot figure)\b/i;
const helpRequests = messages.filter((message) => requestPattern.test(message.body));
const earlyHelpRequests = [];
const eligibleHelpRequests = [];
for (const message of helpRequests) {
  const role = message.from_agent === human1 ? "human1" : "human2";
  const roleStart = firstByRole[role];
  const requestMs = Date.parse(`${message.created_at}`);
  const record = {
    at: message.created_at,
    from: message.from_agent,
    quote: redact(message.body),
  };
  if (roleStart !== null && requestMs - roleStart >= 600_000) {
    eligibleHelpRequests.push({ ...record, id: message.id });
  } else {
    earlyHelpRequests.push(record);
  }
}
const partnerRescued = [];
for (const request of eligibleHelpRequests) {
  const reply = messages.find(
    (message) =>
      message.id > request.id &&
      message.from_agent !== request.from &&
      Date.parse(`${message.created_at}`) >= Date.parse(request.at),
  );
  if (reply) {
    partnerRescued.push({
      request: request.quote,
      response: redact(reply.body),
      response_at: reply.created_at,
    });
  }
}

const normalizeResult = (value) => value
  ?.trim()
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n") ?? "";
const localResult = normalizeResult(local.result);
const remoteResult = normalizeResult(remote.result);
const taskCompleted = Boolean(
  localResult &&
  remoteResult &&
  localResult === remoteResult,
);

const gaveUpMessage = messages.find((message) => /\[gave up\]/i.test(message.body));
const gaveUp = Boolean(gaveUpMessage);
const gaveUpReason = gaveUpMessage
  ? redact(gaveUpMessage.body.replace(/\[gave up\]\s*:?\s*/i, "").trim()) || null
  : null;

const isolationEvents = [...local.isolationEvents, ...remote.isolationEvents];
const transcriptVoid = messages.some(
  (message) => /\[isolation void\]/i.test(message.body),
);
const isolationVoid = Boolean(
  local.isolationVoid ||
  remote.isolationVoid ||
  isolationEvents.length > 0 ||
  transcriptVoid,
);
const decoderTools = new Set([
  "base64", "node", "python", "python3", "jq", "openssl", "perl", "ruby",
]);
const linkInspected = isolationEvents.some(
  (event) =>
    event.kind === "inspection-capable-tool" &&
    decoderTools.has(event.tool) &&
    (linkReceivedMs === null || event.at_ms >= linkReceivedMs),
);

const errorLines = commands
  .filter((event) => event.exit_code !== 0)
  .flatMap((event) => event.stderr.split(/\r?\n/))
  .map((line) => line.trim())
  .filter(Boolean);
const uniqueErrors = [...new Set(errorLines)].slice(0, 50);
const helpInvocations = commands.filter((event) => event.help).length;
const nonzeroExits = commands.filter((event) => event.exit_code !== 0).length;
const commandSequence = commands.map(
  (event) => `${event.role}:${event.command}`,
);
const golden = ["human1:login", "human1:invite", "human2:accept"];

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[left.length][right.length];
}

const journals = [local.journal, remote.journal];
const uninterpretable = journals.flatMap((journal, index) =>
  journal.split(/\r?\n/)
    .filter((line) => /UNINTERPRETABLE:/i.test(line))
    .map((line) => ({
      role: index === 0 ? "human1" : "human2",
      quote: redact(line.trim()),
    })));
const resetMs = Date.parse(setup.reset_completed_at ?? setup.reset_started_at);

const metrics = {
  wall_clock_link_to_connected:
    linkReceivedMs !== null && connected
      ? Math.max(0, connected.ended_at_ms - linkReceivedMs)
      : null,
  command_interval_timeline: commands.map((event, index) => ({
    at: new Date(event.started_at_ms).toISOString(),
    since_previous_ms: index === 0
      ? null
      : event.started_at_ms - commands[index - 1].ended_at_ms,
    role: event.role,
    command: event.command,
    duration_ms: event.duration_ms,
    exit_code: event.exit_code,
  })),
  coswarm_invocations: commands.length,
  coswarm_invocations_by_role: {
    human1: commands.filter((event) => event.role === "human1").length,
    human2: commands.filter((event) => event.role === "human2").length,
  },
  nonzero_exits: nonzeroExits,
  unique_error_strings: uniqueErrors,
  help_invocations: helpInvocations,
  completed_without_help: taskCompleted && helpInvocations === 0,
  help_requests_to_partner: helpRequests.map((message) => ({
    at: message.created_at,
    from: message.from_agent,
    quote: redact(message.body),
  })),
  early_partner_help_requests: earlyHelpRequests,
  partner_rescued_steps: partnerRescued,
  time_to_first_coswarm:
    firstCommandMs === null || Number.isNaN(resetMs)
      ? null
      : Math.max(0, firstCommandMs - resetMs),
  time_to_first_coswarm_by_role: Object.fromEntries(
    Object.entries(firstByRole).map(([role, timestamp]) => [
      role,
      timestamp === null || Number.isNaN(resetMs)
        ? null
        : Math.max(0, timestamp - resetMs),
    ]),
  ),
  time_to_first_accept_attempt:
    !firstAccept || Number.isNaN(resetMs)
      ? null
      : Math.max(0, firstAccept.started_at_ms - resetMs),
  command_sequence: commandSequence,
  golden_path_distance: editDistance(commandSequence, golden),
  used_link_stdin: commands.some((event) => event.used_link_stdin),
  used_positional_link: commands.some((event) => event.used_positional_link),
  link_pasted_in_chat: Boolean(linkDelivery),
  link_form: linkForms[0] ?? null,
  link_forms: linkForms,
  link_inspected: linkInspected,
  task_completed: taskCompleted,
  gave_up: gaveUp,
  gave_up_reason: gaveUpReason,
  uninterpretable_outputs: uninterpretable,
  coswarm_sha_mini: setup.coswarm_sha_mini,
  coswarm_sha_laptop: setup.coswarm_sha_laptop,
  workspace_id: setup.workspace_id,
  seed_sha: setup.seed_sha,
  oauth_consent: setup.oauth_consent,
  carryover: setup.carryover ?? true,
  multi_project_path: preflight.multi_project_path,
  current_live_memberships: preflight.current_live_memberships,
  projected_live_memberships: preflight.projected_live_memberships,
  join_latency_ms: {
    human1: setup.human1_join_latency_ms ?? null,
    human2: setup.human2_join_latency_ms ?? null,
  },
  join_attempts: {
    human1: setup.human1_join_attempts ?? null,
    human2: setup.human2_join_attempts ?? null,
  },
  isolation_void: isolationVoid,
  isolation_events: isolationEvents,
};

mkdirSync(outputDir, { recursive: true });
mkdirSync(join(outputDir, "journals"), { recursive: true });
mkdirSync(join(outputDir, "results"), { recursive: true });

const safeWrite = (path, value) => {
  const safe = redact(value ?? "");
  if (
    capabilityForms(safe).length > 0 ||
    /\bswm_agt_[A-Za-z0-9_-]+\b/.test(safe) ||
    /\beyJ[A-Za-z0-9._-]{20,}\b/.test(safe)
  ) {
    throw new Error(`credential survived in-flight redaction for ${path}`);
  }
  writeFileSync(path, safe.endsWith("\n") ? safe : `${safe}\n`, { mode: 0o600 });
};

safeWrite(join(outputDir, "human1-feedback.md"), local.feedback);
safeWrite(join(outputDir, "human2-feedback.md"), remote.feedback);
safeWrite(join(outputDir, "journals", "human1.md"), local.journal);
safeWrite(join(outputDir, "journals", "human2.md"), remote.journal);
if (local.result) safeWrite(join(outputDir, "results", "human1.md"), local.result);
if (remote.result) safeWrite(join(outputDir, "results", "human2.md"), remote.result);

const transcript = [
  `# Round ${round} chat`,
  "",
  ...messages.flatMap((message) => [
    `**${message.created_at} — ${message.from_agent} → ${message.to_agent}:**`,
    "",
    redact(message.body),
    "",
  ]),
].join("\n");
safeWrite(join(outputDir, "transcript.md"), transcript);

const metricsJson = `${JSON.stringify(metrics, null, 2)}\n`;
safeWrite(join(outputDir, "metrics.json"), metricsJson);

const biasRows = [
  ["Real emotional friction, fear/trust around OAuth", "**No** — systematic miss"],
  ["Wall-of-text terminal scanning difficulty", "**No**"],
  ["Genuine giving-up under time pressure", "**No / rare** — LLMs grind"],
  ["Misreading jargon the way humans do", "**No** — LLMs parse jargon too well"],
];
const allRows = [
  ["Missing / confusing CLI output", "**Yes** (strong)"],
  ["Dead ends, non-zero loops, wrong next-action in errors", "**Yes** (strong)"],
  ["Unexplained multi-step flows, missing narration", "**Yes** (strong)"],
  ["Broken happy path / version skew", "**Yes** (strong — preflight fails closed)"],
  ["Link hygiene and origin-pin refusal", "**Yes** (medium–strong)"],
  ["Partner-coordination confusion over chat", "**Partial**"],
  ...biasRows,
  ["Install / PATH discovery as a civilian", "**Weak**"],
];
const exactErrors = uniqueErrors.length > 0
  ? uniqueErrors.map((line) => `- \`${line.replace(/`/g, "\\`")}\``).join("\n")
  : "- None observed.";
const report = `# UX test round ${round}

## Validity
- Role-play bias: LLM ≠ non-technical human — classes we cannot claim: ${biasRows.map(([name]) => name).join("; ")}
- Carryover: ${metrics.carryover}  (if true: no discovery-UX claims)
- Isolation: ${isolationVoid ? "VOID" : "clean"}  (if VOID: stop, do not rank findings)
- Partner-rescued steps: ${partnerRescued.length > 0 ? JSON.stringify(partnerRescued) : "[]"}
- Version under test: mini ${setup.coswarm_sha_mini} / laptop ${setup.coswarm_sha_laptop}  (must match)
- OAuth consent: ${setup.oauth_consent}
- Membership path: ${metrics.multi_project_path
  ? `multi-project resolution (preflight current=${metrics.current_live_memberships}, projected=${metrics.projected_live_memberships}; measures workspaces -> use -> invite, not the sole-membership shortcut)`
  : `sole-membership shortcut (preflight current=${metrics.current_live_memberships}, projected=${metrics.projected_live_memberships})`}

| Failure class | Does this harness catch it? |
|---|---|
${allRows.map(([left, right]) => `| ${left} | ${right} |`).join("\n")}

## Objective result

- Connection timing: ${metrics.wall_clock_link_to_connected === null ? "not observed" : `${metrics.wall_clock_link_to_connected} ms`}
- Commands: ${commands.length}; non-zero: ${nonzeroExits}; help: ${helpInvocations}
- Link delivery observed: ${metrics.link_pasted_in_chat}; form: ${metrics.link_form ?? "not observed"}
- Shared task: ${taskCompleted ? "completed with matching two-line results" : "not script-verified"}
- Give-up: ${gaveUp}; isolation: ${isolationVoid ? "VOID" : "clean"}

## Exact non-zero CLI lines

${exactErrors}

## Findings

${isolationVoid
  ? "Round is VOID. Do not rank or salvage findings."
  : "Lead synthesis required. Rank only findings supported by exact CLI lines above or the redacted journals; tag each as solo or partner-rescued from metrics.json."}

## What this round did not test

Workspace creation was fixture-seeded through privileged test setup. This round
does not test governed product workspace creation. The operator's own drive
remains the final word for the failure classes marked No or Weak.
`;
safeWrite(join(outputDir, "REPORT.md"), report);
