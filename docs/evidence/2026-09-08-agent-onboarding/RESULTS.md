# Agent onboarding implementation — 2026-09-08

Status: local working changes based on main `042afa63b965f43637561277090c02a921c3a1a7` (0.1.64). Not committed, pushed, deployed, or released. No subagents or model review arms were started, as the user required. D-036 review is still required before a later landing. The release bundle retains the existing version; it is a local test artifact only.

## What changed

- One short handoff prompt; optional JSON setup-file download. Inline handoff remains available. The form has one normal field (agent name); key lifetime is inside closed Key settings. No new field is required.
- `cswarm setup` imports a versioned connection envelope, checks full authenticated identity and paging support, and stores a private profile outside git. Credentials retain the existing parser, renewal system, and secure storage. Setup reports whether messages are pending; `cswarm check` reads them before work.
- `--profile` supplies connection flags for supported commands. Host IDs select only a matching managed context; they never borrow another session's proof. `resume --profile` reuses local settings and explicitly does not claim a fresh authentication check.
- Standalone `check` works without a listener. Hook/manual/resume checks share a cursor. Equal timestamps use a cursor with an ID; pages and message previews are bounded. Full text is retained in a bounded private cache. Output failure does not consume messages. Quiet success prints nothing; a failed check is not called an empty inbox.
- Receive mode is saved per profile and host session. Claude and Codex hooks preserve other handlers and require matching host input and directory. Until a hook runs, status says pending. Hosts without hooks use an instruction fallback. Turn mode has no background renewal process.
- Claude wake uses a host-owned MCP stdio channel with the documented preview opt-in. It never starts a model. It uses existing durable delivery claims, Realtime hints, and server ACKs. A notification alone is not receipt. The exact pending nonce and same-session receipt are required. Idle canary proof is cleared on restart, mode switch, and transport failure. Configuration and heartbeat use the same state lock.
- The installer fetches the published checksum first and skips the binary download when local bytes match. Damaged bytes and a changed build are replaced; malformed checksums fail closed.

The local profile and channel journal hold host configuration, cursors, and replay state. Postgres delivery rows remain authoritative. This patch adds no server schema, edge function, new worker, or cross-machine preference field. The web app's existing agent-connection status is unchanged; per-session receive proof is available through `cswarm receive status` and is not published to the web roster.

## Claims corrected

The retired entry guide instructed installation of ACP bridges and a “local Claude worker.” The replacement connects the current session. The retired “note … does NOT wake anyone” statement is removed: eligible directed notes and asks can reach a configured receiver. Reading comes before posting work intent. Turn checks are a valid choice without a listener. No state calls wake verified before its idle receipt test.

## Verification

| Gate | Result |
| --- | --- |
| `npm test` | 869 passed |
| `npm run test:p1-cli` | 572 passed |
| `npm --prefix site test` after clean build | 541 passed, 1 skipped, 0 failed |
| `npm run build` and `npm run check:tests` | Passed |
| `scripts/build-release.sh` | Exit 0; artifact was executed by the build script |
| Standalone artifact outside git, without adjacent node_modules | 18 onboarding/channel/installer tests passed |
| Desktop, phone, file handoff render | Inspected local built HTML with current CSS; screenshots beside this file |

The new tests are in `tests/p1-cli/` and run through that package script's glob. They are not silently assumed to be part of the literal `npm test` list. The final channel identity/restart fixes were followed by build, typecheck, release build, and all 18 focused tests against the standalone artifact. No edge or database code changed, so database and edge suites were not run.

A concurrent earlier CLI run failed an existing four-second hook timing assertion at 4.21 seconds. Running the full CLI suite without the site browser suite passed. No timing assertion was weakened. An earlier main-suite tight timing check also passed on its isolated rerun. The site skip is the suite's existing `baseline audit prints common rendered geometry` skip, not a new excluded test.

## Measurements

`benchmark.json` records ten compiled-CLI loopback trials, with the same synthetic credential shape for both prompt versions. Tokenizer: tiktoken 0.14.0, `o200k_base`.

- Old entry prompt: 4,059 tokens.
- Attached-file prompt: 269 tokens, 93.4% less (about 15× smaller).
- Inline prompt including connection data: 598 tokens, 85.3% less (about 7× smaller).
- Warm local setup/configure/check takes about 0.31 seconds median. These are loopback fixture measurements, not production or model timing.

The old review used a shorter synthetic public key and a characters/4 estimate. Its 13,426 characters and estimated 3,357 tokens are not the later tokenizer baseline. The later baseline uses a representative longer public key and measures 14,917 characters. The benchmark's character reduction and token reduction are separate measures.

Run `npm run benchmark:onboarding` after `npm run build`. To include token counts, set `CSWARM_TOKENIZER_PYTHON` to a Python executable with tiktoken. The script checks the baseline source dependencies before comparing prompts.

## Not established / next release gates

No live Claude or Codex session was started, no hook trust approval was exercised in a real host, and no production credential or test workspace was used. The stdio test uses an MCP client fixture that sends host events and receipts; it does not prove a model sees an idle event. Claude wake is therefore preview-only and unverified until a real same-session test succeeds. Codex idle wake is unavailable.

The requested end-to-end 10× speed/token goal, ten live trials per host/mode, long-idle renewal, and baseline completion-rate comparison remain unmeasured. No overall 10× claim is made. Quiet empty checks do perform network I/O; local instruction fallback incurs a model tool call. The measured quiet CLI check is about 0.11 seconds, above the proposal's 100 ms local-fast-path target.

The live workspace brain could not be read because the available default login could not refresh; no agent credential was supplied. Reconcile `brain-how-to`, `listener-attended`, `agent-restart`, and `releases` before release. A future release must obtain its D-036 reviews, run live host controls, publish the CLI before the site prompt advertises the new commands, and verify production. No global CLI install or production mutation was performed here.

## Cleanup

Ran `scripts/branch-audit.sh` before cleanup. Its nonzero result identifies pre-existing branches with unique work; it is not a test failure. Preserve all pre-existing branches and the three pre-existing worktrees (`spec/app-backlog`, `lane/identity-handoff-astra-20260907`, `lane/agent-identity`). The task's `lane/onboarding-20260908` has no commits beyond the base. Its complete diff is applied to the main working tree, then its worktree and branch are removed. The task's static fixture server, temporary artifact/tokenizer, and unused dependency backup are removed. This is not a release cleanup of other agents' lanes.
