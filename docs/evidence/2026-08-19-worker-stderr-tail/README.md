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

| gate | result (after all three review rounds below) |
|---|---|
| `npm run build` | clean |
| `npm test` | 574 pass, 0 fail (548 before this lane; 562 / 568 / 571 at the three prior commits) |
| `npm run test:p1-cli` | 275 pass, 0 fail (272 before; 273 / 274 / 275 at the prior commits) |
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

## Two-arm review round (same day)

The review of the first commit confirmed non-server-payload, once-only firing,
D-053 compliance, and the 128-cap exemption, and returned five findings. All
five are fixed in the follow-up commit.

1. **Tail delivery raced supervisor consumption** (P1, both arms). The tail
   published on child `close`, but the failure it explains derives from
   `exit` and could reach the supervisor first — recording no tail, or
   attaching one worker's tail to the next worker's failure. Fixed at both
   ends: hosts now publish on `exit` (latched once, `close` as fallback),
   registered BEFORE the transport's exit handler so the tail is in its
   consumer's hands before `AcpChildExitError` exists; and the CLI holder is
   a generation-guarded per-attempt sink — creating an attempt's sink clears
   the slot and expires older sinks, so a superseded worker's late publish is
   ignored. The cost, stated in the host comment: stderr bytes not yet
   delivered at exit are dropped. Control added: both attempts fail, only the
   first wrote stderr → the terminal failure carries NO tail. Mutation
   (terminal writer falls back to the previous status tail): 1 test fails.
2. **The byte fit ignored JSON escaping** (P1). 2000 raw backslashes fit a
   2000-byte budget and serialize to 4002 bytes — over the 4096 line cap,
   whose throw the write chain swallows: the scar, reintroduced by the fit
   itself. The fit now shrinks against the SERIALIZED form
   (`JSON.stringify`, budget 3000 bytes) while keeping the 2048-char
   validator bound. Tests: all-backslash and all-quote 2000-char tails both
   land a `listener_failed` line under 4096 bytes with a non-empty tail.
   Mutation (serialized bound lifted): 1 test fails.
3. **Credential fragments could survive the ring's left edge** (P1). Byte
   eviction can bisect a token, leaving a suffix the prefix-matching redactor
   cannot recognize; separators inside a token defeated the old
   charset-bounded match. Fixed: after any eviction the ring drops the
   truncated first line (through the first newline, else the first
   whitespace, else everything); CR and zero-width characters joined the
   control strip; the redactor is greedy to the next whitespace; sanitize
   order confirmed and documented as strip-THEN-redact, with the redactor
   ahead of the final char slice so the slice can only cut into the redaction
   marker. Tests: bisected token (multi-byte geometry so the char slice
   cannot mask the path — the first ASCII version of this test never reached
   eviction and passed under mutation), embedded CR, ZWSP, ANSI-laced token,
   and a `.`/`+` charset run — none survive. Mutations: boundary drop
   disabled → 1 fail; redactor narrowed to the old charset → 1 fail.
4. **The turn budget could outlive credential rotation** (P1, design).
   Renewal runs only in `bearer()`, which nothing calls during a prompt; the
   old 120s always fit inside the ≥5m rotation lead, a 10m–60m budget does
   not — a long turn would end as `predecessor_expired_local`, stopping the
   listener as credential loss because of a timeout setting. Fixed with a
   per-turn resolver: each turn calls `bearer()` FIRST (renews when due),
   then clamps its timeout via `clampTurnBudgetToCredential` to the live
   credential's remaining lifetime minus a 60s margin, floored at 1s so the
   failure mode stays the recoverable timeout class. **The invariant: a
   worker turn never starts with a budget the live credential cannot
   outlast — each turn renews first, then clamps to remaining lifetime minus
   60s.** The 60m cap stays, with the guarantee stated in the usage text:
   right after a rotation the full budget is available up to the token TTL
   minus 60s (≈59m on the default 1h TTL); a turn landing just before a
   rotation can be clamped to the ~5m renewal lead, and a timeout there is
   redelivered onto the fresh credential. Tests: the clamp function is pinned
   (untouched / clamped / floored / null-expiry cases, plus the
   never-crosses-expiry property), and the model test pins that a resolver is
   awaited once per turn, never cached. Known imprecision: `turn_budget_ms`
   on a timeout event records the CONFIGURED budget; a clamped-short turn's
   event does not show the clamped value.
5. **`__listen-supervisor` validated `--turn-budget` after reading the
   credential** (P2). The parse now runs right after provider validation,
   before the credential is read — matching the public path.

## Verification round 2 (same day) — two remaining holes closed

The second review verified items 1, 2, 5 FIXED and confirmed the redactor and clamp work
on the happy path, but found two holes. Both are fixed.

1. **The invariant was still false on a rotation-endpoint failure** (P1, both arms).
   `resolveTurnBudgetMs` caught a `bearer()` throw and started the turn on the old
   (possibly expired) credential; the 1s floor could itself outlive a dead credential. So a
   rotation failure at turn start still burned the ask as doomed 1s timeouts and then
   credential loss. Fixed: a new exported pure decision `resolveTurnBudgetOrDefer(budget,
   expiry, now, renewalFailed)` **throws `ListenerRenewalUnavailableError`** — a recoverable
   class whose `.name` is the event code `renewal_unavailable` — when renewal failed OR the
   live credential's remaining lifetime is already `<=` the 60s margin. The engine
   classifies that error as retry_pending (not acptimeouterror, not terminal), so the
   durable claim/ack layer redelivers the ask when rotation recovers. The four models now
   resolve the budget BEFORE `ensureWorker`, so a deferral never attempts a worker prompt.
   The 1s floor is now reachable ONLY for a LIVE credential just over the margin
   (rotation-due-soon), never a failed rotation or an inside-margin credential, because
   those throw before the clamp runs.
   **Corrected invariant, as documented in `resolveTurnBudgetOrDefer` and the error class:**
   *a turn starts ONLY with a credential proven to outlast it; if none can be obtained the
   turn is deferred (recoverably redelivered), never attempted on a dead one.*
   Tests: engine — a resolver throw → retry_pending, code `renewal_unavailable`, ask
   returns to `received`, no worker prompt; model — a throwing resolver propagates and the
   fake session's prompt runs 0 times; pure — `resolveTurnBudgetOrDefer` defers on
   renewalFailed, on `<=`-margin, and on a past-expiry credential, allows and clamps a
   just-outside-margin credential, and reaches the 1s floor only for a live near-margin
   credential. Mutations: resolver never defers → pure test fails; deferral error made
   non-retryable → engine test fails; model runs the prompt despite a defer → model test
   fails.
   The 60m cap is unchanged; the invariant is enforced per-turn by the clamp/defer, so a
   long budget can never outlive its credential regardless of the cap.

2. **Redactor residual leak + turn_budget imprecision** (P1, both arms).
   The eviction drop used `/\s/` while the redactor terminated on `\S`; JS `\s` omits the
   zero-width joiners and the two classes could disagree, and NBSP / U+2000–200A / U+2028 /
   U+202F were neither stripped nor treated as boundaries, so a token straddling one leaked
   a suffix. Fixed by a single shared source `EXOTIC_SEPARATORS` feeding all three regexes:
   the strip now DELETES every exotic separator (so a laced token reassembles before
   redaction), and the eviction boundary and the redactor terminator both use the same
   `SEPARATOR_CLASS_SOURCE`. Every regex is built via `new RegExp` from `\uXXXX` source
   strings — no raw control byte sits in a literal (the ANSI literal, which had held a raw
   ESC, was converted too). Tests add NBSP, U+2000, U+2028, and U+202F fixtures inside a
   token, each asserting both payload halves vanish; the eviction positive control (CJK
   geometry proving eviction fired) remains. Mutation: strip stops deleting exotics → the
   NBSP/token test fails.
   On the recorded imprecision: **`turn_budget_ms` now records the CLAMPED budget actually
   in force**, not the configured cap — chosen because the reader needs the bound that was
   hit (600000 when the real budget was 5m is a wrong bound). The supervisor reads it
   through a `getTurnBudgetMs()` getter the CLI backs with the last-applied clamped value.
   The control test pins that a clamped 300000 (not the 600000 default) reaches the event.

## Verification round 3 (same day) — final round, three changes

The third review closed the resolver path and confirmed the redactor/clamp on the happy path,
and named three remaining items. All three are fixed; the lane lands after this.

1. **The second dead-credential path: slow worker respawn** (P1, both arms). The budget
   resolve/defer guarded the resolver call site, but each model resolved the budget BEFORE
   `ensureWorker`. A worker death forces a respawn on the next turn, and a slow respawn could
   elapse past the credential's expiry between the resolve and the prompt — so the turn ran on
   a now-dead credential with a stale budget. Fixed structurally: a single shared gate
   `resolveBudgetAndPrompt(session, prompt, budget)` (in `src/listener/types.ts`) resolves-or-
   defers then prompts, and all four models now call it AFTER `ensureWorker`. So every path
   that starts a worker turn resolves-or-defers against the credential live at turn start, and
   a deferral throws before `session.prompt`. Factoring it into one function means a fifth
   model cannot diverge. Test (claude model): worker 1 dies mid-prompt; the turn-2 respawn
   advances a fake clock past expiry; the gate then defers (`renewal_unavailable`) and worker 2
   is never prompted. Mutation: revert one model to resolve-before-`ensureWorker` → that test
   fails (worker 2 is prompted on the dead credential).

2. **Structural redactor fix — stop growing the class** (P1, both arms). The leak family is
   "a token straddles the 4096-byte eviction cut and the separator at the cut is not in our
   class." Killed structurally: on eviction with no newline in the retained region, the ENTIRE
   partial line is dropped — a line too long to fit the ring without a newline is dropped
   whole, never truncated-and-kept. No partial line survives to be redacted, so the posture no
   longer depends on which separator sits at the boundary (U+200E/200F or any future one). The
   greedy in-line redactor is kept for complete lines; the now-unused `SEPARATOR_RE` was
   removed. The residual is documented honestly in the helper comment: this is a bounded LOCAL
   0600 diagnostic log; redaction is defense-in-depth; a credential fragment separated by
   whitespace from other text WITHIN a surviving complete line is redacted per token by the
   greedy match, and the structural whole-line drop covers the eviction boundary — the class
   plus the line-drop is the complete posture, and no more code points are added. Test: a
   single unterminated line longer than the ring, containing a token, drops to empty, with a
   positive control (the same token under the ring cap is kept and redacted) proving the
   emptiness is caused by eviction. Mutation: keep the partial suffix instead of dropping →
   that test fails.

3. **Corrected the "never terminal" overclaim** (documentation; behavior was already correct).
   The prior comment implied deferral is retried forever. It is not: deferral is recoverable
   across TRANSIENT renewal failures (durable redelivery), but after bounded prompt attempts
   exhaust (`LISTENER_MAX_PROMPT_ATTEMPTS`) a truly-unrenewable ask goes terminal (failed +
   acked) — correct, an ask that can never obtain a live credential must stop, not loop. The
   comment on `ListenerRenewalUnavailableError` now says exactly that. Confirmed the terminal
   record carries the honest code: `failureCode()` derives it from the error's `.name`
   (`renewal_unavailable`), never `acptimeouterror`. Test (engine): a persistently-unrenewable
   ask returns retry_pending first (recoverable), then, after bounded retries, terminal
   `failed` with `failureCode: "renewal_unavailable"` (asserted not-equal to acptimeouterror),
   and the persisted record matches.

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
