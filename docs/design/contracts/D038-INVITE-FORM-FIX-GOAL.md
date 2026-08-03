# /goal — accept the link the product actually hands out, and stop blaming the payload

Worker: **Sill** (Codex). Lane: D-038, invite link form.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `src/cloud/invite-link.ts`, `src/cli.ts` (accept-path messages only), and their tests.
**The Lead will not commit to this branch while you hold it.**

## The defect (D-038 in the register — read it first)

The product generates **only** `https://commonswarm.com/invite#invite=<payload>`
(`site/src/lib/member-invite.ts:176`). The CLI accepts **only** `cswarm://accept/<payload>` or a bare
`swm_inv_` capability. No `cswarm://` form exists anywhere in `site/` — verified.

So there is no path from "the link you were sent" to "the command the README documents".

And the error misleads. `decodeInviteLink` (`src/cloud/invite-link.ts:181-183`) strips
`cswarm://accept/` **if present** and otherwise passes **the whole string** to the strict base64url
check, which fails on the URL's own colons, slashes and hash:

```
invite link payload must be strict unpadded base64url
```

The payload was never the problem. The **wrapper** was. The message accuses the wrong thing and
offers nothing actionable.

Evidence this is a real first-run path, not a papercut: the Lead, asked to mint an invite, copied the
web link from the dashboard and sent it — the same reflex any human has — and the laptop worker then
hit this error and had to hand-convert the form.

## The fix — accept the form the product emits

**Preferred: make the CLI accept the web link.** If the input is an `http(s)` URL whose fragment (or
query) carries `invite=<payload>`, extract that payload and proceed exactly as if it had arrived as
`cswarm://accept/<payload>`. That makes *"Send one link. They connect their agent"* true instead of
scoping it down.

Constraints on that:

- Extract from the **fragment** as the site emits it; if you also accept a query parameter, say so.
- Do **not** fetch the URL. Parse it locally — the payload is self-contained, and a CLI that
  dereferences a user-supplied URL is a new attack surface.
- Do **not** relax the strict base64url check on the extracted payload. The wrapper is what changes;
  the payload validation stays exactly as strict.
- Host is not a trust decision here — the payload is validated on its own merits — but if you accept
  any `http(s)` host, note that plainly rather than silently.

**Also fix the message.** When input is not any recognised form, the error must not accuse the
payload encoding. Distinguish: an unrecognised wrapper, versus a recognised wrapper with a bad
payload. Product voice — say what happened, what is true, what to do next.

## Second-order, in scope because it shares the code path

`0.0.1` accepts only `coswarm://accept/`; `0.1.4` only `cswarm://accept/`. Each rejects the other with
the same misleading message. **Accept the retired `coswarm://` scheme too**, treating it as an alias,
so a saved link or old runbook still works. If you think that is wrong — that a retired scheme should
be refused loudly rather than silently honoured — say so and make the refusal *explicit and named*
rather than a base64url complaint.

## Tests — must discriminate

Add tests, and prove each **RED before, GREEN after**:

1. the exact web form the site emits is accepted and yields the same payload as the `cswarm://` form;
2. `cswarm://accept/<payload>` still works (no regression);
3. a bare `swm_inv_` capability still works (no regression);
4. `coswarm://accept/<payload>` is handled per your decision above — accepted, or refused with a
   *named* reason that is not the base64url message;
5. a genuinely malformed payload inside a valid wrapper still fails the strict base64url check —
   the validation must not have been loosened;
6. an unrecognised input produces the new message, not the payload accusation.

If a test cannot be made to fail first, say so — it does not discriminate.

## Gates

`npm test` (count should rise), `npm run check:tests`, `npm run build`, `git diff --check`. No DB
lane needed. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`docs/evidence/2026-08-02-v015-execution/d038-invite-form-fix.md` — **committed, not scratchpad** —
with the diff, each red-then-green proof, your decision on `coswarm://`, and the gate counts.

## Non-goals

Do not change `site/` — whether the product *also* emits a CLI-form link is a separate decision. Do
not touch the invite payload schema, the token format, or anything in `supabase/`. No version bump,
deploy, tag, or release. Do not join the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a test cannot be made red first · the fix would require loosening payload
validation (stop and report — that is the wrong trade) · any existing test regresses.

State what you did **not** establish.
