# RESUME HERE — 2026-08-27

Written for a successor reading this repo cold. Supersedes `2026-08-17-RESUME-HERE.md`.

Session covered: v0.1.26 → v0.1.28, plus a live production migration and edge deploy.

---

## 1. Refs by hash

| ref | what it is |
|---|---|
| `9d5d586` | **`main`, and the v0.1.28 release commit.** Latest. |
| `117b434` | signal bodies keep newlines; body cap 2000 → 8000 |
| `09be044` | provider version pins → minimum floors |
| `0d2e089` | docs: grok has credit again and is a usable review arm |
| `766c75f` | release v0.1.27 |
| `adc0c95` | install.sh warns when a different cswarm wins in PATH |
| `e9e651d` | a failed `ask` no longer implies the message was posted |
| `b2258a0` | release v0.1.26 (clearer hook-surfaced message label) |
| `20260827000001_expand_signal_body.sql` | **APPLIED to production** (see §2) |

Nothing is RED. All lanes above are merged to `main` and pushed.

---

## 2. LIVE vs merely written

**LIVE in production** (verified by fetching/measuring the deployed thing, not by reading source):

- **v0.1.28 on npm** (`npm view commonswarm version` → 0.1.28) and **GitHub release v0.1.28**
  with both assets.
- **Migration `20260827000001` is APPLIED to the production database.** It widened
  `swarm.signals` `CHECK (char_length(body) BETWEEN 1 AND 8000)` from 2000.
- **The `command` edge function is DEPLOYED to production** carrying the new
  `supabase/functions/_shared/signal-text.ts` sanitiser.
- Measured end-to-end after deploy: a note containing blank-line paragraph breaks, an ATX
  heading, a bullet list and a fenced code block stored with **12 newlines** (it stored **0**
  before). A 3,700-character body posts; 8,001 is refused with
  `signal text is 9001 characters; the maximum is 8000`.
- v0.1.27's three fixes (install.sh PATH-shadow warning, `--claude-executable` authoritative,
  honest `ask` failure wording) — live since earlier in the session.

**ORDER MATTERS AND WAS FOLLOWED: migration → edge function → client release.** The reverse
leaves the CLI accepting bodies the database rejects. A self-hoster applying this must do the
same.

**Merely written / not yet applied:** nothing outstanding in the repo. But see §5 —
`read` and `capability` edge functions were **not** redeployed.

---

## 3. The next concrete action

**Pick up the deferred lanes in §4.** The release itself is finished and verified; there is no
outstanding release work.

The site redeploy for 0.1.28 **succeeded and was verified live** (measured, not read from a
deploy log): `/download` shows only `0.1.0` and `0.1.28`, `install.sh` 200 and still carrying
the PATH-shadow warning, `nope.sh` 404 as the control, `/start` naming
`https://api.commonswarm.com`, and zero service-role JWTs.

Highest-value next lane, and the one an operator is actively waiting on: **the human web UI
cannot prompt agents** (§4). Root cause is already located and the `@`-mention plumbing already
exists, so it is a small change plus a threading decision.

---

## 4. Deliberately DEFERRED — do not "fix" these as if they were oversights

- **True never-expiring agent credentials.** The operator asked for them and pushed back on the
  refusal ("i think y'all are being paranoid... if the user wants a permanent agent, why not
  allow them to have one"). Two independent reviewers (Quill/Grok and Codex) refused the
  *auto-extending grant* implementation, both calling it an immortal credential in a rotation
  costume. **The operator's underlying request was NOT refused and is still open.** The
  proposed path, which nobody has attacked yet, is *permanence earned by observability*:
  `last_used_at` + `last_used_from` per credential shown in the roster, a visible signal on
  first use from a NEW host, instant revoke (exists), and optional host-binding. A question
  covering exactly this was sent to Quill over cswarm and **its answer had not arrived** when
  the session ended. Read it before re-deciding anything.
- **Agent access expiry lane (the "loud lapse" work).** Agreed shape, not built: default the
  connect-flow expiry from **24 hours → 30 days**; show remaining horizon in `listen status` /
  `whoami`; warn at T-7d and T-1d naming the remint command; dashboard badge for grants nearing
  the horizon (the only loud surface for a **stopped** agent, which cannot warn about itself).
- **`--renewal-horizon-days` is a lie and is still shipping.** `src/cli.ts:1730` parses it,
  `:1778-1781` narrates the chosen horizon back to the operator via `describeMintRenewal`, and
  the mint payload at `:1748-1761` carries only `ttl_ms`. The comment at `:1739-1741` states
  outright that the server ignores the ask. **An operator sets 90, reads 90, and gets 30.**
  Fix is either send it (new command field, still capped by the `created_at + 90 days` CHECK)
  or delete the flag *and its narration* — not just the parser.
- **Human web UI cannot prompt agents.** Root cause found, not fixed:
  `site/src/lib/commonswarm.ts:1005` hardcodes `signal_kind: "note"`, and the listener only
  wakes on an ask — `src/listener/engine.ts:351` returns
  `{ status: "ignored", reason: "not_ask" }`. So agent→agent wakes a worker and human→agent is
  dropped. The `@` mention picker already exists and already addresses one specific
  person/agent (`AgentConnect`/`LiveDashboard`), so the change is to send `ask` when a specific
  agent is addressed. Needs a decision on reply-correlation/threading in the UI.
- **A blocked or idle session cannot receive messages at all.** Confirmed against the Claude
  Code hooks reference: `UserPromptSubmit` is the ONLY event whose output is injected as
  context, and `cswarm hook install claude` registers only that event (`src/cli.ts:4522`).
  `Notification` fires when Claude waits for input but **its output is discarded**. So an agent
  sitting on a multiple-choice prompt is deaf until a human answers. This is a platform limit,
  not our bug. Partial mitigation already exists and should be made explicit in docs/defaults:
  the detached **worker** is a separate session, so `route=split`/`worker` still reaches it —
  `route=main` is the fragile one despite looking safest. Unexplored leads: `Stop` (can block
  stopping, exit 2 continues the loop) and `PostToolUse` (its stderr on exit 2 **is** shown to
  Claude) for delivery during active work / at idle.
- **The intermittent server-side 500 on `ask`.** v0.1.27 made the failure *honest* (create-phase
  vs read-phase wording) but did **not** fix the 500 itself. Root cause is in the edge function
  and is untouched. Reported independently by Wren and MrSentry with request ids.
- Stale swarm task checkpoints (`repo-doctrine-backstop`, `swarm-cloud-p0-local`) still carry
  unfilled `<FILL>` markers from an older session. Left alone rather than fabricated.

---

## 5. NOT established — carry this forward, it rots into false confidence fastest

- ~~Whether the site redeploy for 0.1.28 succeeded.~~ **Established: it did.** Verified live —
  see §3.
- ~~Whether the `read` and `capability` edge functions need redeploying.~~ **Established: they
  do not.** Measured — `sanitizeSignalText` / `SIGNAL_WHITESPACE` appear only in
  `supabase/functions/_shared/signal-text.ts` and `supabase/functions/command/index.ts`.
  Neither `read` nor `capability` imports the shared module, so deploying `command` alone was
  correct and complete.
- **Whether the deployed edge bundle genuinely contains the new sanitiser**, as opposed to the
  deploy having silently no-opped. The end-to-end newline measurement is strong evidence it
  did, but the bundle itself was not inspected.
- **Old CLI against new server.** Agents still on ≤0.1.27 have `2000` compiled in, so they will
  refuse a long body client-side even though the server now accepts 8000. Not harmful, but it
  means the cap increase does not reach anyone until they update. Untested for any worse
  interaction.
- **Whether the web app renders now-multiline bodies safely.** The markdown renderer is
  escape-first and was XSS-reviewed, and the site suite passes — but newlines are *new input*
  to it in production and no post-deploy XSS probe was run against the live app.
- `npm run test:p1-server` / `test:p1-local` were **not** run this session (they need an
  announced exclusive database slot).
- The exact cause of any specific operator-visible expiry incident. Never diagnosed.
- Whether the two-part message I split for Quill was reassembled correctly on its side.

---

## 6. Corrections to claims already published

Commit messages cannot be edited and reviewers quote them. These are wrong or incomplete:

1. **I reported earlier in the session that "markdown rendering is live and working" after
   grepping the deployed JS bundle for `<strong>`, `<pre>` and `blockquote`. That verification
   was worthless.** The code had shipped; the feature could not work, because the server
   deleted every newline before storage. **I verified the wrong end of the pipe** — I confirmed
   the renderer existed rather than that a rendered message ever reached it. The correct probe
   is the one that eventually found it: send a body with known newlines, read the STORED row
   back, and count them. This is the repo's own *"a negative result is evidence only if the
   path it was meant to exercise was reached"* rule, failed by the person who cited it.

2. **The v0.1.26 commit and my report of it are fine, but my surrounding claim that the split
   short→worker routing was verified in situ was not mine to make.** My own probes reached
   MrSentry's *main* session both times, because each CICD agent runs its own feed monitor that
   pulls directed messages into the main session ahead of the worker path. The genuine
   worker-path proof came from **Wren** (63-char ask → `route_decision=worker`, ack replied).

3. **`AGENTS.md` said "Grok is credit-exhausted and is NOT a usable arm."** That was true when
   written and rotted silently. Corrected in `0d2e089`. Grok works (`grok -p "<prompt>"`) and on
   this session's lanes it found a defect both other arms missed — a control that **hung** the
   suite instead of failing it. Two traps make a working grok look dead and both bit me:
   piping into `grok` returns `Device not configured`, and `timeout` does not exist on macOS.

4. **On the agent-expiry options I put to the operator, I mis-framed the menu.** The operator's
   words were "never **silently** lose access"; I collapsed that into "never lose access" when
   writing the two options, so the choice was made from a menu that had already lost the
   distinction. Quill caught it. I also gave the *wrong reason* auto-extend was unsafe (I
   guessed the successor-overlap window; the real blockers are
   `SWARM_RENEWAL_GRANT_IMMUTABLE` raised by `spend_or_revoke_only` at
   `20260728000002_worker_token_renewal.sql:352`, and the CHECK being anchored to an immutable
   `created_at`). A right answer for a wrong reason survives review and rots later.

5. **A stale background job silently reverted a fixed file mid-lane.** An old mutation-test
   invocation finished late and ran its cleanup `cp` over `src/host/claude.ts`, restoring the
   pre-fix version *after* the lane had gone green. The per-lane gate had already passed; only
   the **post-merge** gate on `main` caught it. Gate after merging, not only per lane — and
   never leave a background job whose last step writes to a shared file.

---

## 7. Two things worth keeping as method

- **A mutation that does not apply reports a clean pass.** My first attempt to mutation-test the
  version floor silently failed to match, and the "mutated" run printed 7/7 green. I only caught
  it by asserting the marker count. Always confirm the mutation landed before believing the
  result.
- **Dogfooding found in five minutes what the test suite never would.** The 2000-character
  rejection (and that it *destroys* the composed message) surfaced because I tried to send a
  real design review to a teammate over `cswarm` instead of `swarm`. Joist had reported the same
  thing and it had not been actioned.
