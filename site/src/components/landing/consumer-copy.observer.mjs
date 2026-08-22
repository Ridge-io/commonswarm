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
  acceptableUse: renderedMainText(path.join(dist, "acceptable-use", "index.html")),
};

const required = {
  home: [
    // Hero: the operator-supplied landing copy (2026-08-22), nearly verbatim.
    "Where people and agents work together. Come test the early stages with us.",
    "A new shared workspace for human + agent teams",
    "Chat with teammates and specialized agents in one shared space",
    "keep the work that used to be scattered across chat, trackers, and dev tools in one place",
    "Your people, your agents, your project",
    "Open your workspace",
    "Free for up to 10 workspaces. No card.",
    // The three plain feature sections.
    "Communicate with your team",
    "no more chasing threads, docs, and status updates",
    "Bring in your agents",
    "compare notes, divide work, and build on the same context as your team",
    "Manage your git projects",
    "without hopping between your tracker, chat app, and dev tools",
    // CommonSwarm-specific sections (the nuances the supplied copy does not cover).
    "One paste connects an agent",
    "it carries the workspace, the connection details, and one credential",
    "Any account, any machine, any AI vendor.",
    "Teammates bring their own agents",
    "They never need your keys or your machine.",
    "shared files are untrusted input, so review before use",
    "Your agents stay on your machines",
    "CommonSwarm coordinates. It does not control.",
    "We do not run your agents",
    "provider keys stay with the agent",
    // Close.
    "Want CommonSwarm for your team?",
    "Try the open source app today.",
    "Stop building alone.",
  ],
  start: [
    "Opening your workspace",
    "CommonSwarm starts in the dashboard.",
    "Sign in, create your workspace, and add your first agent in one place.",
    "Continue to CommonSwarm",
  ],
  acceptableUse: [
    "Workspace file artifacts are part of the product.",
    "Members and agents may share files for the workspace’s work within the published caps below.",
    "general-purpose bulk storage",
    "content delivery network",
    "Workspace file artifacts: 25 MB per version, 1 GB of unpurged versions per workspace",
    "Ten live workspaces per verified identity, free, no card.",
  ],
};

const forbidden = {
  home: [
    // Operator rule 2026-08-22: NO comparisons to other products on this page.
    "Slack is a room for people.",
    "GitHub records commits, reviews, and issues after the work.",
    "A shared repo holds files.",
    "An agent framework puts work inside one runtime.",
    "Slack cannot wake an agent",
    "GitHub is after the fact",
    "Sample workspace",
    "Launch room",
    "not switched on for everyone",
    "the flow is a preview",
    "There is no signup",
    "Accelerate teamwork with agent-to-agent chat.",
    "Create your free workspace",
    "For technical teams:",
    'cswarm working-on "wiring the payments webhook"',
    "Your workspace is ready. Open the dashboard.",
    "Your agents stop working blind.",
    "one shared feed",
    "One feed, and nobody starts blind.",
    "Every agent starts informed",
    "Working with a friend usually slows you down.",
    "The fix everyone suggests is a standup",
    "Workspace settings",
    "No process",
    "You don't have to manage it.",
    "Signals are posted once, never edited.",
    "The second agent finds out too late.",
    "close the workspace",
    "Close workspace",
    "doesn't help",
    "Joining is simple",
    "Two easy ways into the workspace.",
    "More agents can duplicate the work.",
    "collision found too late",
    "A detached listener can wake an agent",
    "Build together from anywhere.",
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
    "Connect your AI assistant",
    "Connect an agent",
    "Create a temporary key",
    "Getting started",
    "Email me a sign-in link",
    "Sign in with GitHub",
    "Before you paste it",
    "Joining a teammate’s workspace",
    "Accept your invite",
    "Your ten workspaces are ready to use",
  ],
  acceptableUse: [
    "a cache, a file store, a chat transport",
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

// Primary consumer workspace CTAs must land on /app, not the legacy /start detour.
const primaryCtaFiles = [
  path.join(siteRoot, "src/components/SiteHeader.astro"),
  path.join(siteRoot, "src/components/SiteFooter.astro"),
  path.join(siteRoot, "src/components/landing/ConsumerHero.astro"),
  path.join(siteRoot, "src/components/landing/ConsumerStory.astro"),
  path.join(siteRoot, "src/components/download/AfterInstall.astro"),
];
for (const file of primaryCtaFiles) {
  checks += 1;
  const source = fs.readFileSync(file, "utf8");
  if (/href:\s*"\/start"|href="\/start"/.test(source)) {
    failures.push(`${file}: primary source still routes /start`);
  }
  if (!/href:\s*"\/app"|href="\/app"/.test(source)) {
    failures.push(`${file}: missing /app primary CTA`);
  }
}

// Built home must not expose primary create doors to /start.
checks += 1;
const homeHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const startCreateHrefs = [
  ...homeHtml.matchAll(/href="(\/start[^"]*)"[^>]*>([^<]*(?:Create|workspace)[^<]*)</gi),
];
if (startCreateHrefs.length > 0) {
  failures.push(`home: built primary create still points at /start: ${startCreateHrefs.map((m) => m[0]).join("; ")}`);
}
checks += 1;
if (!/href="\/app"[^>]*>Open your workspace</.test(homeHtml)) {
  failures.push('home: built hero CTA must be /app Open your workspace');
}

// /start remains a real route for backward compatibility.
checks += 1;
if (!fs.existsSync(path.join(dist, "start", "index.html"))) {
  failures.push("start: route missing from build");
}

if (failures.length > 0) {
  console.error(`consumer-copy observer: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`consumer-copy observer: ${checks} checks across built /, /start, and /acceptable-use passed`);
  console.log("primary workspace CTAs: /app (header, footer, consumer hero/story, install)");
  console.log("legacy signup checklist is absent from the compatibility handoff");
}
