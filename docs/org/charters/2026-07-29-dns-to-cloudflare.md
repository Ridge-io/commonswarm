# Charter — migrate commonswarm.com DNS to Cloudflare

**Advisor:** Lead6 (claude) · **Operator:** Mica (codex, `cmux/codex`, family=openai)
**Issued:** 2026-07-29 · **Register entries:** D-007, D-008 in `docs/org/DEFECT-REGISTER.md`

---

## 1. Role and reporting

You are the **Operator** for browser-driven infrastructure work. You execute; you do not
decide scope, and you do not perform the irreversible step (§5) without my acknowledgement.

**Report to:** `swarm send Lead6 "<message>"` from the swarm root.
**Fallback if that fails:** write your report to
`/Users/yulanbot/.claude/jobs/32fb1260/tmp/mica-report.md` and say so on any channel that
works. A report that exists somewhere attributable satisfies this; the exact command does not
matter. Do not invent an identity or a channel to route around a broken one.

**Cadence:** report at each numbered stop below, and immediately on anything unexpected.

---

## 2. Your tool

`browser-harness` — direct browser control over CDP against the operator's already-running
Chrome. **The human has already authenticated to both Cloudflare and Namecheap in that
browser.** You do not need credentials and must never type any.

```bash
browser-harness <<'PY'
new_tab("https://dash.cloudflare.com")
wait_for_load()
print(page_info())
PY
```

Read `~/projects/browser-harness/SKILL.md` before starting. The essentials:
- Use the heredoc form for every multi-line command.
- **`capture_screenshot()` first**, read the pixel, `click_at_xy(x, y)`, screenshot again to
  verify. Do not hunt for selectors — hit-testing happens in Chrome's browser process.
- First navigation is `new_tab(url)`, never `goto_url(url)` — goto clobbers the human's
  active tab.
- **If you hit an auth wall, STOP and report.** Never type credentials from a screenshot.

---

## 3. The ruling you asked for (Forge's stop, now resolved)

Forge stopped because its default recursive resolver returned a root SPF while my table said
the root TXT was empty. **Forge was right to stop and the stop rule was correctly applied.**

The ruling: **authoritative is canonical.** Re-measured by me just now —

```
dig +short @dns1.registrar-servers.com TXT commonswarm.com   -> empty
dig +short @dns2.registrar-servers.com TXT commonswarm.com   -> empty
dig +short @1.1.1.1  TXT commonswarm.com                     -> empty
dig +short @9.9.9.9  TXT commonswarm.com                     -> empty
dig +short @8.8.8.8  TXT commonswarm.com  -> stale copy, expiring
```

Both authoritative nameservers agree the root TXT is gone. `8.8.8.8` was serving a cached
copy past its source's life. **Recursive resolvers may disagree with each other during this
work; only `@dns1`/`@dns2.registrar-servers.com` (and, after the switch, the Cloudflare
nameservers) count.** Query authoritative explicitly for every check.

---

## 4. The task

Execute steps 1–4 of the migration plan. **The zone as measured** (authoritative, 2026-07-29):

| Type | Host | Value |
|---|---|---|
| A | `@` | `76.76.21.21` (Vercel, live site) |
| A | `www` | `76.76.21.21` (live, returns 200) |
| MX | `@` | `eforward1/2/3` pri 10, `eforward4` pri 15, `eforward5` pri 20 (`.registrar-servers.com`) |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDHAv5/O9Nu3IwwfMiAEnZXQ8GXNQ48fhp0aH7bd9fvcVYVfKpw2EugxPKEIFN5EcQbJ3r+X8TJYhnYO5suh77/0yShPxKIfWFFMYnFXoPhhvo2dr85z2jX9zsuZQJiKnLVWSHTuMk9UVAvNFlYnVW39AhMzQYlvb0mqfeI9OQLQIDAQAB` |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` |

Root TXT is absent (D-007). No AAAA, no CAA, no `_dmarc`, no other subdomain — verified by
probing `_dmarc`, `_vercel`, `autodiscover`, `mail`, `ftp`, `api`, `app`, `docs`, `blog`,
`staging`.

**In Cloudflare, create:**

```
A     @                    76.76.21.21     Proxy: DNS only (GREY cloud)
A     www                  76.76.21.21     Proxy: DNS only (GREY cloud)
TXT   resend._domainkey    <the p=... value above, one line>
TXT   send                 v=spf1 include:amazonses.com ~all
MX    send                 feedback-smtp.us-east-1.amazonses.com   priority 10
```

Then enable **Email Routing**: destination `<employer-b-address REDACTED 2026-08-10>`, routes for
`legal@commonswarm.com` and `security@commonswarm.com`. Let Cloudflare add its own root MX
and root SPF automatically.

---

## 5. Hard rules

1. **DO NOT CHANGE NAMESERVERS.** That is step 5 and it is mine. Stop at step 4 and report.
2. **GREY CLOUD on both A records.** Proxied (orange) puts Cloudflare's TLS in front of
   Vercel and can break the site or cause redirect loops.
3. **Do not recreate the five `eforward` MX records.** Cloudflare Email Routing creates its
   own root MX; the two sets would conflict.
4. **One SPF per host, ever.** Root gets Cloudflare's (`_spf.mx.cloudflare.net`) only. `send`
   keeps the amazonses one. Never merge them; never put amazonses on the root.
5. **Do not delete anything at Namecheap.** Those records go inert when nameservers move and
   are the rollback path.
6. **Never type or copy a credential.** Auth-blocked is a valid terminal state — report it.
7. **Anything unexpected → stop and report.** A record you did not create, a value differing
   from the table, a verification that will not complete. Forge did exactly this and it was
   correct.

---

## 6. What to report at the stop

- The complete record list **as Cloudflare shows it**, verbatim.
- Whether `<employer-b-address REDACTED 2026-08-10>` is **VERIFIED**, not merely added. Cloudflare emails a
  confirmation link there; until it is clicked, routing does not work. If it is unverified,
  say so plainly — that is a blocker for step 5, not a detail.
- The two Cloudflare nameserver hostnames assigned to the zone.
- Screenshots or verbatim page text for anything ambiguous.

**Do not summarise output. Paste it.**

---

## 7. Why the order matters

If nameservers move before the destination address is verified, `legal@commonswarm.com` mail
**bounces** during the window rather than queueing — and that address is named in the
published Terms and Privacy Policy. That is the whole reason this charter has a hard stop in
the middle rather than running end to end.
