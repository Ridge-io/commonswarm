#!/usr/bin/env bash
# Fail when a commit in the given range carries no agent-authorship trailers.
#
# WHY A GATE EXISTS AT ALL. Without one the trailer is missing on exactly the commits most worth
# auditing: the rushed ones, the ones pushed with --no-verify, the ones from a seat whose hook was
# never installed. An audit with holes in it is worse than no audit, because the holes are not
# random — they correlate with the thing being measured.
#
# SCOPE, stated plainly because overstating it would be the defect. This is an ACCIDENT GUARD, the
# same class as scripts/check-commit-identity.sh. GitHub runs the workflow that ships WITH the ref
# under test, so a change that edits this script, its workflow, or the vocabulary passes both.
# It catches a forgotten hook. It does not stop someone who means to lie about a model, and no
# in-repo check can.
#
# It ALSO cannot verify that a trailer is TRUE. `Agent-Model: claude-opus-5` on a commit a human
# typed is indistinguishable from an honest one. What the gate buys is that the field is never
# silently ABSENT, which is what makes `Agent-Model-Source` worth reading: a `declared` source is
# an assertion and a `runtime-transcript` source is a measurement, and the audit can weigh them
# differently.
#
# Exit codes, never conflated:
#   0  every commit in range carries the required trailers (or there were none to check)
#   1  at least one commit is missing them, or carries a value outside the vocabulary
#   2  the check COULD NOT RUN. NOT a pass.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-trailer-vocab.sh
. "$script_dir/lib/agent-trailer-vocab.sh"

# Every list below is built from the arrays in the vocabulary, never typed here.
required_keys_sentence() { agent_trailer_join "${AGENT_TRAILER_REQUIRED_KEYS[@]}"; }
families_sentence() { agent_trailer_join "${AGENT_TRAILER_FAMILIES[@]}"; }

trailer_value() {
  local sha="$1" key="$2"
  git show -s --format="%(trailers:key=${key},valueonly)" "$sha" 2>/dev/null | head -1 | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# Returns 0 when the commit is fine, 1 when it is not. Prints one diagnostic per problem.
check_commit() {
  local sha="$1"
  local subject bad=0
  subject="$(git show -s --format='%s' "$sha")"

  # Grace. If the commit's OWN TREE does not contain the hook, its author could not have installed
  # it from this repo, so the trailer is not required. See AGENT_TRAILER_HOOK_PATH in the
  # vocabulary for why this is the commit's own tree and not a date.
  #
  # Exit 2 here means SKIPPED, which the caller counts and reports separately — a skipped commit
  # must never be reported as a checked one.
  if ! git cat-file -e "${sha}:${AGENT_TRAILER_HOOK_PATH}" 2>/dev/null; then
    return 2
  fi

  # A merge commit's message is written by GitHub or by git, not by the agent that wrote the work.
  # The parent commits carry the trailers, so requiring them here would fail every merge forever
  # while adding nothing to the audit.
  if [ "$(git rev-list --no-walk --count --merges "$sha")" -gt 0 ]; then
    return 0
  fi

  local key value
  for key in "${AGENT_TRAILER_REQUIRED_KEYS[@]}"; do
    value="$(trailer_value "$sha" "$key")"
    if [ -z "$value" ]; then
      printf 'MISSING  %s  %s: %s\n' "$(git rev-parse --short "$sha")" "$key" "$subject"
      bad=1
    fi
  done

  value="$(trailer_value "$sha" Agent-Family)"
  if [ -n "$value" ] && ! agent_trailer_contains "$value" AGENT_TRAILER_FAMILIES; then
    printf 'BAD-VALUE %s  Agent-Family: %s (expected one of: %s)\n' \
      "$(git rev-parse --short "$sha")" "$value" "$(families_sentence)"
    bad=1
  fi

  value="$(trailer_value "$sha" Agent-Model-Source)"
  if [ -n "$value" ] && ! agent_trailer_contains "$value" AGENT_TRAILER_SOURCES; then
    printf 'BAD-VALUE %s  Agent-Model-Source: %s (expected one of: %s)\n' \
      "$(git rev-parse --short "$sha")" "$value" "$(agent_trailer_join "${AGENT_TRAILER_SOURCES[@]}")"
    bad=1
  fi

  return "$bad"
}

check_range() {
  local range="$1"
  if ! git rev-list --no-walk "$range" >/dev/null 2>&1 && ! git rev-list "$range" >/dev/null 2>&1; then
    printf 'agent-trailers: COULD NOT RUN — cannot resolve range %s\n' "$range" >&2
    printf 'agent-trailers: this is not a pass. Fetch the base ref and retry.\n' >&2
    return 2
  fi

  local -a shas=()
  while IFS= read -r sha; do [ -n "$sha" ] && shas+=("$sha"); done < <(git rev-list "$range")

  if [ "${#shas[@]}" -eq 0 ]; then
    printf 'agent-trailers: no commits in range %s — nothing to check\n' "$range"
    return 0
  fi

  local bad=0 skipped=0 checked=0 sha status
  for sha in "${shas[@]}"; do
    status=0
    check_commit "$sha" || status=$?
    case "$status" in
      0) checked=$((checked + 1)) ;;
      2) skipped=$((skipped + 1)) ;;
      *) checked=$((checked + 1)); bad=$((bad + 1)) ;;
    esac
  done

  if [ "$bad" -gt 0 ]; then
    cat >&2 <<MSG

AGENT-AUTHORSHIP TRAILERS MISSING OR INVALID on $bad of $checked commit(s) checked.

A commit whose own tree has no $AGENT_TRAILER_HOOK_PATH predates this rule and is skipped; $skipped
of ${#shas[@]} in this range were skipped for that reason. The ones named above are not.

Every commit records the model that wrote it, so past work can be audited as new models ship.
Required on each commit: $(required_keys_sentence)

Install the hook once and this happens without anyone remembering:

    npm run hooks:install

Then fix the commits already made:

    git commit --amend --no-edit          # the last one
    git rebase -r --exec 'git commit --amend --no-edit' <base>   # several

If the commit genuinely has NO agent author — a human wrote it by hand — say so explicitly
rather than leaving the field blank:

    CSWARM_AGENT_MODEL=$AGENT_TRAILER_MODEL_NO_AGENT git commit --amend --no-edit

If an agent wrote it but its runtime exposes no readable model, the honest value is
'$AGENT_TRAILER_MODEL_UNKNOWN' with Agent-Model-Source 'none'. Do NOT type a model name you did
not read off the runtime: a wrong value is worse than an absent one, because it is invisible.

Format and escape hatches: docs/development/agent-trailers.md
MSG
    return 1
  fi

  if [ "$skipped" -gt 0 ]; then
    printf 'agent-trailers OK: %d commit(s) checked in %s; %d skipped as having no %s in their own tree\n' \
      "$checked" "$range" "$skipped" "$AGENT_TRAILER_HOOK_PATH"
  else
    printf 'agent-trailers OK: %d commit(s) checked in %s\n' "$checked" "$range"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Self-test
#
# CI runs this and parses the assertion count out of the last line. AN EXIT CODE CANNOT CERTIFY
# THAT A TEST RUN HAPPENED — deleting the body of this function would make --self-test exit 0
# having asserted nothing, and a bare `run:` would accept that as green. The count is what makes
# the CI step able to tell "passed" from "did not run".
#
# This is also the mutation test the gate needs in order to be a gate: assertions below build a
# commit WITHOUT trailers and require check_range to return 1 on it. A guard nobody has watched
# fail is not a guard.
# ---------------------------------------------------------------------------

selftest_assertions=0
selftest_failures=0

assert_status() {
  local expected="$1" actual="$2" what="$3"
  selftest_assertions=$((selftest_assertions + 1))
  if [ "$expected" != "$actual" ]; then
    printf 'self-test FAIL: %s (expected exit %s, got %s)\n' "$what" "$expected" "$actual" >&2
    selftest_failures=$((selftest_failures + 1))
  fi
}

assert_equal() {
  local expected="$1" actual="$2" what="$3"
  selftest_assertions=$((selftest_assertions + 1))
  if [ "$expected" != "$actual" ]; then
    printf 'self-test FAIL: %s (expected [%s], got [%s])\n' "$what" "$expected" "$actual" >&2
    selftest_failures=$((selftest_failures + 1))
  fi
}

# Commit with an arbitrary message in the fixture repo. Identity is passed with -c so the fixture
# does not depend on the machine's git config. The file defaults to file.txt; the merge assertion
# passes a different one so the branches do not conflict — a conflicting merge exits non-zero and,
# under `set -e`, would abort the suite rather than fail an assertion.
fixture_commit() {
  local message="$1" file="${2:-file.txt}"
  printf '%s\n' "$RANDOM" >>"$file"
  git add "$file"
  git -c user.name='Fixture' -c user.email='fixture@cloud-swarm.local' \
    commit --quiet --no-verify -m "$message"
}

run_selftest() {
  local checker="$script_dir/check-agent-trailers.sh"
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  # THE FIXTURE'S BASE COMMIT CARRIES THE HOOK, and that line is load-bearing. Grace skips any
  # commit whose own tree has no hook, so a fixture repo without one would put EVERY assertion
  # below on the skipped side: assertion 1 ("an untagged commit is rejected") would then fail, and
  # a fixture built to hide that would leave the gate green while checking nothing. The path comes
  # from the constant, so renaming the hook moves the fixture with it.
  (
    cd "$tmp"
    git init --quiet -b main .
    mkdir -p "$(dirname "$AGENT_TRAILER_HOOK_PATH")"
    printf '#!/bin/sh\nexit 0\n' >"$AGENT_TRAILER_HOOK_PATH"
    git add "$AGENT_TRAILER_HOOK_PATH"
    git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --no-verify -m "base"
  ) >/dev/null 2>&1

  local status out

  # 1. THE MUTATION: a commit with no trailers at all must FAIL. If this assertion ever passes
  #    trivially, the gate is decorative.
  ( cd "$tmp" && fixture_commit "feat: untagged work" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 1 "$status" "a commit with no Agent-* trailers is rejected"

  # 2. The same commit passes once the trailers are there.
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "feat: tagged work

Agent-Model: claude-opus-5
Agent-Family: anthropic
Agent-Model-Source: runtime-transcript" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "a commit with the required trailers is accepted"

  # 3. Each required key is INDIVIDUALLY load-bearing. Without this, deleting a key from the
  #    required list would still leave assertion 1 green, and the gate would quietly weaken.
  local key
  for key in "${AGENT_TRAILER_REQUIRED_KEYS[@]}"; do
    local body=""
    local other
    for other in "${AGENT_TRAILER_REQUIRED_KEYS[@]}"; do
      [ "$other" = "$key" ] && continue
      body="${body}${other}: anthropic"$'\n'
    done
    ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
        commit --quiet --amend --no-verify -m "feat: partial

${body}" ) >/dev/null 2>&1
    status=0
    ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
    assert_status 1 "$status" "a commit missing only $key is rejected"
  done

  # 4. The escape hatch works: a human-authored commit is accepted when it SAYS so.
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "docs: written by hand

Agent-Model: $AGENT_TRAILER_MODEL_NO_AGENT
Agent-Family: human
Agent-Model-Source: declared" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "the human escape hatch is accepted"

  # 5. The honest-ignorance sentinel is accepted too. It must be, or the pressure is to type a
  #    fake model name — the one outcome the whole design is trying to prevent.
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "chore: unreadable runtime

Agent-Model: $AGENT_TRAILER_MODEL_UNKNOWN
Agent-Family: unknown
Agent-Model-Source: none" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "the unknown-model sentinel is accepted"

  # 6. A family outside the vocabulary is rejected. This is what stops a typo'd or invented family
  #    from entering the audit as if it were a real one.
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "chore: bogus family

Agent-Model: something
Agent-Family: nonesuch
Agent-Model-Source: declared" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 1 "$status" "a family outside the vocabulary is rejected"

  # 7. Every family IN the vocabulary is accepted. Pairs with 6 so the check discriminates rather
  #    than merely rejecting; and it is generated from the array, so adding a family cannot leave
  #    a stale expectation behind.
  local family
  for family in "${AGENT_TRAILER_FAMILIES[@]}"; do
    ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
        commit --quiet --amend --no-verify -m "chore: family probe

Agent-Model: probe
Agent-Family: $family
Agent-Model-Source: declared" ) >/dev/null 2>&1
    status=0
    ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
    assert_status 0 "$status" "family '$family' from the vocabulary is accepted"
  done

  # 8. A source outside the vocabulary is rejected, and every listed one accepted.
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "chore: bogus source

Agent-Model: probe
Agent-Family: unknown
Agent-Model-Source: telepathy" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 1 "$status" "a model-source outside the vocabulary is rejected"

  local source
  for source in "${AGENT_TRAILER_SOURCES[@]}"; do
    ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
        commit --quiet --amend --no-verify -m "chore: source probe

Agent-Model: probe
Agent-Family: unknown
Agent-Model-Source: $source" ) >/dev/null 2>&1
    status=0
    ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
    assert_status 0 "$status" "model-source '$source' from the vocabulary is accepted"
  done

  # 9. An unresolvable range is exit 2 and NOT exit 0. Conflating "nothing to check" with "could
  #    not check" is how a guard fails open; prompteden's pre-push hook shipped that defect once.
  status=0
  ( cd "$tmp" && "$checker" --range "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 2 "$status" "an unresolvable range exits 2, not 0"

  # 10. An empty-but-valid range is exit 0 and says nothing was checked.
  status=0
  out="$( cd "$tmp" && "$checker" --range "HEAD..HEAD" 2>&1 )" || status=$?
  assert_status 0 "$status" "an empty range exits 0"
  selftest_assertions=$((selftest_assertions + 1))
  case "$out" in
    *"nothing to check"*) : ;;
    *) printf 'self-test FAIL: empty range does not say nothing was checked\n' >&2
       selftest_failures=$((selftest_failures + 1)) ;;
  esac

  # 11. The emitter and this checker agree. The block agent-trailers.sh produces must pass the
  #     gate — otherwise the hook writes commits that CI rejects, which is the worst failure mode
  #     because it appears only after the work is done.
  local emitted
  emitted="$("$script_dir/agent-trailers.sh" --emit)"
  ( cd "$tmp" && git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      commit --quiet --amend --no-verify -m "feat: emitter round-trip

$emitted" ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "the block agent-trailers.sh emits passes this gate"

  # 12. ...and it really carries a model, rather than passing because the gate is lenient.
  local emitted_model
  emitted_model="$( cd "$tmp" && git show -s --format='%(trailers:key=Agent-Model,valueonly)' HEAD | head -1 | tr -d ' \r' )"
  selftest_assertions=$((selftest_assertions + 1))
  if [ -z "$emitted_model" ]; then
    printf 'self-test FAIL: the emitted block carried no Agent-Model value\n' >&2
    selftest_failures=$((selftest_failures + 1))
  fi

  # 13. THE HOOK ROUND-TRIP. Assertion 11 proves the emitted block passes the gate, which is NOT
  #     the same claim: the gate only requires two keys, so a hook that silently dropped the
  #     others would still pass it. This runs the real hook over a real message file and requires
  #     EVERY key the emitter produced to survive.
  #
  #     This is the assertion that catches the measured defect: `--if-exists doNothing` makes git
  #     treat Agent-Model-Source as the same token as Agent-Model and drop it, exit 0, no error.
  local hook="$script_dir/hooks/prepare-commit-msg"
  if [ -x "$hook" ]; then
    local msg_file="$tmp/COMMIT_EDITMSG_probe"
    printf 'feat: hook round-trip\n\nbody\n' >"$msg_file"
    ( cd "$(git -C "$script_dir/.." rev-parse --show-toplevel)" && "$hook" "$msg_file" ) >/dev/null 2>&1 || true
    local emitted_key
    while IFS= read -r emitted_key; do
      [ -n "$emitted_key" ] || continue
      emitted_key="${emitted_key%%:*}"
      selftest_assertions=$((selftest_assertions + 1))
      if ! grep -qi "^${emitted_key}:" "$msg_file"; then
        printf 'self-test FAIL: the hook dropped the trailer %s from the message\n' "$emitted_key" >&2
        selftest_failures=$((selftest_failures + 1))
      fi
    done <<EOF
$emitted
EOF

    # ...and running it twice must not duplicate the block.
    ( cd "$(git -C "$script_dir/.." rev-parse --show-toplevel)" && "$hook" "$msg_file" ) >/dev/null 2>&1 || true
    assert_equal 1 "$(grep -ci '^Agent-Model:' "$msg_file" | tr -d ' ')" \
      "running the hook twice does not duplicate the block"
  fi

  # 14. A merge commit is exempt, because its message is written by git or GitHub and its parents
  #     carry the trailers.
  local merge_setup=0
  ( cd "$tmp"
    git checkout --quiet -b side HEAD~1
    fixture_commit "side: work

Agent-Model: probe
Agent-Family: unknown
Agent-Model-Source: declared" side.txt
    git checkout --quiet main
    git -c user.name=Fixture -c user.email=fixture@cloud-swarm.local \
      merge --quiet --no-ff --no-verify -m "Merge branch 'side'" side
  ) >/dev/null 2>&1 || merge_setup=$?
  # Assert the fixture itself built, so a broken merge setup fails loudly instead of making the
  # exemption assertion below pass for the wrong reason.
  assert_status 0 "$merge_setup" "the merge fixture was built"
  assert_equal 2 "$( cd "$tmp" && git rev-list --no-walk --count --parents HEAD >/dev/null 2>&1; \
    cd "$tmp" && git show -s --format='%p' HEAD | wc -w | tr -d ' ' )" \
    "the fixture HEAD really is a merge commit (two parents)"
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD^..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "a merge commit is exempt from the trailer requirement"

  # 15. THE GRACE PAIR. A commit whose own tree has no hook predates the rule and is accepted with
  #     no trailers; the same untagged commit WITH the hook in its tree is rejected. Neither means
  #     anything alone — the first also passes on a gate that accepts everything, the second on one
  #     that rejects everything. Together they show the hook's presence is what decides.
  ( cd "$tmp" && git checkout --quiet -b grace main ) >/dev/null 2>&1
  ( cd "$tmp"
    git rm --quiet "$AGENT_TRAILER_HOOK_PATH"
    fixture_commit "chore: a checkout that never had the hook" grace.txt
  ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 0 "$status" "an untagged commit whose tree has no hook is accepted"

  # ...and the output must SAY it was skipped rather than counting it as checked. A gate that
  # silently drops commits from its own total is how a reader concludes work was audited when it
  # was not.
  out="$( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" 2>&1 )" || true
  selftest_assertions=$((selftest_assertions + 1))
  case "$out" in
    *"1 skipped as having no $AGENT_TRAILER_HOOK_PATH in their own tree"*) : ;;
    *) printf 'self-test FAIL: a grace-skipped commit is not reported as skipped (got: %s)\n' "$out" >&2
       selftest_failures=$((selftest_failures + 1)) ;;
  esac

  ( cd "$tmp"
    mkdir -p "$(dirname "$AGENT_TRAILER_HOOK_PATH")"
    printf '#!/bin/sh\nexit 0\n' >"$AGENT_TRAILER_HOOK_PATH"
    git add "$AGENT_TRAILER_HOOK_PATH"
    fixture_commit "chore: a checkout that has the hook" grace.txt
  ) >/dev/null 2>&1
  status=0
  ( cd "$tmp" && "$checker" --range "HEAD~1..HEAD" ) >/dev/null 2>&1 || status=$?
  assert_status 1 "$status" "an untagged commit whose tree has the hook is rejected"

  # 16. THE HOOK PATH MUST NAME A REAL FILE IN THIS REPO. Assertion 15 builds its fixtures from the
  #     constant so they move with it, which is what keeps them from going stale — and is exactly
  #     why they cannot notice a constant that points at nothing. A path naming no file skips every
  #     real commit and leaves the gate green while checking nothing, the same decorative-gate
  #     failure a cutoff date in the future would have caused. This assertion is the one that fails
  #     on that mutation.
  selftest_assertions=$((selftest_assertions + 1))
  if [ ! -f "$script_dir/../$AGENT_TRAILER_HOOK_PATH" ]; then
    printf 'self-test FAIL: %s names no file, so every commit is skipped and the gate checks nothing\n' \
      "$AGENT_TRAILER_HOOK_PATH" >&2
    selftest_failures=$((selftest_failures + 1))
  fi

  if [ "$selftest_failures" -gt 0 ]; then
    printf 'self-test: FAILED %d of %d assertions\n' "$selftest_failures" "$selftest_assertions"
    return 1
  fi
  printf 'self-test: PASSED %d assertions\n' "$selftest_assertions"
  return 0
}

usage() {
  cat <<MSG
usage: $0 --range <git-range>
       $0 --self-test

Required trailers on every non-merge commit: $(required_keys_sentence)
Accepted families: $(families_sentence)

A commit whose own tree has no $AGENT_TRAILER_HOOK_PATH predates this rule and is not checked.

Exit codes: 0 clean, 1 a commit is missing or has an invalid trailer, 2 the check could not run.
MSG
}

case "${1:-}" in
  --range)
    [ $# -ge 2 ] || { usage >&2; exit 2; }
    check_range "$2"
    ;;
  --self-test) run_selftest ;;
  --help | -h) usage ;;
  *) usage >&2; exit 2 ;;
esac
