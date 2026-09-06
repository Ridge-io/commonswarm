# Lane — route main is the only route; the listener never starts a model (`lane/main-only`)

**Operator ruling (2026-09-06, absolute, highest priority):** "There should NEVER be headless agents
answering on behalf of the main agent. That's a failure mode of the system." The point of a seat is its
live, long-lived session and its context window. A signal WAKES that session and asks it to read the
message. The listener's job is to claim the delivery into the seat's queue and wake the session; it must
never start a model. Brain topic `listener-attended` (v6) carries the doctrine; the ledger
`docs/org/2026-08-29-RESUME-HERE.md` (last entries) carries today's history.

## What to change
1. **Routes.** `ListenerRouteMode` (`src/listener/main-routing.ts:35`) becomes the single member `"main"`,
   exported as a constant array `LISTENER_ROUTE_MODES = ["main"] as const` that the parser, the usage line,
   and every message read. `--route worker` and `--route split` are refused with a sentence generated
   from that constant plus the ruling in one clause ("a listener never answers for a session; the seat's
   own session reads the queue"). `--defer-over` is refused the same way (it only made sense for split).
   Old status files that say `routeMode: "worker"|"split"` still PARSE (`control.ts:620` default) and are
   reported as legacy in `listen status` with the sentence that they cannot be started again.
2. **No model, ever.** Remove the `options.model.start()` path from `src/listener/runtime.ts` (the
   `if (routeMode !== "main")` branch and everything only it reached: the provider worker, the permission
   canary for the worker, `enablePromptsAfterCanary`, the Grok/Claude/Codex/OpenCode ACP hosts as listener
   dependencies). The provider flags (`--provider`, `--*-executable`, `--model`, `--effort`,
   `--permissions`) stay accepted for now ONLY to name the attendance surface kind (`--provider claude`
   → the Claude hook); executables are no longer spawned by the listener. Put the hosts' removal from the
   tree behind a follow-up if the diff would exceed what one review can hold; the load-bearing change is
   that NO code path in `runtime.ts`/`supervisor.ts` can spawn a model. A test asserts it with a fake
   model whose `start()` throws: the listener reaches `ready` without calling it.
3. **Attendance surfaces.** `listen start` on route main today refuses without a principal-scoped hook
   (`listen_unattended_refused`, `src/cli.ts:~6050`). Add the second surface the operator names, the
   notify watcher: a running `cswarm inbox --notify` for the same principal on this host (lane A's
   single-watcher lock is the evidence; find it in `src/cloud/arrival-watch.ts` / `src/cli.ts` and reuse
   the lock path, never a pgrep). With hook OR watcher present, start is accepted; with neither, the
   refusal names both remedies, generated from one constant list of surfaces; `--allow-unattended` stays
   as the explicit queue-only opt-in and its sentence says a queue may not wake a session.
4. **Status honesty.** `listen status` says which surface is attending (hook / watcher / none) and, when
   none, that signals queue and nothing wakes the session. Sentences from constants.
5. **Docs.** `docs/design/SWARM-CLOUD.md` listener section: one paragraph stating the ruling and the single
   route; AGENTS.md "Reachable traps": one trap ("the listener never starts a model; a lane that adds a
   worker is wrong by construction"). CLI usage line regenerated from the constants.

## Tests (pure; `npm test` list gains any new file)
route parser: `main` accepted, `worker`/`split`/`--defer-over` refused with the generated sentence
(mutation: add "worker" back to the constant → the refusal test fails); runtime: fake model with throwing
`start()` → `ready`, signals go to `pending-for-main.json`; attendance: hook only / watcher lock only /
both / neither (refusal names both remedies) / neither + `--allow-unattended`; legacy status file with
`routeMode: "worker"` parses and renders the legacy sentence; existing listener tests updated, none
weakened. Live control (paste in REVIEW.md): a listener with `--state-dir <temp>` against the local stack
(read-only use of the stack; no `db:reset`), `listen status` JSON showing `routeMode: "main"`, the
attending surface, and a posted note landing in `pending-for-main.json` with no model process spawned
(`pgrep` for the provider executable → 0 with a positive control).

## Gates
`npm run build`, `npx tsc --noEmit -p tsconfig.json`, `npm test`, `env -u FORCE_COLOR npm run test:p1-cli`,
`npm run check:tests`, `npm run check:edge`, `scripts/check-commit-identity.sh origin/main..HEAD`. Plain
statements under `set -e`. D-053. Every enumeration from its constant. Commit as the repo config sets.
Freeze; `arms-<sha>/REVIEW.md` + `DIFF.patch`; ONE Gemini arm detached (absolute paths, quote-back,
VERDICT line). Write `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-main-only-REPORT.md`. Stop; do not merge; never production.
