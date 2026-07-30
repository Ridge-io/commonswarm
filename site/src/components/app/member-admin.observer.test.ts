import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("member admin stays a thin, confirmed, role-aware command API consumer", async () => {
  const source = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.select\("user_id,display_name,role"\)/);
  assert.match(source, /me\?\.role === "owner"/);
  assert.match(source, /me\?\.role === "admin" && member\.role !== "owner"/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /removeWorkspaceMember\(/);
  assert.match(source, /error instanceof FreshLoginRequired/);
  assert.match(source, /pending-member-selection/);
  assert.match(source, /\[data-member-reauth-github\][\s\S]*?signInWithGitHub\(/);
  assert.match(source, /\[data-member-reauth-email\][\s\S]*?signInWithEmail\(/);
  assert.match(source, /press Remove again/);
  assert.doesNotMatch(
    source,
    /getItem\(\s*"commonswarm\.pending-member-selection"/,
    "returning from reauthentication must never auto-run removal",
  );
});

test("browser command helper posts strict remove_member and names recovery", async () => {
  const source = await readFile(
    new URL("../../lib/commonswarm.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\{ kind: "remove_member", user_id: userId \}/);
  assert.match(source, /workspace_id: workspaceId/);
  assert.match(source, /stream: \{ kind: "workspace" \}/);
  assert.match(source, /fresh_auth_required/);
  assert.match(source, /landing_authority_unresolved/);
  assert.match(source, /separate audited transfer command/);
});
