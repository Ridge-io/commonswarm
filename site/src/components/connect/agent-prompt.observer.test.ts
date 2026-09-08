import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { dashboardAgentConnection, dashboardAgentFilePrompt, dashboardAgentPrompt, promptCopyPayload} from "./agent-prompt";
import { parseAgentConnection } from "../../../../src/cloud/agent-profile";
import { AGENT_CONNECTION_FIELDS } from "../../../../src/cloud/agent-onboarding-contract";

const TOKEN = `swm_agt_${"A_".repeat(21) + "A"}`;
const INPUT = {
  credential: {
    principalId: "11111111-1111-4111-8111-111111111111", principalName: "Observer",
    tokenId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333",
    token: TOKEN, expiresAt: Date.parse("2099-07-29T23:00:00Z"), renews: true,
    horizonExpiresAt: null, grantKind: "standing" as const,
  },
  workspaceId: "44444444-4444-4444-8444-444444444444", workspaceName: "Observer room",
  deploymentUrl: "https://example.supabase.co", anonKey: "TEST_ONLY_PUBLIC_KEY",
};

test("the generated connection is accepted by the CLI without changing the credential schema", () => {
  const raw = dashboardAgentConnection(INPUT);
  const envelope = parseAgentConnection(raw);
  assert.deepEqual(Object.keys(envelope).sort(), [...AGENT_CONNECTION_FIELDS].sort());
  assert.equal(envelope.credential.agent_token, TOKEN);
  assert.equal(envelope.principal_id, INPUT.credential.principalId);
  assert.equal(envelope.workspace_id, INPUT.workspaceId);
  assert.equal(raw.split(TOKEN).length - 1, 1);
});

test("one-paste setup includes a single connection and full agent ID, with private file instructions", () => {
  const prompt = dashboardAgentPrompt(INPUT);
  assert.equal(prompt.split(TOKEN).length - 1, 1);
  assert.equal(prompt.split(INPUT.anonKey).length - 1, 1);
  assert.match(prompt, new RegExp(`connect-${INPUT.credential.principalId}/connection.json`));
  assert.match(prompt, /file-writing tool/);
  assert.match(prompt, /0700/);
  assert.match(prompt, /0600/);
  assert.match(prompt, /cswarm setup --connection-file/);
  assert.match(prompt, /cswarm setup --check-version/);
  assert.ok(prompt.length < 2900, `inline prompt grew to ${prompt.length} characters`);
});

test("file handoff stays short without hiding a manual fetch", () => {
  const prompt = dashboardAgentFilePrompt(INPUT);
  assert.ok(prompt.length <= 1600, `file prompt has ${prompt.length} characters`);
  assert.equal(prompt.includes(TOKEN), false);
  assert.equal(prompt.includes(INPUT.anonKey), false);
  assert.match(prompt, /attached connection JSON/);
  assert.match(prompt, /setup guide only when needed/);
});

test("both prompts require the mode choice and same-session proof, without retired workers", () => {
  for (const prompt of [dashboardAgentPrompt(INPUT), dashboardAgentFilePrompt(INPUT)]) {
    assert.match(prompt, /Ask once:[\s\S]*wakeups in this same session[\s\S]*each turn's start and whenever asked/);
    assert.match(prompt, /user's choice[\s\S]*reuse a saved choice/);
    assert.match(prompt, /idle test passes/);
    assert.match(prompt, /cswarm check before work/);
    assert.doesNotMatch(prompt, /claude-agent-acp|codex-acp|--permissions allow|local Claude worker|note.*does NOT wake|Only after the detached listener/);
    assert.doesNotMatch(prompt, /renews (itself|automatically)|does not expire/);
  }
});

test("file download stays in memory, can be cleared, and key lifetime is under settings", () => {
  const source = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
  assert.match(source, /<details class="ac__advanced">[\s\S]*data-field="ttl"[\s\S]*<\/details>/);
  assert.match(source, /data-action="download-connection"/);
  assert.match(source, /URL.revokeObjectURL/);
  assert.match(source, /#forget\(\) \{[\s\S]*this.#connection = null;[\s\S]*this.#filePrompt = null;/);
  assert.doesNotMatch(source, /localStorage.setItem/);
});


test("copy source has lossless fenced JSON and a plain executable install command", () => {
  const prompt = dashboardAgentPrompt(INPUT);
  const raw = prompt.match(/```json\n([^]*?)\n```/)?.[1];
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), JSON.parse(dashboardAgentConnection(INPUT)));
  assert.equal(parseAgentConnection(raw).credential.agent_token, TOKEN);
  assert.equal(prompt.match(/```sh\n([^]*?)\n```/)?.[1], "curl -fsSL https://commonswarm.com/install.sh | sh");
  assert.doesNotMatch(raw, /\\_/);
  assert.match(prompt, /Use a setup file/);
  assert.match(prompt, /Codex supports turn checks/);
  const source = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
  assert.match(source, /navigator.clipboard.writeText\(this.#prompt\)/);
  assert.match(source, /node.textContent = value/);
});


test("the component copy method sends the source string even when displayed text differs", async () => {
  const source = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("    async #copy()"), source.indexOf("\n  }\n", source.indexOf("    async #copy()")));
  // Execute the shipped method with inert DOM/timer dependencies; no browser or credentials.
  const harness = `return class {
    #prompt; #copyTimer; constructor(prompt) { this.#prompt = prompt; }
    #q() { return { textContent: "altered display", setAttribute() {} }; }
    #text() {} #resetCopyLabel() {}
    async copy() { await this.#copy(); }
    ${method}
  }`;
  const js = ts.transpile(harness, { target: ts.ScriptTarget.ES2022 });
  let copied = "";
  const Component = new Function("navigator", "window", js)(
    { clipboard: { async writeText(value: string) { copied = value; } } },
    { clearTimeout() {}, setTimeout() { return 1; } },
  );
  const prompt = dashboardAgentPrompt(INPUT);
  await new Component(prompt).copy();
  assert.equal(copied, prompt);
  assert.deepEqual(JSON.parse(copied.match(/```json\n([^]*?)\n```/)![1]!), JSON.parse(dashboardAgentConnection(INPUT)));
});


/* The clipboard flavour, measured against a real damaged hand-off on 2026-09-08.
 *
 * A manual selection copy writes text/plain AND text/html. A Markdown client converts the HTML,
 * which escapes underscores as \_ and rewrites a bare URL as a Markdown link — the exact damage
 * reported from a live connection attempt, arriving by a route the code fences cannot reach. The
 * block now writes plain text itself; this pins WHAT it writes. */
test("an empty selection copies the whole prompt, because a keyboard copy has no range", () => {
  assert.equal(promptCopyPayload("", "WHOLE PROMPT"), "WHOLE PROMPT");
  assert.equal(promptCopyPayload("   \n\t ", "WHOLE PROMPT"), "WHOLE PROMPT");
});

test("a partial selection stays exactly that selection", () => {
  assert.equal(promptCopyPayload("cswarm setup", "WHOLE PROMPT"), "cswarm setup");
});

/* The Grok arm on 1f460eb noted this case was unpinned: a ONE-CHARACTER selection is legitimate and
 * must not fall through to the whole prompt. Only whitespace may. */
test("a one-character selection is kept, and only whitespace falls back", () => {
  assert.equal(promptCopyPayload("_", "WHOLE PROMPT"), "_");
  assert.equal(promptCopyPayload("`", "WHOLE PROMPT"), "`");
  assert.equal(promptCopyPayload(" ", "WHOLE PROMPT"), "WHOLE PROMPT");
});

test("the payload is returned byte for byte: no underscore escaping, no link rewriting", () => {
  const hostile = '{"anon_key":"a_b-c","url":"https://api.commonswarm.com"}';
  assert.equal(promptCopyPayload(hostile, "WHOLE"), hostile);
  assert.ok(!promptCopyPayload(hostile, "WHOLE").includes("\\_"), "an underscore must not be escaped");
  assert.ok(!promptCopyPayload(hostile, "WHOLE").includes("]("), "a URL must not become a Markdown link");
  const whole = 'save {"anon_key":"a_b"} to https://api.commonswarm.com';
  assert.equal(promptCopyPayload("", whole), whole);
});
