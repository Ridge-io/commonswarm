# Adversarial review task

You are an adversarial reviewer. You have shell access. Work ONLY inside this directory
(a read-only git worktree of the CommonSwarm repo at `origin/main` = `d57d480`). Change no files.

**Target of review:** `docs/design/2026-09-04-chat-platform-reconciled.md` in this directory.

It is a DESIGN-ONLY spec. It reconciles two earlier drafts that contradicted each other:
- Draft A: `git show spec/streams-dms-threads:docs/design/2026-09-04-streams-dms-threads.md`
- Draft B: `git show lane/chat-platform-spec:docs/design/2026-09-04-CHAT-PLATFORM.md`

Draft A already survived two adversarial arms; draft B had none. The reconciled spec rules on each
conflict and says which draft won. Your job is to break the reconciled spec, not to praise it.

## What you must do

1. **Check EVERY citation.** Open the file at the cited `path:line` and confirm the quoted text and the
   claim it supports. Report every citation that is wrong, off by lines, or supports a different claim
   than the spec says it does. Be specific: give the cited ref, what is actually there, and what the
   correct ref is if one exists. A citation that is merely off by a line or two is still a finding, but
   say so and rank it lower than a substantive error.

2. **Find the migration or RLS case that breaks.** The spec's §3 has three migration files and §5 has one
   new view clause. Attack them. In particular:
   - Is `channel_id` really safe as a nullable column with no backfill, against the CURRENTLY DEPLOYED
     command edge function (which names its insert columns explicitly)? Find a case where it is not.
   - Is the reverse direction handled — a new edge function deployed against a database where the
     migration has NOT applied?
   - The spec recreates `swarm_read.signals` twice. Does anything it says about `CREATE OR REPLACE VIEW`
     hold? Is its claimed protection real? What can still go wrong silently?
   - New clause (e) adds `s.from_principal = auth.uid()` (plus an owned-agent arm) to the view. Find a row
     it discloses that should not be disclosed. Consider: agents reading through
     `supabase/functions/read/index.ts` (note how that function sets `request.jwt.claims`), the delivery
     receipt views, the attachments subquery in the view, and the composite-FK / tenant-pinning idiom.
   - Does the spec's index list actually serve the queries it proposes? Name any query with no index.

3. **Answer explicitly: "would the first slice leave old clients working?"** The spec's first slice is
   §6 P1 (public channels). Enumerate the client surfaces (CLI read, CLI write, browser read, browser
   write, agent read edge, agent write) and for each say YES or NO with the code citation. If any is NO,
   that is a FAIL.

4. **Attack the three central rulings.** For each, either confirm it with your own measurement or refute
   it with a citation:
   - **R2 (threads):** the spec claims `in_reply_to` means "reply privately to the author", NOT a public
     thread, and that draft B's proposed normalisation `in_reply_to := COALESCE(parent.in_reply_to,
     parent.id)` would silently change who receives a reply. Read
     `supabase/functions/command/index.ts` around the post_signal validator and around
     `resolveSignalWriteTarget`, plus `src/cli.ts` runReply and `src/listener/runtime.ts`. Is the spec
     right? Is its worked example (the A -> agent -> A -> agent chain) actually correct, or did it get the
     resolution wrong?
   - **R3 (DMs):** the spec claims the live `swarm_read.signals` view has no `from_principal` clause, so a
     sender cannot re-read their own directed signal, so draft B's "DMs need no migration" is false.
     Verify against the LIVE view definition (three migrations define it; find the newest).
   - **R4 (no backfill):** the spec rules that `channel_id` is never backfilled and `#all-signals` is a
     view, not a row. Find the case this breaks that draft A's default-channel backfill handled.

5. **Find anything the spec asserts that is not true**, especially: user-facing strings it quotes, test
   files and line numbers it lists in its claim family (§11), and any enumeration it states as complete.

6. Note where the spec is longer than it needs to be or where a ruling is asserted without a measurement.

## Output rules

- Be concrete. Every finding needs a `path:line` and the actual text.
- Distinguish DEFECT (the spec is wrong or would cause an outage/disclosure) from NIT (citation drift,
  wording).
- If you cannot verify something, say so rather than guessing.
- **Your last line must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.** FAIL if you found any DEFECT.
