# Review brief — lane/composer-to-field at 3bb9815 (round eight)

Repo: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field
Base: 5756a6bbb1b30cb8d595301cfcaa015a8a8122a3 (merge-base with origin/main)
Whole-lane diff: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field/arms-3bb9815/DIFF.patch
THIS ROUND ONLY (4e1be6a..3bb9815): /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-composer-to-field/arms-3bb9815/ROUND.patch — read this one first.
Previous round's findings: docs/evidence/2026-09-05-composer-to/README.md, and docs/evidence/2026-09-05-composer-to/arms/d96de1d-grok-ARM.txt
You may read any file in the repo. Do not change any file.

## What this round changes

Round seven of this lane ended FAIL on a verified, pre-existing defect and wrote its shape down
rather than fixing it: **work the SEND owns sat behind a guard that asks whether the SCREEN is
still the send's.** Round six had already moved the send's STORAGE out from behind that guard.
This round moves the rest and gives the in-flight moment a browser control.

1. `composerSendToken` is the send's identity for the send flag. One submit takes a token
   (`++composerSendToken`) and only that submit may lower the flag it raised; `resetComposer`
   bumps the token, which says the composer that send raised it on is gone. The lift in the
   submit's `finally` asks the token and nothing about the screen. `requestVersion` cannot
   answer the question: six controls reopen the CURRENT workspace (Refresh, retry-workspace,
   remove-member, edit-model, revoke, remove-agent) and every one advances the generation
   without running `resetComposer`.
2. The catch no longer opens with `if (version !== requestVersion || workspaceId !==
   activeWorkspaceId) return;`. Send-owned work runs first (clear the draft this send wrote,
   retire the command id it minted, release its previews), then a guard that asks the token and
   the workspace decides the screen work (restore the body, the error, Retry, the feed).
3. A landed post's `composerIntent` retirement, the status sentence it put up, and the sample
   store write moved above the screen guard, with the rest of the send's own bookkeeping. The
   status was the LAST line of the screen block, so a reopen left "Posting message…" standing
   over a composer that was finished, empty and writable. I found that one myself after the
   first arm pair was launched and killed it; attack whether anything else of that kind is left.
4. The line between the two is stated at the submit rather than left to be inferred: what the
   send has to FINISH is the send's, what the reader is LOOKING AT is the screen's, so the feed
   list, `postedSinceReset` and the row caches stay behind the guard. Attack that ruling.
5. `sampleSendWindow` gives the sample send an in-flight window and a way to fail in it, read
   from two document-element hooks. Sample mode is entered only when there is no Supabase client
   at all, so neither hook is on any path that talks to a server.
6. `openSampleWorkspace` now models a REOPEN as well as a switch: it advances the generation and
   tears nothing down, exactly as `openWorkspace` does for the workspace already on screen. The
   sample Refresh button takes that path.
7. Five new browser controls at the end of composer-to-field.observer.test.ts drive an in-flight
   send under a Refresh and under a workspace switch, plus a return-before-it-finishes. Eight new
   mutations in docs/evidence/2026-09-05-composer-to/mutate.mjs drive them.

## The direct question

**Does this SHA close the family that six rounds of this lane kept reopening — send-owned work
gated on the screen's identity? If it does not, name the ONE cause, not a list of symptoms.**

## Checks to attack

1. **A NINTH INSTANCE OF THE SAME CLASS.** Enumerate everything the submit does after its first
   await. For each, say whether it belongs to the SEND (its command id, its storage keys, its
   workspace, its previews, its flag) or to the SCREEN (the box, the feed, the status, focus),
   and whether the guard it sits behind matches. Name any send-owned write still gated on
   `requestVersion`, and any screen write that is not gated at all. Do the same for
   `resetComposer` and `openWorkspace`.
2. **THE TOKEN.** `composerSendToken` is a monotonic counter. Find a sequence of submits,
   switches, reopens and sign-outs where the wrong send lowers a flag, or where a send that
   still owns its composer fails to lower one and wedges it again. The counter is bumped in
   exactly two places; say whether that is enough.
3. **THE CATCH'S NEW ORDER.** The landed clear and the intent retirement now run before the
   screen guard, and the previews are released on both paths out. Is anything released twice, or
   released while the composer is still showing it? Is anything the reader can see written when
   the box is not the send's?
4. **THE SETTLE.** `syncComposerAddress()` runs only when the token and the workspace both still
   belong to this send, while `clearComposerDraft(sendDraftKey)` runs unconditionally for a
   landed post. Can that clear remove a draft the reader is writing in another workspace, or
   leave a draft the settle just wrote?
5. **THE SAMPLE HOOKS.** Can `data-sample-send-delay` or `data-sample-send-fail` reach a real
   post, a real workspace, or any code path that runs when a Supabase client exists? Is reading
   both at the START of the window rather than at its end right?
6. **THE SAMPLE REOPEN.** `openSampleWorkspace` now bumps `requestVersion` and skips
   `resetComposer` on the same id, and repaints from `sampleSignals`. Does it model
   `openWorkspace` closely enough for the controls above to be about the real path, and does it
   break any existing claim about a sample SWITCH?
7. **THE CONTROLS.** Each in-flight step records `sawFlagUp` as its positive control. Is that
   enough to prove the step acted inside the window? Do the assertions discriminate — could each
   named mutation fail for a reason other than the assertion it names? Is any of them green
   against a defect it claims to defend?
8. **RETIRED CLAIMS AND THE README.** docs/evidence/2026-09-05-composer-to/README.md now says two
   items left the NOT-established list. Check each against the code. Is any sentence in the
   repository still asserting something this SHA made false?

Attempt refutations rather than describing the diff. Quote back the diff's first `diff --git`
line before your findings. End with `VERDICT: PASS` or `VERDICT: FAIL` as the last line.
