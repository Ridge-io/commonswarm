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
  /* RETIRED CLAIM (2026-09-04): the composer had a TO select and a "Post a note" checkbox above
     the text box. The address is the message now — an @tag typed in the body — so both controls
     are gone and the bar fits in 80px. */
  assert.doesNotMatch(markup, /data-composer-audience|data-composer-note-toggle/);
  assert.match(dashboard, /const composerRecipientsFrom = \(body: string\)/);
  assert.match(markup, /maxlength=\{SIGNAL_BODY_MAX\}/);
  assert.match(dashboard, /import \{ SIGNAL_BODY_MAX \} from/);
  assert.doesNotMatch(markup, /maxlength="8000"/);
  assert.match(markup, /placeholder="What are you about to do\?"/);
  assert.doesNotMatch(markup, /Message #general|Message #all-signals/i);
  assert.doesNotMatch(markup, /only .* sees|will see|private|lock/i);
  /* This gate was retired for "thread" on 2026-09-05 when a thread reply bar shipped in the
     composer, and RESTORED the same day when the coordinator cut the thread surface to
     `lane/chat-app-threads`. Nothing in the composer may name a feature that is not there,
     and none of the three is. */
  assert.doesNotMatch(markup, /emoji|reaction|thread/i);

  /* An untagged body is still a broadcast; that default did not change, only where it is read
     from. There is no stored address to disagree with the text. */
  assert.match(dashboard, /tagged\.length === 0 \? \[\{ kind: "everyone" \}\] : tagged/);
  assert.doesNotMatch(dashboard, /let composerAudience|composerPostAgentNote/);
});

/* RETIRED (2026-09-04): "the agent-only control opts out of wake". That control was the note
   checkbox, and it is gone — an @tag on an agent IS the wake. browserSignalKind still takes the
   opt-out flag for the CLI's sake; the app never passes it, which is what the second assertion
   below pins. */
test("composer kind defaults by recipient, and the app never opts out of the wake", () => {
  assert.deepEqual([
    browserSignalKind({ kind: "everyone" }),
    browserSignalKind({ kind: "person", id: "person-1" }),
    browserSignalKind({ kind: "agent", id: "agent-1" }),
  ], ["note", "note", "ask"]);

  const submit = between(
    dashboard,
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
    'for (const button of all<HTMLButtonElement>("[data-feed-filter]")',
  );
  /* The kind is PER recipient now. Tags in the body can name a person and an agent in one
     message, and the agent must be woken while the person is not — which is why the note
     checkbox could go: an @tag on an agent IS the wake. */
  assert.match(submit, /const recipientKinds = recipients\.map\(\(recipient\) => browserSignalKind\(recipient\)\)/);
  assert.match(submit, /kind: recipientKinds\[index\]!/);
  assert.match(
    submit,
    /rawBody,\s*recipient,\s*recipientKinds\[index\]!,\s*attachmentRefs,\s*placement,/,
  );
  assert.doesNotMatch(dashboard, /browserSignalKind\([^)]*,\s*true\)/);
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
  /* ~~`attachmentRefs,\s*\)\);`~~ retired 2026-09-05: `placement` is the last argument now,
     and it is where the post says which channel it lands in. */
  assert.match(
    submit,
    /rawBody,\s*recipient,\s*recipientKinds\[index\]!,\s*attachmentRefs,\s*placement,\s*\)\);/,
  );
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

/* RETIRED CLAIM (2026-09-04): "one removable address chip". The picker used to lift the name
   OUT of the text and park it in a chip beside the box. Chips are gone: the pick writes the name
   into the body, where the reader can see and edit it like any other word, and the send reads the
   address back out of that text. */
test("the mention picker writes the name into the message body", () => {
  /* Two slices: the pick (which writes the tag) and the list itself (which renders it). */
  const pick = between(dashboard, "const selectMention", "const renderMentionPicker");
  const picker = between(dashboard, "const renderMentionPicker", "const resetComposer");
  assert.match(picker, /role", "option"/);
  assert.match(picker, /aria-selected/);
  assert.match(picker, /dashboard__mention-picker-avatar/);
  assert.match(picker, /markAgentAvatar/);
  assert.match(picker, /agent · managed by/);
  assert.match(pick, /const tag = `@\$\{entityName\(mention\)\} `;/);
  assert.match(pick, /input\.value = `\$\{input\.value\.slice\(0, search\.start\)\}\$\{tag\}/);
  assert.doesNotMatch(pick, /composerMention|dashboard__mention-chip/);

  const keys = between(
    dashboard,
    'one<HTMLTextAreaElement>("[data-composer-input]")?.addEventListener(\n      "keydown"',
    'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
  );
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Enter"]) {
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
