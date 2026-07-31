# Host protocol matrix reconciliation

Date: 2026-07-31

Scope: local read-only version, help, and protocol audit. The reconciliation did not run model
turns, start agents, access the network or database, or deploy.

## Landing scope

OpenCode ACP is merged at `69cafc31b8276a6638a499e2675f5f34dde29e89` on
`lead7/mvp-release-0.1.5`. At measurement, `origin/main` was
`20ade63db9be10726d670b4c8676382243de78b2` and did not contain
`src/host/opencode.ts`, `src/listener/opencode-model.ts`, their tests, or the two OpenCode evidence
files. “Merged” therefore means merged into the Lead7 integration branch only, not landed on main,
released, or established in production.

## Matrix reconciliation

Lane H required a matrix before choosing the second adapter. The previous Lane-H worker was
interrupted without delivering a final matrix (`SWARM-AND-WORKTREES.md` section 2), so the OpenCode
selection was not preceded by the required complete comparative matrix.

The narrower causal decision is nevertheless recorded: OpenCode 1.18.10 provided ACP v1
`initialize` plus `session/new`, a live host-correlated forced-denial canary, and a causal
hostile-project configuration control. Codex app-server zero-tool behavior was unproven on this
machine. This supports a provisional OpenCode choice against Codex; it does not establish
comparative superiority over Claude Code or Gemini/AGY.

| Host | Measured local result | Honest status |
|---|---|---|
| Codex | `codex-cli 0.145.0`; experimental app-server advertises stdio and daemon management | No handshake, isolated-session, denial-canary, cancellation, authentication, or concurrency proof; foreground NDJSON is the fallback |
| Claude Code | `2.1.220`; advertises background/resume, tool allow/deny, bare mode, and JSON/stream-JSON | No ACP or force-denial, isolation, or cancellation proof; foreground NDJSON is the fallback |
| Gemini CLI | Executable absent | Unsupported locally; foreground NDJSON/manual polling is the fallback |
| AGY | `1.1.9`; advertises continuation, sandboxing, and JSON/stream-JSON | Not evidence of Gemini CLI or ACP; no isolation, canary, or lifecycle proof |
| OpenCode | `1.18.10`; ACP advertised | ACP-v1 handshake, denial canary, and configuration control established only at this pin; no production CommonSwarm canary |
| Grok | `0.2.117`; existing v0.1.4 ACP reference | Production same-owner proof and gated cross-owner/concurrency evidence; a live cross-owner production turn remains unestablished |

## Evidence supporting the provisional choice

- `docs/evidence/2026-07-31-opencode-acp-host-adapter.md` records the implementation and local
  host tests.
- `docs/evidence/2026-07-31-opencode-live-permission-canary.md` records the live forced-denial and
  hostile-project configuration controls for OpenCode 1.18.10.
- `docs/evidence/2026-07-31-aegis-security-review.md` preserves the earlier adversarial findings;
  the later live evidence closes only the explicitly measured handshake, configuration, and canary
  claims.

## Required next evidence

Before calling the adapter fully matrix-selected or production-ready, record equivalent versioned
probes for Codex, Claude, and any installed Gemini host. Then run a production OpenCode listener
canary covering same-owner behavior, cross-owner isolation, forced denial, cancellation and
revocation, one-winner startup, and credential absence from arguments, environment, status, and
logs.

## Not established

- No comparative model-quality result was measured by this lane.
- No real CommonSwarm listener was started for Codex, Claude Code, Gemini, AGY, or OpenCode.
- Help text is evidence of an advertised surface, not proof that its security or lifecycle
  behavior works.
- OpenCode evidence is pinned to version 1.18.10 and does not establish later versions.
