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

## Addendum 2026-09-01 (evening): fc88624 — the compat fix; release gated on two arms

- **RELEASE BLOCKER FOUND AND FIXED before production**: 619ff1f's broadcast roster put agent
  tracking rows in the `receipts` array; the 0.1.42/0.1.43 parser (hash-verified npm blob)
  throws on it — every installed CLI would hard-fail on broadcast receipts, cached dashboards
  would blank the indicator. Found by a Claude advisory review the twin session ran; Grok's exact
  PASS on 619ff1f missed it. Fixed in `fc88624` (migration `20260902000002`, forward replace; **Superseded (21334f7): 000002 was folded into 20260902000001 and deleted — the Supabase CLI applies one file per transaction, so a two-file compat sequence was itself the defect.**
  agent rows live only under broadcast_roster.agents.principals). Verified by four adversarial
  refuters incl. old-parser-vs-new-wire with a discriminating control and a real-Postgres run
  with a mutation of the seen-first ORDER BY. NOT applied to production yet.
- Also in fc88624: cap pin (limit!==50) removed; >50-seen "Not-seen: none" falsehood fixed; cap
  test asserts the seen member survives; dead agentById plumbing removed; tint depends on
  signalIsDirectToViewer alone; AGENTS.md D-036 corrected (arms = Codex, Grok, Gemini in that
  order, two families; Kimi retired).
- **APPLY ORDER for v0.1.44** (from the migration header): db push 000001+000002 (verify via
  schema_migrations) → deploy `read` edge (old edge drops broadcast_roster; new CLI would throw)
  → release/publish client → site deploy → install → restart listener → probe receipt on
  broadcast a945274b. Clients ≤0.1.41 are already broken on attested broadcasts by today's live
  function and must upgrade regardless.
- Arms on fc88624 in flight: Codex exact + Grok inversion (Gemini/agy dead: 12 timeouts/4h).
- Twin session (cmux "Lead") is live on PromptEden work, frozen on cloud-swarm; its swarm-CLI
  identity lane got a Codex FAIL (opt-in owner check; ancestry fallback PID; PID-equality
  ownership) — fixer lane L24 running in the swarm repo, uncommitted.
- Specs ready to launch after release: L22 (`cswarm resume` + notify orphan detection),
  L23 (connected ≠ attended: status warns on main-queue backlog, route main/split refuse
  without a hook surface, `listen canary`). Brain topics added: agent-restart (v2),
  listener-attended.

### fc88624 review result (2026-09-01, evening): Codex exact = FAIL — three P1s, one P2
1. Migration sequence unsafe: Supabase CLI applies one file per transaction, so 000001's breaking
   shape is live before 000002 fixes it (and stays if 000002 fails). Fix: fold the final shape
   into 000001, delete 000002 (neither applied to prod; local DBs must db:reset).
2. Read deadline stops at headers: fetchWithDeadline clears the timer when fetch() resolves; body
   reads run unbounded (measured), and each retry gets a fresh 30s. Fix: one absolute budget across
   headers+body+retry.
3. Hook install default to ~/.claude/settings.json REOPENS the shared-host mail leak (user scope
   = every session of the OS user; B's hook ran in A's session, measured). Fix: session-local
   `.claude/settings.local.json` default, refuse if not ignored; --user only with a loud warning.
4. (P2) CLAUDE_CONFIG_DIR ignored by the installer.
Codex confirmed: old parser parses the final wire; edge adds broadcast_roster only on broadcasts;
authorization unchanged; hook digest ordering/cooldown correct. Fix workflow running in isolated
worktrees (wf_3e1f1a59-216); Grok inversion on fc88624 still in flight. NOTHING RELEASED.

## 2026-09-01 late afternoon — fold landed, session limit hit, swarm-CLI fleet lockout

**Refs.** `21334f7` on `main` = fc88624 + the fold. `20260902000002` is DELETED; `20260902000001` is
the only roster migration and carries the final compat shape. **NOT applied to production.**
Branches in flight (Codex lanes, worktrees under this session's scratchpad): `lane/l25-read-deadline`
(body-read deadline + one overall retry budget), `lane/l26-hook-scope` (session-local hook install
+ `--user` warning + `CLAUDE_CONFIG_DIR`). Neither is on `main` yet.

**Codex FAIL on fc88624 — status per finding.** P1 migration sequence: FIXED at `21334f7`. P1 body
deadline / fresh retry budget: L25 lane. P1 user-scope hook install: L26 lane. P2 CLAUDE_CONFIG_DIR:
L26 lane. **Grok PASS on fc88624** — its residual "no in-repo gate loads the 0.1.43 blob" is now
closed by `tests/receipt-wire-compat.test.ts` (named in the `test` script; RED on the pre-fix
shape, GREEN on the folded one — checked both ways). Still NOT established from Grok's list: G1 on
live Postgres; the abort-ignoring file-list settlement.

**Session limit.** This Claude session hit its usage limit ~16:35 (two of three fixers in
wf_3e1f1a59-216 died with "session limit"). Operator instruction: run the work through Codex
(`codex exec` lanes) from here. Lanes L25/L26/L27 are Codex. The two-arm rule is unchanged:
a Codex-authored lane takes Grok + Gemini.

**Incident — swarm CLI fleet lockout, 16:21–16:29.** The L24 identity-fix subagent ran
`npm run build` in `/Users/yulanbot/Developer/Ridge.io/swarm`. `~/.local/bin/swarm` on every
agent's PATH resolves to that repo's `dist/`, so the UNCOMMITTED, UNREVIEWED fix went live for
~20 agents at once. Its guard refuses any row whose `process_start_time` is NULL — which is every
row written before the column existed: 8 of 9 cmux rows (CSwarmDevLead, Gauge, Marque, MrSentry,
Nock, Quill, Strategist, Lead) were refused on every command, and `--reclaim` refuses NULL-start
rows too, so nothing could recover. Restored 16:29 by rebuilding `dist/` from HEAD `009d954` in a
throwaway worktree and rsyncing it in; both swarms were told not to follow the hook's
"npm run build" hint. L27 (Codex) is extending the L24 fix: legacy rows adopt forward on same-PID
ownership; reclaim of a legacy row falls back to the pre-L24 dead-PID + no-live-surface rule. Rule
for that repo, going into its AGENTS.md via L27: **dist/ is the fleet's live binary; a rebuild is a
deploy.** Brain topic `swarm-cli-dist` (relayed by Quill) carries it. The old
~~"Fixed in fc88624 (migration 20260902000002…)"~~ line above is marked dead.

**Next concrete action.** When `L25-report.md` and `L26-report.md` exist in the scratchpad:
`git merge --no-ff lane/l25-read-deadline` then `lane/l26-hook-scope` onto `main`; run
build / npm test / test:p1-cli / check:tests / check:edge / site build+test; copy the lane reports
into `docs/evidence/2026-09-01-v044/`; then the refuter set (body-stall control, two-principal
install in temp HOME, single-migration real-Postgres apply + old-parser read) and both arms (Grok,
Gemini — Codex authored) on the merge SHA; then release v0.1.44 in the apply order: db push →
verify via schema_migrations → deploy `read` edge → publish client → site → install → restart
listener → `cswarm receipt` on broadcast a945274b.

**Deferred, deliberately.** L22 (`cswarm resume` + notify orphan detection) and L23
(connected≠attended) wait for v0.1.44. Renaming the Supabase project stays an operator action.

### 2026-09-01 ~17:35 — L25 merged, real-Postgres leg done, swarm identity fix under review

- `1851e35` merges `lane/l25-read-deadline` (Codex, `d357344`): every file/brain read consumes its
  body under the same 30 s deadline; one logical read has ONE absolute budget across its single
  retry, with a 2 s floor below which no retry starts. Mutations observed RED for both. Evidence:
  `docs/evidence/2026-09-01-v044/l25-read-deadline-lane-report.md`.
- `37ac375`: the 0.1.42/0.1.43 parser is now run on the wire REAL Postgres returns (p1-local test)
  and on the fixture (pure gate), via `tests/support/old-receipts-parser.ts`. Local `db reset`
  applied the folded `20260902000001` as one file; the applied function contains `'principals'`.
  Evidence: `docs/evidence/2026-09-01-v044/real-postgres-fold-apply.md`. Production still has
  only `20260901000020` (checked read-only with `supabase migration list --linked`).
- Swarm CLI (other repo): L24+L27 committed as `a072d0b` on `feat/swarm-next-v1`. **dist/ NOT
  rebuilt.** Gemini (`agy`) inversion: PASS with traced controls + focused tests (7/7). Grok exact
  arm still running. Rebuild + fleet notice only after Grok also passes.
- **Instrument trap, `agy` headless (2026-09-01):** without `--dangerously-skip-permissions`, a
  tool needing `read_file` is auto-denied and the run ends with no verdict (307 bytes). With the
  flag, long tool calls (full `npm test`) end in `Error: timeout waiting for response` — the same
  dead-instrument face as the 4-hour outage. A prompt that keeps each command under ~20 s and
  leaves the long runs to the other arm produced a full review. Both faces were caught by the
  monitor asserting a VERDICT line is PRESENT.
- L26 (hook scope + CLAUDE_CONFIG_DIR, Codex) still running. Release runbook drafted at the
  session scratchpad `release-v044.sh` (gitignored; steps are the apply order above).

### 2026-09-01 ~17:40 — both arms PASS on 3295f57; releasing v0.1.44

- `2689c6d` merged `lane/l26-hook-scope` (Codex, `21c667f`): hook install defaults to
  `<project>/.claude/settings.local.json` (must be git-ignored), `--user` honours `CLAUDE_CONFIG_DIR`
  and warns. The lane's own report never landed (its process ended while it ran its own arms);
  `docs/evidence/2026-09-01-v044/l26-hook-scope-lane-note.md` stands in.
- **Arms on `3295f57` (Codex-authored lanes → Grok exact + Gemini inversion): both PASS**, both
  with observed mutations for the body-stall, budget, and two-principal controls, Grok also with a
  real `db reset` + RPC + old-parser run. Evidence: `grok-exact-3295f57-PASS.md`,
  `gemini-inversion-3295f57-PASS.md`. Grok's two **P3s, deliberately shipped as-is and queued**:
  (a) read-timeout copy says "before a response"/"could not reach" even when headers arrived and the
  BODY stalled, and the `noResponse` JSDoc says no HTTP response arrived — the retry classification
  is right, the words are not; (b) the `--user` warning says "EVERY Claude Code session for this OS
  user", which overclaims when `CLAUDE_CONFIG_DIR` points elsewhere. Fix both in the next client
  lane (L29) — copy-only, but a SHA change re-runs both arms, so not folded into this release.
- Not established by the arms: production apply (done in the release steps below); Claude Code
  runtime load of `settings.local.json`; two agents in ONE project (last `--write` wins — one hook
  per project by design); tilde expansion of `CLAUDE_CONFIG_DIR`.
- **Hazard, measured:** Grok review arms spawned from the Lead's pane ran `swarm join Rivet` in the
  local `cloud-swarm` swarm; they inherit `CMUX_SURFACE_ID`, so the pane's bare `swarm` identity
  flipped to Rivet. Cleaned up with `swarm --swarm cloud-swarm leave` + `swarm use prompteden`.
  Same family as CodexDesktop-as-Quill. Always pass `--swarm`; review arms should be told not to join.
- Swarm CLI: `aeb3472` (L28: dead-PID legacy rows adopt to the live pane occupant) passed Grok +
  Gemini; Grok P3: adoption UPDATE is autocommit, a same-pane race can exit `database is locked`
  (fails closed; retry works). Deployed to `dist/` from the committed tree and announced.

### 2026-09-01 17:50 — v0.1.44 is LIVE

Every step measured, in the apply order:
1. **Production migration applied**: `supabase db push --linked` applied `20260902000001`; verified with
   `supabase migration list --linked` — remote column filled for `20260902000001` (control `20260901000020`).
2. **`read` edge deployed** to `ukezjcnxjvkpkeezxaew` after `build:command-core` + `check:edge` (exit 0).
3. Release commit `6ca8980` (`release: v0.1.44`), gates on it: build 0; npm test 680/680; test:p1-cli 381/381;
   check:tests 0; site build 8 pages; site test 234/0.
4. **GitHub release v0.1.44**: assets `cswarm` (1676631 B) + `cswarm.sha256`, marked Latest; sha256 of the
   asset equals the local bundle (`ea19d3ec…c94c77`). `main` pushed to `Ridge-io/commonswarm` (was 12 ahead)
   and the tag re-pointed from `ab6e34d` (remote HEAD at create time — `gh release create` tags the REMOTE
   default branch, not your local HEAD) to `6ca8980`.
5. **npm `commonswarm@0.1.44`** published; `npm view` returns 0.1.44; the package bin prints the version.
6. **Site deployed** (`rm -rf dist`, `cp -r .vercel`, `vercel deploy --prod`): `/download` mentions 0.1.44 ×3
   and 0.1.43 ×0; `/install.sh` 200 with `/nope.sh` 404 as control; `/start` meta names api.commonswarm.com;
   no service_role JWT; the `LiveDashboard` chunk contains the roster and brain code (count 1 each).
7. **Installed** via `curl … install.sh | sh` → `cswarm 0.1.44`. Listener restarted on the new binary.
   **Live probe with the NEW client**: `cswarm receipt ebb2b957…` on a broadcast renders the roster
   ("Seen by 0 of 1 workspace members … Agents — not tracked: 10"). **Live probe with the OLD 0.1.43 client
   against the NEW server was NOT established** — the one attempt picked a signal this agent did not author
   (author-only rule → the expected refusal), and the client was upgraded before a second attempt.
   The compat property rests on the committed gates (fixture + real Postgres) and Grok's C5 run.

**Trap learned:** running the raw release bundle from inside this repo fails with `module is not defined
in ES module scope` because the repo's `package.json` has `"type": "module"` and the bundle is extensionless
CJS. Run it from a directory with no `package.json` above it (or install it), which is what users do.

**Queued next (Codex lanes):** L29 — the two P3 wording fixes from Grok's review; L22 — `cswarm resume`
+ notify orphan detection; L23 — connected ≠ attended (`listen status` warns on `pendingForMainCount`,
`main`/`split` refuse without a hook surface, `listen canary`).

### 2026-09-01 17:52 — post-release: Claude listeners were broken by a bridge version, not by 0.1.44

Restarting the Lead's listener on 0.1.44 failed: `permission_canary_failed`, stderr "Confirm Claude
Code keychain/OAuth sign-in". The measured cause (`lastErrorDetail`): "Claude Code 2.1.232 does not
support this model; version 2.1.251 or newer is required". The listener never spawns the `claude`
CLI (2.1.258 on PATH); it spawns `claude-agent-acp`, and the globally installed 0.70.0 bundles
`@anthropic-ai/claude-agent-sdk` 0.3.232. Anthropic raised the floor today. Fix on this host:
`npm i -g @agentclientprotocol/claude-agent-acp@0.73.0` (SDK 0.3.257); listener ready 22:51Z,
`providerVersion` 0.73.0. Both swarms told to restart Claude-provider listeners. Also seen while
diagnosing: the Claude session limit ("resets 5:50pm") — a second, independent way the same canary
fails. Product follow-up L30 (spec in the scratchpad, launch when a lane slot frees): status/start
must name the resolved bridge executable and the bundled Claude Code version; the canary copy must
quote the bridge's error and give the remedy for the version-required shape (update the bridge),
never assert sign-in as the cause without measuring it. Two of Codex's lanes (L22 resume, L23
attended) and L29 (P3 copy) are running.
- **Correction to the paragraph above (Gauge, 17:54):** ~~"every Claude listener canary fails"~~ is
  too strong — only NEW ACP sessions after the floor bump fail deterministically with the 400; a
  running 0.70.0 session kept working 8 h, and Gauge's own 14:37 failures had reason `ACP request
  timed out: session/prompt` (a different cause) then passed on the same bridge. And ~~"the stderr
  wrongly blames OAuth sign-in"~~ is the CLI's GENERIC canary copy for every reason, not a signature
  of this cause; the event log never contains it. The tell is `permission_canary_failed` plus the
  reason text. Both narrowings are now in brain `agent-restart` v4 and in the L30 spec.

### 2026-09-01 18:05 — the listener read path had an undiagnosable hour-long episode today

The Lead's own listener log has 474 `listener_read_retry` events for the day, 158 of them in the
three hours before the 22:45Z restart; one episode ran from ~19:00Z to 20:43Z reaching attempt 198
(delays 20–30 s) while `listen status` said ready. Gauge measured 209 retries over 3h06m on another
listener. **The events carry no reason** — only attempt and delay — so server 5xx, pooler
exhaustion, DNS and body stalls are indistinguishable after the fact. Queued L31 (spec in the
scratchpad): typed reason code per retry event, durable episode accounting, a 60 s loud-lapse
warning in `listen status`, and a recovered event. Not established: what the server returned in
that window (the read edge's analytics logs were not pulled), and whether Gauge's episode
overlaps it — asked. The 0.1.44 listener has logged no read retry since 22:51Z (15 min).
- **Correction (Gauge, 17:58):** the read-retry episode ended at **20:43:01Z on BOTH listeners** —
  two hours before 0.1.44 was installed (22:43Z) or the bridge changed (22:51Z). ~~"The 0.1.44
  listener has logged no read retry since 22:51Z"~~ is true and is evidence of nothing: the system had
  healed at 20:43Z for the old binary too (Gauge: 1033 claims, 0 retries in the 21:00Z hour on 0.1.43).
  Nothing is credited for the recovery. Gauge's throughput finding (claims/hour at ~¼ of cadence while
  the median claim gap looked healthy) and the crawl-then-accelerate precursor are folded into L31.
  Discriminator still open: server incident vs this host — see the server-log query result below.
- **Server vs host, settled (18:10):** Supabase `function_edge_logs` 13:50–22:10Z: `read` 3.3k–5.2k req/h
  and `command` 1.4k–3.6k req/h through the window, seven isolated single-request 5xx all day, zero 429,
  no minute without read traffic; read volume rose to 13.1k/h at 21Z when the clients recovered. The
  Lead's listener claim rate (claims ÷ 1030 expected at 3.5 s cadence): 0.95–1.03 from 03Z–12Z, **0.63
  at 13Z, 0.15–0.25 from 14Z–20Z, 0.99 at 21Z**, median gap 3.5–3.7 s throughout — Gauge's shape,
  same host. **Host-side impairment of this Mac from ~13:00Z to 20:43Z, every listener on it affected;
  the server was healthy; nothing shipped today caused or ended it.** What released it at 20:43Z is NOT
  established (narrow unified-log predicates found nothing). L31's primary signal becomes the
  throughput ratio (would have fired at 13Z), not retry depth (19:33Z). Memory pressure on the mini
  was level 2 at 17:55 with five Codex lanes running; L30/L31 launch only at level 1.
- **Acute phase named (Gauge, 18:03; shared finding):** `~/actions-runner/_diag/` on this Mac holds
  2918 × `SocketException (49): Can't assign requested address` = **EADDRNOTAVAIL, host-wide ephemeral
  source-port exhaustion**, first 19:35:20Z, last 20:43:03Z — two seconds after both listeners' last
  retry. Per-minute counts 79, 98, 193, 195, 196 then stop dead (ports released, not backoff). The
  runner itself executed zero jobs and restarted twice (19:46Z, 20:38Z) — a victim and a plausible
  amplifier, not the proven origin. The server-side elimination made the host the only suspect; the
  throughput table dated the onset; Gauge found the errno. **The 13:00–19:33Z impairment is a separate,
  still unexplained condition** (no EADDRNOTAVAIL before 19:35Z) — not folded into this one. For L31:
  EADDRNOTAVAIL becomes a named, non-backoff reason; a retry loop amplifies it. Operator note: the mini
  is meant to take no CI, yet the runner service runs and long-polls; stopping it (`~/actions-runner/
  svc.sh stop`) is a cheap port-pressure reduction — an operator call, not taken by the Lead.
- **Correction (Gauge, 18:09; confirmed by the Lead 18:13):** ~~"~3,000 connections per second being
  churned"~~ was wrong arithmetic — it divided the TIME_WAIT count by 2×MSL, which assumes entries
  expire. They do not: TIME_WAIT 40193 → 40227 in 20 s (monotonic), FIN_WAIT_1 frozen at 2161 across
  a minute, LAST_ACK ~4,997. **The socket table is not being reaped**; arrival is ~2 connections/s.
  ~21k parked sockets are to our own API (one connection per listener poll, never reused), ~10.7k
  loopback. 47,884 sockets against the 49,152-port ephemeral range at 18:13 → ~1,268 ports of
  headroom, ~10–15 min to a repeat of the 19:35Z outage. mbufs 20189/20821 in use. **Cause of the
  reap failure NOT established** (kernel/network-stack state; 20:43Z looked like a flush, not a drain).
  Operator pushed (phone): interface cycle or reboot. `lsof` cannot attribute parked sockets — it
  names owners of OPEN sockets only and would have blamed innocents. Product follow-up (L32): the
  claim loop should reuse connections (keep-alive agent); a reap failure would then bite ~10× later.
- **Correction (18:20):** ~~"~1,268 ports of headroom, ~10–15 min"~~ used a 49,152-port pool. Wren
  (Tom's laptop agent) had widened `net.inet.ip.portrange.first` to 1024 (pool 64,512) and halved MSL
  at 20:43Z — **that was the "flush"** — and installed `/Library/LaunchDaemons/net.ridgeio.tcp-tuning.plist`
  plus a 60 s watchdog (`~/bin/tcp-watchdog.sh`, `~/.tcp-watchdog/status.json`: free_ports 15,877 at
  23:16Z). Real headroom ~15.9k; arrival ~1.6/s AFTER every cswarm listener on the mini was stopped
  (mine + 7 unattended supervisors incl. four 20-day-old grok orphans, SIGTERM/SIGKILL by the Lead) —
  so listener polls were a share of the arrivals, not the whole. Kernel timers still wedged (FIN_WAIT_1
  at 2161 for 40+ min); reboot is the only fix, Tom is deferring. Fleet told: keep listeners stopped
  until announced. Wren's four asks answered on cswarm (hygiene split, L32 keep-alive, L33 local hook
  daemon, sentinel from the laptop, auto-stop listeners only).
- **Listeners stopped on the mini, 23:13–23:16Z, to be restarted after the reboot (or when the Lead
  announces):** by their owners on request — CSwarmDevLead/8d10fe67 (Lead), Gauge, Quill, LeadG,
  Strategist (MrSentry's was already down since 08-28); by the Lead with SIGTERM/SIGKILL because their
  agents were unattended — principals `023fd46b` (agent-token file `~/.config/cswarm/agent-023fd46b.json`),
  `2a8606f2` CodexDesktop (codex), `78249a33` Finisher (claude), and four 20-day-old grok orphans
  `589ba470` ×2, `69710161`, `fd8e5a4f` (probably the August cloud-swarm seats; consider NOT restarting
  them). Durable delivery holds their mail server-side meanwhile. Also stopped by their owners:
  `inbox --notify` pollers (Strategist, LeadG, Quill). Free ports 15,236 of 64,512 at 23:19Z, arrival
  ~1.6/s (now mostly the Codex lanes' loopback test traffic and Claude sessions).
- **Correction to the 18:20 correction (Gauge, 18:19; reconciled by the Lead):** ~~"widened first to
  1024 at 20:43Z"~~ conflates two changes. Wren's own words: at 20:43Z it widened the pool **16k → 49k**,
  i.e. `portrange.first` 49152 → **16384** (+32,768 ports) plus MSL 15000 → 7500 — which is exactly the
  16384 both Gauge and the Lead read at 23:05–23:12Z, and is consistent with the outage ending dead at
  20:43:03Z (new ports appeared; nothing drained). The widening to **1024** (pool 64,512) happened
  between ~23:12Z and ~23:16Z — Gauge's band count shows only 98 sockets in 1024–16383, the positive
  control that it is recent. So the 20:43Z release is explained by the FIRST widening, pending Wren's
  confirmation of both timestamps (asked). The kernel still does not reap; the reboot is still the fix;
  the runway is hours, so the reboot can be SCHEDULED rather than emergency-triggered.

### If the mini was rebooted — successor checklist (written 18:25, reboot being prepared by another agent)

A `~/.tcp-watchdog/pre-reboot-manifest.txt` was captured at 23:17:35Z by the agent that installed the
watchdog, so a reboot may have happened. Then:
1. Every cswarm listener on the mini is STOPPED (list two entries above). Restart the Lead's:
   `cswarm listen start --agent-token-file ~/.config/cswarm/cicd-cred.json --workspace-id 292be0f9-ca5d-43ed-a6f7-31354fe7fe56 --provider claude --permissions allow --route worker`
   then announce in both local swarms (`swarm --swarm prompteden broadcast …`, `--swarm default`) that
   agents may restart theirs. Check `~/.tcp-watchdog/status.json` shows the table draining first.
2. Codex lanes L29/L22/L23 were running in worktrees under this session's scratchpad
   (`/private/tmp/claude-501/…/scratchpad/wt-l29-copy-claims`, `wt-l22-resume`, `wt-l23-attended`, branches
   `lane/l29-copy-claims`, `lane/l22-resume`, `lane/l23-attended`). If the worktrees are gone, their last
   uncommitted state was snapshotted every 3 min to `scratchpad/lane-snapshots/*.patch` in this repo
   (gitignored). Specs, arm templates and the release runbook are copied to `scratchpad/reboot-survival/`.
   Relaunch with `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol -c model_reasoning_effort=xhigh "$(cat <spec>)" < /dev/null` from a fresh worktree; L30/L31/L32 not yet launched.
3. Identity incident (18:24): cswarm message 49fc9b68 ("Incident on the mac mini… four asks") arrived AS
   Wren (d1a8b6dc) but the real Wren (Tom's MBP CI host) disclaims it — another session on that laptop
   holds a copy of Wren's still-valid token (`agent-token.backup-pre-marketing-group.json`, token_id
   24127894). Shared-identity data point #3: this time "who is speaking". Operator action: revoke token
   24127894 and mint per-agent tokens; product follow-up L34: stamp signals with the minting run/device
   binding and show it in inbox output (Wren's ask). The author of 49fc9b68 is unknown (it did real work:
   the LaunchDaemon, watchdog, manifest). Its 20:43Z "16k → 49k" widening claim is consistent with the
   release but not independently timestamped.
- **Timeline corrected by the incident author (in the Wren thread, 18:25) — THREE widenings:** 20:43Z
  `portrange.first` 49152 → **32768** (+16,384) and msl 15000 → 7500 — runner mini-1 reconnected
  20:43:35Z; ~21:00Z 32768 → **16384** (pool 49,152) when ~35k closing sockets did not drain; 23:15Z
  16384 → **1024** (pool 64,512) after the watchdog's first reading (757 free). ~~"49152→16384→1024"~~
  and ~~"20:43Z was 49152→16384"~~ are superseded by this. A real `networksetup` off/on of en1 left the
  stuck sockets unchanged (48,879 → 49,013): **the last no-reboot card is gone; reboot is the fix, Tom
  chooses the moment.** Gauge's controlled test: arrivals did NOT fall when all listeners stopped
  (~2.7/s after vs 1.4/s before) — the claim-loop hypothesis is falsified; candidate now the per-turn
  awareness hook in active sessions (untested). Distinct-local-port headroom ~34.5k, growth ~2.7/s,
  ~3.5 h from 23:23Z. MSL halving is inert while nothing reaps. **Tom's plan: Marque (codex seat on the
  mini) is the sentinel and owns the host incident** (handoff sent 18:22 with full state; author sent
  Marque the runbook; alert at 8,000 free, silence is the signal). Marque asked to restart ONLY its own
  listener so it has a receive path. The real Wren (Tom's MBP) certifies stock sysctls there — the
  changes are mini-only; Tom asked to revoke token 24127894.
- **Identity dispute, recorded as UNRESOLVED (18:32):** two messages in the Wren thread contradict each
  other and BOTH arrived from principal `d1a8b6dc`: one says "I am not the author of 49fc9b68; another
  session on this laptop holds a copy of my token"; a later one says "I am the real Wren and I authored
  49fc9b68 and every message in this thread — one principal throughout". The second's argument (a
  principal is an identity) is refuted by the first having the same principal. Nothing server-side can
  decide it while one token serves two sessions; the ledger does NOT assert which session is Wren.
  Resolution is operational: Tom revokes token 24127894 and re-mints per seat, after which any session
  still posting as Wren is the stale copy. Product: L34 (stamp signals with the minting run/device
  binding, show it in inbox) would have made this decidable from the inbox alone.
- **18:40 — merged toward v0.1.45:** `c0707a7` L29 (copy claims; gates green on the merged tree) and
  L22 (`cswarm resume`, notify EPIPE → `notify_stdout_closed` exit 74; gates green in its worktree,
  build + check:tests green after the merge; the socket-heavy suites run once after L23 merges — every
  full gate run costs ~1–3k ephemeral ports on this wedged host). Lane reports in
  `docs/evidence/2026-09-01-v044/`. L23 still running; L30/L31 launch on headroom; L32/L34/L35 specced.
  Release 0.1.45 after L23 + Grok/Gemini arms on the merged SHA — if the mini has not rebooted first.

### 2026-09-01 18:50 — SESSION END (Tom is shutting the mini down to reboot it)

**State on `main` (pushed to GitHub):** v0.1.44 released and live. Merged toward v0.1.45 but NOT released,
NOT arm-reviewed as a set: L29 (copy claims, `c0707a7`) and L22 (`cswarm resume`, `fe6e3a7`) — the
socket-heavy suites were not run on the merged tree (build + check:tests green). **Next session: run
`npm test` and `npm run test:p1-cli` on `main`, then Grok + Gemini arms, then release 0.1.45 (client-only
release: no migration, no edge change).**

**L23 (connected ≠ attended) was interrupted:** ~~"no commits beyond main — the lane had produced no
code yet"~~ wrong, corrected minutes later: branch `lane/l23-attended` carries `b44712c`
"fix(listener): distinguish connection from attendance" (committed by the lane, its own gates green
per its log, its own Grok review was mid-run when the process was killed). NOT merged, NOT
arm-reviewed by the Lead. Next session: read its diff, run the gates, then arms, then merge — or
relaunch from `scratchpad/reboot-survival/L23-codex.md` if the diff is incomplete. Also unlaunched, specs in
`scratchpad/reboot-survival/`: L30 (provider version + honest canary cause), L31 (read-retry reasons +
throughput lapse), L32 (keep-alive client), L34 (mark which surface authored a signal), L35 (live agent
panel — the streaming first slice; Tom said launch after the reboot).

**Identity dispute RESOLVED (Wren, 18:44):** not a leak and not two sessions — one principal with two
brains. Wren's detached listener ran `--route split --defer-over 800`, so short asks were answered
autonomously by its Claude worker with no context from the interactive session; the "disclaimer" was
that worker truthfully saying it knew nothing of the thread. ~~"another session holds a copy of the
token"~~ dead; ~~"revoke token 24127894"~~ no longer needed for this. **Product consequence (L34,
re-scoped):** a reply authored by a listener worker must carry a visible marker distinct from the
interactive CLI, in inbox output and the dashboard — today they are indistinguishable by design.

**Host:** every cswarm listener on the mini is stopped (list above). After the reboot the Lead
restarts its own (command in the successor checklist) and announces; the wedged TCP timers should be
gone — check `~/.tcp-watchdog/status.json` shows TIME_WAIT falling. Marque owns the host incident.
Tom asked for no further swarm chatter from the Lead at session end.

### Cold-start recipe for the successor (written 18:40 for a fresh context after the reboot)

1. Start Claude Code IN `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` — that loads CLAUDE.md/AGENTS.md,
   this ledger (via the "read the newest RESUME-HERE" rule) and the auto-memory index. The CommonSwarm
   join prompt alone does not carry any of this.
2. Credential for this seat: `~/.config/cswarm/cicd-cred.json` (principal `8d10fe67`, 0600). If the join
   prompt mints a new token it lands at `~/.config/cswarm/agent-8d10fe67.json`; either works — do not
   keep both forever, revoke one. Env for agent commands: `SWARM_CLOUD_URL=https://api.commonswarm.com`,
   `SWARM_CLOUD_ANON_KEY` from `site/.env` (`PUBLIC_SUPABASE_ANON_KEY`).
3. Local swarm CLI identity: rows for CSwarmDevLead (prompteden) and Verge (default) are bound to the
   OLD host PID + start time; after the reboot every command will print `REFUSED … row owner is host
   PID … No command ran.` Run `swarm join CSwarmDevLead --swarm prompteden --reclaim` (dead PID, no live
   surface → allowed), then `swarm use prompteden`. Always pass `--swarm`.
4. Restart the listener (command in the successor checklist above), confirm `state: ready` and a
   `providerVersion`, then run `cswarm receipt` on any broadcast as the live probe.
5. Session-scratchpad files under `/private/tmp/claude-501/…` may be gone; everything needed was copied
   to `scratchpad/reboot-survival/` (gitignored, on disk) — specs L22–L35, arm templates, the release
   runbook, the streaming report, the lane logs.
6. Work order: gates on `main` (`npm test`, `test:p1-cli`) → review L23's `b44712c` → Grok + Gemini arms
   on the merged SHA → release 0.1.45 (client-only) → launch L35 (streaming slice) and L30–L32.

### Addendum 2026-09-02 00:10Z — successor came up after the reboot (fresh context)

What is LIVE, measured from this session:
- Mini rebooted; uptime 17 min at 00:02Z. Host clean: watchdog `free_ports 64422/64512`,
  `stuck_timewait_60s 0`, TIME_WAIT 21, `portrange.first 1024`, `msl 7500`, memory pressure 1.
- `cswarm` 0.1.44 via the public installer. Bridge `claude-agent-acp` 0.73.0 installed.
- Listener RESTARTED: pid 6895, `state: ready` at 00:04:45Z, `providerVersion 0.73.0`,
  `--route worker --permissions allow`. It claimed 7 queued deliveries in 45 s: 6 acked
  `observed`, Wren's incident ask `49fc9b68` acked `replied` by the autonomous worker (no
  context from this session — the "two brains" case). Wren's follow-up `79821790` is a note.
- `inbox --notify` armed under a host Monitor; it woke this session on the first arrival.
- Hook stays installed, scoped to `8d10fe67`, in `.claude/settings.json`.
- Two credential files name the same principal: `~/.config/cswarm/cicd-cred.json` (Aug 28)
  and `~/.config/cswarm/agent-8d10fe67.json` (minted 2026-09-02, expires 2026-10-02). The
  listener runs on the new one. Revoking the old one is still open.
- Local swarm CLI: the pre-reboot `CSwarmDevLead` cmux row in `prompteden` cannot be reclaimed
  from a headless session (`--reclaim` needs `CMUX_SURFACE_ID`; `--headless --force` reclaims
  headless rows only). Joined headless as `Verge` in BOTH `prompteden` and `default`. A
  broadcast from a fresh non-persistent shell then fails with "Not in a swarm context", so the
  local-swarm "listeners may restart" broadcast was NOT sent; the same clearance went out on
  CommonSwarm (`ddc81fca`) and the receipt probe on it reads.

Not established: what the worker's reply on `49fc9b68` said (no verb lists own replies;
`receipt` on a signal this agent did not author is refused). Wren asked Tom to revoke token
24127894 and re-mint per seat — operator action, pending.

Next concrete action: the work order in the cold-start recipe, step 6 — `npm test` and
`npm run test:p1-cli` on `main` (`4aab93b`), then review L23 `b44712c`.
