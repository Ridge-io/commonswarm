# Review: CLI Surface & Host Model Reachability Audit, Dead Model Pruning, and Main Import Guard

**Lane:** `lane/cli-surface`  
**Repository:** `Ridge-io/cloud-swarm`  
**Base Commit:** `92594ec` (v0.1.63)  
**Date:** 2026-09-06  

---

## 1. Context & Objectives

This change fulfills two sequential objectives for the `cli-surface` area:

1. **Dead Model Code Mapping, Audit, & Pruning**:
   Since CommonSwarm 0.1.61, the listener runtime never starts an ACP model subprocess (`newModel()` in `src/cli.ts:5947-5950` returns `NullListenerModel` unconditionally). The task is to map every entry point from `src/cli.ts` and `src/listener/` into `src/host/{claude,codex,opencode,grok}.ts` and `src/listener/*-model.ts`, recording `file:line -> reachable yes/no and WHY`.
   - Delete only what nothing in production can reach, together with its dedicated tests.
   - Preserve everything that is reachable (e.g. `inspectClaudeBridgeExecutable` for provider install evidence, `classifyClaudeCanaryFailure` shared canary classifier, and executable resolvers `resolveClaudeExecutable`, `resolveCodexExecutable`, `resolveOpenCodeExecutable`) to ensure the shipped CLI is never broken.
   - Retain `src/listener/grok-model.ts` because it is imported by cross-lane test suites (`tests/listener-control.test.ts:12`) outside the ownership scope of `cli-surface`.
   - Retain test coverage for `classifyClaudeCanaryFailure` by migrating the canary classifier unit tests from `tests/listener-claude-model.test.ts` into a dedicated test file `tests/listener-claude-canary-classify.test.ts`.

2. **Side-Effect Free Import of `src/cli.ts`**:
   `main()` previously executed immediately on module load at `src/cli.ts:8572`. Guard `main()` so that importing `src/cli.ts` produces no side effects (no CLI commands run, no output written to stdout/stderr, `process.exitCode` unmodified), while ensuring direct execution continues to work seamlessly across both ESM development/testing and the single-file CommonJS release bundle (`dist-release/cswarm`). Add a dedicated test in `tests/p1-cli/` asserting that importing `src/cli.ts` runs nothing.

---

## 2. File:Line Entry Point Mapping

The following catalog maps every potential entry point from `src/cli.ts` and `src/listener/` targeting `src/host/{claude,codex,opencode,grok}.ts` and `src/listener/*-model.ts`:

| Source File:Line | Target Module & Symbol | Reachable? | Reason / Runtime Path |
| :--- | :--- | :---: | :--- |
| `src/cli.ts:354`<br>Call: `src/cli.ts:5509` | `src/listener/claude-canary-classify.ts`<br>`classifyClaudeCanaryFailure` | **YES** | Imported statically into `src/cli.ts:354`. Called at `src/cli.ts:5509` in `listenerFailureMessage(...)` when `code === "permission_canary_failed"` and `provider === "claude"`. Formats human-readable diagnostics for canary failures in `renderListenerStatus` (`cswarm listen status`, line 5160), `resolveDetachedClaudeExecutable` (line 5589), and `runListenStart` (lines 6309, 6328). Extracted to keep ACP host subprocess modules off the static session command import graph (`tests/p1-cli/session-interactive-nospawn.test.ts`). |
| `src/cli.ts:361-363`<br>Call: `src/cli.ts:4845` | `src/host/claude.ts`<br>`inspectClaudeBridgeExecutable` | **YES** | `loadHostClaude()` dynamically imports `./host/claude.js`. Invoked in `listenerProviderInstallEvidence(status: ListenerStatus)`. Called by `runListenQuery` at line 6548 when running `cswarm listen status` on a Claude provider listener. Probes local bridge executable, inspects bundled agent SDK and Claude Code versions, and renders install evidence. |
| `src/cli.ts:361-363`<br>Call: `src/cli.ts:5575` | `src/host/claude.ts`<br>`resolveClaudeExecutable` | **YES** | `loadHostClaude()` dynamically imports `./host/claude.js`. Invoked in `resolveDetachedClaudeExecutable(executable, pathEnv)`. Called by `runListenStart` at line 6233 when `cswarm listen start --provider claude --claude-executable <path>` is run. Validates executable path and permissions. Verified by `tests/p1-cli/listener-provider.test.ts` and `tests/p1-cli/release-bundle.test.ts`. |
| `src/cli.ts:365-367`<br>Call: `src/cli.ts:5601` | `src/host/codex.ts`<br>`resolveCodexExecutable` | **YES** | `loadHostCodex()` dynamically imports `./host/codex.js`. Invoked in `resolveDetachedCodexExecutable(executable, pathEnv)`. Called by `runListenStart` at line 6237 when `cswarm listen start --provider codex --codex-executable <path>` is run. Ensures the binary is the `codex-acp` bridge and not the raw `codex` CLI. |
| `src/cli.ts:369-371`<br>Call: `src/cli.ts:6229` | `src/host/opencode.ts`<br>`resolveOpenCodeExecutable` | **YES** | `loadHostOpenCode()` dynamically imports `./host/opencode.js`. Invoked in `runListenStart` at line 6229 when `cswarm listen start --provider opencode --opencode-executable <path>` is run. Validates executable path and permissions. |
| `src/cli.ts:5947-5950` | `src/listener/runtime.ts`<br>`NullListenerModel` | **YES** | `newModel()` unconditionally instantiates `new NullListenerModel()`. The listener claims into `pending-for-main.json` and does not spawn a model. |
| `src/cli.ts` (any) | `src/host/grok.ts`<br>(all exports) | **NO** | `src/cli.ts` does NOT import or load `src/host/grok.ts`. In lines 6197-6198 and 6264-6265, `--grok-executable` is passed unvalidated to the child process spec. Tested directly via `tests/host-acp-grok.test.ts` and `tests/host-version-floor.test.ts`. |
| `src/cli.ts` (any) | `src/listener/*-model.ts`<br>(all classes) | **NO** | `src/cli.ts` imports none of the listener model classes. `newModel()` returns `NullListenerModel`. |
| `src/listener/grok-model.ts:9,80`<br>Call: line 145 | `src/host/grok.ts`<br>`openGrokAcpSession` | **NO (in prod)**<br>**YES (in tests)** | `src/listener/grok-model.ts:9` imports `openGrokAcpSession`. In constructor line 80, `this.openSession = options.open ?? openGrokAcpSession`. In `ensureWorker()` line 145, `this.openSession` is invoked. Unreachable in CLI runtime, but `GrokListenerModel` is imported and used by `tests/listener-control.test.ts:12` and `tests/host-version-floor.test.ts:40`. |
| `src/listener/index.ts` | `src/listener/*-model.ts`<br>`src/host/*.ts` | **NO** | `src/listener/index.ts` does NOT re-export any `*-model.ts` or `src/host/*.ts` files. |
| `src/listener/{runtime,supervisor,control,detach,engine,activity,hook}.ts` | `src/host/{claude,codex,opencode,grok}.ts`<br>`src/listener/*-model.ts` | **NO** | Core listener modules do not import provider host modules or model classes; they only import shared host utilities (`bounds.js`, `types.js`, `credential-redaction.js`, `env.js`, `sanitize.js`). |

---

## 3. Deletions and Preservations (Piece 1)

### What Was Deleted
The following dead model modules and their dedicated test suites had zero production importers and zero cross-lane test consumers:
1. `src/listener/claude-model.ts` and `tests/listener-claude-model.test.ts`:
   - `ClaudeListenerModel` was completely unreferenced in production code.
   - The permission canary failure classification assertions (`tests/listener-claude-model.test.ts:35-78`) were preserved and moved to `tests/listener-claude-canary-classify.test.ts`, importing directly from `src/listener/claude-canary-classify.ts`.
2. `src/listener/codex-model.ts` and `tests/listener-codex-model.test.ts`:
   - `CodexListenerModel` had zero production references and zero external test consumers.
3. `src/listener/opencode-model.ts` and `tests/listener-opencode-model.test.ts`:
   - `OpenCodeListenerModel` had zero production references and zero external test consumers.
4. `package.json`:
   - Literal test list under `"test"` was updated: removed the 3 deleted test files and added `tests/listener-claude-canary-classify.test.ts`.

### What Was Preserved
1. **Reachable Host Exports & Dynamic Loaders**:
   - `inspectClaudeBridgeExecutable` in `src/host/claude.ts`: Required for `cswarm listen status` provider install evidence.
   - `resolveClaudeExecutable`, `resolveCodexExecutable`, and `resolveOpenCodeExecutable`: Required for explicit `--*-executable` validation on `cswarm listen start`.
   - `loadHostClaude()`, `loadHostCodex()`, and `loadHostOpenCode()` (lines 361-371 of `src/cli.ts`): Required for esbuild to inline host modules into the CJS bundle while keeping them off the static session graph (`tests/p1-cli/session-interactive-nospawn.test.ts`).
   - Line numbers in `src/cli.ts` (lines 354, 361, 365, 369, 5575, 5601, 6229) are strictly pinned by `tests/p1-cli/citation-drift.test.ts`. All lines before line 6300 remain completely untouched.
2. **`classifyClaudeCanaryFailure` in `src/listener/claude-canary-classify.ts`**:
   - Imported directly by `src/cli.ts:354` for canary diagnostic failure formatting. Retains full unit test coverage via `tests/listener-claude-canary-classify.test.ts`.
3. **`src/listener/grok-model.ts`**:
   - Imported by `tests/listener-control.test.ts:12` (owned by listener/control, outside `cli-surface` scope) and `tests/host-version-floor.test.ts:40`.
   - Deleting `src/listener/grok-model.ts` would break `npm test` with `ERR_MODULE_NOT_FOUND` and violate repo ownership boundaries. Therefore, `grok-model.ts` and `tests/listener-grok-model.test.ts` are preserved.
4. **`src/host/grok.ts`**:
   - Exported by `src/host/index.ts` and verified by `tests/host-acp-grok.test.ts` and `tests/host-version-floor.test.ts`. Preserved.

---

## 4. Piece 2: Side-Effect Free `src/cli.ts` Import

### Implementation
In `src/cli.ts`:
1. `realpathSync` was added to the existing `node:fs` import on line 5 (preserving line count and position).
2. `fileURLToPath` was imported from `node:url` at line 8572 (after all pinned citation lines, preserving lines 1 to 6300 for `tests/p1-cli/citation-drift.test.ts`).
3. `isCliMain(): boolean` was exported:
   ```ts
   export function isCliMain(): boolean {
     if (
       typeof require !== "undefined" &&
       typeof module !== "undefined" &&
       require.main === module
     ) {
       return true;
     }
     if (!process.argv[1]) return false;
     try {
       const script = realpathSync(process.argv[1]);
       const modulePath = realpathSync(fileURLToPath(import.meta.url));
       return script === modulePath;
     } catch {
       return false;
     }
   }
   ```
4. Top-level `main().catch(...)` was wrapped in `if (isCliMain()) { ... }`.

### Dual-Format Compatibility
- **CommonJS Release Bundle (`dist-release/cswarm`)**:
  Bundled by esbuild with `--format=cjs`. In this artifact, esbuild emits `var import_meta = {}`, so `fileURLToPath(import.meta.url)` cannot be used. Direct execution relies on the standard Node.js CommonJS idiom `require.main === module`, which evaluates to `true` when the bundle is run directly as the entrypoint. When required programmatically, `require.main === module` is `false`.
- **ESM / Development / Direct Node & TSX**:
  When run via `node dist/cli.js`, `npx tsx src/cli.ts`, or `node --import tsx src/cli.ts`, `require.main` is undefined or not the module. `process.argv[1]` is canonicalized via `realpathSync` and compared against `realpathSync(fileURLToPath(import.meta.url))`, which matches when invoked directly as a script.
- **Module Imports**:
  When imported by another module (e.g. `await import("../../src/cli.js")` in tests), `process.argv[1]` points to the test runner rather than `src/cli.js`, and `require.main === module` is false, so `isCliMain()` returns `false` and `main()` never executes.

### Verification Test
A new test was added at `tests/p1-cli/cli-import-no-run.test.ts`:
- Dynamically imports `../../src/cli.js`.
- Asserts `isCliMain()` returns `false`.
- Asserts that stdout and stderr received 0 bytes of output.
- Asserts that `process.exitCode` remains unmodified.

---

## 5. Verification Gates

All required gates were executed on `lane/cli-surface` and passed cleanly:

| Gate | Command | Result |
| :--- | :--- | :--- |
| Build | `npm run build` | **Exit 0** (`dist/cli.js` built and chmod 755) |
| TypeScript Source | `npx tsc --noEmit -p tsconfig.json` | **Exit 0** (0 errors) |
| Test Typecheck | `npm run check:tests` | **Exit 0** (`tsc -p tsconfig.tests.json` 0 errors) |
| Citation Drift | `npx tsx tests/p1-cli/citation-drift.test.ts` | **Pass** (1/1 passed, 0 drift) |
| Gate Coverage | `npx tsx tests/p1-cli/test-gate-coverage.test.ts` | **Pass** (3/3 passed) |
| Pure CLI Suite | `env -u FORCE_COLOR npm run test:p1-cli` | **Pass** (554/554 passed, 0 failures) |
| Unit Test Suite | `npm test` | **Pass** (869/869 passed, 0 failures) |
| Release Bundle | `bash scripts/build-release.sh` | **Exit 0** (verified by running artifact v0.1.63) |
| Commit Identity | `scripts/check-commit-identity.sh origin/main..HEAD` | **Exit 0** (2 address-fields OK) |
