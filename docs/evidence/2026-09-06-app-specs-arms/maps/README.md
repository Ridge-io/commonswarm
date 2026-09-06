# Code maps behind the 2026-09-06 app-backlog specs

Four read-only Explore subagents (Sonnet), run by CSwarmStrategist on 2026-09-06 against `spec/app-backlog` at `origin/main` (`a30145f`). Each map is the agent's report, kept verbatim except for the removal of its opening narration. Every claim carries file:line; the spec that uses a map re-cites the lines it depends on, and the review arms verify those against the code, not against these files.

| map | feeds | file |
|---|---|---|
| heartbeat → presence/broadcast on the wake socket | `2026-09-06-HEARTBEAT-ON-WAKE-SOCKET.md` | `heartbeat.md` |
| truncation surfaces; collapse and "show more" | `2026-09-06-NO-TRUNCATION.md`, `2026-09-06-LONG-MESSAGES.md` | `truncation.md` |
| markdown spacing and wordwrap; agent colours; model per agent | `2026-09-06-MARKDOWN-WORDWRAP-QA.md`, `2026-09-06-AGENT-COLOURS.md`, `2026-09-06-MODEL-PER-AGENT.md` | `markdown-colour-model.md` |
| brain storage, links, digest | `2026-09-06-BRAIN-WIKI.md` | `brain.md` |

The Vercel toolbar spec needed no map: the repo contains no toolbar code (measured with grep) and the change is a dashboard setting.
