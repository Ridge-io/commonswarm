import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listenerPermissionMode } from "../../src/cli.js";

/* The default permission mode for a listener, pinned.
 *
 * WHY THIS FILE EXISTS AT ALL: the default was flipped from deny to allow and **747 tests passed
 * unchanged** — `npm test` 499/499 and `test:p1-cli` 248/248. Nothing exercised the omitted-flag
 * path in either direction. Two `permissionMode: "deny"` literals appear in the suite and both are
 * fixture fields being handed IN, not the resolver's answer. A default that can be inverted
 * silently is not a default anyone is holding.
 *
 * WHAT WAS MEASURED, 2026-08-11: on the two-agent dogfood (OpenCode; the other three providers
 * were not exercised) a worker started under `deny` had Bash and Write refused, so it could not
 * hash, persist, or initiate — and `cswarm listen status` reported it healthy throughout. The
 * agent on the other end read it as uncooperative. Operator direction the same day: "we want low
 * friction here by default."
 *
 * SCOPE OF `deny`, since the first version of this comment overstated it: deny governs only the
 * operations the PROVIDER raises a permission request for. Which those are is the provider's
 * choice, not ours.
 *
 * WHAT `allow` IS: allow-once PER REQUEST, falling back to deny when the host offers no such
 * option. Not a blanket grant. The permission-boundary canary forces deny regardless of the mode,
 * so the proof that CommonSwarm controls ACP permissions is untouched by this default.
 *
 * WHAT IS NOT ESTABLISHED: steady-state `allow` is unmeasured — the canary's own limit strings in
 * src/cli.ts say exactly that and remain true. This file pins the DEFAULT, not the safety of the
 * mode it selects. */

test("omitting --permissions selects allow, not deny", () => {
  assert.equal(listenerPermissionMode(undefined), "allow");
});

test("--permissions deny is still reachable, and still means deny", () => {
  /* CONTROL, and the one that carries the weight. "Low friction by default" is satisfiable by
   * deleting deny entirely, which would pass the assertion above while removing the only answer
   * for a listener that takes work from outside your account. The harder mode has to survive its
   * own demotion. */
  assert.equal(listenerPermissionMode("deny"), "deny");
  assert.equal(listenerPermissionMode("allow"), "allow");
});

test("an unrecognised value is still rejected rather than defaulted", () => {
  /* A resolver written as `value === "deny" ? "deny" : "allow"` passes both tests above and
   * silently upgrades a TYPO to allow — `--permissions den` would grant tool use. That is a worse
   * defect than the one being fixed, because the operator asked for the safe mode and got the
   * permissive one with no error. */
  assert.throws(() => listenerPermissionMode("den"), /must be deny or allow/);
  assert.throws(() => listenerPermissionMode("Allow"), /must be deny or allow/);
  assert.throws(() => listenerPermissionMode(""), /must be deny or allow/);
});

test("the deny escape hatch is documented where an operator will meet it", () => {
  /* Pins the CLAIM, not just the behaviour. A default that trades an enforced boundary for
   * friction is only defensible if the operator can find the boundary again; if the onboarding
   * prompt stops naming deny, the trade becomes invisible and this whole change is a downgrade.
   *
   * Read from the prompt SOURCE because that is the authority for what a new operator is told —
   * checking cli.ts against cli.ts would only prove our own files agree with each other. */
  const prompt = readFileSync(
    new URL("../../site/src/components/connect/agent-prompt.ts", import.meta.url),
    "utf8",
  );
  /* Comment-stripped: this same file explains the change in a block comment that contains every
   * string below, so an unstripped read would pass on the explanation alone. That mistake has
   * been made four times in this repo. */
  const emitted = prompt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(emitted, /--permissions allow/, "the prompt no longer starts listeners with allow");
  assert.match(
    emitted,
    /--permissions deny/,
    "the prompt stopped naming the mode that protects a cross-owner listener",
  );
  assert.match(
    emitted,
    /outside your account/,
    "the prompt names deny without saying when an operator should reach for it",
  );
});

test("every provider the CLI accepts is offered a detached adapter in the onboarding prompt", () => {
  /* Codex was missing from the prompt's adapter list while `cswarm listen start` accepted it, so a
   * Codex user was routed to the foreground fallback — which does not wake a model. One of four
   * supported providers silently lost the feature, and the site suite stayed green because nothing
   * compared the two lists.
   *
   * Read the CLI usage line as the AUTHORITY for what is supported, and the prompt source for what
   * is offered. Comparing the prompt against another copy of the prompt would only prove our own
   * files agree — which is exactly how this survived. */
  const cliUsage = readFileSync(
    new URL("../../src/cli.ts", import.meta.url),
    "utf8",
  );
  const usageLine = cliUsage
    .split("\n")
    .find((line) => line.includes("cswarm listen start") && line.includes("--provider"));
  assert.ok(usageLine, "the listen start usage line moved; this control cannot find the authority");

  const supported = (/--provider ([a-z|]+)/.exec(usageLine!)?.[1] ?? "").split("|").filter(Boolean);
  assert.ok(supported.length >= 4, `expected 4+ providers in the usage line, saw ${supported.join(",")}`);

  const prompt = readFileSync(
    new URL("../../site/src/components/connect/agent-prompt.ts", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  for (const provider of supported) {
    assert.ok(
      prompt.includes(`--provider ${provider}`),
      `the CLI supports --provider ${provider} but the onboarding prompt never offers it`,
    );
  }
});
