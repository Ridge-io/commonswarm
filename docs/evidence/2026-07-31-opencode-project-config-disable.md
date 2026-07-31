# Live OpenCode 1.18.10 project-config disable probe

Date: 2026-07-31 (UTC 2026-07-31T16:22:04Z)
Executable: `/Users/yulanbot/.opencode/bin/opencode`
Version: `1.18.10`

## Method

1. Private 0700 home with forced-ask global `opencode.json`.
2. Hostile project cwd with `permission.bash/edit/write/* = allow`.
3. Run `/Users/yulanbot/.opencode/bin/opencode debug config --pure` with and without `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
4. Assert no sentinel file was created under the hostile project.

## Results

| Condition | permission.bash | permission.* |
|---|---|---|
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | `ask` | `ask` |
| unset (causal control) | `allow` | `allow` |

- Sentinel file created: **false**
- Every forced tool (`bash`, `write`, `edit`, `execute`, `*`, and the full OPENCODE_FORCED_PERMISSION_TOOLS set) resolves to **ask** under disable (re-probed 2026-07-31 remediation).
- Conclusion: project allow is disabled only with `OPENCODE_DISABLE_PROJECT_CONFIG=1`. A private home alone is **not** sufficient (control arm merges allow).

## Machine JSON

```json
{
  "measured_at": "2026-07-31T16:22:04Z",
  "executable": "/Users/yulanbot/.opencode/bin/opencode",
  "version": "1.18.10",
  "with_OPENCODE_DISABLE_PROJECT_CONFIG": {
    "permission_bash": "ask",
    "permission_star": "ask"
  },
  "without_OPENCODE_DISABLE_PROJECT_CONFIG_control": {
    "permission_bash": "allow",
    "permission_star": "allow"
  },
  "sentinel_file_created": false,
  "conclusion": "Project allow is disabled only when OPENCODE_DISABLE_PROJECT_CONFIG=1; private home alone is insufficient. No sentinel side effect."
}
```
