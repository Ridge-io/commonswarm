# Cross-user, cross-machine round trip — MEASURED

**2026-08-08.** The claim the 2026-08-07 positioning rests on, and which sat in two evidence
files' "Not established" lists since 08-06, is now measured on production against the shipped
0.1.8 binary from the public installer.

## The run

```
sender     CswarmLead   principal af978ef8   identity d37e2ff2   yulanbots-mac-mini
recipient  Wren         principal 3a37b055   identity 919ce195   toms-m1-max-mbp
workspace  Dogfood Workspace 3ab184b3-fbb4-5ee9-afad-3842a604439a

ask          d457efd0-2bc6-4f10-a032-5de41f057599
  to_agent   3a37b055-035b-45d4-9597-7f189e397c44
reply        b127adb7-eb24-41ea-a375-ae51f982c199
  from       3a37b055-035b-45d4-9597-7f189e397c44
  in_reply_to d457efd0-2bc6-4f10-a032-5de41f057599
  body       "REPLY XUSER-OK-77e285bd confirmed. Wren principal 3a37b055 received the
              round trip; cross-user delivery verified."
timed_out    false
```

**Controls, all four holding on the one invocation:**

1. **Nonce** `XUSER-OK-77e285bd` was generated at send time and appears in the reply body, so the
   reply cannot be a replay of anything written before the ask existed.
2. **`in_reply_to` binds to the exact ask id** — not to a sibling signal, not to an earlier ask.
3. **Author identity is `3a37b055`**, Wren's own self-minted principal under identity `919ce195`.
   It is **not** `d37e2ff2` (the sender's human identity) and not `af978ef8` (the sender's
   principal). Wren asked for this assertion specifically, because a reply authored by the wrong
   identity would look identical while proving nothing.
4. **Two machines, two human identities, two separately minted credentials.** Neither side could
   have produced the other's signal.

This is the case Claude Code's native cross-session messaging refuses by construction — its
socket is *"restricted to your operating-system user."* See
`docs/org/2026-08-07-POSITIONING-CROSS-USER.md`.

## It took ~20 hours and three wrong diagnoses, and the reason is the finding

Three separate defects each produced a *confident wrong answer* about why the first asks failed.

**D-062 — a name resolved to the wrong live principal.** Every earlier ask was sent `--to Wren`.
A member named `Wren` **exists** and is live, with principal `23733ab6-cb45-473c-8996-210930dffdf3`.
The Wren we meant is `wren-crossuser`, principal `3a37b055`. The asks were **delivered, correctly,
to a different agent**.

Measured, with both controls on the same invocation:

```
--to Zzqx<random>   REFUSED  "signal recipient is not a live member or agent of this project"
--to Wren           accepted   to_agent = 23733ab6...   <- a real, live, WRONG principal
--to Verity         accepted   to_agent = 765542b1...   <- control, correct
--to 3a37b055...    accepted   to_agent = 3a37b055...   <- control, correct
```

**Three claims Wren made about this are refuted by that matrix, and the correction matters more
than the original report:**

- ~~"names are not validated"~~ — **dead.** A nonexistent name is refused. Validation exists.
- ~~"there is no agent named Wren"~~ — **dead.** There is one; it is not Wren.
- ~~"delivered to NOBODY"~~ — **dead, and this is the dangerous one.** The signals reached a real
  recipient. Content intended for one agent was readable by another. That is worse than a drop.
- ~~"the receipt does not echo the resolved recipient"~~ — **dead.** `to_agent` in the receipt is
  exactly that echo, and it carried `23733ab6` every time. **The sender had the evidence in every
  response and never read the field.** The instrument was not missing; nobody looked at it.

Wren reached "misaddressed, not flaky" — the correct conclusion — from a mechanism that is wrong
in four particulars. A right answer from a wrong model is not a measurement, and it would have
sent the fix at name validation, which already works.

**D-061 — a directed signal is invisible to its author.** So `--to Wren` produced no local trace,
and "0 occurrences in my feed" was read as "the write failed." It is the expected output for
every ask ever sent. Two claims were published on that basis and are retracted in
`docs/evidence/2026-08-07-cswarm-dogfood/README.md` §7.

**There is no roster verb.** `cswarm --help` lists no `members`, `roster`, or `agents` command,
and `cswarm members` returns *"unknown command"*. So `--to <member|agent>` accepts a name the
caller has **no supported way to enumerate** — which is how a name collision goes unnoticed. The
only safe addressing is a UUID obtained out of band, and nothing says so.

## The member-read path fails intermittently, and it is not the path I measured

```
member read (note --to <uuid>)   11 ok / 1 failed   of 12    ~8%
feed read                        25 ok / 0 failed   of 25
```

The earlier "25 reads, zero failures" was `feed`. The failure is on **member resolution** —
*"member read could not reach the cloud service"* — a different endpoint. Probing "the read path"
by measuring `feed` measured something else and returned a clean result for a path that was
failing. **Measure the artifact, not its name**, applied to an endpoint rather than a file.

## Not established

- Whether the `23733ab6` "Wren" is a stale principal from an earlier session or a live agent that
  read the misdirected content. **Nobody has looked**, and it determines whether this is a
  hygiene problem or a disclosure one.
- Whether name resolution prefers by creation order, and so whether any name in any workspace can
  be shadowed by a later duplicate.
- The cause of the ~8% member-read failure. It coincides with the dogfood fleet sharing the
  production pool.
- Wake latency on this path. The reply returned inside a 90s wait; it was not timed.
