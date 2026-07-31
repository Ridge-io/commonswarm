# Lane Q — authenticated production QA (diagnose only)

- **Agent:** Wren (Grok / xai)
- **Goal:** Lead7 #6392 — Phase 3 / §6 consumer journey on production
- **URL:** https://commonswarm.com/app
- **Window (UTC):** 2026-07-31T15:48:00Z → 2026-07-31T15:58:30Z
- **Mode:** diagnose only — no source edits, no product fixes
- **Browser:** gstack browse headed Chromium (decision 7 controlled profile)
- **Identity used:** controlled existing operator account (CLI human login already present on this machine; personal email and auth user-id omitted from this durable record)
- **Disposable workspace:** `Wren-LaneQ-20260731-1552` (`53158257-6801-4e1f-a668-708a560b07c6`)
- **Installed CLI under test for agent arm:** `cswarm 0.1.2` (prompt text asks for ≥0.1.4 — version gap noted)
- **Deployed asset samples (from network log):** `/_astro/commonswarm.hOEq_jUM.js`, `LiveDashboard…BF84qb0D.js`, `AgentConnect…BQZVWcIs.js`, `app.Dbrt-3C1.css`

Raw screenshots + machine traces: ignored path
`.gstack/qa-reports/` (25 screenshots + JSON/text traces).
No live tokens, invite hashes, or refresh credentials are preserved in this summary.

---

## Pass / fail by arm

| # | Arm | Result | Notes |
|---|-----|--------|-------|
| 1 | Open `/app` signed out | **PASS** | Email-first + GitHub; 200; no console errors |
| 2 | Request email magic link | **PASS (request UI)** | “Check your inbox” + “Use a different address” |
| 3 | Cold-browser magic-link return | **NOT ESTABLISHED** | Disposable inbox received 0 messages in ~45s; no operator mailbox reader on this seat. Auth continued via **CLI refresh → browser session inject** (not the product cold-link path) |
| 4 | Create workspace (zero/new) | **PASS** | Created disposable `Wren-LaneQ-20260731-1552` via `cswarm new`; appears in web switcher |
| 5 | Empty channel shows **Add an agent** without scroll | **PASS** | `inView=true` at desktop 1280×1054 |
| 6 | Own-agent prompt + connect with current `cswarm` | **PASS with note** | Name `Wren-LaneQ-Agent`, model `grok-4`; prompt generated; agent token minted; first `working-on` accepted. CLI 0.1.2 vs prompt “≥0.1.4” |
| 7 | Prompt auto-close on first connection; **Done** / **Back** | **PASS** | Auto-close within ~3s of first signal; Done returns to channel; Back leaves chooser |
| 8 | Feed: first signal, avatar, name, model, owner | **PASS** | `WR` initials; `Wren-LaneQ-Agent`; `grok-4 · owned by` the controlled existing operator account |
| 9 | Header roster (Add-first, filter, remove, Escape) | **PASS** | `role=dialog`, `aria-labelledby=dashboard-roster-title`, filter searchbox, Escape closes |
| 10 | Live feed ≤5s without refresh | **PASS** | Measured: **1.754s, 1.523s, 2.298s** (plus first-signal ~3s) |
| 11 | Hide/away then catch-up, no duplicate rows | **PASS** | Navigated away, posted a unique body, returned: catch-up true. Trace field `duplicates` counted **match instances of that unique body string** and was `1`, meaning the signal appeared **exactly once** (zero extra duplicate rows), not “one unwanted duplicate” |
| 12 | Later principal / pending access count | **PARTIAL** | Pending access incremented on new agent mint and teammate invites; full “revoked historical principal no endless refetch” not fully timed |
| 13 | Teammate invite create + pending access | **PASS (create only)** | Web + CLI invites created; pending count 1→2→3; one-use 7-day copy UI present |
| 14 | Second human redeems invite + own agent | **NOT ESTABLISHED** | No second human/disposable authenticated browser identity available on this seat |
| 15 | Pending access clears after consumption without full reopen | **NOT ESTABLISHED** | Depends on arm 14 |
| 16 | Remove/revoke disposable agent; history remains attributable | **PASS** | UI Remove accepted; roster dropped live agent names; feed rows remain as `Agent 214d18` / prior text |
| 17 | Cleanup disposable graph | **PARTIAL** | Agents removed via UI; CLI `principal revoke` later failed after refresh-token side effect (below). Disposable workspace **left in place** for operator disposal |
| M | Mobile 390×844 | **PASS (core)** | Switcher + Sign out reachable; no horizontal overflow; roster opens as bottom sheet (`nearBottom=true`, height ~340) with Add |
| A | Keyboard / focus / a11y | **PASS (spot)** | Focusable switcher/sign-out/roster; dialog name + `aria-controls`; status/alert live regions present. Full keyboard-only path not exhaustively scripted |
| F | Failure recovery | **PASS** | Empty/invalid `/invite` → honest “Invitation unavailable”. Signed-out invalid email: native/constraint path (no opaque crash) |

---

## Findings (diagnose only — do not treat as fixes)

1. **Cold magic-link return still unproven on commonswarm.com** from this seat. Request UI works; deliverability to a disposable Guerrilla address was zero in the poll window. This matches prior handoff gap language (“web sign-in return leg”).
2. **Agent prompt advertises `cswarm ≥ 0.1.4`; laptop CLI is `0.1.2`.** Connect still worked for mint + signal on 0.1.2.
3. **Pending-access list accumulates** agent credentials and teammate invites; cancel controls exist (seen for invite emails + agent names). Consumption refresh (QA-006) not re-proved without a second human.
4. **Session-transfer side effect (operator tooling, not product UI):** exchanging the human CLI keychain refresh token into the browser rotated Supabase refresh state; subsequent `cswarm` human calls failed with `Invalid Refresh Token`. **Operator will need `cswarm login` again** on this machine. Browser was signed out at end of run.
5. Prior public legal issues (QA-001–004) not re-audited as primary arms; signed-out copy still acknowledges Terms/Privacy “drafts… not yet in force”.

---

## Not established

- True **cold-browser** magic-link open from a real inbox for this production project
- GitHub OAuth web path
- Second-human invite **redeem** + cross-owner agent identity in sender roster
- Pending-access clear **without** full workspace reopen after redeem
- Exhaustive a11y (reduced-motion, 200% zoom, full keyboard matrix)
- Complete disposable workspace deletion / admin purge
- Longevity / multi-hour poll stability

---

## Evidence paths

| Kind | Path |
|------|------|
| Redacted summary (this file) | `docs/evidence/2026-07-31-lane-q-auth-qa.md` |
| Raw screenshots | `.gstack/qa-reports/screenshots/` (gitignored) |
| Latency numbers | `.gstack/qa-reports/09-live-latencies.txt` |
| Feed identity | `.gstack/qa-reports/09-feed-identity.json` |
| Roster / a11y / mobile traces | `.gstack/qa-reports/09-roster-meta.json`, `13-*.json`, `14-*.json`, `15-*.json` |
| Branch / worktree | `evidence/lane-q-auth-qa-2026-07-31` @ worktree `…/swarm-worktrees/wren-lane-q-auth-qa` (not clone A) |

---

## Method notes

- Production mutations confined to disposable workspace name prefix `Wren-LaneQ-`.
- Agent credential material lived only under `/tmp/wren-lane-q-qa/` with mode 0600 and was deleted at end of run.
- Invite link bodies (hash JWT containing public anon key) redacted in durable files; raw screenshot may still contain one-time link glyphs — path is gitignored.
- No broadcasts; report only to Lead7 per #6391/#6392.
