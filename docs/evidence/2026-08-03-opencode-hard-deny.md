# OpenCode 1.18.10 hard-deny measurement

Date: 2026-08-03  
Scope: D-040 Fix 5, cross-owner listener turns

## Exact subject

- Local executable: `/Users/yulanbot/.opencode/bin/opencode`
- `opencode --version`: `1.18.10`
- Upstream repository: `anomalyco/opencode`
- Tag: `v1.18.10`
- Resolved upstream commit: `7902e04`

## Measured configuration surface

CommonSwarm starts the restricted child with the fixed environment value:

```text
OPENCODE_PERMISSION={"*":"deny"}
```

The same environment and executable used for the child were passed to:

```text
opencode debug config --pure
```

The exact positive-control result was:

```json
{"wildcard":"deny","lastKey":"*","allows":[]}
```

The executable version was separately measured as `1.18.10`. The host rejects
the probe if any effective permission entry
is `allow`, or if the final permission entry is not the wildcard deny.

## Enforcement path checked in the tagged source

At `7902e04`:

- `packages/opencode/src/config/config.ts` merges `OPENCODE_PERMISSION` after
  file and managed configuration.
- `packages/opencode/src/permission/index.ts` converts permission object order
  into rules, selects the last matching rule, and identifies tools whose final
  wildcard rule is `deny`.
- `packages/opencode/src/session/llm/request.ts` filters those disabled tools
  from the model request before sending it.

This explains why the shared dynamic permission canary cannot run on the same
hard-denied child: the model receives no tool with which to exercise that path.
The isolated child is enabled only after the exact effective-config probe.
Same-owner workers retain the dynamic ACP canary. The ACP permission callback
also remains reject-by-default if a restricted child unexpectedly sends a
permission request.

## Negative boundary and limitations

- The same-owner child environment has no `OPENCODE_PERMISSION` override.
- A hostile parent value such as `{"*":"allow"}` is removed by child-env
  sanitisation and replaced only for the restricted child.
- No billable model turn was used to ask a child to invoke a denied tool.
- This is an OpenCode enforcement layer, not an operating-system sandbox.
