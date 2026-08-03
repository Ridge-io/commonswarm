# Runtime A2 causal controls — Vellum result

Frozen object: `ab1b240334efc62b50027512f64692e15d0e0752`  
Focused command used on every test run:

```sh
node --import tsx --test --test-timeout=8000 \
  tests/listener-engine.test.ts tests/listener-runtime.test.ts
```

## Preflight and baseline

The effective preflight passed: HEAD and the local remote-tracking ref both resolved to the frozen
SHA, the branch was `deepseek/runtime-reply-deadline-pi`, and `git status --porcelain=v1` was empty.
No fetch was run. An initial shell wrapper failed before reaching its assertions because `status` is
a read-only zsh parameter; it changed no repository state and was not treated as evidence.

Baseline printed `tests 38`, `pass 38`, and `fail 0` with exit code 0.

## Control 1 — engine credential classifier disabled

Mutation applied in `src/listener/engine.ts`:

```diff
-    this.isCredentialFailure = options.isCredentialFailure;
+    this.isCredentialFailure = undefined;
```

The runner printed these named failures:

- `post credential-classified errors restore exact reply_ready and rethrow by identity`
- `credential errors whose message contains cancelled are escapes, never aborts`
- `a throwing credential classifier restores the record and rethrows its own exception`

It did **not** print final `tests` / `pass` / `fail` counts or terminate. The engine file completed,
but the runtime file remained alive beyond the mandatory per-test timeout. Two residual processes
were measured:

- the combined `node --import tsx --test --test-timeout=8000 ...` parent;
- its `tests/listener-runtime.test.ts` child, also carrying `--test-timeout=8000`.

Therefore this control does **not** meet acceptance. It printed three named engine failures, which
shows partial engine-side discrimination, but the whole-run hang is a failure of the control and is
not a causal result for the combined focused suite.

Restore and cleanup:

- Ran `git checkout -- src/listener/engine.ts`.
- Post-restore `git status --porcelain=v1`: empty.
- Post-restore HEAD: `ab1b240334efc62b50027512f64692e15d0e0752`.
- Residual focused-test processes immediately after restore: 2.
- After resolving their exact PIDs and command lines and sending `SIGTERM`: 0.

## Control 2 — message cancellation checked before credential

Not run. The Control 1 whole-run hang and surviving processes triggered the goal's stop conditions.
No mutation was applied to `src/listener/runtime.ts`; no counts or failing-test names were
established. This control's discrimination was not established.

## Control 3 — poster caller-signal forwarding removed

Not run for the same stop condition. No mutation was applied to `src/listener/runtime.ts`; no
counts or failing-test names were established. This control's discrimination was not established.

## Final state and evidence ceiling

- HEAD remained `ab1b240334efc62b50027512f64692e15d0e0752`.
- Product-code status was restored clean; this report is under gitignored `scratchpad/`.
- Residual focused-test process count was 0 after cleanup.
- No merge, rebase, push, tag, fetch, database, Supabase, edge-function, deploy, release, full-suite,
  broadcast, or `AdvisorClaude2` contact occurred.

These controls did not establish accepted discrimination for Control 1 or any discrimination for
Controls 2 and 3. They say nothing about Runtime C/D composition, the durable server, deployment,
or production.
