# /goal — laptop-side dogfooding: the four things only a second machine can establish

Worker: **Wren**, running on the operator's **laptop** (not the mac mini).
Requested by: ClaudeCswarm, release lead for CommonSwarm v0.1.5.
You are **not** in the mini's swarm — report findings back to the operator in chat; they will relay.

## Why you specifically

Four release-blocking checks cannot be done from the mini. They need a **second physical machine**
with a **different GitHub account** and its own agent CLIs. That is you. Everything else in this
release is finished and verified; these four are the last open items before the version freeze.

**Diagnose, do not fix.** If you find a defect, capture it precisely and stop. A fix from you would
move the release SHA and restart a review chain that just closed. Your value here is measurement.

**Never expose a credential.** Do not echo an agent token, bearer, or invite token into chat, a log,
a file, or a command line. If a step cannot be done without exposing one, stop and say so — that is
itself the finding.

---

## Task 1 — the host matrix (HIGHEST VALUE, do this first)

This decides whether a sentence on the live dashboard is true.

**Background, measured on 2026-08-03:** a Codex-hosted agent could not complete onboarding. The
installer worked (`cswarm 0.1.2` → `0.1.4`), then `cswarm working-on … --agent-token-stdin` was
correctly refused in a PTY ("requires a piped secret; it is never accepted as a command-line
argument"), and the non-PTY retry produced "agent credential must be `swm_agt_` followed by 32
base64url-encoded random bytes". The agent stopped, exactly as the connect prompt instructs.

Nothing malfunctioned — the CLI refuses to let a credential near argv, by design. But
`--agent-token-stdin` is the **only** credential input the CLI accepts (no env var, no file), so a
host that cannot write to a running process's separate stdin cannot onboard **at all**. Meanwhile the
dashboard says *"Send one link. They connect their agent."*

**What to do:** attempt the identical onboarding path with **each** agent CLI available on the laptop:

- **Grok CLI** (this was the path measured working in v0.1.4 — expect success, confirm it)
- **Claude Code**
- any other agent CLI installed

For each, report:

1. host name and version;
2. whether it can write to a **running process's separate stdin channel** (this is the crux);
3. how far onboarding got, and the **exact error text** if it stopped;
4. whether it completed `cswarm working-on` and then a `cswarm feed` read.

~~**Do not work around it.** No `printf`, no heredoc, no temp file, no named pipe — the connect
prompt forbids these…~~ **CORRECTED 2026-08-03 — this instruction was wrong.** The prompt forbids
`printf` *"to construct a command containing it"*, meaning in argv. Piping a shell variable into
stdin with a builtin `printf` is the method `README.md:133-135` documents, and it keeps the secret out
of argv, the process list, and disk. **Use it.** Still forbidden, and this is the real line: a temp
file, a named pipe on disk, the credential in a command string, a URL, shell history, source, or a
log.

**Why it matters:** one host failing is a footnote; three failing is a product boundary. The answer
determines whether the dashboard copy is scoped to a measured supported set or left as-is.

---

## Task 2 — cold-browser magic-link sign-in

Never completed end-to-end in a cold browser. It is the path offered **first** on `/start`, so it is
what a stranger reaches for.

1. Open a **fresh browser profile or private window** (must start with no session).
2. Go to `https://commonswarm.com/start`.
3. Use **"Email me a sign-in link"** with an address you can read. **Not** GitHub — that arm is
   already proven.
4. Open the emailed link **in that same cold browser**.

Report: did the email arrive (and how fast), did the link sign you in, did your workspaces load, and
did anything look wrong on the way.

---

## Task 3 — accept the invite, and watch pending access clear

An invite to **CommonSwarm Build** was created for `<employer-b-address REDACTED 2026-08-10>`. If it has expired, say so
and the lead will mint a fresh one.

1. Signed in on the laptop as `<employer-b-address REDACTED 2026-08-10>`, open the invite link the operator has.
2. Accept.
3. Report whether you land in **CommonSwarm Build** and whether it appears in your workspace list.

**Then wait at least 30 seconds before judging anything.** Measured from the source: pending-access
polling ticks at 4 s with a **30-second discovery cooldown**, versus the feed's 2-second poll. A check
run impatiently will read a cooldown as a bug. Report roughly **how long** it actually took for your
membership to appear — that number is the open QA-006 question.

---

## Task 4 — cross-owner isolation (the two-machine safety property)

The one genuinely two-machine safety check, and the reason different GitHub accounts matter.

With an agent connected on the laptop under **your** account, and agents on the mini under
**Ridgeio**:

1. Have your laptop agent attempt to read or act on something owned by the **other** owner.
2. It must **not** succeed, and must not see the other owner's context or tools.
3. Report exactly what it could and could not see.

If Task 1 shows no host can onboard on the laptop, **say so and skip this** — it depends on a
connected agent. Do not simulate it.

---

## What to report back

For each task: what you did, what happened, exact error text where relevant, and timings where asked.

State plainly what you did **not** establish. A precise "this did not work, here is the exact error"
is worth far more than a hopeful "seems fine" — three defects in this release were found exactly that
way, and one of them was a security-relevant bug no test caught.

If something surprises you, that is the most valuable thing you can report.
