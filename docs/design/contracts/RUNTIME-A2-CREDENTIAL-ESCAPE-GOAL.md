# /goal — Runtime A2 credential escape and caller-signal composition

Status: **worker complete at `ab1b240334efc62b50027512f64692e15d0e0752`; awaiting independent
exact acceptance and Lead integration as of 2026-07-31 21:59 CDT.** Do not resume writing on this
branch unless an exact review produces a narrower frozen repair goal.

Lane: listener Runtime A2, narrow prerequisite for durable Runtime C.  
Writer: fresh DeepSeek V4-Flash through Pi.  
Worktree: `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi`.  
Branch: `deepseek/runtime-reply-deadline-pi`.  
Frozen accepted Goal-A base: `cc18bf36b5db0b1e4558dab3b0ae0f1bf9c8e431`.  
Original integration base: `664282866cb3840734f6a25845494d18d695253f`.

Read root `AGENTS.md`, every Runtime-A goal/audit/completion, the Kimi final inversion,
`RUNTIME-C-D-PREFLIGHT-CORRECTIONS.md`, and all four owned files. Stop unless HEAD, clean tree,
local tracking ref, and live remote branch equal the frozen base. Preserve every accepted Goal-A
deadline, tagged first-winner, typed-HTTP, timer/listener, envelope, and idempotency invariant.

## Owned paths only

- `src/listener/engine.ts`
- `src/listener/runtime.ts`
- `tests/listener-engine.test.ts`
- `tests/listener-runtime.test.ts`

Do not edit command client, listener types/control/supervisor/CLI, delivery transport/journal,
package, server, site, release, or docs.

## Empirically confirmed defect

The default reply poster calls `credentialSession.bearer()` inside `ListenerEngine.post`. Typed
HTTP 401/403 already restore `reply_ready` and rethrow, but renewal reauthorisation, revocation, and
secret-absence errors are ordinary nonretryable errors to the engine. They become terminal
`failed`, so runtime never sees credential loss and later durable composition could ACK the signal
as `failed_terminal`.

Kimi's exact-SHA probe measured:

```text
RenewalRevoked       => returned:failed; last=failed/renewalrevoked
RenewalReauth        => returned:failed; last=failed/renewalreauthorisationrequired
secret-absence       => returned:failed; last=failed/error
hostile-http401-text => threw:CommandHttpError; last=reply_ready/null
```

It also proved runtime's message-regex abort check can turn a rethrown
`CommandHttpError(401/403, "...cancelled...")` into `{reason:"cancelled"}` instead of credential
stop, and found the accepted caller signal is not yet passed into the engine/default reply post.

## Frozen implementation

### Engine credential seam

Add optional:

```ts
isCredentialFailure?: (error: unknown) => boolean;
```

to `ListenerEngineOptions`. This name matches the established follow API. Undefined preserves the
current source-compatible behavior. The classifier is synchronous and local; never give it server
response bodies or credentials. Fail safely if an injected classifier itself throws: restore exact
`reply_ready`/null with the already-incremented attempt, then rethrow that classifier exception so a
classifier defect cannot strand the record in `posting`.

Freeze the post-catch order:

1. `CommandHttpError` is handled first with the existing closed behavior. 401/403 restore exact
   `reply_ready`, set `failureCode:null`, and rethrow the identical error. Other HTTP errors skip
   the credential classifier and continue to the existing typed retry/terminal logic. This stops
   server-controlled message text from reaching name/wording classification.
2. For non-HTTP errors only, call the optional credential classifier. When true, write exact
   `reply_ready` with `failureCode:null` and rethrow the identical original poster error. When the
   classifier throws, restore the same record and rethrow the classifier exception.
3. Then handle genuine abort, expiry, retry, and terminal failure exactly as before.

Make the engine's abort helper name-only as well (`error.name === "AbortError"`, with caller signal
state handled explicitly). Arbitrary `aborted`/`cancelled` message text is untrusted and must not
become cancellation in either engine or runtime.

Preserve reply body, command ID, truncation flag, reply signal ID, immutable signal fields, and the
already-incremented `postAttempts`. Never create `credential_unavailable` or a terminal record.

### Runtime classification and signal wiring

- Pass one local closed runtime predicate into the engine seam; runtime exposes no override.
- That predicate returns immediately for every `CommandHttpError` (true only for 401/403, false for
  every other status), then recognizes the actual `RenewalReauthorisationRequired` and
  `RenewalRevoked` classes, then delegates other non-HTTP values to
  `isFollowCredentialFailure`. Thus typed HTTP 5xx/409 text can never fall through to wording.
- In both read and engine catches, adjudicate exact caller abort state first, then the closed
  credential predicate, then name-only `AbortError`. This preserves an explicit caller abort that
  already won while preventing hostile error message text from impersonating cancellation.
- Make runtime abort recognition typed/name-based (`AbortError`) plus the explicit caller signal;
  do not classify arbitrary `aborted`/`cancelled` message substrings. Typed HTTP errors can never
  be cancellation because of their text.
- Pass the runtime caller signal into `ListenerEngine`.
- In the default poster, accept the engine-provided `abortSignal` and pass it as `signal` to
  `ThinCommandClient.sendSignal`. Do not change the command envelope or construct a second signal.
- Keep read retries, model lifecycle, shutdown, and custom injected poster compatibility intact.

## Required causal tests

### Engine

- Inject a closed credential classifier and separately throw a reauthorisation-shaped error,
  revocation-shaped error, and explicit secret-absence error from the poster. Each restores exact
  `reply_ready`/`failureCode:null`, preserves body/command ID/postAttempts, and rethrows the exact
  same object by identity.
- A `CommandHttpError(500, "secret is absent; operation cancelled")` never reaches the classifier
  and stays typed retry behavior. A typed 409 stays terminal. Existing hostile 401/403 remain exact
  credential escapes.
- A credential error whose message contains `cancelled` is credential escape, not abort.
- A throwing credential classifier restores the record and rethrows its own exact exception rather
  than leaving `posting` or hiding the classifier defect.
- Ordinary noncredential errors whose text merely says `aborted`, `cancelled`, a renewal class
  name, or `secret is absent` outside the existing exact fleet wording/predicate cannot impersonate
  cancellation or override typed HTTP 409/429/5xx.

### Runtime

- Have the default poster's `credentialSession.bearer()` throw each credential family immediately
  before post. Runtime returns `{reason:"credential"}` with the identical error, effect state is
  exact `reply_ready`, and no reply fetch occurs.
- An injected poster throwing `CommandHttpError(401, "server says cancelled")` produces credential
  stop, never cancelled.
- The default-post HTTP path also maps exact 401/403 to credential stop, not fatal/cancelled.
- A trusted injected poster receives the same closed runtime classification; runtime exposes no
  classifier override.
- An explicitly already-aborted runtime remains cancelled even if the concurrently surfaced error
  is credential-shaped; exact abort state is authoritative.
- An ordinary noncredential error merely containing `secret is absent` is classified only according
  to the existing bounded fleet convention; do not broaden wording beyond that function.
- The default poster forwards the exact runtime caller signal to the command fetch. An already or
  subsequently aborted caller remains bounded and leaves the effect resumable.

Reversible controls must make the focused suite red when: the engine classifier branch is removed;
runtime checks message cancellation before credential; or poster signal forwarding is removed.
Restore byte-identically and prove zero residual focused processes.

## Gates and handoff

Pure/static only: focused engine+runtime tests, causal mutants, root `npm test`,
`npm run check:tests`, `npm run build`, and original-base `git diff --check`. No DB, edge serve,
provider/live network beyond Pi, deployment, publish, or version work.

Commit once, push, prove clean HEAD/local tracking/live remote equality, send Lead7 one direct
completion or blocker message, leave the swarm, exit Pi, and freeze. Never broadcast or contact
AdvisorClaude2. State that Runtime C/D composition, DB/provider behavior, deployment, and production
remain unestablished.
