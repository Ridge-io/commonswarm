import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupParticipantsByOwner } from "../../lib/participant-rail";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("participant groups retain empty people and collect unresolved agents", () => {
  const groups = groupParticipantsByOwner(
    [
      { userId: "dana", name: "Dana Rivera", role: "owner" as const },
      { userId: "tom", name: "Tom Langridge", role: "member" as const },
    ],
    [
      { principalId: "atlas", name: "atlas", ownerUserId: "dana" },
      { principalId: "orphan", name: "orphan", ownerUserId: "former-member" },
    ],
  );

  assert.deepEqual(groups.map((group) => group.kind), ["member", "member", "unresolved"]);
  assert.equal(groups[0]?.agents[0]?.name, "atlas");
  assert.deepEqual(groups[1]?.agents, [], "a person with no agents must remain in the rail");
  assert.equal(groups[2]?.kind === "unresolved" ? groups[2].label : "", "Owner unavailable");
  assert.equal(groups[2]?.agents[0]?.name, "orphan", "an unresolved owner must not hide its agent");
});

test("the dashboard nests each agent list under its owner row", () => {
  const start = dashboard.indexOf("const renderSidebarParticipants =");
  const end = dashboard.indexOf("const workspaceMenuItems =", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const renderer = dashboard.slice(start, end);

  assert.match(renderer, /for \(const group of groupParticipantsByOwner\(members, agents\)\)/);
  assert.match(renderer, /groupItem\.append\(personRow, nestedAgents\)/);
  assert.match(renderer, /participantList\.append\(groupItem\)/);
  assert.match(renderer, /badge\.textContent = "PERSON"/);
  assert.match(renderer, /badge\.textContent = "AGENT"/);
  assert.doesNotMatch(renderer, /operated by/, "nesting replaces repeated owner captions in the rail");
});
