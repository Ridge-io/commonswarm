### Independent Inversion Review (Ruling D-036)

**Target SHA:** `ab1b240334efc62b50027512f64692e15d0e0752`  
**Delta:** `cc18bf3..ab1b240`  
**Touched Files:** [`src/listener/engine.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts), [`src/listener/runtime.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts), [`tests/listener-engine.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/tests/listener-engine.test.ts), [`tests/listener-runtime.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/tests/listener-runtime.test.ts)

---

### Analysis Against Frozen Contract & Attack Vectors

1. **Hostile Server-Controlled Text Immunity:**
   - In [`src/listener/engine.ts:L451-L460`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts#L451-L460), `CommandHttpError` is checked first. 401/403 errors restore `reply_ready` with `failureCode: null` and rethrow. Other HTTP status codes skip the `else` block containing `isCredentialFailure` and fall strictly into typed retry/terminal handling. Server message text (e.g., 500/409 containing "cancelled" or "secret is absent") cannot reach the classifier or impersonate cancellation.
   - In [`src/listener/runtime.ts:L112-L124`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts#L112-L124), `isCredentialLoss` handles `CommandHttpError` strictly by status (401/403), returning immediately without delegating to message-based matchers.

2. **Catch Order & Adjudication Priority:**
   - In [`src/listener/runtime.ts:L286-L302`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts#L286-L302) and [`L341-L354`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts#L341-L354), runtime checks `abort?.aborted` first, `isCredentialLoss(error)` second, and name-only `isAbort(error)` third.
   - Explicit caller cancellation takes precedence over concurrently surfaced credential errors.

3. **Classifier Safety & Defect Isolation:**
   - In [`src/listener/engine.ts:L468-L479`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts#L468-L479), if the injected `isCredentialFailure` classifier throws, the engine catches `classifierError`, restores `reply_ready` with `failureCode: null`, and rethrows `classifierError`. The record is never left stranded in `"posting"`.

4. **Strict Name-Only Cancellation (`isAbort`):**
   - In both [`src/listener/engine.ts:L157`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts#L157) and [`src/listener/runtime.ts:L103`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts#L103), `isAbort` is implemented strictly as `error instanceof Error && error.name === "AbortError"`. Substring matching (`/aborted|cancelled/i`) has been completely removed.

5. **Poster AbortSignal Forwarding:**
   - In [`src/listener/runtime.ts:L178-L191`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/runtime.ts#L178-L191), default poster accepts `abortSignal` and forwards it directly as `signal` in `client.sendSignal`. The command payload structure is unaffected and no secondary signal is instantiated.

6. **State & Field Preservation:**
   - In [`src/listener/engine.ts:L453-L457`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts#L453-L457) and [`L481-L485`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/src/listener/engine.ts#L481-L485), record updates spread `...record` while overriding only `state: "reply_ready"` and `failureCode: null`. `replyBody`, `commandId`, `replyTruncated`, `replySignalId`, and the already-incremented `postAttempts` are preserved intact.

7. **Contract & Test Coverage:**
   - All contract requirements specified in `RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md` are backed by corresponding unit tests in [`tests/listener-engine.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/tests/listener-engine.test.ts) and [`tests/listener-runtime.test.ts`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/deepseek-runtime-reply-pi/tests/listener-runtime.test.ts).
   - No unnecessary code modifications or scope creep were introduced in the delta.

---

### Findings

- **CRITICAL Findings:** None.
- **MAJOR Findings:** None.
- **MINOR Findings:** None.

---

### Verdict

**VERDICT:** PASS

**NOT VERIFIED:**
1. Live network interaction with remote cloud command endpoints or AI provider services.
2. Production DB persistence or durable Runtime C/D composition pipelines beyond the memory store.
3. End-to-end CLI execution or package build/release distribution.
