import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const client = readFileSync(new URL("../../lib/commonswarm.ts", import.meta.url), "utf8");

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing end anchor: ${end}`);
  return source.slice(startAt, endAt);
};

test("composer defaults to broadcast and keeps signal language", () => {
  const markup = between(dashboard, '<form class="dashboard__composer"', "</form>");
  assert.match(markup, /data-composer-audience/);
  assert.match(markup, /maxlength="8000"/);
  assert.match(markup, /placeholder="What are you about to do\?"/);
  assert.doesNotMatch(markup, /Message #general|Message #all-signals/i);
  assert.doesNotMatch(markup, /only .* sees|will see|private|lock/i);
  assert.doesNotMatch(markup, /attach|emoji|reaction|thread/i);

  assert.match(dashboard, /let composerAudience: ComposerAudience = \{ kind: "everyone" \}/);
  assert.match(dashboard, /everyone\.textContent = "Everyone · nobody is notified"/);
  assert.match(dashboard, /No recipient · broadcast · no agent will be woken/);
  assert.match(dashboard, /One recipient · agent addressed · its listener can wake it/);
  assert.match(dashboard, /One recipient · person addressed · no agent will be woken/);
});

test("browser-authored signals use the existing broadcast and direct target fields", () => {
  const helper = between(client, "export async function postBrowserSignal", "/**\n * Reads the shared feed");
  assert.match(helper, /signal_kind: "note"/);
  assert.match(helper, /const address = browserSignalAddress\(recipient\)/);
  assert.match(helper, /to_user_id: address\.toUserId/);
  assert.match(helper, /to_agent_principal_id: address\.toAgentPrincipalId/);
  assert.match(helper, /in_reply_to: null/);
  assert.doesNotMatch(helper, /mentions|mentioned|delivery/i);

  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'for (const button of all<HTMLButtonElement>("[data-feed-filter]")',
  );
  assert.match(submit, /const address = browserSignalAddress\(audience\)/);
  assert.match(submit, /to: address\.toUserId/);
  assert.match(submit, /toAgent: address\.toAgentPrincipalId/);
  assert.match(submit, /body,\s*audience,\s*\);/);
  assert.match(submit, /await postBrowserSignal/);
});

test("mention picker resolves people and agents into one removable address chip", () => {
  const picker = between(dashboard, "const mentionSearch", "const resetComposer");
  assert.match(picker, /role", "option"/);
  assert.match(picker, /aria-selected/);
  assert.match(picker, /dashboard__mention-picker-avatar/);
  assert.match(picker, /markAgentAvatar/);
  assert.match(picker, /agent · managed by/);
  assert.match(picker, /composerMention = mention/);
  assert.match(picker, /composerAudience = \{ \.\.\.mention \}/);
  assert.match(picker, /input\.value = `\$\{input\.value\.slice/);

  const chips = between(dashboard, "const renderComposerMentions", "const mentionSearch");
  assert.match(chips, /dashboard__mention-chip/);
  assert.match(chips, /entityControl/);
  assert.match(chips, /Remove mention of/);
  assert.match(chips, /composerMention = null/);
  assert.match(chips, /composerAudience = \{ kind: "everyone" \}/);

  const keys = between(
    dashboard,
    'one<HTMLTextAreaElement>("[data-composer-input]")?.addEventListener(\n      "keydown"',
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
  );
  for (const key of ["Backspace", "Escape", "ArrowDown", "ArrowUp", "Enter"]) {
    assert.ok(keys.includes(`"${key}"`), `mention keyboard handling is missing ${key}`);
  }
});

test("posted mentions keep the same visual entity control without entering the command", () => {
  const feed = between(dashboard, "const renderFeed =", "const syncConnectWorkspace =");
  assert.match(feed, /visualMentions\.get\(signal\.id\)/);
  assert.match(feed, /dashboard__mention-chip dashboard__message-mention/);
  assert.match(feed, /entityControl/);

  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'for (const button of all<HTMLButtonElement>("[data-feed-filter]")',
  );
  assert.match(submit, /visualMentions\.set\(signal\.id, mentions\)/);
  assert.doesNotMatch(
    submit.match(/await postBrowserSignal\(([\s\S]*?)\);/)?.[1] ?? "",
    /mentions/,
  );
  const workspaceOpen = between(dashboard, "const openWorkspace = async", "const openAgentChoice");
  assert.match(
    workspaceOpen,
    /if \(changesWorkspace\) \{[\s\S]*resetComposer\(\)/,
    "composer references must not cross workspace boundaries",
  );
});
