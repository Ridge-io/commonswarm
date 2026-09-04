You are an ADVERSARIAL CRITIC. Your job is to REFUTE a spec, not to approve it.

REPO (read-only for you; do not edit anything): /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-standing-default
It is a git worktree of the CommonSwarm repo at origin/main (SHA e3df06b). Read files there.

CONTEXT. Operator decision 2026-09-04: "When I add an agent, I want the default to be that it never
expires." An agent is added through the web app at /app, whose form is
site/src/components/connect/AgentConnect.astro and whose mint call is site/src/lib/agent-connect.ts.

THE PROPOSED CHANGE (narrow lane; ONLY these files may change):
  1. site/src/lib/agent-connect.ts — add `renewal_kind: "standing"` to the mint_agent_token wire
     body, and NEVER send `renewal_horizon_ms` in any form. Stop computing
     `horizonExpiresAt = issuedAt + RENEWAL_HORIZON_DEFAULT_MS` (lines 508-510) and instead read
     `grant_kind` and `horizon_expires_at` off the accepted response body. Add `grantKind` to the
     exported `AgentCredential` interface. Delete `RENEWAL_HORIZON_DEFAULT_MS`.
  2. site/src/components/connect/AgentConnect.astro — copy only: the form must tell a person that
     access does not expire, that "Revoke grant" in the roster stops it, and that N idle days
     suspend it, N interpolated from a constant, never typed.
  3. site/src/lib/standing-grants.ts — export a constant for the idle-suspension days and build
     STANDING_GRANT_COPY from it (today line 1-2 says literally
     "This does not expire. Revoke is the only kill switch.").
  4. New/edited test files for the above, plus docs.
NOT changeable in this lane: any file under supabase/, src/, site/src/components/app/LiveDashboard.astro,
site/src/components/connect/agent-prompt.ts, site/src/pages/**, site/public/**.

CLAIMS TO ATTACK. For EACH one, try hard to REFUTE it by reading the code. Quote file:line.

C1. NO server or migration change is needed. The wire type already accepts
    `renewal_kind: "timeboxed" | "standing"`, and the deployed validator accepts standing.
C2. Sending `renewal_horizon_ms: null` alongside `renewal_kind: "standing"` is a 400. The field
    must be ABSENT from the JSON, not null.
C3. The app already sends `device_id`, so an app-minted standing grant is bound, and
    `grantRiskBadge` in site/src/lib/standing-grants.ts can never return "UNBOUND" for it.
C4. AFTER THIS CHANGE, DOES AN AGENT ADDED IN THE APP ACTUALLY NEVER EXPIRE, AND IS IT BOUND?
    This is the question that matters most. In particular: the grant's bound_device_id becomes the
    BROWSER's device row, but the agent renews from a DIFFERENT machine. Trace whether renewal
    passes or fails. Follow: supabase/functions/command/index.ts mint path -> swarm.agent_runs row
    -> supabase/functions/_shared/agent-auth.ts -> loadRenewalFacts -> swarm.prepare_renewal_grant
    and swarm.agent_tokens_successor_fence in
    supabase/migrations/20260901000001_standing_grants.sql. If renewal breaks, SAY SO LOUDLY.
C5. A standing grant unused for ~14 days is suspended on its next renewal, suspension is one-way,
    and revoke + re-add is the only remedy in the committed code. Verify the number, the trigger
    that forbids un-suspend, and that nothing un-suspends.
C6. The CLI's `--confirm-standing` (src/cli.ts) is a client-side acknowledgment, not a security
    control, so the app needs a sentence and not a checkbox or a second click.
C7. The change is SAFE TO SHIP WITHOUT touching agent-prompt.ts. Today
    site/src/components/connect/agent-prompt.ts `renewal()` (lines 32-48) prints
    "can rotate it until <date>" when horizonExpiresAt is a number and a different sentence when it
    is null. After the change horizonExpiresAt is null for standing. Is the resulting prompt text
    FALSE, or merely incomplete? Read it and decide.
C8. Nothing else in site/ reads `AgentCredential.horizonExpiresAt` or
    `RENEWAL_HORIZON_DEFAULT_MS` in a way this change breaks. Enumerate every reader; do not
    pattern-match.
C9. Deployment risk: if the production `command` edge function predates the `renewal_kind` wire
    field, does every add-agent fail LOUDLY (400) or SILENTLY? Read `exactKeys` and the optional
    key list in supabase/functions/command/index.ts.
C10. Copy correctness. The proposed sentences must not say the credential never expires (only the
    GRANT has no horizon) and must not say the grant is "locked to this computer". Name any
    sentence in the change list above that would be FALSE, and any TRUE fact a new user needs that
    is missing.

RULES
- Verify every line number you are given; if a citation points at the wrong code, say so.
- A negative result must reach the path it claims to test. If your probe could not have detected
  the failure, say the probe was inconclusive rather than reporting a pass.
- Do not accept a claim because it sounds right. Read the code.
- Be concrete: file:line for everything.

OUTPUT FORMAT
Per claim C1..C10: one paragraph — REFUTED / UPHELD / INCONCLUSIVE — with the citation that decides
it. Then a short list of the most serious defects, worst first. Then, on the LAST line, EXACTLY one
of these two literal lines and nothing after it:
VERDICT: PASS
VERDICT: FAIL
PASS means the spec is safe to implement as written. FAIL means at least one claim is refuted or a
serious defect exists. You MUST print a VERDICT line.
