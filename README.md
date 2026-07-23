# cloud-swarm

Multi-human, multi-agent **coordination cloud service** — the cloud evolution of
[`swarm`](https://github.com/Ridgeio/swarm) (the local, single-machine CLI).
Forked into its own repo so cloud development can never destabilize the in-use
local tool (the local swarm builds and runs from its own working tree).

## Status

**P0 — Foundations (local, no provisioning).** Building the reducer-complete
authority core: the §2.2 task/lease state machine + event reducers + upcasters +
property tests, as a pure module (`src/protocol/`) with no I/O. P1 wires it behind
the Supabase command API; nothing is provisioned until the operator reviews the
plan.

## Canonical spec

`docs/design/SWARM-CLOUD.md` is the single, consolidated, multi-model-reviewed
specification (Part I cloud spec + Appendix A board UI + Appendix B doctrine
backstop + Appendix C operator UX). Component sources sit beside it; on conflict
the consolidated doc wins. The **design ethos (§0)** is the interpretive frame:
*friction is justified only by irreversibility* — smooth by default, hard only at
the few genuinely irreversible acts.

Planned tracks beyond the coordination core (architected-for now, built later):
- **SaaS track** (§9 P5): public, free-to-start self-serve.
- **Access plane**: a key-less secrets broker + policy egress proxy so agents
  operate third-party services (Sentry, PostHog, Supabase, env-file leasing)
  without holding raw keys — tiered by reversibility, gated by the same
  capability/audit model.

## Dev

```bash
npm install
npm test      # node --test via tsx
npm run build # tsc → dist/
```

## Relationship to `swarm`

The local `swarm` CLI remains supported indefinitely for solo/offline use;
migration into a cloud workspace is `swarm cloud attach` (spec §6). Shared code
(transports, board UI) is copied here on demand as the build reaches it and may
later be extracted into a shared package if divergence warrants.
