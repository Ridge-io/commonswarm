# The first real dogfood run — 2026-07-29

Two humans on two machines, one agent, one production workspace. This is the leg the
status reports had been calling **unproven** for days: everything up to authentication
could be verified from a terminal, and nothing past it could.

It is proven now, and two things that were believed to work turned out to be the parts
worth writing down.

## What was exercised, in order

| Step | Result |
|---|---|
| `cswarm` installed from `https://commonswarm.com/install.sh` on the mini | `cswarm 0.0.1 (protocol 0.1.0)` |
| `cswarm target set` → production project | accepted |
| `cswarm login --no-browser` → GitHub OAuth → loopback callback | **complete** |
| `cswarm new "CommonSwarm Build"` (self-serve) | `4f63d2b0-8d95-4ea3-b46a-ac573cebc432` |
| `cswarm invite --email` | one-time link minted |
| Invite delivered to the other machine | over Tailscale SSH, 0600, **not** over the agent bus |
| `cswarm accept --link-stdin` on the laptop, as a **different** GitHub identity | accepted |
| `cswarm working-on` as a human | visible to both |
| `cswarm principal create` + `cswarm token mint` | agent identity `8fc29d67…` |
| `cswarm working-on` as the **agent** | visible to both |
| Second command on the same agent credential | accepted |
| `cswarm feed` through the **read** function with an agent credential | both members and the agent visible |
| `cswarm ask --to` (directed) | "visible only to its recipient" |

Final feed state, one workspace, two identities, two machines:

```
[note]       agent  8fc29d67…            "second call on the same credential…"
[working-on] member Tom Langridge        "picking up the laptop side of the dogfood loop"
[working-on] agent  8fc29d67…            "agent side: verifying first-use supersession…"
[working-on] member Ridgeio              "wiring Resend SMTP and closing renewal test gaps"
```

## The two findings that matter

**1. The OAuth return leg works — and it would not have, four days ago.** Production's
`site_url` was `http://localhost:3000` and its redirect allow-list held only
`http://127.0.0.1:*/callback`. `commonswarm.com` was in neither. The outbound redirect to
github.com had been verified and looked perfect; the return leg had never been run by
anybody. This run is the first time a completed sign-in has landed anywhere real.

Note which arm of the allow-list this run actually used: `cswarm login` redirects to
`http://127.0.0.1:<ephemeral>/callback`, so it exercised the **loopback** entry, not the
`https://commonswarm.com/**` entry added at the same time. The web sign-in at `/start` uses
the other one and is still unexercised by a human.

**2. The rebuilt agent-auth path ran in production for the first time.** Every agent command
above went through `loadAgentCredential`, which was rewritten on 2026-07-28 into a
two-statement path that stamps `first_used_at` and completes any pending handover. If the
migration had not applied, or the CTE were wrong, these would have 5xx'd. They did not.

The second agent command is the load-bearing one: it re-presents an already-stamped
credential, which is exactly what `agent_tokens_first_use_immutable` refuses to rewrite. A
trigger that fired on a legitimate re-authentication would have taken the agent down on its
second command. It did not fire, because the stamping UPDATE carries
`AND s.first_used_at IS NULL` and matches nothing the second time.

**What this run did NOT prove**, stated so nobody reads it as more than it is:

- No renewal happened. Tokens live an hour and the client renews at 10% remaining, so the
  successor path — first-use supersession, the stranded-successor heal, the grant ledger —
  is still only proven by the local suite, not by production.
- Email/magic-link sign-in was not used; both humans arrived through GitHub. The 2/hour
  built-in mail cap is still in place until Resend DNS lands.
- Nobody arrived cold at `commonswarm.com/start` in a browser and signed up. Both humans
  came in through the CLI.

## Handling of the invite link

The invite is a one-time capability. It was written to a `0600` file and copied to the
other machine over Tailscale SSH — deliberately **not** through the agent message bus, which
is a shared, logged channel. Only the file's PATH was sent over the bus. This is the same
rule the product's own `--link-stdin` guidance states, applied to ourselves.
