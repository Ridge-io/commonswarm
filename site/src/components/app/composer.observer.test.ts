import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BROWSER_ATTACHMENT_MAX,
  BROWSER_ATTACHMENT_MAX_BYTES,
  browserSignalKind,
  prepareBrowserAttachments,
} from "../../lib/commonswarm.js";

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
  assert.match(markup, /maxlength=\{SIGNAL_BODY_MAX\}/);
  assert.match(dashboard, /import \{ SIGNAL_BODY_MAX \} from/);
  assert.doesNotMatch(markup, /maxlength="8000"/);
  assert.match(markup, /placeholder="What are you about to do\?"/);
  assert.doesNotMatch(markup, /Message #general|Message #all-signals/i);
  assert.doesNotMatch(markup, /only .* sees|will see|private|lock/i);
  assert.doesNotMatch(markup, /emoji|reaction|thread/i);

  assert.match(dashboard, /let composerAudience: ComposerAudience = \{ kind: "everyone" \}/);
  assert.match(dashboard, /everyone\.textContent = "Everyone · nobody is notified"/);
  assert.match(dashboard, /No recipient · broadcast · no agent will be woken/);
  assert.match(markup, /Post a note · no agent is woken/);
  assert.match(dashboard, /`Wakes \$\{entityName\(composerAudience\)\}'s listener`/);
  assert.match(dashboard, /`Posted for \$\{entityName\(composerAudience\)\} to read; no wake`/);
});

test("composer kind defaults by recipient and the agent-only control opts out of wake", () => {
  assert.deepEqual([
    browserSignalKind({ kind: "everyone" }),
    browserSignalKind({ kind: "person", id: "person-1" }),
    browserSignalKind({ kind: "agent", id: "agent-1" }),
    browserSignalKind({ kind: "agent", id: "agent-1" }, true),
  ], ["note", "note", "ask", "note"]);

  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'for (const button of all<HTMLButtonElement>("[data-feed-filter]")',
  );
  /* The kind is decided ONCE for the whole send, from the first recipient. Every recipient of
     one send is the same kind, because agents never mix with a person in one address. */
  assert.match(submit, /const signalKind = browserSignalKind\(recipients\[0\]!, postAgentNote\)/);
  assert.match(submit, /kind: signalKind/);
  assert.match(submit, /rawBody,\s*recipient,\s*signalKind,\s*attachmentRefs/);
});

test("browser-authored signals use the existing broadcast and direct target fields", () => {
  const helper = between(client, "export async function postBrowserSignal", "/**\n * Reads the shared feed");
  assert.match(helper, /signal_kind: signalKind/);
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
  /* Each recipient of a fan-out resolves to the same two nullable wire fields. The address is
     computed per recipient, so a second agent cannot inherit the first one's target. */
  assert.match(submit, /const address = browserSignalAddress\(recipient\)/);
  assert.match(submit, /to: address\.toUserId/);
  assert.match(submit, /toAgent: address\.toAgentPrincipalId/);
  assert.match(submit, /rawBody,\s*recipient,\s*signalKind,\s*attachmentRefs,\s*\)\);/);
  assert.match(submit, /await postBrowserSignal/);
  /* One command id per recipient, so a retry of a partly-sent message cannot repost the ones
     that already landed. A single shared id would make the second post look like a duplicate. */
  assert.match(submit, /commandIds: recipients\.map\(\(\) => uuid\(\)\)/);
  assert.match(submit, /postBrowserSignal\(\s*session!,\s*commandIds\[index\]!,/);
});

test("attachments use one picker, drop, paste, staging, and failure-restore path", () => {
  const markup = between(dashboard, '<form class="dashboard__composer"', "</form>");
  assert.match(markup, /type="file" multiple data-composer-file-input/);
  assert.match(markup, /data-composer-attach[\s\S]*aria-label="Attach files"/);
  assert.match(markup, /data-composer-attachments/);
  assert.match(markup, /data-composer-drop-target/);

  const staging = between(dashboard, "const renderStagedAttachments", "const syncComposerControls");
  assert.match(staging, /dashboard__attachment-chip/);
  assert.match(staging, /dataset\.removeAttachment/);
  assert.match(staging, /stagedAttachments\.splice/);
  assert.match(staging, /URL\.createObjectURL/);
  assert.match(staging, /prepareBrowserAttachments\(files, stagedAttachments\.length\)/);

  const wiring = between(
    dashboard,
    'one<HTMLButtonElement>("[data-composer-attach]")',
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
  );
  for (const event of ["dragenter", "dragover", "dragleave", "drop", "paste"]) {
    assert.ok(wiring.includes(`"${event}"`), `composer is missing ${event}`);
  }
  assert.match(wiring, /item\.type\.startsWith\("image\/"\)/);
  assert.match(wiring, /setComposerDropTarget\(true\)/);
  assert.match(wiring, /setComposerDropTarget\(false\)/);

  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'for (const button of all<HTMLButtonElement>("[data-feed-filter]")',
  );
  assert.match(submit, /setComposerSending\(true\)/);
  assert.match(submit, /uploadBrowserAttachment/);
  assert.match(submit, /Uploading file \$\{index \+ 1\} of/);
  assert.match(submit, /stagedAttachments = \[\]/);
  assert.match(submit, /stagedAttachments = attachmentSnapshot;\s*renderStagedAttachments\(\)/);
  assert.match(submit, /input\.value = rawBody/);
  assert.match(dashboard, /hadAttachments/);
  assert.match(dashboard, /Files from this saved draft are not attached after reload/);
});

test("browser attachment preflight mirrors the eight-file and 25 MB limits", () => {
  const file = (name: string, size: number): File => ({ name, size } as File);
  assert.equal(
    prepareBrowserAttachments([file("screen.png", 100)], 0)[0]?.contentType,
    "image/png",
  );
  assert.throws(
    () => prepareBrowserAttachments(
      Array.from({ length: BROWSER_ATTACHMENT_MAX + 1 }, (_, i) => file(`${i}.md`, 1)),
    ),
    /up to 8 files/,
  );
  assert.throws(
    () => prepareBrowserAttachments([file("too-big.png", BROWSER_ATTACHMENT_MAX_BYTES + 1)]),
    /25 MB/,
  );
  assert.throws(() => prepareBrowserAttachments([file("run.exe", 1)]), /file type/);
  const upload = between(
    client,
    "export async function uploadBrowserAttachment",
    "/** Gets a short-lived signed download URL",
  );
  assert.match(upload, /if \(!intent\.uploaded\)/);
  assert.match(upload, /intent\.uploaded = true/);
  assert.match(upload, /intent\.commitCommandId/);
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
  /* Every recipient gets a chip and its own × — with several agents addressed, one remove must
     drop one name. The clearing itself moved into removeComposerRecipient. */
  assert.match(chips, /for \(const \[index, mention\] of composerChips\(\)\.entries\(\)\)/);
  assert.match(chips, /removeComposerRecipient\(index\)/);
  const removal = between(dashboard, "const removeComposerRecipient", "const renderComposerMentions");
  assert.match(removal, /composerMention = null/);
  assert.match(removal, /composerAudience = \{ kind: "everyone" \}/);
  /* Removing the first of several promotes the next agent instead of clearing the whole row. */
  assert.match(removal, /composerAudience = \{ kind: "agent", id: promoted\.id \}/);

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
  /* A posted row carries ITS OWN recipient chip. Handing every row the whole address would
     label a message to one agent with the names of the others. */
  assert.match(submit, /visualMentions\.set\(signal\.id, mentionsFor\(recipients\[index\]!\)\)/);
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
