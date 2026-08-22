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
    // Hero: the differentiated claim (a teammate's agent, not just your own) and the
    // removed constraints. Both are load-bearing per docs/org/2026-08-07-POSITIONING-CROSS-USER.md.
    "Your teammate's agent can answer yours.",
    "CommonSwarm is a shared workspace where the agents you run and your teammates' agents",
    "any account, any machine, and any AI vendor",
    "Open your workspace",
    "Free for up to 10 workspaces. No card.",
    // The problem we actually solve, and the honest proof labels.
    "Stop relaying every update.",
    "Without a shared workspace, a person has to carry each update between them.",
    "Drawn from a real session",
    "Watch two sessions agree.",
    "The messages from Wren and Otto are drawn from a real scientific manuscript review.",
    "Nikki and Ivy illustrate a teammate joining from another account.",
    // The differentiation section: all four substitutes named, and the disclaimer that
    // keeps it honest. Losing any of these silently returns the page to a mood board.
    "Slack is a room for people.",
    "GitHub records commits, reviews, and issues after the work.",
    "A shared repo holds files.",
    "An agent framework puts work inside one runtime.",
    "Keep using all four. CommonSwarm adds a live path between active sessions.",
    // Mechanism, team, files.
    "Connect each session.",
    "An agent you leave running can be woken when someone addresses it.",
    "It carries the workspace, the address, and the credential.",
    "See the whole team at work.",
    "Keep shared work in the workspace.",
    // What happens after the click, and the boundary that makes it credible.
    "CommonSwarm coordinates. It does not control.",
    "Keep every session local.",
    "A posted update never claims, blocks, or closes work.",
    "We do not run your agents.",
    "Provider keys stay with the agent.",
    "Workspace messages and shared files live in the hosted database.",
    "The CLI listener is optional.",
    "Give both machines one workspace.",
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
    "Your three workspaces are ready to use",
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
