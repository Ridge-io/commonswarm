# D-038 — accept the invite form the product emits

Date: 2026-08-03
Worker: Sill
Branch: `lead7/mvp-release-0.1.5`
Frozen base: `0d6f4b1e91bfef48b30e3604badc82dd447e308a`

## Preflight

After fetching the branch, all three objects were identical:

| Object | SHA |
|---|---|
| `HEAD` | `0d6f4b1e91bfef48b30e3604badc82dd447e308a` |
| `origin/lead7/mvp-release-0.1.5` | `0d6f4b1e91bfef48b30e3604badc82dd447e308a` |
| `git ls-remote origin refs/heads/lead7/mvp-release-0.1.5` | `0d6f4b1e91bfef48b30e3604badc82dd447e308a` |

The worktree was clean before the D-038 test was added.

## Decision and implementation

The retired `coswarm://accept/` form is accepted as a compatibility alias. A saved link or
old runbook therefore reaches the same decoder as `cswarm://accept/`; it is never mislabeled
as corrupt base64url.

`decodeInviteLink` now recognizes these wrapper forms before invoking the existing payload
decoder:

- `https://...#invite=<payload>` and `http://...#invite=<payload>`;
- `cswarm://accept/<payload>`;
- retired `coswarm://accept/<payload>`;
- the pre-existing bare encoded payload form.

HTTP(S) links are parsed locally with `URL`, then the raw fragment parameter is extracted
without percent decoding. There is no fetch or URL dereference. Only the fragment is accepted;
a query-string `invite` parameter was not added. Any HTTP(S) host is accepted deliberately:
the wrapper host is not a trust decision, while the extracted self-contained payload continues
through its existing target, token, schema, size, and strict base64url checks.

The strict validator itself was not relaxed: `STRICT_BASE64URL_RE`, the decode/re-encode
canonicality check, and the payload/schema validation remain in place. A recognized wrapper
with `invite=abc=` still returns `invite link payload must be strict unpadded base64url`.
An unrecognized wrapper instead says that the wrapper was not recognized and names accepted
forms. CLI usage and positional-count copy now include the web form.

Changed product/test surfaces:

| Path | Change |
|---|---|
| `src/cloud/invite-link.ts` | Local wrapper extraction, retired-scheme alias, distinct wrapper/input errors |
| `src/cli.ts` | Accept-path usage and argument guidance only |
| `tests/p1-cli/d038-invite-form.test.ts` | Six focused D-038 cases |
| `package.json` | Names the focused file in `npm test`, so the pure gate actually runs it |
| this file | Durable execution evidence |

No path under `site/` or `supabase/` changed. The invite payload schema and invitation-token
format did not change.

## RED then GREEN proof

Each case was run alone with:

```sh
node --import tsx --test --test-name-pattern='D-038: <n>' \
  tests/p1-cli/d038-invite-form.test.ts
```

Before the source change, each invocation returned exit 1 with exactly one test and one
failure. After the source change, each invocation returned exit 0 with exactly one test and
one pass.

| Case | RED observation on frozen source | GREEN observation |
|---|---|---|
| 1. exact product web form equals CLI form | Whole HTTPS URL reached strict base64url error | Web and CLI wrappers decode identically; an arbitrary-host HTTPS wrapper also decodes locally |
| 2. current `cswarm://` remains accepted | Current form decoded, web side was rejected by positional parser | Both positional forms produce the same link payload |
| 3. bare `swm_inv_` remains accepted | Bare token parsed, web side was rejected | Bare token remains token mode; web form is link mode |
| 4. retired `coswarm://` | Whole retired wrapper reached strict base64url error | Retired wrapper decodes as an alias |
| 5. malformed payload stays strict | The valid-web positive arm failed before the malformed arm; a follow-up causal control also proved `%65…` was incorrectly normalized and accepted by the first candidate | Valid web wrapper decodes; both `invite=abc=` and a percent-escaped otherwise-valid payload receive the unchanged strict base64url error |
| 6. unrecognized wrapper gets wrapper guidance | Expected wrapper error but received strict base64url accusation | Decoder names the wrapper problem; positional parser names accepted input forms; neither blames base64url |

The focused six-test file also passed as one invocation: 6 tests, 6 passed, 0 failed.

One existing regression was caught during the broader CLI run: a padded bare payload had
temporarily been classified as an unrecognized wrapper. The raw-payload candidate path was
restored without weakening strict validation; the existing padding test and the six D-038
tests then passed together.

The first exact-SHA Codex review of candidate `9e9c80ef464d7fbe6442429cb78d04d7d18cb348`
returned a P1 finding: `URLSearchParams` decoded `%65…` before the strict validator saw it.
The new causal assertion failed 0/1 on that candidate with “Missing expected exception.” The
wrapper extractor now reads the named parameter from the raw fragment, so percent encoding is
not normalized into valid base64url; the same assertion then passed 1/1. The candidate was not
pushed. Both D-036 arms must run again on its replacement SHA.

## Gates

| Gate | Result |
|---|---|
| Frozen baseline `npm test` | 370 tests, 370 passed, 0 failed |
| Final `npm test` | 376 tests, 376 passed, 0 failed — count increased by the six named D-038 tests |
| `npm run test:p1-cli` | 143 tests, 143 passed, 0 failed |
| `npm run check:tests` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |

An intermediate final-tree `npm test` invocation reported 375/376 because the existing
`detached CLI cursor fallback still receives and replies` test raced while recursively
removing its temporary listener directory (`ENOTEMPTY`). An immediate isolated rerun hit the
same teardown race; a subsequent full `npm test` invocation passed 376/376. The D-038 tests
were green in every final-tree invocation. No listener code or listener test was changed.

## Not established

- No live two-human OAuth/acceptance journey was run, no production invitation capability
  was redeemed, and the post-auth behavior previously left unmeasured in D-038 remains
  unmeasured.
- The cause or frequency of the existing listener temporary-directory cleanup race was not
  established; only the final full-gate pass was established.
- Query-string invite extraction was not implemented or tested; the product's fragment form
  is the accepted web form.
- Nothing was deployed, tagged, released, or version-bumped. Production state was not
  changed or re-verified by this lane.
