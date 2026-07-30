# Legal draft date label and widened placeholder guard

Task: `legal-draft-date-guard` · agent Onyx · base `01f5446`

## Product change

- While `draft={true}`, LegalDoc labels the first date field **Proposed effective**
  (not Effective). Final pages keep **Effective**.
- Terms / Privacy / Acceptable Use remain `draft={true}`; bodies and date values
  unchanged. **No legal document was activated or legally approved.**

## Guard change

`scanLegalDocPlaceholders` in `site/src/lib/legal-placeholders.ts` scans every
user-visible field: title, lede, effective, updated, section id/title, and all
nested block/list/note strings. Final documents (`draft={false}`) fail the build
if any `[[PLACEHOLDER]]` remains.

## Causal negative control (exact worktree)

Commands and results on this worktree:

1. Clean `npm --prefix site run build` → **GREEN**  
   log: `docs/evidence/2026-07-30-legal-draft-guard-green1.log`
2. Temporary mutation: inject `[[NEGATIVE_CONTROL]]` into the Terms **lede** and
   set that page `draft={false}` (fields previously excluded from the body-only
   scan). Same build command → **RED**, error names `NEGATIVE_CONTROL`  
   log: `docs/evidence/2026-07-30-legal-draft-guard-red-negative-control.log`
3. Restore `site/src/pages/terms.astro` **byte-identical** to pre-mutation  
   (`cmp` + `sha256sum -c` against pristine snapshot).
4. Clean rebuild → **GREEN**  
   log: `docs/evidence/2026-07-30-legal-draft-guard-green2.log`

## Gates after restore

Recorded at freeze (tip reported externally in COMPLETE):

- `npm run test:site` — see COMPLETE
- `npm run check:tests` — see COMPLETE

### Command transcript (abridged)

```sh
rm -rf site/dist && npm --prefix site run build
# → green1 exit 0

# mutate terms.astro lede + draft={false}
rm -rf site/dist && npm --prefix site run build
# → red exit 1; log contains NEGATIVE_CONTROL

cp terms.astro.pristine site/src/pages/terms.astro
cmp terms.astro.pristine site/src/pages/terms.astro

rm -rf site/dist && npm --prefix site run build
# → green2 exit 0
```
