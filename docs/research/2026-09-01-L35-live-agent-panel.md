# L35 — live agent activity in the dashboard: the first streaming slice

Repo: worktree path given at launch (branch lane/l35-live-agent-panel). Read first: AGENTS.md; docs/design/SWARM-CLOUD.md §"live steering" (the structured stream, not a terminal tab); the investigation report copied to scratchpad/reboot-survival/streaming-investigation.md (its §1 recommended first slice, §3.1 Realtime measurements, §4.2 durability boundary, §5.3 the decision already made, §6.1 redaction).

## Scope (the report's recommended first slice, unchanged)
Listener agents publish a coalesced STATUS FRAME (≤2 frames/s per channel) to a private, authorization-enforced per-workspace Supabase Realtime broadcast channel: which signal they are working, phase (claimed / prompting / tool-running / replying / idle), the current tool title, elapsed time. The dashboard entity panel (site/src/lib/entity-panel.ts) gets a LIVE section above the credential fields showing that frame with its age; agents that are not listener-run render "Not instrumented — this agent posts with the CLI and does not stream activity". No schema migration, no new table: status is ephemeral (report §4.2). Token streaming into the transcript (Feature A) is NOT in this lane.

## Hard constraints
1. Redaction: reuse src/host/stderr-tail.ts's CREDENTIAL_PREFIX_RE and its zero-width-joiner normalisation by moving them into a shared module used by both; do not write a second redactor. Tool titles and any free text in a frame pass through it.
2. Never publish raw terminal bytes, stderr tails, or message bodies in a frame (report §5.3 — an operator decision, not ours to reverse).
3. Measure BEFORE building on it: the report saw ~2 frames/s per channel with silent loss above it and send() returning "ok" for dropped frames. Re-measure on the real project with a positive control (send 10/s, count receipts), record the number and whether it is a project quota, and size the coalescer to stay under it with margin.
4. Authorization: only workspace members may subscribe; agents publish only their own frames; verify with a negative test (another workspace's member cannot receive).
5. Durable-by-default rule: nothing here is read back later, so RAM/Realtime is allowed; say so in the code comment with the spec cite.

## Tests (name the gate)
- Frame coalescing (≤2/s) and redaction (a token in a tool title never leaves the process) — pure.
- Panel rendering for: fresh frame, stale frame (>30 s: shows "last seen N s ago"), not-instrumented agent — site tests.
- Authorization negative test — p1-local (needs the stack; say so) or a fake-channel unit test plus a manual measurement recorded in the report.

## Gates
npm run build; npm test; npm run test:p1-cli; npm run check:tests; npm run check:edge (if edge touched); npm --prefix site run build; npm --prefix site test

## Rules
Quote style file-local. COMMIT on your branch when green (scoped add). Do not push/release/deploy. Report to <scratchpad>/L35-report.md, written LAST: the measured Realtime ceiling with its positive control, mechanism, mutation firings, gate tails, NOT established.
