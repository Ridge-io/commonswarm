/** ★ THIS FILE IS NAMED IN `npm test` */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyClaudeCanaryFailure } from "../src/listener/claude-canary-classify.js";

test("Claude canary classifier records the API floor and uses typed timeout", () => {
  assert.deepEqual(
    classifyClaudeCanaryFailure(
      "Internal error: API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.251 or newer is required.",
      "rpc_error",
    ),
    {
      code: "claude_bridge_version_required",
      minimumRequiredVersion: "2.1.251",
    },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("wording can change", "timeout"),
    { code: "claude_canary_timeout", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed (failed 2 attempts)",
      "rpc_error",
    ),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("presentation text changed", "rpc_error", {
      code: -32603,
      data: { errorKind: "authentication_failed" },
    }),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("presentation text changed", "rpc_error", {
      code: -32000,
    }),
    { code: "claude_canary_auth_failed", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("ordinary unknown bridge text", "rpc_error"),
    { code: "claude_canary_unknown", minimumRequiredVersion: null },
  );
  assert.deepEqual(
    classifyClaudeCanaryFailure("could not be refreshed", "rpc_error"),
    { code: "claude_canary_unknown", minimumRequiredVersion: null },
  );
});
