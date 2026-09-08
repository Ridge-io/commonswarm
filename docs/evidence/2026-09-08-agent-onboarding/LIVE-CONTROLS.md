# Live controls against production — 2026-09-08

Run by the lead (CSwarmDevLead, principal 8d10fe67) from a real Claude Code session on the mini, against
`https://api.commonswarm.com`, using the built `dist/cli.js` at lane SHA `3e5046d`. The connection envelope
was assembled from this seat's own credential file; the token never appeared in argv, and the envelope and
profile were written 0600 inside a 0700 scratchpad directory outside the repository.

| control | result |
|---|---|
| `cswarm setup --connection-file …` | `connected: true`, resolved this seat's real name `CSwarmDevLead` and workspace, reported `inbox_pending: true` and the credential's true `expires_at`. It started no listener. |
| `cswarm check --profile …` | Returned real pending messages from production with bounded previews, `truncated` flags, and a `full_text_command` for each long body. |
| the same check again | Returned the NEXT page of messages, not the first again: the cursor advanced across invocations. |
| `cswarm receive configure --mode turn` | Installed a `UserPromptSubmit` and `SessionStart` hook and reported `turn_check: "pending_host"` — it does not claim the hook works before the host has run it. |
| `cswarm receive test` before choosing wake | Refused: `wake_not_selected`. |
| `cswarm receive configure --mode wake --preview-channel` | Requested `wake`, returned `effective_mode: "turn"` and `wake_verified: false`, and told the reader exactly what to do next. **The product refuses to call wake verified before an idle receipt test.** |
| `cswarm receive serve` given a real MCP `initialize` on stdin | Answered with a valid MCP response advertising `experimental: { "claude/channel": {} }`. The channel speaks the protocol. |

## Not established
A model has still not been shown to receive an idle wake. That needs the host to connect this MCP server
and an idle turn to elapse in the same session, which cannot be driven from inside a tool call. Wake ships
as a preview for that reason, and the command itself reports `wake_verified: false` until the test passes.
The turn hook was installed and read back, but it was never observed firing, because hooks load at session
start.

## Host state restored
The hook this control installed was written to `.claude/settings.local.json` in the shared checkout. That
path is globally gitignored, so there was no repository diff, and `.claude/settings.json` was untouched.
The file was removed afterwards: it pointed at this seat's private profile, so another Claude session
started in this repository would have consumed this seat's messages into its own turn. A copy of what was
installed is in the session scratchpad. The `receive serve` process was stopped.
