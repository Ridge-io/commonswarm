# RESUME HERE — 2026-08-29

Written for a successor reading this repo cold. Supersedes `2026-08-27-RESUME-HERE.md`, which
remains accurate for the v0.1.26–v0.1.31 arc.

Session covered: **v0.1.31 → v0.1.37**, nine releases, all live. Every one traces back to a
single operator question: *"are you getting my messages?"*

---

## 1. Refs by hash

| ref | what it is |
|---|---|
| `b9268e1` | **`main`** — v0.1.37 release. Latest. |
| `c99758b` | v0.1.36 — anon key removed from arrival notifications |
| `2003ba2` | v0.1.35 — `inbox --notify`, visible arrival |
| `5a30d21` | v0.1.34 — directed NOTES queued, not observed |
| `a0564f3` | v0.1.33 — `queued` outcome for routed ASKS |
| `744ddbd` | receipt function fix (`auth.uid()` 42501) |
| `f2ae0e5` | v0.1.32 — delivery receipts, `@` addressing, Cmd/Ctrl+Enter |
| `f254899` | `command_failures` diagnostic table |

Migrations applied to production: `20260827000001`, `20260827000002`, `20260828000001`,
`20260828000002`, `20260828000003`. Edge functions `read` and `command` redeployed.

---

## 2. LIVE and independently verified

- **`cswarm inbox --notify` under a host monitor INTERRUPTS a session.** Confirmed by the agent
  **Quill** — different model family, different machine, session genuinely mid-wait:
  *"INTERRUPTED. inbox --notify under a host monitor woke this Grok session mid-wait; I did not
  have to wait for a next prompt."* This is the only claim in the set verified by someone other
  than its author, and it is the one the author had previously called impossible.
- Delivery receipts: `queued` → `observed` → `replied`, verified in production with the PATH
  binary. Broadcast reports "nobody was addressed or woken". Cross-sender reads refused.
- `@` mentions address the message; Cmd/Ctrl+Enter sends; broadcast is labelled
  "no agent will be woken".
- `feed` states it shows broadcasts only and names `inbox`, on populated AND empty results.

---

## 3. ★ THE THREE LAYERS — do not conflate them

This distinction cost most of a night. It is the single most useful thing in this file.

| layer | what it does | what it does NOT do |
|---|---|---|
| `cswarm listen start` | durable delivery — claim, lease, ack, routing | renders nothing anywhere |
| `cswarm hook install claude` | surfaces to the model at its **next prompt**; marks `observed` | invisible to a human watching the terminal; does not interrupt |
| `cswarm inbox --notify` under a **host monitor** | **interrupts now, visibly** | wakes no worker; changes no delivery state |

**A UserPromptSubmit hook's stdout is injected into model context and is NEVER rendered as a
transcript line.** A human watching the terminal sees nothing, forever, no matter how well
delivery works. A **host monitor** — a background watcher whose stdout lines become notifications
— is what renders and what interrupts.

The maintainer had a screenshot of a monitor working on another agent, and still spent hours
telling the operator visible rendering was a host limitation. It was not. He had only ever armed
the hook.

This also resolves Quill's earlier finding, *"inbox --follow does not wake the model — a signal
nobody acts on is not observability."* `--follow` was never broken. **Nothing was watching it.**

---

## 4. ★ THE TRAP THAT CAUGHT ME THREE TIMES IN ONE SESSION

**Upgrading the binary does NOT upgrade a RUNNING process.** Restart the listener, the notify
watcher, and confirm the hook's binary after every single upgrade.

1. The hook runs bare `cswarm` from PATH — `~/.local/bin/cswarm` — which was **0.1.30 while
   0.1.33 was being shipped**. Three releases claimed and none installed for the author.
2. A fix was "verified end to end" using `node dist/cli.js` — the local build — **not the binary
   the hook executes**. `build-release.sh` bundles from source and does not refresh `dist/`.
3. The listener process ran 0.1.34 code while 0.1.37 was being released, because the process was
   never restarted after the upgrade.

Each time the proof was against the wrong artifact and each time it read as success. Check
`cswarm --version` from PATH, and restart long-lived processes, before believing any result.

---

## 5. Corrections to claims published this session

1. **"Observed" was asserted before the agent saw anything** — twice. v0.1.33 fixed routed
   *asks*; the sibling branch for *notes* was left making the identical false claim, and web-UI
   messages are notes, so the operator's actual path stayed broken for a release. Fixed in
   v0.1.34 by **enumerating all 13 ack-outcome branches** against the real event each asserts.
   This is the repo's own *sweep over claims, not lines* rule, broken one message after quoting
   it.
2. **A receipt migration shipped broken because it was reviewed by reading, never run against
   PostgreSQL.** `auth.uid()` inside a `SECURITY DEFINER` owned by `swarm_admin` raises
   SQLSTATE 42501; every other `auth.uid()` in the schema is in a view, which runs as the
   querying role. Verify migrations against a real local Postgres.
3. **"Visible rendering is a host limitation."** False. See §3.
4. **The write-500 was called "load-related"** on two runs separated by time. 22 later writes
   with heavier concurrency failed zero. It is **episodic**; rate-dependence is unestablished.

---

## 6. `feed` omits directed signals — it fooled two agents in one night

`cswarm feed` shows broadcasts. A directed signal is visible only to sender and recipient and
lands in the recipient's **inbox**. The maintainer searched `feed` for his own directed asks,
found nothing, and began investigating a delivery bug that did not exist. Hours later the agent
Quill did the same, concluded the CLI had falsely claimed a message was posted, and announced a
resend — both asks had landed. Duplicates were one message away.

Fixed in v0.1.37 (the empty result carries the guidance too — "no signals" is what fooled both).
Recorded because the *shape* recurs: **a surface that answers a different question than the one
being asked, and does not say which.**

---

## 7. Still OPEN

- **The write-path 500.** Episodic, root cause unknown. `command_failures` (`f254899`) is applied
  and will capture the SQLSTATE next episode — that is the instrument, not the fix.
- **grok `permission_canary_failed` on Quill's machine.** The version floor admits 1.0.5 and the
  canary passed on the maintainer's machine, so that result does not generalise. Needs
  `lastWorkerStderrTail` from a FRESH failure on ≥0.1.30; Quill's existing null predates their
  upgrade and proves nothing.
- **Mobile composer with the on-screen keyboard open.** The layout bug was real and fixed, but the
  keyboard case is unmodelled by the harness — needs a screenshot from a real device.
- **`--agent-token-file`.** The 0600 redirect closes the exposure; a first-class flag would make
  the safe form the obvious one.
- **`--renewal-horizon-days` is still a display value** the server ignores.

---

## 8. The pattern worth carrying forward

Nine releases, and every underlying defect had the same shape: **something reported success — or
reported nothing — while the truth was different, and the artifact read as if it worked.** A dead
listener that swallowed messages silently. Newlines stripped so markdown could never render. A
receipt claiming `observed` before anyone observed. A feed hiding exactly what was being looked
for. A green indicator the operator had to disbelieve.

None were caught by the 600+ test suite. All were caught by an operator refusing an answer that
sounded reasonable, and by agents dogfooding the product — Wren, Joist, LeadG, MrSentry, Quill.

**The most valuable single habit: check the claim against the artifact that actually runs.**

---

## Addendum 2026-08-31 (v0.1.39 + a2a receipts)

- `41bdf8b` — workspace members see delivery receipts on EVERY directed signal (migration
  `20260829000001` APPLIED to production; site DEPLOYED; agent author-only boundary re-proven
  red/green). Six-path authorization matrix verified on real local Postgres.
- `c9bcb8c` — grok 1.0.13 canary fix: grok stopped volunteering a tool call for the generic
  probe (`permission=false deniedTool=false, end_turn`, measured); it now gets the codex-style
  sentinel canary (measured live pass). Canary attempt verdicts now persist to events.ndjson and
  `lastErrorDetail` in status.json (local 0600 only). Two-arm review on c9bcb8c: Grok exact +
  Gemini inversion, both PASS.
- `436c9f4` — release v0.1.39. LIVE on GitHub (latest, assets cswarm + cswarm.sha256), npm
  0.1.39, site /download pins 0.1.39, installed here via the public installer.
- Release traps hit and fixed: `gh release create` timed out → release left DRAFT (installer
  kept serving 0.1.38 as "latest"); the binary asset upload was lost; `cswarm.sha256` was not
  uploaded (installer refuses unverified — build-release.sh EMITS it, upload it). Asset URLs
  404 for ~1 min after upload while the API says "uploaded".
- Known-flaky, pre-existing: `tests/p1-local/file-artifacts-e2e.test.ts` S4-6 "a previously
  failed row drains on the next pass" fails identically on clean main (measured with the diff
  stashed). Not attributed to either change.
- OPEN (constructed, not realistic — Grok review arm): a 2048-char `lastErrorDetail` plus a
  max stderr tail can push the status JSON over the 8192 control-socket cap (measured 8222),
  which `listen status` reports as too-large and can misread live state as `unclean_exit`.
  Typical canary payload is 1202 bytes. Fix if a real message ever gets close.
- My listener restarted on 0.1.39. My `inbox --notify` watcher still runs a 0.1.36 binary —
  deliberately NOT restarted (notify unchanged since 0.1.36; the interrupt pipeline works and a
  restart risks it). Quill pinged to upgrade + restart their grok listener; their report is the
  live end-to-end confirmation of the canary fix.

## Addendum 2026-08-31 (later): v0.1.40 — the shared-host mail leak

- DEFECT (found live, twice): `cswarm hook check` walked every principal's listener directory
  on a shared host — it surfaced other agents' directed mail into the wrong session and acked
  it `observed` with the victims' own credentials. Demonstration one: the maintainer's session
  drained Quill's and MrSentry's queues. Demonstration two: MrSentry read the design-credit
  note addressed to Quill and asked for an attribution correction to a doc that was already
  correct.
- FIX `9873ecf`, released as `71475a5` / v0.1.40 (LIVE: GitHub latest with cswarm +
  cswarm.sha256, npm 0.1.40, /download pins 0.1.40, installed here): hook check takes
  repeatable `--principal-id`, install bakes the scope into the hook JSON, bare check on a
  multi-principal host surfaces nothing and prints one reinstall line. Two-arm review both
  PASS; the exact arm ran its own spoofed-status/planted-credential probes.
- Residual, recorded not fixed (same-user writes required, which is already full compromise):
  a credential file planted inside another principal's correctly-keyed directory is used
  without a rebind check; a crafted UPPERCASE status principalId evades a lowercase scope
  (never produced by the honest write path).
- Quill's standing-grants design recorded at docs/design/2026-08-31-STANDING-GRANTS.md
  (proposal; implementation deferred behind this fix; awaiting operator go).
- Known-flaky (twice now): site observer "Slack-shaped composer geometry stays aligned in real
  Chrome" fails ~1 in 3 runs on timing, passes on rerun. Deflake candidate.
- My hook re-enabled SCOPED to 8d10fe67 in .claude/settings.json; my listener ready on the
  upgraded binary needs a restart to run 0.1.40 code (it started on 0.1.39) — restart it next
  session start or on the next listener-affecting release.


## Addendum 2026-08-31: marketing responsive repair

- Base `820a9e32cf68fed914afd1031946f078352b0e7c`; final code
  `77f701bc3c8b20df4c57eb2feec42620d86f33d1` is LANDED on GitHub `main` and LIVE at
  https://commonswarm.com. PR #1 merged by fast-forward to that exact SHA.
- Work used `codex/marketing-responsive` in
  `/Users/yulanbot/Developer/Ridge.io/commonswarm-responsive`. Other feature branches
  were not changed. Evidence is added separately as an ungated docs commit.
- Fixed the mock sidebar stacking above the feed: show two columns from 40rem,
  and a full-width feed below it. Also fixed missing panel spacing, agent indentation,
  header-label wrapping, and missing homepage navigation targets. Anchor targets sit
  on inner headers so section padding does not add an empty gap after navigation.
- Vercel `coswarm-site` / `ridgedotio`, deployment `dpl_3JtXhJBHcyGQd62pxLnyyPGzZyGp`.
  All eight public page bodies and both homepage CSS assets match the tested build.
  Installer 200 plus missing-file 404 control passed. CLI stays at 0.1.40.
- Both D-036 arms passed on final code SHA: independent Codex exact review and
  Gemini 3.1 Pro inversion. Final site suite: 212 pass / 0 fail / 1 existing diagnostic
  skip. Root suite: 656 pass / 0 fail. Ten live widths, 320 through 1440px, passed.
  Codex also ran non-author stacking and hidden-clipping controls, each red then green.
- Durable record: `docs/evidence/2026-08-31-marketing-responsive/README.md` with raw
  measurements, screenshots, test output, review reasoning, and a replay command.
  `production-geometry-invalid.json` is explicitly INVALID: it measured 1440px ten
  times in an unselected tab. The width control caught it; the replacement has ten
  verified widths. Do not count the invalid file as responsive coverage.
- No remaining repair step. For the next edit, start at
  `site/src/components/landing/ConsumerHero.astro` and keep the rail display and
  two-column media rule together; run `npm --prefix site run build` then
  `npm --prefix site test`, and read the evidence before changing the breakpoint.
- NOT established: Safari/Firefox, physical phones, signed-in flows, or the mobile
  keyboard case. Existing open issues earlier in this file remain open. DEFERRED:
  a pre-existing /download copy mismatch says Node 22 in its heading but Node 24 in
  one instruction; no install-page copy was changed in this layout repair.


## Addendum 2026-08-31: clear homepage signup and login

- Code `59c190bbd77ed352baf902cb50bf5e88eeda00f1` is LANDED on GitHub main and LIVE
  at https://commonswarm.com. PR #2 merged at that exact SHA. Base was
  `e6cb5d768a41c42c91b0b87e3f3f6b3d34860103`.
- Work used codex/homepage-signup in `/Users/yulanbot/Developer/Ridge.io/commonswarm-signup`.
  The shared cloud-swarm checkout had unrelated source/migration edits and was left alone.
- Header, hero, closing section, and footer now say Sign up and Log in. Both lead to
  the existing unified email form at /app. Its title and copy explain both actions.
  Repository links stay in the footer; GitHub auth stays optional. No auth logic changed.
- Also fixed pre-existing no-script header overlap at 481/520px: collapse extra links
  through 40rem. Independent reviewer reproduced the old fault, then confirmed the fix
  with a failing/restored control. Previous mock sidebar and anchor fixes remain intact.
- Both required review arms passed final SHA: independent Codex exact review and
  Gemini 3.1 Pro inversion. Site: 212 pass,1 existing diagnostic skip. Root: 656 pass with
  concurrency 1. Default parallel root runs remain timing-sensitive in the unchanged
  OpenCode 1300ms bound; two failures are preserved in evidence, not claimed green.
- Deployment `dpl_tHg4twNBQJc9ovWSsnK4kA6PM5zq`, coswarm-site/ridgedotio.
  All 8 pages,6 homepage/app assets, and installer match build/source bytes. Missing-path
  control 404. Eight live widths 320–1440 passed. Live Log in reached the email form.
- Evidence: `docs/evidence/2026-08-31-homepage-signup/README.md`. Final source was
  reviewed before landing; this evidence/handoff is a separate ungated docs commit.
- No remaining work in this request. Next edit starts at
  `site/src/components/landing/ConsumerHero.astro` or `site/src/components/SiteHeader.astro`;
  keep clear account labels and script-free fallback, then build and run site tests.
- NOT established: email delivery, live OAuth completion, physical phones, Safari/Firefox,
  or manual signed-in behavior. No account created, email sent, CLI release, or DB change.
  DEFERRED: existing open issues above, including the Node 22/24 download-copy mismatch,
  remain outside this request. Interim signup code f962c86 is superseded by 59c190b.

## Addendum 2026-08-31 (night): v0.1.41 + THE EPISODIC 500 IS SOLVED

- **v0.1.41 LIVE** (`6e2d6d2`; GitHub latest with both assets, npm, /download pins, installed
  here, listener restarted): standing grants (93a2a64) + signal attachments (3ea1a9d) +
  idempotency fix (dc32d30). Two-arm review over the full range, both PASS. Both migrations
  applied to production; command/read deployed. First production attachment delivered to Quill.
- **The month-long "episodic 500" root cause is MEASURED**: `EMAXCONNSESSION — max clients
  reached in session mode, pool_size 38` in production function logs, dominated by
  claim_agent_inbox. The deployed SWARM_DATABASE_URL pointed at the SESSION pooler; the design
  (P1-COMMAND-API §3.2/R13) specified the TRANSACTION pooler all along. Fix (`2ba75f3` + ops):
  DB password rotated per R3 (new one: ~/.config/cswarm-prod-db-password.txt on the mini, 0600),
  SWARM_DATABASE_URL repointed to port 6543 transaction mode, all three functions redeployed,
  per-isolate footprint shrunk (max 2, idle 3s). Verified: 5/5 reads, write OK, zero
  EMAXCONNSESSION since. Production log access without the DB password: Management API
  `analytics/endpoints/logs.all` with the CLI's keyring access token (decode the
  go-keyring-base64 wrapper).
- Merge-window catches worth remembering: p1-server had not been RUN since the markdown change
  (queued-gate trap) and was hiding a broken hash mirror; the mint parser injected defaults into
  the canonical command (idempotency hazard); the SA-local test contradicted its own event
  filter. All fixed in dc32d30.
- NEXT: L16 dashboard lane (Get-prompt, Cmd+Enter mention fix, full-height shell, bottom gap,
  deflake the geometry observer), then L17 human receipts, then L18 workspace brain — specs in
  the session scratchpad. Operator's standing order: all of it, released.

## Addendum 2026-09-01: v0.1.42 + the night's incident chain closed

- **v0.1.42 LIVE** (human read receipts, cee3f99): swarm.signal_human_receipts applied to
  production (verified via schema_migrations query, not push output — the CLI's noise hid the
  apply line), command fn v36, site deployed, installed here, listener restarted on it. Live
  probe: a directed note to the owner answers "Not seen yet — the member's browser reports seen
  state when the message is viewed". Two-arm PASS; agy's refusal map: wrong-recipient = 403,
  foreign-workspace id = 200 matched:0 (deliberate, no existence oracle).
- **CORS outage post-0.1.41** (afec577): the grants dashboard read was the read fn's FIRST
  browser caller; preflight 405'd; every member's channel died with "check your internet".
  Reproduced with a fresh account in real Chrome on this machine (admin magic-link sign-in),
  fixed, re-verified in-browser, confirmed by the operator. Wiring pin added.
- **Dashboard follow-ups** (7c01f7b, two-arm PASS): Get prompt (server gate:
  principal_not_owned), Cmd+Enter respects the mention picker, full-height shell, bottom gap
  =12px both-bounds pinned, geometry observer deflaked.
- **Shared-host identity collision #4** (38cc2e6): every onboarding prompt hardcoded
  ~/.config/cswarm/agent-token.json; agent #2 on a host read agent #1's credential (CodexDesktop
  became Quill; the post-MrSentry whoami guard stopped the impersonation). Prompts now derive
  agent-<principal-first8>.json + an exact-identity MUST-read line. Two prompt lines silently
  failed to interpolate (single quotes) — an observer caught it pre-deploy.
- Lane hygiene lesson recorded: `git add -A` in the shared tree swept another lane's files into
  an unrelated commit once (split before push); L17's files appeared mid-flight in this tree —
  scoped adds only while lanes run.
- Probe debris: auth users probe1-6 deleted; probe6 (be264e05) survives holding empty workspace
  aa2bb3b7 (FK), harmless.
- REMAINING: L18 workspace brain lane (launched); one review pass on its commit; then the
  operator's "get it all done" list is complete.

## Addendum 2026-09-01 (later): v0.1.43 — the brain, and a FAIL that earned its arm

- **v0.1.43 LIVE** (workspace brain, a0b6734 + 4cbe4e7): GitHub latest both assets, npm,
  /download pins (cache-busted verify — a plain fetch HIT a stale CDN page and read as a failed
  deploy), Brain view on deployed /app, installed here, listener restarted. Live probe: brain
  put/ls/get round-trip against production; first topic 'releases' seeds the release ritual.
- **The exact arm FAILED a0b6734 with a measured counterexample** — the Brain pane keyed by slug
  let a workspace switch save workspace A's text into workspace B's file. Fixed in 4cbe4e7
  (fileId binding + save guard), the reviewer's counterexample is now a permanent observer,
  mutation-verified, and BOTH arms re-ran PASS on the replacement SHA. First FAIL verdict of
  this cycle; record that the two-arm gate caught a cross-workspace leak no test suite did.
- Grok-arm residuals recorded, not fixed: raw `file put --name brain--x.md` can enter the
  namespace (shared store, invisible to brain ls); `brain put --agent-token-file` with no path
  uploads stdin (the prompt teaches a path); the prompt's brain put line is not in the
  self-contained-command list.
- **The operator's 'get it all done and released' list is COMPLETE**: grants, attachments, a2a
  receipts, grok canary, hook scope, pooler root cause, CORS outage, dashboard follow-ups,
  per-agent credential paths, human receipts, brain. v0.1.39→v0.1.43 in one arc.

## Addendum 2026-09-01 (afternoon): unreleased work on main, gated on a second review family

**LIVE**: v0.1.43 is the installed/latest release. Everything below is COMMITTED TO MAIN and
NOT RELEASED — pushed ≠ landed ≠ applied.

| sha | what | review state |
|---|---|---|
| `619ff1f` | broadcast recipient roster (migration `20260902000001` NOT applied to prod) + Direct-to-you filter person-only | Grok exact PASS; inversion arm NEVER RAN — Gemini service down 7+ attempts over 2h, Kimi headless has no key |
| `b4c72f3` | file/brain reads retry + 30s deadline | Grok range review → FAIL (human list escaped the deadline) |
| `dc9df04` | hook install → user settings; notify 60s episode machine; listen status credential flags | Grok range review: holds |
| `d1a410b` `2483e8c` | docs: brain cited by name in AGENTS.md; four stale doc claims corrected | n/a |
| `ea3cac4` | brain digest in hook + worker prompt; end-of-task nudge | Grok range review → FAIL (digest ran on cooldown ticks and BEFORE stdout) |
| `185e975` | fixes both FAILs; cooldown control now counts every read as a zero DELTA | Grok rerun in flight |

**Next concrete action**: when the Grok rerun on `185e975` PASSes and ANY different-family
inversion arm returns substance on the range `619ff1f..185e975`, release v0.1.44 in this
order: `supabase db push` (verify via `schema_migrations` query, not push output) → deploy
`read` → version bump → GitHub release with BOTH assets → npm → site → install → restart
listener → live probe `cswarm receipt` on the brain-announcement broadcast `a945274b` (expect
"Seen by X of Y"). If Gemini stays down, ask the operator to open the Kimi tab.

**Lessons this arc added** (both from the exact arm catching my own work):
- A retry without a deadline doubles the worst case — and I shipped exactly that in the one
  path I did not check after writing that sentence in the commit message.
- An optional extra must never run in front of the surface's actual job: the brain digest sat
  before stdout and could spend the hook ceiling. The control that should have caught it
  EXEMPTED the reads it needed to count and asserted absolute counts; it now asserts a zero
  delta on every read.
- Two defects composing (my missing fix + Gauge's broken failure detector) produced a
  convincing non-event; now a section in brain topic `false-success-signals`.

**Brain state**: constitution `brain-how-to` v2; owned topics: releases, shared-host (Quill),
observability (MrSentry), strategy + competitors (Strategist), promote-production (LeadG),
promote-verification (Finisher), false-success-signals (Gauge), cross-family-review (Marque),
knowledgebase-design, vercel-runtime-logs, brand-extraction-budget. Streaming investigation
report in session scratchpad `streaming-investigation.md` — first slice = live status in the
entity panel for listener-run agents only; TUI streaming is impossible for non-listener agents.

**Operator actions outstanding**: mint credentials for Nock and Gauge (dashboard → Add an
agent); Finisher's 9 stranded route-split messages need `hook install claude --principal-id
78249a33-… --write` in their session (three other agents have the same silent backlog).
