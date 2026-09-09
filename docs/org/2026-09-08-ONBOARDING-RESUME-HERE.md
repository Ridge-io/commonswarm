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

---

# v0.1.66 — the connection hand-off survives a Markdown client (2026-09-08, later)

## LIVE
`main` at the release commits; tag `v0.1.66` on bump `3d47c13`. npm `commonswarm@0.1.66` (registry shasum
`efb11881…`, `latest`), GitHub latest release `v0.1.66` with asset sha256 `8e2c5036…`, and the installed
binary's sha256 equals that asset exactly. Site deployed; `/download` reads 0.1.66. CLI published and
confirmed on the registry BEFORE the site went out.

## What changed
The dashboard hands the connection JSON and the install command over inside fenced code blocks. The fence
is computed as one longer than the longest backtick run in the payload, so a run inside can never close the
block. `cswarm setup` recognises a Markdown-damaged file and refuses BEFORE it authenticates, naming the
recovery path rather than asking anyone to repair a credential by hand. The prompt now says wake needs
Claude Code preview channels and Codex uses turn checks. Credentials unchanged; `setup_version` stays 1.

## D-036
Both arms on the exact SHA `b36922c`, author family excluded: **Grok exact PASS**, **Gemini inversion
PASS**. Gemini derived the fence property from the CommonMark closing-fence rule; Grok worked file:line.
Evidence: `docs/evidence/2026-09-08-connection-handoff/arms-b36922c/`.

## Lead verification
Gates re-run as bare statements with their exit codes read: build 0, tsc 0, check:tests 0, npm test
869/869, p1-cli 573/573, build-release 0 (verifies by running the artifact), site build 0, site tests 543
with the suite's one existing skip, identity 0.

An independent probe of the fence rule (`docs/evidence/2026-09-08-connection-handoff/fence-probe.mjs`)
passed eight adversarial payloads: none, one, exactly three, four, ten, a run at the start, a run at the
end, and mixed runs.

The deployed chunk `/_astro/AgentConnect.astro_astro_type_script_index_0_lang.BZgbpl-w.js` is served from
production carrying "Save only the JSON code block contents" and "Wake requires Claude Code preview
channels", with the retired "save the JSON below unchanged" gone (count 0), and `/app` references that
exact chunk.

With the RELEASED binary against production: a clean envelope still imports (`connected: true`,
`setup_version: 1`, correct identity), a file whose underscores were escaped as `\_` is refused with the
Markdown message and exit 1, and a fenced paste is refused the same way. Both refusals happen before any
authentication.

## Note on the detection
`\_` is not a valid JSON escape, so a file containing it cannot parse as JSON. The Markdown detection
therefore sits on the parse-failure path only and cannot fire on a valid envelope.

## NOT established
The exact step that damaged the original paste is still unknown; the site copies its source string
unchanged, so the damage happens somewhere between the copy and the saved file. The fleet was not
restarted: this release changes no listener behaviour.

---

# The hand-off damage was the clipboard's HTML flavour, not the fences (2026-09-08, later still)

## What was reported
On 0.1.66 a real hand-off still arrived broken: underscores escaped as `\_`, the API URL rewritten as a
Markdown link, fences malformed. The agent obeyed the new instruction and refused to repair credentials,
so it did not connect. **0.1.66 did not fix the reported case.**

## Cause, measured
`#copy()` calls `navigator.clipboard.writeText()`, which writes `text/plain` only — the Copy button was
never the cause. But **a manual selection copy** (and the clipboard-refused fallback, which selects the
`<pre>` and asks the reader to press ⌘C) makes the browser write `text/html` as well, and a Markdown-aware
target converts THAT. Markdown conversion escapes underscores and linkifies bare URLs, which is exactly the
reported signature. Code fences live inside the payload and cannot reach damage that happens on a different
clipboard flavour, which is why 0.1.66 did not help.

Nothing pinned the flavour: `grep -nE "addEventListener\('copy'|clipboardData|setData|text/html"` over
`site/src/components/connect/AgentConnect.astro` returned nothing before this change.

## Fix, LIVE
`site/src/components/connect/AgentConnect.astro` now handles `copy` on the prompt block: it sets
`text/plain` from `promptCopyPayload()` and calls `preventDefault()`, so no HTML flavour is produced by any
copy out of that block. A partial selection is preserved; only whitespace falls back to the whole prompt.
Site only — **no CLI release**; the CLI stays at 0.1.66.

Merged `638e41b`. Arms on `1f460eb`: **Grok PASS, Gemini PASS**
(`docs/evidence/2026-09-08-copy-flavour/`). Grok noted the one-character selection was unpinned; a
test-only commit pinned it afterwards (no behaviour change from the reviewed SHA). Mutation control:
injecting `.replace(/_/g, "\\_")` into `promptCopyPayload` fails the suite 545/1; restoring passes 547/0.

Deployed and verified: the served chunk
`/_astro/AgentConnect.astro_astro_type_script_index_0_lang.CAeVJxjg.js` carries `text/plain` and the
0.1.66 wording, the retired "save the JSON below unchanged" is absent, and `/app` references that chunk.

## Still NOT established
Whether a live browser emits `text/html` after `preventDefault()` — the clipboard event contract says it
does not, but no headless control here exercises a real UA. Grok also could not rule out a UA that
synthesises its own `public.html` flavour. The **download** path was always immune (a raw Blob), so
"Use a setup file" remains the recommended route and is what an affected user should use now.

## Operator note
Astra1 (`282a2587`) has the PR #1864 request queued as ask `a341a357`; the operator tells it to check.

## First post-fix hand-off, measured (2026-09-09)

The operator pasted a freshly generated prompt for Astra1 (`282a2587`) into this session. Measured on the
received text, not on a rendering: **no `\_` anywhere, no Markdown link, and the JSON parses**, with the
`anon_key` carrying a bare underscore. The URL is a plain string. So the deployed hand-off is clean through
that path.

Astra1 nevertheless reported the same damage. Both can be true: the prompt is clean when it leaves
CommonSwarm and is converted by whatever client the paste lands in — which is the whole reason the copy now
writes `text/plain` only, and the reason the file download exists. It is also possible Astra1 judged the
prompt as rendered in its own context rather than bytes it had written to disk; the discriminating test is
to write the block to the file and let `cswarm setup` parse it, because the CLI reads bytes and an agent
reads a rendering.

**Credential exposure:** that hand-off included a live agent token for `282a2587`
(token_id `cfd363b9-4e29-46f0-b384-86382a92db1d`, expires 2026-10-09) and it is now in at least two chat
transcripts. The lead cannot revoke another principal's token — `cswarm token revoke` refused with
"token-id does not match the credential" — so the human must revoke it and mint a replacement. Until then
treat it as compromised.
