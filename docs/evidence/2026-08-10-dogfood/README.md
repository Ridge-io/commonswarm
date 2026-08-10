# Dogfood run — 2026-08-10, from the beginning

**Method.** Installed from the LIVE installer into an isolated prefix, and ran as a genuinely
cold user via `HOME` override. Everything below is against production
(`ukezjcnxjvkpkeezxaew`), CLI **0.1.11** (sha256 `8480682a…`), which is what a stranger gets
today. **The D-080 fix is NOT in this build** — it is on `main`, unreleased.

## Instrument check, before any finding

`CSWARM_STATE_DIR` **does not exist.** The credential path is hardcoded at
`src/cloud/storage.ts:92` to `~/.cswarm/credentials.d`. My first isolation attempt set that
variable and would have dogfooded **as the Lead** while reporting a stranger's experience.

Real isolation is a `HOME` override, and it was verified with a control on the same invocation:

```
$ cswarm target show                      # the real user
Current Cloud target: https://ukezjcnxjvkpkeezxaew.supabase.co
Anon key fingerprint: 31639e49bcc6

$ HOME=<isolated> cswarm target show      # the stranger
No current Cloud target is saved. …
```

Two different answers, so the isolation is real. Had both printed the target, the run would have
measured nothing.

---

## F-1 — the installer's own terminal path dead-ends for the user it was written for

**Severity: MAJOR.** It is the first thing a stranger runs, and it is the self-serve path.

The installer's closing output:

```
No invite? Make your own workspace. It is free and takes no card:

  https://commonswarm.com/app

Or stay in the terminal:

  cswarm login
  cswarm new "<project name>"
```

Both terminal commands fail for exactly that reader:

```
$ HOME=<isolated> cswarm login --no-browser
cswarm: no Cloud target is selected: start with cswarm accept --link-stdin because invite links
carry the Cloud target …, or run cswarm target set --url https://<ref>.supabase.co --anon-key
<key> using values from whoever runs this deployment, or from your own project's API settings if
you created it; …

$ HOME=<isolated> cswarm new "My Project"
cswarm: no Cloud target is selected: …same…
```

Control: `cswarm --help` exits 0 in the same isolated HOME, so the binary is fine and these are
not a broken install.

**The remedy text offers three routes and none of them is open to this reader** — the same shape
as D-067, whose fix is quoted in the code comment directly above this very message:

| route offered | why it fails for a cold self-serve user |
|---|---|
| `cswarm accept --link-stdin` | they have no invite link; that is what "No invite?" meant |
| "values from whoever runs this deployment" | for a self-serve signup that person **is them** |
| "from your own project's API settings if you created it" | they did not create a Supabase project |

**`install.sh` already knows this, in writing.** Lines 146–148:

> *"WITH a link: `accept` is the only first-contact verb that needs no `--url`, because the link
> carries its own target. **Sending someone to `login` would send them looking for a project URL
> that has no page to come from.**"*

Line 183 then prints `cswarm login` anyway. The comment governs the invite branch; the "Or stay in
the terminal" line was written for the no-invite branch and reintroduced the exact failure the
comment names. Nothing in `install.sh` is executed by a gate, which is how both of the file's
previously-recorded mechanism bugs also shipped.

**The target is not secret and is already published on the host the installer came from**, so this
is detectable rather than askable, per the onboarding direction in AGENTS.md:

```
$ curl -s https://commonswarm.com/start | grep -o 'commonswarm:url" content="[^"]*"'
commonswarm:url" content="https://ukezjcnxjvkpkeezxaew.supabase.co"
```

**NOT established:** whether the `/app` web path works end to end for a cold user. Only the
terminal path was exercised here.
