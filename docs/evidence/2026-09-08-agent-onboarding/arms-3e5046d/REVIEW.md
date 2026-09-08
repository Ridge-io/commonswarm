# lane/agent-onboarding — freeze for D-036

SHA `3e5046dba0cb008c94010244c1ea070158110ffc`, base `042afa6` (v0.1.64). Diff: `DIFF.patch`.

## Claim, in three sentences
A new short handoff prompt plus an optional private connection file replaces a 4,059-token entry prompt
with 269 tokens, and `cswarm setup` imports that envelope into a profile stored outside git. `cswarm check`
gives a turn-based agent its pending messages with no listener running, sharing one cursor with the hook
and resume paths, while `cswarm receive` saves a mode per profile and host session. The Claude preview
channel wakes the same session over a host-owned MCP stdio channel and never starts a model; the installer
reuses a local build only when the published checksum matches its bytes.

## Files
`src/onboarding-cli.ts`, `src/cloud/agent-{setup,check,receive,profile,host,channel,onboarding-contract}.ts`,
`src/cli.ts`, `install.sh`, `site/src/components/connect/AgentConnect.astro` and `agent-prompt.ts`,
`site/public/skills/cswarm/SKILL.md`, tests under `tests/p1-cli/`, `scripts/benchmark-onboarding.mjs`,
`docs/evidence/2026-09-08-agent-onboarding/`.

## Gate exit codes
Recorded by the lead on this SHA; see the lane report. Every gate is run as a plain statement and its exit
code read — never piped into grep, which is how 0.1.62 shipped a bundle that could not start.

## NOT established (author's own list, docs/evidence/2026-09-08-agent-onboarding/RESULTS.md)
No live Claude or Codex session; no hook trust approval in a real host; no production credential used. The
stdio test uses an MCP client fixture, so it does not prove a model sees an idle event — Claude wake is
preview-only and unverified. Codex idle wake is unavailable. No 10x end-to-end claim is made; the measured
number is prompt tokens only. Quiet empty checks still perform network I/O.
