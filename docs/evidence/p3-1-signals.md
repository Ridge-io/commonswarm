# P3-1 signal-plane evidence

**Brief:** `docs/design/P3-1-SIGNALS-BRIEF.md` v1.3  
**Implementation:** Phase B, Quill, 2026-07-24  
**Rate constants:** provisional v1 values — 120 signals/hour/credential and
1000 signals/hour/workspace. Revisit after dogfood; the local auto-bridge is
out, so these limits cover intentional posts only.

## Collapse-test map (G8)

Every shipped deliverable must preserve at least one reason this is not “just
Slack,” and authorship must remain an auditable principal rather than a display
label.

| # | Deliverable | Agent-addressable | Machine-queryable | Tenancy-scoped | Survives session death | Auditable principal |
|---|---|---:|---:|---:|---:|---:|
| 1 | Private `swarm.signals` + `swarm_read.signals` | ✓ directed owner inbox is readable by an agent | ✓ stable typed columns and filters | ✓ `is_member` plus address narrowing | ✓ durable append-only row | ✓ `from_principal`/`from_kind`, never a label |
| 2 | `post_signal` direct command branch | ✓ human and agent credentials post | ✓ one typed command/receipt | ✓ common route + live-target recheck | ✓ atomic signal + idempotency ledger | ✓ server binds `canonicalPrincipal(auth.actor)` and audits |
| 3 | Five CLI verbs, all with `--json` | ✓ non-interactive agent mode | ✓ JSON posts, feeds, and inboxes | ✓ P2-2 workspace resolution | ✓ remote rows outlive the CLI | ✓ no `--from` grammar |
| 4 | Plain rendering and worded empty states | ✓ agent output remains parseable with `--json` | ✓ body is quoted data | ✓ only authorized rows reach rendering | ✓ expired history remains renderable | ✓ principal UUID remains visible |
| 5 | Credential/workspace rate fairness | ✓ every agent token has its own bucket | ✓ explicit 429 fields | ✓ independent workspace cap | ✓ server bucket survives caller death | ✓ bucket/audit carry credential identity |
| 6 | README | ✓ documents non-interactive post/poll | ✓ documents JSON/query flags | ✓ documents explicit agent workspace | ✓ documents durable retry/horizons | ✓ documents server-bound author |
| 7 | Agent Edge read proxy | ✓ supplies FLOOR item 2’s poll half | ✓ bounded signal/member reads | ✓ executes owner-pinned read views under derived `auth.uid()` | ✓ polling reconstructs state after restart | ✓ owner/principal derive from the token row |
| 8 | Agent durable pending `command_id` | ✓ mint/seed artifacts carry the stable principal | ✓ closed JSON artifact + hashed intent | ✓ workspace is in the intent | ✓ principal-scoped pending id survives token rotation for a one-hour recovery window | ✓ server ledger remains principal-namespaced |
| 9 | Narrow `post_signal` agent scope | ✓ permits precisely the signal post | ✓ scope is explicit token data | ✓ existing agent workspace binding remains | ✓ minted/fixture tokens carry the scope | ✓ scope check uses the authenticated token |

No deliverable is ornamental under this test; none is cut.

## Seam evidence

- A signal uses the workspace stream only as the non-null routing identity for
  `swarm.idempotency_keys`.
- The `post_signal` branch returns before the stream `FOR UPDATE`; it never
  calls `decide()`, `decideWorkspace()`, either reducer, event append,
  projection update, head bump, or event side effects.
- The migration grants the private table only `SELECT, INSERT` to
  `swarm_command`, enables RLS, and adds the append-only trigger. The exposed
  view is owner-pinned, a security barrier, explicitly granted to
  `authenticated, swarm_read`, and denied to anon.
- `swarm.inbox_deliveries` remains deliberately unused. The v1 inbox is a
  query; no delivery/ack semantics were imported.
- `src/protocol/` is unchanged. Rebuilding
  `supabase/functions/_shared/protocol.js` produces zero tracked bundle diff.

## Launch gates

| Gate | Evidence |
|---|---|
| G1 tenancy | Server integration posts a positive-control W1 row, reads it as a W1 member, then proves a W2-only human gets zero W1 rows. |
| G2 server-bound author | Human and agent requests with `from` inside the command and at top level each return 400, add zero rows, and write an explicit validation audit naming `from`. The audit query is scoped to this scenario's ephemeral user, agent principal/token, and workspace-or-envelope-null shapes rather than counting global post-signal audits. Clean rows store the verified user or agent principal. |
| G3 untrusted body | Server integration stores a prompt-injection string while stripping ANSI, non-whitespace C0/C1 controls, bidi controls, zero-width/invisible format characters, BOM, and the Unicode Tag block before storage. C0 whitespace and line/paragraph separators collapse to one space so immutable text does not glue words. CLI rendering quotes it; JSON returns it as data. Residual: downstream model consumers must preserve the data/instruction boundary. |
| G4 rate/fairness | A valid directed post positively proves both buckets increment; a dead target before and after that control leaves both counts unchanged. Buckets are then preloaded to their boundary: human 120 succeeds and 121 refuses while its agent token still succeeds; workspace 1000 succeeds and 1001 refuses. Both refusals name the limit and reset. |
| G5 read canary | Local integration posts and reads the same row in one test before either isolation assertion. Hosted deployment canary must repeat post-then-read after migration/function deployment; the pre-deploy schema exposure control is 401/42501, not 406/PGRST106. |
| G6 idempotency | Same agent `command_id` is posted twice; both receipts match and SQL counts one semantic signal row rather than counting by its primary key. CLI tests preserve the same principal-scoped pending id across transport failure, gateway 5xx, and bearer/token-id rotation; definitive 4xx clears it; an intent at the one-hour recovery boundary receives a fresh id. |
| G7 staleness | A 1ms signal becomes absent under the default `until > now` query and remains present without that filter; rendering marks it `(expired)`. No cron runs. |
| G8 collapse test | The nine-row map above covers all deliverables and all five differentiating properties. |
| G9 agent workspace | Each of the five agent signal verbs fails before I/O when neither flag nor environment supplies a workspace; no human profile default is read. |
| G10 agent read proxy | Agent positive-control polling returns the owner-visible broadcast and an owner-addressed inbox row, while excluding a row addressed to another member; a request for another workspace returns zero; revoked token returns 403. The endpoint imports the command path’s shared token/revocation helper, changes to `swarm_read`, sets claims from the credential-derived owner, and selects the view rather than the private table. The pre-view `principal_workspace_id` equality gate is load-bearing: without it, the derived owner claim could expose a second workspace held by that human but not by the agent principal. |

## Durable run evidence

- `run-001`: additive migration applied locally.
- `run-020`: clean single-runtime server suite 16/16, including all new signal
  command/read/rate
  gates and all prior command/connect gates.
  A separate reviewer run first returned 13/16 because the local Edge runtime
  produced three HTTP 502 responses under load, then returned 16/16 unchanged
  twenty seconds later. This is the infrastructure flake recorded at
  `b3964cd`, distinct from the acquire-path assertion-shaped flake: the 502
  status is the diagnosis. A captured green run establishes the gate, but any
  red run must be read from its full log before it is attributed to product
  logic.
- `run-010`: CLI suite 62/62, including signal transport, principal-stable
  pending IDs across token rotation, one-hour recovery expiry, separate
  0700/0600 agent state, closed mint/seed credential artifacts, reads,
  rendering, recipient resolution, all-five-verb JSON grammar, and agent
  workspace fail-closed checks.
- `run-014`: pure core suites 66/66.
- `run-015`: TypeScript build clean.
- `run-017`: local database lint reports no schema errors across `swarm` and
  `swarm_read`.
- `run-018`: zero diff under `src/protocol/` and the generated command-core
  bundle.
- `run-021`: static read-proxy authority check confirms the
  `principal_workspace_id` gate, derived owner claim, `swarm_read` role/view,
  and absence of a copied membership predicate or private signal-table read.
- `run-022`: controlled B1 red leaves the invisible Unicode classes in the
  stored signal; the expanded sanitizer gate fails. Restoring the write-time
  sanitizer makes the focused server test green.
- `run-023`: controlled B2 red keys the CLI pending intent to the bearer; the
  rotated artifact creates two pending records instead of one. Restoring the
  principal identity makes the focused test green.
- `run-024`: controlled B3 red disables the one-hour purge; the boundary test
  reuses the expired command id and fails. Restoring the recovery window makes
  it green.
- `run-025`: controlled B4 red routes agent pending state through the human
  credential-store selector; the test's disabled file fallback forces the
  loud degraded path and fails. Restoring the dedicated agent store makes it
  green.
- `run-026`: controlled B5 red restores the unvalidated override shortcut;
  the foreign/unknown workspace test observes a false success. Restoring live
  validation makes it green.
- `run-027`: controlled C13 red deletes newline/tab separators; the immutable
  storage assertion observes `reviewsee` rather than `review see`. Restoring
  whitespace collapse makes it green.
- `run-028`: controlled C14 red restores rejecting `Promise.all`; one failed
  supplementary signal read hides core status and the degradation test fails.
  Restoring independent settlement makes it green.
- `run-029`: controlled C16 red removes the end-of-options marker; a
  dash-prefixed body is parsed as an invalid option and the subprocess test
  fails. Restoring standard `--` parsing makes it green.
- `run-030`: controlled C17 red treats only socket/timeout errors as
  ambiguous; the 504 path loses retry guidance and clears its pending id.
  Restoring 5xx ambiguity handling makes it green.
- `run-031`: the G2 audit assertion filters on this scenario's ephemeral
  actor, exact agent token/principal, validation outcome/reason, and the
  workspace-or-envelope-null shapes before asserting its four rows. Unrelated
  concurrent post-signal audits cannot turn a correct run red.

The hosted G5 post/read canary is intentionally not claimed before the linked
migration and Edge functions are deployed. Never use `supabase config push`;
the schema is already exposed and only a surgical `NOTIFY pgrst, 'reload
schema'` is appropriate if PostgREST’s cache is stale.

## Residuals

- Hosted G5 remains unclaimed: no positive post-then-read canary has run
  against the hosted project. Landing this reversible code is separate from a
  live migration/function deploy; the latter requires operator coordination.
- Local integration has two distinct intermittent infrastructure modes:
  acquire-path timing can produce an assertion-shaped mismatch, while Edge
  runtime overload produces diagnostic HTTP 502 responses. Full gate output
  must be captured and the status read before attributing either red run to
  product logic.
- Durable agent pending requires the closed mint-shaped JSON artifact. A
  legacy bare `swm_agt_` credential keeps the pre-slice behavior: it posts
  with a random ephemeral command id and prints a warning that an ambiguous
  retry may create a visible duplicate. The degraded-state path makes the
  same visible-failure choice; neither path uses a deterministic id that
  could silently swallow a deliberate repost.
- The durable bag is per cloud target and stable agent principal, separate
  from the human credential/profile store. Two concurrent agents using
  different tokens for the same principal and posting byte-identical content
  in the same one-hour recovery window therefore share one command id. This
  deliberately favors recovery across token rotation over concurrent-agent
  separation; keying by token id would reopen the rotation failure.
- The one-hour horizon is a recovery window measured from the first attempt,
  not a promise tied to the presenting token's remaining lifetime. A later
  deliberate identical post gets a fresh command id rather than replaying an
  old receipt.
- Human signal post/read commands validate explicit workspace overrides
  against the live membership list and use the existing byte-uniform
  `WorkspaceUnavailableError` for foreign and unknown ids. The agent
  foreign-workspace read remains the deliberately held 200-empty
  non-enumerating contract.
- G3 proves sanitized storage, quoted terminal rendering, and JSON encoding.
  It cannot prove how a downstream skill or model consumer treats the data.
