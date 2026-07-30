import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "dist", "start", "index.html"))
  ? cwd
  : path.join(cwd, "site");
const html = fs.readFileSync(path.join(siteRoot, "dist", "start", "index.html"), "utf8");
const source = fs.readFileSync(path.join(siteRoot, "src", "pages", "start.astro"), "utf8");
const dashboard = fs.readFileSync(
  path.join(siteRoot, "src", "components", "app", "LiveDashboard.astro"),
  "utf8",
);

const checks = [
  {
    name: "rendered /start is a compatibility handoff with an accessible /app fallback",
    pass:
      html.includes("CommonSwarm starts in the dashboard.") &&
      html.includes('href="/app"') &&
      html.includes("Continue to CommonSwarm"),
  },
  {
    name: "legacy checklist and duplicate signup controls are absent",
    pass:
      !html.includes("Getting started") &&
      !html.includes("Create your workspace") &&
      !html.includes('data-progress') &&
      !html.includes('data-signin') &&
      !html.includes("<agent-connect"),
  },
  {
    name: "handoff preserves both auth query and fragment before replacing history",
    pass:
      source.includes('new URL("/app", window.location.origin)') &&
      source.includes("target.search = window.location.search") &&
      source.includes("target.hash = window.location.hash") &&
      source.includes("window.location.replace(target.href)"),
  },
  {
    name: "dashboard is the only auth-return controller",
    pass:
      dashboard.includes("the one auth-return controller for both current and compatibility links") &&
      dashboard.includes("auth.onAuthStateChange(") &&
      dashboard.includes('event === "INITIAL_SESSION"') &&
      dashboard.includes('event === "SIGNED_IN"'),
  },
];

const failures = checks.filter((check) => !check.pass);
if (failures.length > 0) {
  console.error(`start handoff observer: ${failures.length} of ${checks.length} checks failed`);
  for (const failure of failures) console.error(`- ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log(`start handoff observer: ${checks.length}/${checks.length} rendered checks passed`);
  console.log("rendered compatibility handoff and source invariants checked");
}
