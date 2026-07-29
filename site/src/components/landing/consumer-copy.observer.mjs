import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "dist", "index.html"))
  ? cwd
  : path.join(cwd, "site");
const dist = path.join(siteRoot, "dist");

const decode = (value) =>
  value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)));

const renderedMainText = (file) => {
  const html = fs.readFileSync(file, "utf8");
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) throw new Error(`${file}: built page has no <main>`);
  return decode(
    main
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
};

const pages = {
  home: renderedMainText(path.join(dist, "index.html")),
  start: renderedMainText(path.join(dist, "start", "index.html")),
};

const required = {
  home: [
    "Accelerate teamwork with agent-to-agent chat.",
    "Create your free workspace",
    "What are you working on?",
    "Preparing the customer launch email.",
    "Maya is already drafting it",
    "A signal announces. It never locks.",
    "For technical teams:",
    'cswarm working-on "wiring the payments webhook"',
    "Sign up now with email or GitHub.",
  ],
  start: [
    "Create a shared workspace for your AI assistants.",
    "A workspace is the shared feed",
    "Reload and try again",
    "Turn on JavaScript and reload this page",
    "Connect your AI assistant",
    "Create a temporary key for the assistant you already use.",
    "Before you paste it.",
    "Clear this key now.",
    "The installer is published at the address above.",
  ],
};

const typedStops = {
  SignupRefused: [
    "CommonSwarm can’t create a workspace right now",
    "come back later and start again from this page",
  ],
  WorkspaceLimitReached: [
    "Your three workspaces are ready to use",
    "Open your dashboard",
  ],
  EmailNotVerified: [
    "Confirm your email before creating a workspace",
    "confirm the address, then reload this page",
  ],
  EmailDomainNotAccepted: [
    "This email provider can’t be used for signup",
    "Sign out and use another email",
  ],
  ClientTooOld: [
    "This page needs the current version",
    "Reload this page to get the current version",
  ],
  NoDeployment: [
    "This saved copy can’t start signup",
    "Open the live signup page",
  ],
};

const forbidden = {
  home: [
    "not switched on for everyone",
    "the flow is a preview",
    "There is no signup",
  ],
  start: [
    "SWARM_CLOUD_URL",
    "SWARM_CLOUD_ANON_KEY",
    "PUBLIC_SUPABASE_URL",
    "PUBLIC_SUPABASE_ANON_KEY",
    "commonswarm:url",
    "commonswarm:anon-key",
    "meta tags",
    "Workspace id",
    "Workspace ID",
    "verified identity",
    "This step isn’t on the page yet",
    "This step isn't on the page yet",
    "<host>",
    "Agent identity",
    "agent identity",
    "credential",
    "deployment",
    "backend",
  ],
};

let checks = 0;
const failures = [];

for (const [page, needles] of Object.entries(required)) {
  for (const needle of needles) {
    checks += 1;
    if (!pages[page].includes(needle)) {
      failures.push(`${page}: rendered text is missing ${JSON.stringify(needle)}`);
    }
  }
}

for (const [page, needles] of Object.entries(forbidden)) {
  for (const needle of needles) {
    checks += 1;
    if (pages[page].includes(needle)) {
      failures.push(`${page}: rendered text still contains ${JSON.stringify(needle)}`);
    }
  }
}

for (const [name, needles] of Object.entries(typedStops)) {
  for (const needle of needles) {
    checks += 1;
    if (!pages.start.includes(needle)) {
      failures.push(
        `start/${name}: rendered text is missing next-action copy ${JSON.stringify(needle)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`consumer-copy observer: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`consumer-copy observer: ${checks} checks across built / and /start passed`);
  console.log(`typed stops covered: ${Object.keys(typedStops).join(", ")}`);
}
