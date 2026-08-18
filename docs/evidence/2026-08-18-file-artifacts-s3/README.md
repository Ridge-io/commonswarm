# File artifacts S3 — the cswarm file CLI verbs

**2026-08-18.** Stage S3 of `docs/design/2026-08-18-FILE-ARTIFACTS.md`: the CLI surface over
the S1+S2 server commands that landed on `main` at `05ed0a8`. CLI only — no server change, no
deploy; e2e against a real stack is S4's.

## What was built

- `src/cloud/files.ts` — client module for the five command kinds plus both list paths.
  Deliberate choices, each with its why in the file:
  - its own command POST rather than ThinCommandClient, because file refusals carry their
    remedy in the response `message` (the numbers: "31 MB … limit is 25 MB") and the shared
    client's error path keeps only the code;
  - `absoluteStorageUrl` refuses a non-relative "path" from the server — the relative-path
    contract is the S1 evidence's recorded decision, and composing a hostile absolute URL
    would aim the client at an attacker-chosen origin;
  - the §5 content-type map is keyed by extension with longest-suffix matching (`.tar.gz`),
    closed-default null for anything unknown, and every value chosen to pass the server's
    `ALLOWED_CONTENT_TYPE_RE`;
  - two MUST-MATCH constants (`FILE_MAX_VERSION_BYTES` for the zero-byte preflight refusal,
    `FILE_CONTENT_WARNING` for the human list path) cite their server sources — the TTL-drift
    scar shape;
  - list splits by credential kind: agents through `read` (`resource: "files"`), humans
    through the membership-gated `swarm_read.files` view over REST, because the read edge
    accepts agent credentials only — the same split `members` already uses.
- `src/cli.ts` — `cswarm file put/ls/get/rm/restore`, usage lines, flags (`--name`, `--out`,
  `--force`, `--version`, `--include-tombstoned`), dispatch, and the credential-form table
  entry the `--agent-token-stdin` description gate requires. `put` runs
  create → PUT bytes → commit with the local sha256 sent as the labeled attestation; output
  echoes the ★R10 versioned `--about file:<id>@v<n>` reference. `rm` takes no `--confirm`
  (★R7) and announces the restore verb and window end. `get` refuses to overwrite an
  existing local file without `--force` via a pure, tested guard.

## Gates on the committed tree

- `npm run test:p1-cli` — **265/265** (10 new in `tests/p1-cli/file-verbs.test.ts`, reached
  by that script's glob).
- `npm test` — **536/536**.
- `npm run check:tests` — clean. `npm run build` — clean.
- Mutation checks, measured red-then-green:
  - overwrite guard condition inverted in `files.ts` → the guard test FAILS (9/1);
    restored → 10/0;
  - the `--agent-token-stdin` description gate itself caught the five undocumented verbs
    mid-implementation and again refused a shorthand ("file put/ls/…") that did not contain
    the full subcommand names — both refusals observed, both fixed to full names.

## Deviations from the spec, with why

- `--note "<text>"` on `put` (spec §3) is NOT implemented: the server surface has no note
  field, and inventing a client-side signal post inside `put` would couple two commands the
  spec keeps separate. Deferred to a spec decision.
- `file get` writes whole-buffer, not streamed — bounded by the 25 MB cap, so simplicity won.

## NOT established

- End-to-end behavior against a real stack (upload PUT, signed URL composition against
  api.commonswarm.com, download bytes) — S4's stage, deliberately not run here; another
  agent may hold the machine's exclusive DB slot.
- The CLI-side guard WIRING is not mutation-covered: the mutation check exercises the pure
  guard function; deleting the call site in `cli.ts` would not fail a test. Recorded rather
  than papered over — an S4 e2e get-twice test would close it.
- Human-path list against a real PostgREST (`swarm_read.files` over REST) — same S4 gap.
- p1-server / p1-local were not run in this lane (slot discipline); nothing here changes
  server code.
