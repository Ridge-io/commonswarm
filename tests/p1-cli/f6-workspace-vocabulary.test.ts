import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

/* F-6 of the 2026-08-10 dogfood. The CLI called the same thing a "project" and a "workspace",
 * measured at 16 to 11 in cli.ts prose, and the collision was visible in two consecutive
 * commands:
 *
 *   $ cswarm use <id>    -> Selected project Dogfood Workspace (…)
 *   $ cswarm note "…"    -> …visible to members of this workspace.
 *
 * Settled in favour of "workspace", because that is what everything load-bearing already says:
 * the schema (swarm.workspaces), the flag (--workspace-id), the design doc, the site and README.
 *
 * This gate exists because a vocabulary decision with no gate is a vocabulary decision that
 * decays one string at a time, and nothing else in the repo would notice. */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

/* SOMEONE ELSE'S noun, and each must keep it. These are not ours to rename: Supabase calls its
 * own thing a project, OpenCode calls its working directory a project, and Vercel calls its
 * deployment target a project. Renaming any of them would make our text WRONG rather than
 * inconsistent. */
const FOREIGN = [
  "Supabase project",
  "<project-url>",
  "project cwd",
  "project context",
  "opencode_project",
  "OPENCODE_DISABLE_PROJECT",
  "Vercel project",
  "Project Settings",
];

/* Machine surfaces, deliberately NOT renamed: `--json` status codes and payload keys. Renaming
 * them would break anyone scripting against the JSON for a consistency fix to prose. Recorded
 * here so the exemption is a decision on the record rather than an oversight. */
const MACHINE = [
  "project_created",
  "project_membership_required",
  "project_name_ambiguous",
  "project_not_available",
  "project_selected",
  "project_selection_required",
  "project_count",
  "selected_project",
];

const FILES = [
  "src/cli.ts",
  "src/cloud/workspaces.ts",
  "src/cloud/signals.ts",
  "src/cloud/command-client.ts",
];

/** Double-quoted string literals — the CLI's user-facing text. */
function quotedStrings(source: string): string[] {
  return source.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
}

test("F-6: no user-facing string calls a workspace a project", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const source = readFileSync(resolve(root, file), "utf8");
    for (const literal of quotedStrings(source)) {
      if (!/\b[Pp]rojects?\b/.test(literal)) continue;
      if ([...FOREIGN, ...MACHINE].some((k) => literal.includes(k))) continue;
      offenders.push(`${file}: ${literal.slice(0, 90)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these say "project" where they mean a workspace:\n${offenders.join("\n")}`,
  );
});

test("F-6: the foreign nouns SURVIVE — this gate must not drive a wrong rename", () => {
  /* CONTROL, and the one that matters. A gate that only forbids "project" would be satisfied by
   * renaming Supabase's and OpenCode's nouns too, which turns an inconsistency into a factual
   * error. Each of these must still be present somewhere in the tree. */
  const all = FILES.map((f) => readFileSync(resolve(root, f), "utf8")).join("\n");
  const installer = readFileSync(resolve(root, "install.sh"), "utf8");

  for (const phrase of ["Supabase project", "project cwd", "<project-url>"]) {
    assert.ok(all.includes(phrase), `the foreign noun "${phrase}" was renamed away`);
  }
  /* The installer's placeholder must match what `cswarm --help` prints, or a reader following
   * the installer sees a different name than the CLI documents. They move together. */
  assert.ok(
    installer.includes('cswarm new "<workspace name>"'),
    "install.sh no longer matches the --help placeholder",
  );
  assert.ok(
    all.includes('cswarm new "<workspace name>"'),
    "--help no longer prints the placeholder install.sh promises",
  );
});
