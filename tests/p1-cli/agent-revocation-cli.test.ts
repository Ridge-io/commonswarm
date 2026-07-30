import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("CLI help documents principal revoke and token revoke paths", async () => {
  const source = await readFile("src/cli.ts", "utf8");
  assert.match(source, /cswarm principal revoke/);
  assert.match(source, /cswarm token revoke/);
  assert.match(source, /--agent-token-stdin/);
  assert.match(source, /never takes the secret on argv/);
});

test("principal revoke is human-only and calm on success", async () => {
  const source = await readFile("src/cli.ts", "utf8");
  const start = source.indexOf("async function runPrincipal");
  const end = source.indexOf("async function runToken", start);
  assert.ok(start >= 0 && end > start);
  const principalFn = source.slice(start, end);
  assert.match(principalFn, /action === "revoke"/);
  assert.match(principalFn, /kind: "revoke_agent_principal"/);
  assert.match(principalFn, /Agent identity revoked/);
  assert.match(principalFn, /credentials are unchanged/);
  assert.doesNotMatch(principalFn, /agent-token-stdin/);
});

test("token revoke supports human token-id and agent stdin self-surrender", async () => {
  const source = await readFile("src/cli.ts", "utf8");
  const start = source.indexOf("async function runTokenRevoke");
  const end = source.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0);
  const revokeFn = end > start ? source.slice(start, end) : source.slice(start);
  assert.match(revokeFn, /agent-token-stdin/);
  assert.match(revokeFn, /kind: "revoke_agent_token"/);
  assert.match(revokeFn, /stdinCredential/);
  assert.match(revokeFn, /has no token_id/);
  assert.match(revokeFn, /pipe the JSON artifact from token mint/);
  assert.match(revokeFn, /credential has been surrendered/i);
  assert.match(revokeFn, /Agent credential revoked/);
  // Secret must never appear in success output shape.
  assert.doesNotMatch(revokeFn, /agent_token:/);
  assert.doesNotMatch(revokeFn, /printJson\(agentCredentialArtifact/);
});

test("command client ConnectCommand carries both revoke kinds", async () => {
  const source = await readFile("src/cloud/command-client.ts", "utf8");
  assert.match(source, /kind: "revoke_agent_principal"/);
  assert.match(source, /kind: "revoke_agent_token"/);
});
