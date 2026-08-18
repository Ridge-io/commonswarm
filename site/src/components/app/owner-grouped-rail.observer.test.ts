import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupParticipantsByOwner } from "../../lib/participant-rail";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("participant groups sort owners and agents while keeping empty and unresolved rows", () => {
  const groups = groupParticipantsByOwner(
    [
      { userId: "zoe", name: "Zoe", role: "member" as const },
      { userId: "b-alex", name: "Alex", role: "owner" as const },
      { userId: "mara", name: "Mara", role: "member" as const },
      { userId: "a-alex", name: "alex", role: "admin" as const },
    ],
    [
      { principalId: "z-agent", name: "zeta", ownerUserId: "a-alex" },
      { principalId: "b-agent", name: "alpha", ownerUserId: "a-alex" },
      { principalId: "orphan-z", name: "zeta", ownerUserId: "former-member" },
      { principalId: "a-agent", name: "alpha", ownerUserId: "a-alex" },
      { principalId: "orphan-a", name: "alpha", ownerUserId: "another-member" },
    ],
  );

  assert.deepEqual(
    groups.map((group) => group.kind === "member" ? group.member.userId : group.label),
    ["a-alex", "b-alex", "mara", "zoe", "Owner unavailable"],
    "owners sort case-insensitively by display name, then by user ID; fallback stays last",
  );
  assert.deepEqual(
    groups[0]?.agents.map((agent) => agent.principalId),
    ["a-agent", "b-agent", "z-agent"],
    "agents retain name-then-principal ordering inside an owner",
  );
  assert.deepEqual(groups[2]?.agents, [], "a person with no agents must remain in the rail");
  assert.deepEqual(
    groups[4]?.agents.map((agent) => agent.principalId),
    ["orphan-a", "orphan-z"],
    "unresolved ownership must not hide agents or split the final fallback group",
  );
});

test("the dashboard nests each agent list under its owner heading", () => {
  const start = dashboard.indexOf("const renderSidebarParticipants =");
  const end = dashboard.indexOf("const workspaceMenuItems =", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const renderer = dashboard.slice(start, end);

  assert.match(renderer, /for \(const group of groupParticipantsByOwner\(members, agents\)\)/);
  assert.match(renderer, /groupItem\.className = "dashboard__sidebar-owner-group"/);
  assert.match(renderer, /nestedAgents\.className = "dashboard__sidebar-owner-agents"/);
  assert.match(renderer, /groupItem\.append\(personRow, nestedAgents\)/);
  assert.match(renderer, /participantList\.append\(groupItem\)/);
  assert.match(renderer, /label\.textContent = group\.label/);
  assert.match(renderer, /group\.kind === "unresolved" \? group\.label : undefined/);
  assert.match(renderer, /owner\.textContent = `operated by \$\{ownerName\}`/);
  assert.match(renderer, /model\.textContent = agent\.model/);
  assert.match(renderer, /modelGlyphSvg\([\s\S]*?modelFamily\(agent\.model\)/);
  assert.match(renderer, /name\.title = agent\.name/);
  assert.doesNotMatch(renderer, /participantList\.append\(buildAgentRow/);
  assert.doesNotMatch(renderer, /markAgentAvatar/);
  assert.doesNotMatch(renderer, /badge\.textContent = "(?:PERSON|AGENT)"/);
});
