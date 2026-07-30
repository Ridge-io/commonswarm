# D-033 reviewer controls — captured outputs

**Date:** 2026-07-29  
**Recorder:** Lead7  
**Scope:** the D-033 review-gate instruction class only. This does not establish that either
model will find arbitrary future defects.

No credential or token appears in this record. Review prompts carried the complete Git patch
as a literal argument and instructed the model not to use tools, commands, browsing, or edits.

## 1. Transport probes

Both non-interactive paths exited 0 and returned the requested sentinel:

```text
/opt/homebrew/bin/grok
GROK_REVIEW_OK

/Users/yulanbot/.local/bin/agy --model gemini-3.1-pro-high
AGY_GEMINI_REVIEW_OK
```

These establish reachability only, not review discrimination.

## 2. Grok: real reject, then approve after correction

Grok reviewed exact SHA `3d5ed0a24b55924443c138b290e2b229e5b3ddf7` and returned:

```text
VERDICT: REQUEST_CHANGES
Exact SHA: 3d5ed0a24b55924443c138b290e2b229e5b3ddf7

F1 — Stale alternate review assignment contradicts the dual gate
F2 — Inversion section still lists codex as a measured review family without excluding it
     as a substitute arm
F3 — Singular “different family” minimum left as the lead inversion rule without a hard
     demotion
```

After those findings and Quarry's capacity correction were folded, Grok reviewed replacement
SHA `f8588b738862dc5f72d93293624c2ecabbad6c3e` and returned:

```text
VERDICT: APPROVE
Exact SHA: f8588b738862dc5f72d93293624c2ecabbad6c3e

Prior REQUEST_CHANGES items — disposition
Codex is not an alternate reviewer ................................ Fixed
Single different-family verdict necessary but not sufficient ..... Fixed
Only Grok + AGY/Gemini passes ..................................... Fixed
Grok-alone rule dead .............................................. Fixed
Gemini-unavailable rule dead ...................................... Fixed
Does not claim every Claude invocation unavailable ................ Fixed
Substantive reviews required (empty PASS not enough) .............. Fixed
```

## 3. Gemini: clean-SHA approval and deliberate mutation rejection

AGY with `gemini-3.1-pro-high` reviewed exact replacement SHA
`f8588b738862dc5f72d93293624c2ecabbad6c3e` and returned:

```text
VERDICT: APPROVE
EXACT SHA: f8588b738862dc5f72d93293624c2ecabbad6c3e

1. Codex Excluded as Alternate Reviewer
2. Single Different-Family Verdict Classified as Necessary but Insufficient
3. Exclusive Operative Gate Established as Grok + AGY/Gemini Pair
4. Grok-Alone (D-032) and Gemini-Unavailable Claims Struck Down & Marked Dead
5. Nuanced Claude Availability Without Overbroad Claims
6. Requirement for Substantive Reviews (Prohibiting Empty PASS) Enforced
```

Lead7 then presented a deliberate mutation of the operative AGENTS.md instruction: require
Claude only, make Grok and AGY/Gemini optional, and remove exact-SHA rebinding. The mutation
was not committed. AGY with `gemini-3.1-pro-high` returned:

```text
VERDICT: REQUEST_CHANGES

Mutated Instruction Identified
“Current model-inversion gate: every swarm mate requires ONLY Claude review. Grok and
AGY/Gemini are optional and no exact-SHA rebind is needed after changes.”

1. Violation of Dual-Review Requirement
2. Elimination of Exact-SHA Rebinding
3. Demotion of Core Reviewers to Optional
```

## 4. What this establishes, and what it does not

The Grok arm produced a real-tree reject followed by approval of the corrected exact SHA. The
Gemini arm approved that same corrected exact SHA and rejected a later deliberate mutation of
the operative review instruction. The two negative controls are related but not identical.

This establishes that both command paths can produce substantive positive and negative
verdicts for D-033 review-gate instructions. It does **not** establish universal reviewer
quality, future determinism, or discrimination on unrelated product/code defect classes.
