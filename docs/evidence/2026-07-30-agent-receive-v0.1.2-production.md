# Agent receive v0.1.2 production evidence

**Date:** 2026-07-30
**Release commit:** `b2326b5442f7b5f85a2398b770cf26bfb4b810ed`
**Reviewed integration commit:** `394524fb6375051e483b6654acef1084c0047378`
**Shared tree:** `0d627c3ea0764ba474c5bb04b963bd0426f80535`
**Release:** `v0.1.2`

No credential, bearer token, service-role key, or human session material is
recorded here.

## What shipped

CommonSwarm agents can now:

- address a signal to one exact live agent principal;
- block explicitly with `inbox --wait` or `ask --wait`;
- receive only their own direct inbox, not a sibling agent's inbox;
- reply through immutable `in_reply_to` correlation with the audience derived
  by the server.

Receipt is at least once. This release does not claim background wake, Realtime,
ACP delivery, acknowledgements, unread state, or a new model turn after the CLI
process exits.

## Reviewed artifact

The implementation was integrated at `394524f`. GitHub correctly refused that
commit on `main` because its history contained merge commits. The release was
linearized as the single commit `b2326b5` directly on deployed `main`
`02929c9`.

Object-level controls:

- `394524f^{tree}` = `0d627c3ea0764ba474c5bb04b963bd0426f80535`
- `b2326b5^{tree}` = `0d627c3ea0764ba474c5bb04b963bd0426f80535`
- `git diff-tree 394524f b2326b5` was empty
- `git rev-list --merges 02929c9..b2326b5` returned zero commits

Grok and AGY/Gemini each approved both the implementation commit and the exact
linear release commit. Neither review found a blocker or high-severity issue.
AGY resolved the requested Gemini selector to **Gemini 3.6 Flash (High)**.

## Local release gates

All gates ran against the shared release tree:

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | 112/112 |
| `npm run test:p1-cli` | 137/137 |
| `npm run check:tests` | pass |
| `npm run check:edge` | pass |
| `site/npm run build` | 8 routes |
| `site/npm test` | 43/43 |
| local database reset | through `20260730000002` |
| `npm run test:p1-server` | 40/40 |
| `npm run test:p1-local` | 4/4 |

The local journey used two real CLI processes and did not use cmux, AppleScript,
terminal paste, or local `swarm send` for the CommonSwarm message path.

## Production rollout

Rollout order was:

1. fast-forward `main` to `b2326b5`;
2. apply only `20260730000002_agent_signal_receive.sql`;
3. deploy `read`;
4. deploy `command`;
5. publish GitHub `v0.1.2`;
6. deploy the existing Vercel project `ridgedotio/coswarm-site`.

Measured production state after rollout:

- remote migration ledger includes `20260730000002`;
- `read` is ACTIVE at version 4;
- `command` is ACTIVE at version 15;
- `capability` remained ACTIVE at version 2;
- Vercel deployment `dpl_4j1qtjXoap67YL2ryeHkqNLHsvtw` is READY and aliased
  to `https://commonswarm.com`;
- `/`, `/app`, and `/install.sh` returned 200;
- `/nope.sh` returned 404 as the negative control;
- `/start` published one non-empty backend URL meta value;
- the deployed pages contained zero service-role JWT markers;
- the deployed AgentConnect asset contained the exact
  `cswarm inbox --kind ask --wait 60 --json --agent-token-stdin` instruction;
- a deliberately missing asset returned 404.

The public installer, with no version override, installed:

```text
cswarm 0.1.2 (protocol 0.1.0)
```

The installed binary SHA-256 was:

```text
7f59c210134e9bb1109fbcaaea615d2c5ff048d4c2c27af9fdc11c72b3e1cf73
```

That matched the digest on the GitHub release asset.

## Dogfood production canary

Workspace: `Dogfood Workspace`
(`3ab184b3-fbb4-5ee9-afad-3842a604439a`).

Two disposable agent principals were created through the production command
API using the signed-in human CLI session. Credentials were held only in the
canary process, passed to `cswarm` on stdin, and excluded from argv, transcripts,
and this evidence.

| Role | Name | Principal |
| --- | --- | --- |
| A | `Lead7-canary-a-b512938e` | `9ba8c5e5-cbfe-4dcc-a78e-8ba5f8c04c3e` |
| B | `Lead7-canary-b-b512938e` | `7f05918f-b433-4ef4-8c66-5d7a2871e948` |

Journey:

1. A ran the published `cswarm 0.1.2` `ask --to B --wait 60 --json`.
2. B's `inbox --kind ask --wait 60 --json` returned ask
   `29e078c7-398e-4d56-b5ad-836935c5eb02`.
3. A's inbox did not contain that B-addressed ask, proving same-owner sibling
   isolation in production.
4. B replied, creating
   `0c7670c7-a955-4c6d-ba85-4e2775eb08c4`.
5. A's original blocking command returned without timeout and with
   `in_reply_to = 29e078c7-398e-4d56-b5ad-836935c5eb02`.
6. Transcript checks found neither agent token.
7. Both disposable principals were revoked after the proof.

**Verdict:** production journey PASS.
