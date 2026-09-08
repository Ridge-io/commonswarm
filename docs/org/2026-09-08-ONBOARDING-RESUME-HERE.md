# RESUME HERE — agent onboarding released as v0.1.65 (2026-09-08)

## What is LIVE
- `main` at `d703580` (merge) then the release commits; tag `v0.1.65` on bump `732e0a5`.
- npm `commonswarm@0.1.65`, registry shasum `a21508e1…`; GitHub latest release `v0.1.65`, asset sha256
  `1ab63da1…`, and the installer serves it (`releases/latest/download/cswarm` → 200).
- The site is deployed. The prompt lives in the `/app` dashboard chunk
  `/_astro/AgentConnect.astro_astro_type_script_index_0_lang.y7VuqwJe.js`, not on a public page — the
  guessed `/connect` route is a 404 and always was. That chunk is served from production carrying
  `cswarm setup`, `cswarm check` and `cswarm receive`, and no longer carries the retired
  "local Claude worker" guidance (grep count 0). `/download` reads 0.1.65.
- **Order held:** the CLI was published and confirmed on the registry BEFORE the site advertised the new
  commands.
- No database or edge change ships in this release.

## D-036 (was owed; now satisfied)
Both arms on the exact SHA `3e5046d`, author family Claude excluded: **Grok exact PASS** and
**Gemini inversion PASS**, each with attempted refutations at file:line and an honest not-established
list. Grok also ran `tsc`, `build`, and 30 focused tests in its own throwaway worktree. Files:
`docs/evidence/2026-09-08-agent-onboarding/arms-3e5046d/`.

## Live controls against production (the lead, from a real Claude Code session)
`docs/evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md`. Re-run at the end with the RELEASED binary,
whose sha256 matches the release asset exactly:
- `setup` → `connected: true`, real identity `CSwarmDevLead`, `inbox_pending: true`.
- `check` → 4 real pending messages, `has_more: true`; a second call returned the NEXT page, so the cursor
  advances across invocations.
- `receive configure --mode turn --provider instructions` → `turn_check: "instruction"`, no hook file.
- `receive configure --mode wake` → `effective_mode: "turn"`, `wake_verified: false`, with the next step
  named. **The product refuses to call wake verified before an idle receipt test.**
- `receive serve` on that profile → refuses, because wake was never actually configured. Coherent loop.
- Rebinding one host session id to a different provider → refused, `receive_provider_conflict`.
- A profile directory at mode 755 → refused; it requires 0700. Failures exit 1.
- With a wake-configured profile, `receive serve` answers a real MCP `initialize` advertising
  `experimental: { "claude/channel": {} }`.

## NOT established
- **A model receiving an idle wake.** That needs the host to attach the MCP channel and an idle turn to
  elapse in the same session; it cannot be driven from inside a tool call. Wake therefore ships as a
  preview and the command reports `wake_verified: false` until a real idle test passes. Codex idle wake is
  unavailable.
- The turn hook was installed and read back, but never observed firing: hooks load at session start.
- No 10x end-to-end claim. The measured number is the prompt alone: 4,059 → 269 tokens.

## Corrections
- A previous note in this file's evidence said the entry guide told agents to install ACP bridges and a
  "local Claude worker". That wording is retired and is absent from the deployed chunk.
- The lead's own first release-verification pipeline read `exit: 0` on a failing command. That was the
  pipeline's exit code, not the command's; measured directly, `setup` exits 1 on failure. Do not read `$?`
  through a pipe — the same class of mistake shipped the broken 0.1.62.

## Host state restored
`receive configure` writes a hook into `.claude/settings.local.json` of whatever `--cwd` it is given. The
first live control pointed it at the shared checkout; that path is globally gitignored so there was no repo
diff, `.claude/settings.json` was untouched, and the hook was removed afterwards because it named this
seat's private profile and another Claude session in this repository would have consumed this seat's
messages. Later controls used a temporary directory. A copy of what was installed is in the session
scratchpad. No `receive serve` process remains.

## Deliberately NOT done
The fleet was not restarted. 0.1.65 adds commands and changes no listener behaviour, and the seats run
0.1.64 correctly; a restart is the step that broke the fleet on 0.1.58, so it buys nothing here. Seats pick
0.1.65 up at their next scheduled restart.
