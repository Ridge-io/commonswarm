import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agentEntityView, truncateEntityId } from "../../lib/entity-panel";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const between = (start: string, end: string): string => {
  const startAt = dashboard.indexOf(start);
  const endAt = dashboard.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing end anchor: ${end}`);
  return dashboard.slice(startAt, endAt);
};

test("agent panel projection makes never-used and revoked access explicit", () => {
  const view = agentEntityView(
    {
      principalId: "f33a9af2-1111-2222-3333-4444444465f5",
      name: "Mercury",
      model: null,
      ownerUserId: "kenji",
    },
    {
      tokenId: "9bc78d19-aaaa-bbbb-cccc-dddddddd3310",
      issuedAt: "issued",
      expiresAt: "expires",
      firstUsedAt: null,
      revokedAt: "revoked",
    },
    "Kenji Ito",
    (value) => `formatted:${value}`,
  );

  assert.equal(view.model, "Model not specified");
  assert.equal(view.firstUsedAt, "Never used");
  assert.equal(view.revokedAt, "formatted:revoked");
  assert.equal(view.revoked, true);
  assert.equal(truncateEntityId(view.principalId), "f33a9af2…65f5");
});

test("stream entity names are native controls while everyone remains plain text", () => {
  const feed = between("const renderFeed =", "const syncConnectWorkspace =");
  assert.match(feed, /entityControl\([\s\S]*authorName[\s\S]*authorEntity/);
  assert.match(feed, /signal\.toAgent !== null && targetAgent[\s\S]*entityControl/);
  assert.match(feed, /signal\.to !== null && people\.has\(signal\.to\)[\s\S]*entityControl/);
  assert.match(feed, /operated by ["`]\)[\s\S]*entityControl/);
  assert.match(feed, /:\s*"everyone"/);
  const control = between("function entityControl", "const appendEntityField");
  assert.match(control, /document\.createElement\("button"\)/);
  assert.match(control, /button\.type = "button"/);
  assert.match(control, /button\.addEventListener\("click"/);
});

test("the right panel navigates ownership and exposes the complete agent state", () => {
  const renderer = between("function renderEntityPanel", "function openEntityPanel");
  for (const value of [
    "AGENT",
    "PERSON",
    "Model",
    "Principal ID",
    "Token ID",
    "Issued",
    "Expires",
    "First used",
    "Revoked",
    "Access revoked",
  ]) {
    assert.ok(renderer.includes(value), `entity renderer is missing ${value}`);
  }
  assert.match(renderer, /operated by /);
  assert.match(renderer, /\{ kind: "person", id: details\.ownerUserId \}/);
  assert.match(renderer, /\{ kind: "agent", id: agent\.principalId \}/);
  assert.doesNotMatch(renderer, /D-04[0-9]/, "known issues require a generated committed source");
  assert.doesNotMatch(renderer, /only .* sees|private|lock icon/i);
  assert.match(
    dashboard,
    /\.dashboard__frame--entity-panel\s*\{[\s\S]*grid-template-columns:\s*var\(--dashboard-rail\) minmax\(0, 1fr\) minmax\(18rem, 22rem\)/,
    "desktop panel must take its own grid column instead of covering the feed",
  );
});

test("Escape and close restore focus to the stream control that opened the panel", () => {
  const close = between("function closeEntityPanel", "function entityControl");
  assert.match(close, /entityPanelOrigin\.focus\(\{ preventScroll: true \}\)/);
  const open = between("function openEntityPanel", "The rail mirrors participants");
  assert.match(open, /if \(!panel\.contains\(trigger\)\) entityPanelOrigin = trigger/);
  assert.match(open, /data-entity-panel-close/);
  assert.match(
    dashboard,
    /event\.key !== "Escape" \|\| !panel \|\| panel\.hidden[\s\S]*closeEntityPanel\(true\)/,
  );
});
