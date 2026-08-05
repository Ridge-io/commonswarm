# UI queue evidence

Branch: `ui/queue`

Base: `fb94d19`

## Packets

1. `8e41ade` — flattened the workspace participant rail. People and agents share one
   aligned list. Agent rows retain tinted avatars and presence, name their operator, and
   expose the full name through `title`. Person rows show only their role. The rejected
   parent-child list and repeated `PERSON` / `AGENT` badges were removed.
2. `410d6d9` — added peer `Add an agent` and `Invite a collaborator` actions, reduced the
   workspace-creation form, removed the current-stream box treatment, renamed the duplicate
   member disclosure to `Manage people`, and changed the participant list from a fixed
   `block-size` to a `max-block-size` cap.
3. `69ef17d` — removed the model input, datalist, validation, and visibility logic from
   agent onboarding. A new web-created identity omits `model`; existing null rendering stays
   `Model not specified`. The one-time-key warning moved from the naming form to the result.

## Gate

The starting tree passed 145 of 145 site tests after a clean build. The final source tree
passed 146 of 146 after a clean build. The extra test observes that the model picker stays
absent and the key warning appears only after a prompt exists.

The environment rejected the requested `rm -rf site/dist` command before execution. For
each clean build, the resolved `site/dist` directory was moved to a fresh temporary directory
before `npm --prefix site run build`; the build therefore started with no `site/dist` path.

`header-roster.observer.test.ts` was not changed and stayed green. The dashboard color-literal
guard stayed green. `tokens.css` and `supabase/` were not changed.

Existing tests changed:

- `owner-grouped-rail.observer.test.ts`: the rejected nesting assertion became a flat-list
  assertion that requires operator copy and forbids nested owner lists and rail badges.
- `slack-shape.observer.test.ts`: the agent identity assertion now pins tinted avatar and
  presence treatment instead of the deleted badge; the rendered geometry fixture now uses
  flat rows and proves a short list shrinks while a large list caps and scrolls.
- `workspace-entry.observer.test.ts`: the empty-state observer now requires both peer actions,
  the collaborator route, reduced creation copy, the accessible unlabeled input, and the
  action-oriented people disclosure.
- `access-lifecycle.observer.test.ts`: a new observer requires the model control and its copy
  to remain absent, while the key warning is present only in the result panel. Its existing
  `Model not specified` assertion remains.

Model-rendering assertions in `entity-panel.observer.test.ts` were left unchanged.
`header-roster.observer.test.ts` and `connect/agent-prompt.observer.test.ts` were also left
unchanged because they do not assert that the removed input exists.

## Rendered inspection

All images are 1440 × 1000 renders of the clean built `/app` route in its explicit light and
dark modes:

- `participants-light.png`
- `participants-dark.png`
- `empty-workspace-light.png`
- `empty-workspace-dark.png`
- `create-workspace-light.png`
- `create-workspace-dark.png`
- `agent-form-light.png`
- `agent-form-dark.png`

Observed in both schemes:

- Participant names share one left rhythm. People use outlined avatars and role metadata;
  agents use smaller tinted avatars, presence, and quiet `operated by` metadata.
- Dana Rivera has multiple agents, Kenji Ito has none, and the final agent uses the honest
  `Owner unavailable` fallback. Its long machine-style name truncates with an ellipsis.
- The participant list ends at its content. The former reserved gap is absent.
- The STREAMS heading has no surrounding box treatment.
- The empty workspace gives `Add an agent` and `Invite a collaborator` equal button treatment.
- The create screen shows one heading, one sentence, one input, and one action. The input has
  an `aria-label`; no visible label or eyebrow repeats “workspace.”
- The agent form asks for `Name it` and has no model control. The pre-key warning is absent.

The built sample workspace supplies the page shell. For the participant screenshots only,
the rendered final sample agent row was changed in the DOM from Lumen to a long unresolved
owner fixture. This produced the required combination of two people, one with multiple
agents, one with none, and one unresolved agent without changing source or backend state.
The empty, create, and agent-form screenshots expose markup that sample mode normally keeps
hidden. They use the built component CSS and markup, but do not represent a browser-authenticated
workflow.

## Not established

- No production deployment, push, Supabase mutation, database test, or real invitation was
  performed.
- The screenshots do not establish production data behavior, a successful credential mint,
  model self-identification by the CLI, or that a collaborator accepted an invite.
- Visual inspection covered one desktop viewport in Chromium. It did not measure contrast
  ratios or cover responsive widths, other browsers, screen readers, or OS font rendering.
