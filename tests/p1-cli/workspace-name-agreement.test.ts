/**
 * Item D: agents and humans must call a workspace by the same name.
 *
 * WHY THIS EXISTS. The operator asked whether to add Grok Bot to "the CommonSwarm Build
 * workspace" and CSwarmStrategist could not answer, because no agent surface returned the
 * workspace's display name — `whoami --json` gave `workspace_id` and `owner_display_name` and
 * nothing else. A person names a workspace; an agent names a uuid; neither can check the other.
 *
 * The failure this pins is DRIFT: the CLI and the app reading the workspace name from different
 * places, or rendering it in different shapes, so the same id gets two names. So the controls
 * here are about AGREEMENT, not about either value on its own.
 *
 * Reached by `npm test` (named in the literal list) and `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { renderWorkspace, workspaceLabel } from "../../src/cli.js";
import type { SignalDirectory } from "../../src/cloud/signals.js";

const root = new URL("../../", import.meta.url);
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

const directory = (name: unknown): SignalDirectory =>
  ({
    members: [],
    agents: [],
    identity: {
      credential_valid: true,
      owner_user_id: "11111111-1111-4111-8111-111111111111",
      principal_id: "22222222-2222-4222-8222-222222222222",
      workspace_id: "4f63d2b0-8d95-4ea3-b46a-ac573cebc432",
      workspace_name: name,
    },
  }) as unknown as SignalDirectory;

/* The CLI and the app must read the name from the SAME row. The app reads the
 * swarm_read.workspaces view; so must the edge that feeds every agent surface. Reaching past it
 * to swarm.workspaces is not a style question — measured 2026-09-14, it answered HTTP 500 for
 * every caller. The handler runs as ROLE swarm_read, which has USAGE on the swarm schema but no
 * SELECT on swarm.workspaces: `permission denied for table workspaces`. */
test("the agent identity reads the workspace name from the view the app reads", () => {
  const edge = read("supabase/functions/read/index.ts");
  const block = /const workspaceRows = await tx<\{ name: string \}\[\]>`([\s\S]*?)`;/.exec(edge)?.[1];
  assert.ok(block, "the read edge no longer selects a workspace name for the agent identity");
  assert.match(
    block!,
    /FROM swarm_read\.workspaces/,
    "the read edge reads the workspace name from somewhere other than swarm_read.workspaces, which is the view the app reads",
  );
  /* Pin the WHERE too. Control on FROM alone leaves the predicate free: a Grok arm noted that
   * switching to body.workspace_id would still pass. The early-return on a mismatched
   * workspace_id stops a leak today, but a control that does not mention the predicate is not
   * a control over it. The id must come from the AUTHENTICATED context, never the request. */
  assert.match(
    block!,
    /WHERE workspace_id = \$\{agent\.principal_workspace_id\}::uuid/,
    "the workspace-name query no longer scopes to the authenticated principal's own workspace",
  );
  assert.ok(
    !/\$\{body\.workspace_id\}/.test(block!),
    "the workspace-name query takes its id from the request body instead of the authenticated context",
  );
  assert.ok(
    !/FROM swarm\.workspaces/.test(block!),
    "the read edge reaches past the view to the base table; the handler runs as role swarm_read, which cannot SELECT swarm.workspaces, and this answered HTTP 500 on production",
  );

  const app = read("site/src/lib/commonswarm.ts");
  assert.match(
    app,
    /\.schema\("swarm_read"\)\s*\n?\s*\.from\("workspaces"\)/,
    "the app no longer reads swarm_read.workspaces; the CLI and the app would then name one id from two sources",
  );
});

/* ONE renderer for the CLI, so `Name (id)` cannot become `Name [id]` on one surface and
 * `Name - id` on another. The human `status` verb has printed `Workspace: <name> (<id>)` since
 * before this item; the agent surfaces were the half that printed nothing, and they must match.
 *
 * The APP does NOT share this renderer and cannot: it builds its own DOM in the browser and
 * imports nothing from src/cli.ts. Its half of the agreement is the separate switcher control
 * below, and the shared SOURCE — both read swarm_read.workspaces. Saying "one renderer serves
 * the app" would be false, and a review arm caught that wording. */
test("every CLI surface renders a named workspace the same way", () => {
  assert.equal(
    renderWorkspace("4f63d2b0-8d95-4ea3-b46a-ac573cebc432", "CommonSwarm Build"),
    "CommonSwarm Build (4f63d2b0-8d95-4ea3-b46a-ac573cebc432)",
  );

  const workspaces = read("src/cloud/workspaces.ts");
  assert.match(
    workspaces,
    /`Workspace: \$\{options\.selected\.name\} \(\$\{options\.selected\.workspace_id\}\)/,
    "human status no longer prints `Workspace: <name> (<id>)`; the agent surfaces are pinned to that shape",
  );

  const cli = read("src/cli.ts");
  for (const surface of [
    /`Workspace: \$\{renderWorkspace\(identity\.workspace_id, workspaceName\)\}/,
    /lines\.push\(`Workspace: \$\{renderWorkspace\(workspace\.workspaceId, workspace\.workspaceName\)\}`\)/,
  ]) {
    assert.match(cli, surface, `a surface stopped rendering through renderWorkspace: ${surface}`);
  }
});

/* An unknown name is not an error and must never be invented. An older deployment omits the
 * field; an archived workspace has no row in the view. Both render the id alone. */
test("an unknown workspace name degrades to the id, never to a guess", () => {
  assert.equal(workspaceLabel(directory(undefined)), null);
  assert.equal(workspaceLabel(directory(null)), null);
  assert.equal(
    renderWorkspace("4f63d2b0-8d95-4ea3-b46a-ac573cebc432", null),
    "4f63d2b0-8d95-4ea3-b46a-ac573cebc432",
  );
  assert.equal(workspaceLabel(directory("CommonSwarm Build")), "CommonSwarm Build");
  /* A present but blank name is UNKNOWN, not a manufactured label. */
  assert.equal(workspaceLabel(directory("")), null);
  assert.equal(workspaceLabel(directory("   ")), null);
});

/* The profile file caches the name. It must stay OPTIONAL: the parser compares the key set
 * exactly, so requiring it would declare every profile written before this release damaged, on
 * every host at once. */
test("the profile file accepts a workspace name without requiring one", () => {
  const profile = read("src/cloud/agent-profile.ts");
  assert.match(
    profile,
    /workspace_name\?: string;/,
    "workspace_name became required on AgentProfile; every profile written before this release would be rejected",
  );
  assert.match(
    profile,
    /keys === \[\.\.\.required\]\.sort\(\)\.join\(\) \|\|\s*\n?\s*keys === \[\.\.\.required, "workspace_name"\]\.sort\(\)\.join\(\)/,
    "the profile key-set check no longer accepts BOTH shapes; one of the two is now rejected",
  );
});

/* The app's switcher must show the id, because that is the half a person cannot otherwise see.
 * Pinned against the built artifact is the job of the site observers; here we pin the source. */
test("the app's workspace switcher shows the id beside the name", () => {
  const dashboard = read("site/src/components/app/LiveDashboard.astro");
  /* Anchored on the two structural ends of the option builder, not on a character budget: the
   * first version allowed 900 characters and a comment added here pushed the real span to
   * 1,010, so the control failed for its own reason rather than the code's. A lazy match to the
   * next `button.append` is bounded by the structure itself. */
  /* Anchor on the SWITCHER, not on the first `createElement("span")` in the file — that one is
   * the members list. A Grok arm noted the old start-anchor was not unique and worked only
   * because the id lines happen to exist nowhere else today. */
  const block = /dashboard__workspace-button[\s\S]*?button\.append\(label, check\)/
    .exec(dashboard)?.[0];
  assert.ok(block, "the workspace switcher's option rendering is no longer recognisable");
  assert.match(block!, /identifier\.textContent = workspace\.id/, "the switcher no longer shows the workspace id");
  assert.match(block!, /label\.append\(identifier\)/, "the id is built but never attached to the option");
});
