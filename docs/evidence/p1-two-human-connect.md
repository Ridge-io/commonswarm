# Evidence — FIRST TWO-HUMAN AGENT CONNECT (2026-07-24)

**Operator goal (same day, achieved):** two users connect their agents to each other
across the internet via coswarm, end to end on hosted (`ukezjcnxjvkpkeezxaew`),
entirely through the governed command path. No service_role fixtures anywhere in the
chain. Operator (Tom) personally drove every human-side command.

## The chain, as executed and verified

| # | Act | Actor | Proof |
|---|---|---|---|
| 1 | `coswarm login` machine 1 (Mac mini), GitHub PKCE | human A `d37e2ff2` | device `8cbd746b`, keychain credential |
| 2 | `coswarm invite` (governed `invite_member`) | A | invitation `345ad183`, event seq 6 `MemberInvited`; raw `swm_inv_` shown once |
| 3 | `coswarm login` machine 2 (M1 Max MBP), **distinct** GitHub identity | human B `919ce195` | device `317256c6` (see lesson 5 below) |
| 4 | `coswarm accept` (capability-only, atomic consumption) | B | seq 7 `InvitationAccepted` `consumed_by=919ce195`, seq 8 `MemberJoined` `invited_by=d37e2ff2` |
| 5 | `coswarm principal create` → `laptop-agent` | B | seq 9 `AgentPrincipalCreated`, principal `5103ae10` |
| 6 | `coswarm command create` task `first-connect` | A | seq 10 `TaskCreated`, task `223a81aa`, epoch 0 |
| 7 | `coswarm token mint` (first governed agent mint on hosted) | B | token id `7a3118c6`, run `b3bfdb96` created in-tx; raw `swm_agt_` fresh-response-only |
| 8 | **agent acquires A's task with its own credential** | B's `laptop-agent` | seq 12 `LeaseAcquired`, event `dbf9686c`, triple-stamped `actor_user=919ce195` / `actor_agent_principal=5103ae10` / `actor_run=b3bfdb96`, owner=principal, epoch 1 |

## Independent verification

- Event-level canary re-query of hosted (Anvil/psql, read-only, strict-JSON output):
  seq 3–10 dumped verbatim — one invite, exactly one consumption, correct actor
  stamping, prior dogfood relics (seq 3–5) clearly distinct. **Anvil's first,
  free-text readback misassociated actor columns; the strict-JSON re-query corrected
  it — the "verify with exact canary fields, compact output" landmine held again.**
- All command responses above are direct HTTP outputs pasted by the operator, not
  agent self-reports.
- Code path: 2b-1 pure core `10d6d0a` (Kimi K3 FIX(7) folded, 66/66), 2b-2 wiring
  `8b4bc1a` (Kimi K3 fast-follow FIX(5) all-minor, hunt-ledger clean on all 8
  load-bearing seams; minors queued). Suites at deploy: 66/66 unit, 14/14 CLI,
  10/10 server (live local stack).

## Field lessons (operator-driven; fold into onboarding + ux-connect-polish)

1. `coswarm login` never returns the prompt after success (must exit 0) — bug #1.
2. Paste-fallback prompt prints in the happy path — reads as an error — bug #2.
3. `--workspace-id` undiscoverable by the operator (Lead had to derive it from the
   seed) — env + profile default queued — bug #3.
4. Stale global `npm link` dist produced `unknown command: invite` — version signal
   queued — bug #4.
5. **GoTrue links identities by verified email:** operator's two GitHub accounts
   shared an email → same uid on both machines. Second human REQUIRES a
   distinct-email identity; must be stated on the invite page/docs — lesson #5.
6. `coswarm logout` used global sign-out scope: logging out on machine B revoked
   machine A's session ("Invalid Refresh Token"). Also *proved* cross-machine
   revocation fails closed in seconds. Fix: `scope:'local'` + explicit
   `--all-devices` — bug #6.
7. `read -rsp` snippet was bash-only; operator shell is zsh — runbooks must be
   shell-exact.

## Residual notes

- The demo `swm_agt_` credential appeared in the operator's chat transcript; it is
  task+run+epoch-bound, 8-command-scoped, TTL 1h (expires ~16:31 UTC 2026-07-24).
  Revoke wiring is deferred (2b remainder) — expiry is the mitigation, accepted.
- Fixture-era null-bound seeded tokens still live; revoke once revoke wiring lands
  (decision #79d).
- Epoch-binding enforcement at command time (token.epoch vs lease epoch) not yet
  wired — forward-registered with the 2b remainder.
