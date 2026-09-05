# Round 3 arms on SHA c26d0e4 — grok PASS, gemini FAIL

A split verdict is not a vote. The FAIL was verified on the branch and ruled on.

## Gemini's one finding, and why it does not stand

> Exporting `CHANNEL_SUBCOMMAND_NAMES` from `src/cli.ts` and importing it in the
> test triggers `main()` at module evaluation. `process.argv[2]` will be the
> test file path, so `main()` throws a `UsageError`, the catch prints
> `cswarm: unknown command ...` and sets `process.exitCode = 1`, so the suite
> always exits 1 even when every assertion passes.

Measured on the branch, at SHA c26d0e4:

```
$ node --import tsx --test tests/p1-cli/chat-cli.test.ts > /tmp/x.log 2>&1; echo "EXIT=$?"
EXIT=0
$ grep -c "unknown command" /tmp/x.log
0
$ grep -E "^i (pass|fail)" /tmp/x.log
pass 21
fail 0
```

The stated mechanism is wrong. Under `node --test` the test file runs in a child
whose `process.argv` is `[node, <file>]`, so `argv[2]` is UNDEFINED. `main()`
takes the `!verb` branch, writes `usage()` to stdout, and returns normally. It
never reaches the unknown-command path, never throws a `UsageError`, and never
sets `process.exitCode`. The full gate agrees: `npm run test:p1-cli` exits 0 with
472 passing.

## The true part of the observation, and why it is not this lane's

`main()` DOES run when `src/cli.ts` is imported. That is real, and it prints 73
lines of usage text into the test output. It is also repo-wide and older than
this lane: THIRTEEN test files import `src/cli.js`, twelve of them on `main`
before this lane started.

```
$ grep -rln 'from "\.\./\.\./src/cli.js"\|from "\.\./src/cli.js"' tests/ | wc -l
13
$ node --import tsx --test tests/p1-cli/listener-provider.test.ts >/tmp/y.log 2>&1; echo "EXIT=$?"
EXIT=0                      # a PRE-EXISTING importer, same noise, same exit 0
$ grep -c "^Usage:" /tmp/y.log
1
```

Same shape as gemini's round-1 em-dash finding: a real property of `main`,
reported as a defect of this patch. Changing when `main()` runs would move
thirteen test files and every consumer of the module, which is a separate lane.
It is named in the lane report as an item for whoever picks it up.

## Ruling

Grok's PASS stands. Gemini's FAIL is refuted by the measurement above, so there
is nothing to fix and nothing to re-review. Both arms are recorded here in full.
