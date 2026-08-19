# Worker stderr tail + prompt turn budget (2026-08-19)

Two changes shipped together on this lane, each driven by a measured incident
from the Fastio dogfood swarm.

## Incident 1 — the crash loop nobody could diagnose (stderr tail)

MrMarketing's `claude` listener on macOS (durable_claim mode) crash-looped:

- reached `listener_ready` **6 times**;
- the worker died **~35 seconds after each** ready;
- restarts were exhausted and the listener was left `failed`;
- **every** failure event in events.ndjson carried the bare
  `failure_code: "error"` — nothing else.

The cause was invisible by design: all four ACP hosts (claude, codex, grok,
opencode) deliberately drained child stderr (`child.stderr.on("data", () =>
undefined)`) on the grounds that stderr may contain prompt text or local
paths. The privacy concern is right; the totality was wrong — the one place
the crash names itself was being discarded on the machine whose operator
needs it.

The parent session's mac mini could **not** reproduce the failure. That is
the point: an environment-specific worker death can only be diagnosed from
the failing box's own log, so the capture has to be local and always-on, not
something a maintainer reproduces elsewhere.

### What was built

- `src/host/stderr-tail.ts` — a bounded ring (last 4,096 bytes) attached to
  child stderr in all four hosts, replacing the drain. Overflow discards the
  HEAD: the end of a crash log is the part that names the cause. `read()`
  sanitizes: ANSI escapes stripped, control chars stripped (newline/tab
  kept), credential-shaped substrings (`swm_(agt|inv|cap)_…`) **redacted at
  the producer** — the event validator's secret scan throws, and the
  supervisor's write chain swallows throws, so an unredacted token would
  silently drop the one failure line the tail exists to enrich. Bounded to
  2,048 chars.
- Each host's open options gained `onStderrTail?: (tail: string) => void`,
  invoked exactly once on child `close` (stderr fully flushed by then).
- The tail **never rides an error object**. Errors travel — through retries,
  replies, and server payloads. `AcpChildExitError` carries no tail field and
  never will. The only consumers are the operator's own 0600 files:
  - `events.ndjson`: `worker_stderr_tail` on `listener_restarting` and
    `listener_failed` (fitted from the front to ≤2,000 bytes so the line
    stays under the 4,096-byte cap — a throw there would be swallowed by the
    write chain, the supervisor.ts scar);
  - `status.json`: `lastWorkerStderrTail`, cleared on ready and on clean
    stop; old files without the key normalize to null;
  - `cswarm listen status` human output: final 3 lines under
    "Worker stderr (local log only):".
- `appendListenerEvent` extended deliberately: `worker_stderr_tail` is exempt
  from the generic 128-char string cap (own bound 2,048) but the secret scan
  still applies; `turn_budget_ms` must be a positive safe integer. A 300-char
  value in any *other* string field is still rejected (pinned by a control).

## Incident 2 — the deterministic 120s turn ceiling (prompt budget)

A second Fastio agent hit a hard ~120s worker turn budget: a heavyweight ask
produced `listener_effect retry_pending failure=acptimeouterror` at exactly
+120s after claim, **twice**, succeeding only on `promptAttempts: 3` via
durable retry. The 120s came from `ACP_DEFAULT_REQUEST_TIMEOUT_MS`, which
governs every ACP request including worker prompt turns.

### What was built

- `LISTENER_PROMPT_TIMEOUT_MS = 600_000` (`src/listener/types.ts`): worker
  PROMPT turns get a 10-minute default budget. Everything else — initialize,
  session/new, the permission canary — keeps the tight 120s transport
  default, because a wedged handshake should fail fast and restart. The raise
  is safe because the durable claim/ack layer already redelivers the signal
  if the worker dies mid-turn; the timeout is not the only safety net.
- The four listener models pass `{ timeoutMs }` on the worker
  `session.prompt` call only; open options do not widen `requestTimeoutMs`
  (pinned by test).
- `cswarm listen start --turn-budget <duration>` (s/m/h forms; floor 30s,
  cap 60m), validated before target/credential work, forwarded to the
  detached supervisor verbatim. Documented in usage and the description text;
  the KNOWN_FLAGS/help-coverage gate passes.
- Local retry events whose failure is the timeout class
  (`failure_code === "acptimeouterror"` — a code comparison, D-053) carry
  `turn_budget_ms` so the log shows what bound was hit.

## Verification

All on this branch's tree, macOS, Node 24:

| gate | result |
|---|---|
| `npm run build` | clean |
| `npm test` | 562 pass, 0 fail (was 548 before this lane) |
| `npm run test:p1-cli` | 273 pass, 0 fail (was 272) |
| `npm run check:tests` | clean |

New tests and where they run:

- `tests/host-stderr-tail.test.ts` — **added to the `npm test` literal list**
  (a file no script reaches is not a gate). Ring overflow keeps the TAIL;
  sanitizer strips ANSI/control, keeps newline/tab, redacts credentials;
  2,048-char bound; a real spawned child that writes stderr and exits
  delivers exactly one sanitized tail on close.
- `tests/listener-control.test.ts` (npm test list) — event allowlist bounds
  for `worker_stderr_tail` and `turn_budget_ms` with controls; status
  round-trip / absent-key normalization / secret rejection; supervisor:
  terminal failure carries the tail in event + status, restart carries it,
  ready clears it, **a healthy stop writes NO tail field** (field-absence
  control), oversized tail is fitted from the front under the line cap;
  `turn_budget_ms` rides only the `acptimeouterror` effect line, with a
  non-timeout control.
- `tests/listener-claude-model.test.ts` (npm test list) — prompt turns pass
  600,000ms by default; handshake `requestTimeoutMs` stays unset;
  `promptTimeoutMs` override and `onWorkerStderrTail` threading.
- `tests/p1-cli/listener-provider.test.ts` (npm test list + p1-cli glob) —
  `--turn-budget` bounds (5s, 2h rejected; 90x malformed) before any
  credential work, with a valid-duration positive control.

Mutation check (required by the lane): removing the ring cap and the
TAIL_MAX_CHARS slice made `tests/host-stderr-tail.test.ts` fail **2 of 5**
tests; restored, 5 of 5 pass. The bound assertions discriminate.

## Not established

- No end-to-end CLI process test drives a fake ACP provider that writes
  stderr and dies; the chain is covered at the ring layer (real child
  process), the model seam (callback threading), the supervisor (event/status
  writes through the real validators), and the validators themselves. The
  full fake-grok harness in `tests/listener-cli-process.test.ts` exercises a
  healthy worker and was not extended to a crashing one.
- `test:p1-local` / `test:p1-server` were not run (no server or edge-function
  changes on this lane; both need an exclusive DB slot).
- The 10-minute default has not been validated against a live provider; the
  measured facts are only that 120s was hit deterministically and that the
  durable layer recovered.
