# Slack-shaped workspace UI report

Date: 2026-08-04

Branch: `ui/slack-shape`

Starting commit: `1314557`

## Outcome

The dashboard now uses the light, Slack-shaped workspace frame described in
`docs/design/2026-08-03-SLACK-SHAPE-UI.md` and the resolved goal contract:

- a neutral light field with a warm, quiet rail and a white reading column;
- a monospace workspace name and `# all-signals` channel identity;
- rail sections for `STREAMS`, `PEOPLE`, and `AGENTS`;
- real broadcast and direct-signal counts derived from the signals already loaded in the
  browser;
- a fixed `14rem` height and matching maximum with internal vertical scrolling on the AGENTS list;
- person and agent initial avatars, literal `PERSON` / `AGENT` badges, agent presence dots,
  and inline `operated by …` attribution;
- `All`, `Broadcast`, and `Direct to you` client-side feed filters;
- whitespace and hairlines in place of the prior framed dashboard card treatment;
- the existing target chips, identity badges, operator attribution, and direct-row tint;
- the existing header roster dialog as the sole agent-management surface.

The dashboard owns its light palette locally, including when the operating system prefers a
dark scheme, so the change does not leave a dark rail or dark controls beside a light feed.

## Diff scope

- `site/src/components/app/LiveDashboard.astro` — workspace frame, rail participant rendering,
  loaded-signal counts, feed filtering, responsive treatment, and dashboard-scoped visual system.
- `site/src/lib/signal-feed.ts` — executable loaded-signal classification shared by filters and
  counts.
- `site/src/components/app/slack-shape.observer.test.ts` — six new shape, behavior, rendered
  geometry, and emitted-artifact checks.
- `REPORT.md` — this report.

No root `src/`, Supabase, schema, migration, edge-function, manifest, lockfile, or deployment file
was changed.

## Test evidence

The goal packet records the clean pre-change baseline as:

```text
tests 118
pass 118
fail 0
```

My first clean pre-change full run executed all 118 tests but reported 117 passes because Chrome
was killed after the geometry observer had produced its measurements. Running that unchanged
observer by itself immediately passed 1/1. This was an execution failure, not a failed geometry
assertion; the final full gate below completed without it.

Before implementation, the new observer was run against the pre-change dashboard and built
artifact. All five new checks failed: rail grouping/bounds, channel framing, filters, real sidebar
counts/light field, and agent presence.

After implementation and the exact-review corrections, the clean full built site gate was:

```text
tests 124
pass 124
fail 0
```

The new file is reached by the site test script's
`src/components/**/*.observer.test.ts` glob. `site/scripts/test-gate-coverage.test.mjs` reported
`unreachable = []`.

### Existing tests modified

None relative to the task's starting commit, `1314557`. In particular,
`site/src/components/app/header-roster.observer.test.ts` is byte-unchanged. Its complete suite
stayed green, including the prohibition on restoring the old unbounded rail management list. The
new bounded list uses separate sidebar hooks and contains no Remove or Add management controls.

The new `slack-shape.observer.test.ts` was strengthened during exact review before landing: source
patterns for counts and filters became executable mixed-target behavior checks, sign-out clearing
was pinned with explicit participant-list and count clearing, workspace transitions were required to
refresh signal counts even on empty and error paths, and a Chrome geometry fixture now proves that 3
and 50 agents occupy the same rail height while the 50-row list scrolls.

## Render inspection

The freshly built `/app` sample was inspected at 1440×1000. The desktop render showed the complete
participant rail, one tinted direct row, two untinted broadcast rows, and the typographic hierarchy
specified by the direction document. Chrome's screenshot process enforces a 500px minimum inner
width, so its nominal 390px image was a crop rather than mobile evidence. I then applied a true
390×844 device-metrics override through Chrome's debugging protocol: the participant rail
collapsed, the header roster remained available, and both the document and body reported
`clientWidth = scrollWidth = 390` with no element crossing the viewport.

The design pass followed a restrained editorial/developer-tool direction: colour is limited to
meaningful state and identity, while spacing, weight, and hairlines carry the structure.

## Not established

- No deployment, production check, authenticated browser session, database query, or RLS/privacy
  measurement was performed.
- The UI states addressees only. It makes no claim about who can read a direct signal.
- Counts describe the signals loaded in the browser, including older pages after the user loads
  them; they do not claim a server-wide total. Deliveries were omitted because the loaded dashboard
  data cannot derive that count.
- Presence dots indicate membership in the active loaded roster. Online health or last-seen state
  was not available and is not asserted.
- The original mockup image was unavailable. Exact avatar hues, rail width, and spacing were chosen
  from the written aesthetic direction and verified in the rendered sample; pixel parity with the
  unavailable image was not established.
- Threads, the profile panel, composer targeting, workspace-owned agents, commands, schemas, and
  signal-send behavior remain unchanged and out of scope.
