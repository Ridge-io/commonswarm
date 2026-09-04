import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  grantRiskBadge,
  STANDING_GRANT_COPY,
  STANDING_GRANT_RULES,
  STANDING_IDLE_PAUSE_DAYS,
  STANDING_RESUME_ACTORS,
  type GrantRiskInput,
} from "../../lib/standing-grants";

const dashboard = await readFile(
  new URL("./LiveDashboard.astro", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-08-31T12:00:00Z");
const base: GrantRiskInput = {
  kind: "timeboxed",
  horizonExpiresAt: "2026-09-30T12:00:00Z",
  boundDeviceId: null,
  lastUsedAt: "2026-08-31T11:00:00Z",
  issuedAt: "2026-08-01T12:00:00Z",
  newHostAt: null,
  suspendedAt: null,
  revokedAt: null,
};

test("grant risk badge covers every state in strict first-match order", () => {
  const cases: Array<[string, GrantRiskInput]> = [
    ["REVOKED", { ...base, revokedAt: "2026-08-31T11:00:00Z", suspendedAt: "2026-08-30T11:00:00Z" }],
    ["SUSPENDED", { ...base, suspendedAt: "2026-08-30T11:00:00Z", newHostAt: "2026-08-29T11:00:00Z" }],
    ["NEW HOST", { ...base, newHostAt: "2026-08-29T11:00:00Z" }],
    ["UNBOUND", { ...base, kind: "standing", horizonExpiresAt: null, boundDeviceId: null }],
    ["STALE", { ...base, lastUsedAt: "2026-08-20T11:00:00Z" }],
    ["HORIZON 3d", { ...base, horizonExpiresAt: "2026-09-02T12:00:00Z" }],
  ];
  for (const [expected, row] of cases) {
    assert.equal(grantRiskBadge(row, now), expected);
  }
  assert.equal(grantRiskBadge(base, now), null);
});

test("standing copy is assembled from the rules, never a typed list", () => {
  /* THE RETIRED ASSERTION PINNED THE WRONG CLAIM. It required exactly "This does
     not expire. Revoke is the only kill switch." while the schema already
     suspended an idle standing grant after 14 days with no way back — so revoke
     was NOT the only thing that stopped it, and the green test made that
     sentence stable rather than true. What is checked now is that the paragraph
     is BUILT from the rules and that the rules name the two numbers the server
     enforces, which is a claim that fails when the enforcement moves. */
  assert.equal(STANDING_GRANT_COPY, STANDING_GRANT_RULES.join(" "));
  assert.ok(STANDING_GRANT_RULES.length >= 3);
  assert.match(STANDING_GRANT_COPY, /does not expire/);
  assert.match(
    STANDING_GRANT_COPY,
    new RegExp(`${STANDING_IDLE_PAUSE_DAYS} days with no use pauses it`),
  );
  for (const actor of STANDING_RESUME_ACTORS) {
    assert.ok(
      STANDING_GRANT_COPY.includes(actor),
      `the copy drops "${actor}" from the set the resume gate accepts`,
    );
  }
  assert.match(STANDING_GRANT_COPY, /Revoking it is the only permanent stop\./);
  assert.doesNotMatch(
    STANDING_GRANT_COPY,
    /Revoke is the only kill switch/,
    "retired copy claimed revocation was the only stop while idle suspension also stopped it",
  );
});

test("roster shows standing truth and wires one-confirm grant revocation", () => {
  assert.ok(dashboard.includes("STANDING_GRANT_COPY"));
  assert.match(dashboard, /revokeButton\.textContent = "Revoke grant"/);
  assert.match(
    dashboard,
    /revokeButton\.addEventListener\("click", async \(\) => \{[\s\S]*window\.confirm\([\s\S]*revokeAgentToken\([\s\S]*grant\.tokenId/,
  );
  assert.match(dashboard, /grantRiskBadge\(\{/);
  assert.match(dashboard, /grant\.lastUsedAt/);
});
