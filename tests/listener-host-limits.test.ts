/**
 * Exact copy/JSON tests for provider-aware listen host_limits.
 * ★ Named in npm test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { listenerHostLimits } from "../src/cli.js";
import { OPENCODE_FORCED_PERMISSION_TOOLS } from "../src/host/bounds.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("listenerHostLimits opencode states DISABLE_PROJECT_CONFIG probe, not private-home alone", () => {
  const limits = listenerHostLimits("opencode");
  assert.equal(typeof limits.config_isolation, "string");
  assert.equal(typeof limits.deny_canary_scope, "string");
  assert.equal(typeof limits.steady_allow_unproven, "string");
  assert.equal(typeof limits.cross_owner_isolation, "string");
  assert.equal(typeof limits.credential_home_cleanup, "string");
  assert.equal(typeof limits.human_copy, "string");

  const text = limits.human_copy;
  assert.match(text, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(text, /effective-config probe|debug config --pure/);
  assert.match(text, /not a project-config firewall|private 0700 home is auth-only/i);
  assert.doesNotMatch(
    text,
    /private home alone|unless the adapter uses a private home/i,
  );
  assert.match(text, /does not prove steady-state/);
  assert.match(text, /--permissions allow|allow behavior/);
  assert.match(limits.credential_home_cleanup, /retained on shutdown failure/);
});

test("listenerHostLimits grok does not claim OpenCode project-config disable", () => {
  const limits = listenerHostLimits("grok");
  assert.equal(typeof limits.config_isolation, "string");
  assert.equal(typeof limits.deny_canary_scope, "string");
  assert.equal(typeof limits.steady_allow_unproven, "string");
  assert.equal(typeof limits.cross_owner_isolation, "string");
  assert.equal(typeof limits.credential_home_cleanup, "string");

  const text = limits.human_copy;
  assert.doesNotMatch(text, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(text, /Grok|ambient/i);
  assert.match(text, /does not prove steady-state/);
});

test("bounds.ts does not claim wildcard stops project allow merging", () => {
  const source = readFileSync(
    resolve("src/host/bounds.ts"),
    "utf8",
  );
  assert.match(source, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(source, /secondary/);
  assert.doesNotMatch(
    source,
    /wildcard covers future tools so ambient project allow cannot bypass/,
  );
  assert.ok(OPENCODE_FORCED_PERMISSION_TOOLS.includes("*"));
  assert.ok(OPENCODE_FORCED_PERMISSION_TOOLS.includes("bash"));
});
