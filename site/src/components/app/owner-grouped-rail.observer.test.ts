import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderParticipantRailFixture } from "./participant-rail.fixture.js";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("the live participant renderer sorts and nests agents under owner rows", async () => {
  const rail = await renderParticipantRailFixture(
    [
      { userId: "zoe", name: "Zoe", role: "member" },
      { userId: "b-alex", name: "Alex", role: "owner" },
      { userId: "mara", name: "Mara", role: "member" },
      { userId: "a-alex", name: "alex", role: "admin" },
    ],
    [
      { principal_id: "z-agent", name: "zeta", model: "Claude", owner_user_id: "a-alex" },
      { principal_id: "b-agent", name: "beta", model: "GPT", owner_user_id: "a-alex" },
      { principal_id: "orphan-z", name: "orphan zeta", owner_user_id: "former-member" },
      { principal_id: "a-agent", name: "alpha", owner_user_id: "a-alex" },
      { principal_id: "orphan-a", name: "orphan alpha", owner_user_id: "another-member" },
    ],
  );

  assert.deepEqual(
    rail.groups.map((group) => group.heading),
    ["alex", "Alex", "Mara", "Zoe", "Owner unavailable"],
  );
  assert.equal(rail.groups[0]?.hasNestedList, true);
  assert.deepEqual(rail.groups[0]?.agents, ["alpha", "beta", "zeta"]);
  assert.equal(rail.directAgentCount, 0, "agent rows must never be flattened beside owner groups");
  assert.deepEqual(rail.groups.at(-1)?.agents, ["orphan alpha", "orphan zeta"]);
});

test("empty and missing owner ids render in a visible fallback group", async () => {
  const rail = await renderParticipantRailFixture([], [
    { principal_id: "empty-owner", name: "Empty owner", model: null, owner_user_id: "" },
    { principal_id: "missing-owner", name: "Missing owner", model: "unknown" },
  ]);

  assert.equal(rail.groups.length, 1, "an agents-only workspace must not render empty");
  assert.equal(rail.groups[0]?.heading, "Owner unavailable");
  assert.deepEqual(rail.groups[0]?.agents, ["Empty owner", "Missing owner"]);
});

test("a member with zero agents has no empty nested list", async () => {
  const rail = await renderParticipantRailFixture(
    [{ userId: "mara", name: "Mara", role: "member" }],
    [],
  );

  assert.equal(rail.groups.length, 1);
  assert.equal(rail.groups[0]?.heading, "Mara");
  assert.equal(rail.groups[0]?.hasNestedList, false);
});

test("LiveDashboard uses the observed roster normalizer and renderer", () => {
  assert.match(dashboard, /result\.push\(\.\.\.rosterAgentsFromRows\(page\)\)/);
  assert.match(
    dashboard,
    /renderSidebarParticipants\(participantList, members, agents, initials\)/,
  );
});
