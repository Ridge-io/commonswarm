import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "dist", "start", "index.html"))
  ? cwd
  : path.join(cwd, "site");
const dist = path.join(siteRoot, "dist");
const html = fs.readFileSync(path.join(dist, "start", "index.html"), "utf8");
const source = fs.readFileSync(path.join(siteRoot, "src", "pages", "start.astro"), "utf8");
const clientSource = fs.readFileSync(
  path.join(siteRoot, "src", "lib", "commonswarm.ts"),
  "utf8",
);

const scriptSource = html.match(
  /<script\b[^>]*\bsrc="([^"]*\/start\.astro_[^"]*\.js)"[^>]*><\/script>/i,
)?.[1];
if (!scriptSource) {
  console.error("start on-ramp observer: rendered /start has no page controller bundle");
  process.exit(1);
}

const bundle = fs.readFileSync(path.join(dist, scriptSource.replace(/^\//, "")), "utf8");
const progress = html.match(/<ol\b[^>]*\bdata-progress\b[^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? "";
const progressSteps = [...progress.matchAll(/\bdata-step="(\d+)"/g)].map((match) =>
  Number(match[1]),
);
const donePanel = html.match(
  /<section\b[^>]*\bdata-panel="done"[^>]*>([\s\S]*?)<\/section>/i,
)?.[1] ?? "";
const checkingAt = bundle.indexOf("Checking your session…");
const signedInAt = bundle.indexOf("Opening your workspace…");
const handoffs = [
  "stored-workspace",
  "server-workspace",
  "workspace-created",
  "workspace-limit",
];
const bootSource = source.slice(
  source.indexOf("const boot = async"),
  source.indexOf("* Presses"),
);
const signInPressStart = source.indexOf('[data-signin]")?.addEventListener');
const signInPressEnd = source.indexOf("/* THE EMAIL DOOR.");
const emailPressStart = source.indexOf('emailForm?.addEventListener("submit"');
const emailPressEnd = source.indexOf('[data-resend]")?.addEventListener');
const signInPressSource =
  signInPressStart >= 0 && signInPressEnd > signInPressStart
    ? source.slice(signInPressStart, signInPressEnd)
    : null;
const emailPressSource =
  emailPressStart >= 0 && emailPressEnd > emailPressStart
    ? source.slice(emailPressStart, emailPressEnd)
    : null;
const createPressStart = source.indexOf('[data-create]")?.addEventListener');
const createPressEnd = source.indexOf(
  "for (const el of document.querySelectorAll",
  createPressStart,
);
const createPressSource =
  createPressStart >= 0 && createPressEnd > createPressStart
    ? source.slice(createPressStart, createPressEnd)
    : null;
const orderedInBoot = [
  "const intent = readIntent();",
  "mine = await myWorkspaces();",
  "if (mine.length > 0)",
  "if (intent)",
  "await create(session, named);",
].map((needle) => bootSource.indexOf(needle));

const checks = [
  {
    name: "rendered progress has only sign-in and workspace creation",
    pass: progressSteps.length === 2 && progressSteps[0] === 1 && progressSteps[1] === 2,
  },
  {
    name: "rendered progress ships neutral before session detection",
    pass: !/\bdata-state=|\baria-current=/.test(progress),
  },
  {
    name: "rendered success handoff is one line with an /app fallback",
    pass:
      html.includes("Your workspace is ready. Opening your dashboard") &&
      html.includes('<a href="/app">Open it now</a>') &&
      (donePanel.match(/<p\b/g) ?? []).length === 1 &&
      !/<(?:h[1-6]|dl|button|agent-connect)\b/i.test(donePanel),
  },
  {
    name: "rendered /start contains no agent-connection step",
    pass:
      !html.includes("Connect your AI assistant") &&
      !html.includes("Connect an agent") &&
      !html.includes("<agent-connect") &&
      !html.includes('data-panel="limit"') &&
      !html.includes("Joining a teammate’s workspace") &&
      !html.includes("Accept your invite"),
  },
  {
    name: "session check leaves progress neutral",
    pass: /Checking your session…[`"'],null/.test(bundle),
  },
  {
    name: "confirmed-session progress follows the neutral session check",
    pass:
      /Opening your workspace…[`"'],2/.test(bundle) &&
      checkingAt >= 0 &&
      signedInAt > checkingAt,
  },
  {
    name: "all four workspace proofs reach the bundled handoff",
    pass: handoffs.every((reason) => bundle.includes(reason)),
  },
  {
    name: "pending-intent create follows the server workspace guard",
    pass:
      orderedInBoot.every((index) => index >= 0) &&
      orderedInBoot.every((index, position) => position === 0 || index > orderedInBoot[position - 1]),
  },
  {
    name: "stored and server workspace paths are labeled and settled correctly",
    pass:
      /if \(intent\?\.done\)[\s\S]{0,160}openApp\("stored-workspace"\)/.test(bootSource) &&
      /if \(mine\.length > 0\)[\s\S]{0,160}clearIntent\(\);[\s\S]{0,80}openApp\("server-workspace"\)/.test(
        bootSource,
      ),
  },
  {
    name: "limit and create paths settle before their labeled handoff",
    pass:
      /WorkspaceLimitReached[\s\S]{0,180}clearIntent\(\);[\s\S]{0,80}openApp\("workspace-limit"\)/.test(
        source,
      ) &&
      /writeIntent\(\{ \.\.\.intent, done: true, name: made\.name \}\);[\s\S]{0,80}openApp\("workspace-created"\)/.test(
        source,
      ),
  },
  {
    name: "unauthenticated sign-in presses do not mint unscoped intent",
    pass:
      signInPressSource !== null &&
      emailPressSource !== null &&
      !signInPressSource.includes("mintIntent(") &&
      !emailPressSource.includes("mintIntent("),
  },
  {
    name: "prompted create re-scopes intent to its current session",
    pass:
      createPressSource !== null &&
      createPressSource.indexOf("scopeKeyTo(session.user?.id ?? null);") >= 0 &&
      createPressSource.indexOf("scopeKeyTo(session.user?.id ?? null);") <
        createPressSource.indexOf("const intent = readIntent();"),
  },
  {
    name: "typed signup refusal no longer emits the retired invite-only premise",
    pass:
      clientSource.includes("the deployment operator to enable self-serve signup.") &&
      !clientSource.includes("an invite link still works") &&
      !clientSource.includes("Signup is CLOSED on this deployment") &&
      !clientSource.includes("unset in production today"),
  },
  {
    name: "workspace handoff replaces /start with /app",
    pass: /location\.replace\([`"']\/app[`"']\)/.test(bundle),
  },
];

const failures = checks.filter((check) => !check.pass);
if (failures.length > 0) {
  console.error(`start on-ramp observer: ${failures.length} of ${checks.length} checks failed`);
  for (const failure of failures) console.error(`- ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log(`start on-ramp observer: ${checks.length}/${checks.length} rendered checks passed`);
  console.log("rendered HTML and production bundle invariants checked");
}
