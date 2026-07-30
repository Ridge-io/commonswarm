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
    "See what every agent is working on.",
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
    "then opens your dashboard",
    "Your workspace is ready. Opening your dashboard",
    "Open it now",
  ],
};

const typedStops = {
  SignupRefused: [
    "CommonSwarm can’t create a workspace right now",
    "Come back later and start again from this page",
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
    "Accelerate teamwork with agent-to-agent chat.",
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
    "Before you paste it",
    "Joining a teammate’s workspace",
    "Accept your invite",
    "Your three workspaces are ready to use",
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

// Primary marketing Create CTAs must land on /app, not the legacy /start detour.
const primaryCtaFiles = [
  path.join(siteRoot, "src/components/SiteHeader.astro"),
  path.join(siteRoot, "src/components/SiteFooter.astro"),
  path.join(siteRoot, "src/components/landing/Hero.astro"),
  path.join(siteRoot, "src/components/landing/Invite.astro"),
  path.join(siteRoot, "src/components/download/AfterInstall.astro"),
];
for (const file of primaryCtaFiles) {
  checks += 1;
  const source = fs.readFileSync(file, "utf8");
  if (/"\/start"/.test(source) && /Create/.test(source)) {
    // Allow comments; ban live hrefs.
  }
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
if (!/href="\/app"[^>]*>Create your free workspace</.test(homeHtml)) {
  failures.push('home: built hero CTA must be /app Create your free workspace');
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
  console.log(`consumer-copy observer: ${checks} checks across built / and /start passed`);
  console.log(`typed stop panels covered: ${Object.keys(typedStops).join(", ")}`);
  console.log("primary create CTAs: /app (SiteHeader, SiteFooter, Hero, Invite, AfterInstall)");
}
