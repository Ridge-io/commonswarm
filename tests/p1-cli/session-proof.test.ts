import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SESSION_ERROR_CODE_LIST,
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  isAgentSessionErrorCode,
} from "../../src/cloud/session-contract.js";
import {
  AgentSessionError,
  agentSessionErrorFromBody,
  sessionErrorMessage,
} from "../../src/cloud/session-errors.js";
import {
  bindSessionProof,
  generateSessionKey,
  proofHeaders,
  redactSessionHeaders,
  redactSessionText,
  sessionKeyHash,
} from "../../src/cloud/session-proof.js";

test("proof headers match the wire names and are redacted in logs", () => {
  const proof = {
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    key: generateSessionKey(),
  };
  const headers = proofHeaders(proof);
  assert.equal(headers[AGENT_SESSION_ID_HEADER], proof.session_id);
  assert.equal(headers[AGENT_SESSION_GENERATION_HEADER], "7");
  assert.equal(headers[AGENT_SESSION_KEY_HEADER], proof.key);
  const redacted = redactSessionHeaders({
    ...headers,
    authorization: "Bearer swm_agt_SYNTHETICSYNTHETICSYNTHETICSYNTHETICxxx",
  });
  assert.equal(redacted[AGENT_SESSION_KEY_HEADER], "[redacted-session-proof]");
  assert.equal(redacted[AGENT_SESSION_ID_HEADER], "[redacted-session-proof]");
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(proof.key));
  const text = redactSessionText(
    `${AGENT_SESSION_KEY_HEADER}=${proof.key} swm_agt_SYNTHETICSYNTHETICSYNTHETICSYNTHETICxxx`,
  );
  assert.doesNotMatch(text, new RegExp(proof.key));
  assert.doesNotMatch(text, /swm_agt_/);
});

test("bindSessionProof attaches headers without putting proof in the body", async () => {
  const proof = {
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 2,
    key: generateSessionKey(),
  };
  let seen: Headers | null = null;
  let body = "";
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    body = String(init?.body ?? "");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const bound = bindSessionProof(fetcher, proof);
  await bound("http://127.0.0.1:9/functions/v1/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command_id: "stable-id", command: { kind: "post_signal" } }),
  });
  assert.equal(seen!.get(AGENT_SESSION_ID_HEADER), proof.session_id);
  assert.equal(seen!.get(AGENT_SESSION_KEY_HEADER), proof.key);
  assert.match(body, /stable-id/);
  assert.doesNotMatch(body, new RegExp(proof.key));
});

test("session errors classify on the code field, never error.message", () => {
  for (const code of AGENT_SESSION_ERROR_CODE_LIST) {
    assert.equal(isAgentSessionErrorCode(code), true);
    const error = agentSessionErrorFromBody(403, { error: code });
    assert.ok(error instanceof AgentSessionError);
    assert.equal(error!.code, code);
    assert.equal(error!.message, sessionErrorMessage(code));
  }
  assert.equal(agentSessionErrorFromBody(500, { error: "internal_error" }), null);
  const typed = new AgentSessionError(409, "session_conflict");
  assert.equal(typed.code, "session_conflict");
  assert.notEqual(typed.message, "session_conflict");
});

test("key hash is sha256 hex of the key string", () => {
  const key = generateSessionKey();
  assert.equal(sessionKeyHash(key).length, 64);
  assert.match(sessionKeyHash(key), /^[0-9a-f]{64}$/);
  assert.equal(sessionKeyHash(key), sessionKeyHash(key));
});
