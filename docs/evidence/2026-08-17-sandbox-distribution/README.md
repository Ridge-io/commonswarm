# Sandbox distribution lane — Node 22 floor, npm package, api.commonswarm.com

**2026-08-17.** Trigger: the operator dogfooded onboarding from Claude Cowork. Its cloud sandbox
allowed egress to package registries only; `commonswarm.com`, the Supabase host, and `nodejs.org`
were all blocked at the proxy, and the box ran Node 22 with no way to install 24. Codex (open
network) worked; Cowork could not install, connect, or upgrade. Everything below exists to make
that environment work, and each piece was verified live.

## What shipped

1. **Node floor 24 → 22, released as v0.1.17.** Measured first: `npm test` 536/536 and
   `test:p1-cli` 254/254 under Node 22.23.1, plus the bundle (rebuilt `--target=node22`) smoke-run.
   Every claim surface swept: installer check + copy, engines (+lockfile), site copy (7 files),
   `llms.txt`, README, AGENTS.md, and the design/marketing docs' prerequisite lines.
2. **npm distribution: `npm install -g commonswarm` (command stays `cswarm`).**
   `scripts/build-npm.sh` stages the identical release bundle as `cswarm.cjs`. Published as
   `commonswarm@0.1.17`, verified by a cold `npm install -g commonswarm` → `cswarm 0.1.17`.
   The bare name `cswarm` was REFUSED by npm's similarity filter (E403, "too similar to charm").
3. **GitHub release v0.1.17** with both assets; live installer re-verified end to end
   (cold `curl | sh` → `cswarm 0.1.17`).
4. **`api.commonswarm.com` is the API host.** Supabase custom-domain add-on enabled ($10/mo),
   CNAME + `_acme-challenge` TXT on Cloudflare (DNS-only), verified, ACTIVATED. The GitHub OAuth
   app now carries BOTH callback URLs, so neither old nor new host breaks sign-in. The site
   deployed with `PUBLIC_SUPABASE_URL=https://api.commonswarm.com`; a cold CLI discovery run
   returned *"Using the CommonSwarm deployment at https://api.commonswarm.com, discovered from
   https://commonswarm.com"* followed by the correct next error. The supabase.co host still
   serves — saved CLI targets keep working (both `/auth/v1/health` probes answered identically).

**The sandbox ask is now one line:** allowlist `commonswarm.com` (which covers
`api.commonswarm.com`), and install through npm, which such sandboxes already allow.

## Two-arm review (D-036), operator-directed via the codex and grok CLIs

`codex exec` (exact review) + `grok -p` (adversarial inversion) on the staged diff. **Grok was
used as an arm on explicit operator instruction this session** — supersedes the standing
"credit-exhausted, not usable" note if it still appears elsewhere. Both arms returned substantive
findings; all were fixed before release:

- lockfile still pinned `>=24` (both arms);
- `site/public/llms.txt` and the `WhatHappens.astro` frontmatter map still said 24;
- four design/marketing doc surfaces plus two sample-output lines (codex's line-784 catch);
- `build-npm.sh`: substring version check (0.1.1 would accept 0.1.10), shell-interpolated
  version string, no shebang check — all hardened;
- grok's InstallPanel:150 claim was checked and found already fixed (stale), the remaining
  "24"s there are SVG viewBox and CSS tokens.

**npm's own publish pipeline found one more:** with `"bin": {"cswarm": "./cswarm.cjs"}`, npm 11
warns `script name cswarm.cjs was invalid` and silently REMOVES the bin entry — the package would
have installed no command. The `./` prefix was the trigger; the template now uses the bare
filename, and the E403 (2FA) that blocked that first publish is what stopped the broken tarball
going live.

## Ops record

- npm account `chartingalpha` (tom@chartingalpha.com) created this session; credentials on the
  operator's Desktop pending 1Password; publish used a granular token (bypass-2FA, expires
  2026-08-24, `~/.config/cswarm-npm-token.txt`). New-account publishes REQUIRE 2FA or such a
  token; TOTP enrollment is no longer offered (security-key only).
- `Ridge-io/cloud-swarm` was **DELETED** (admin `Ridgeio`, `delete_repo` scope granted via
  device flow + operator's phone). 404 confirmed against a live `Ridge-io/commonswarm` control;
  `forks_count` was 0 at deletion, so the employer-address history is genuinely gone.

## Not established

- Windows / `npx` behavior of the npm package (grok's point): only Unix symlink+shebang was
  exercised.
- A full GitHub OAuth sign-in through `api.commonswarm.com` end to end (health + callback
  registration verified; a real browser login was not run).
- `@types/node` stays at 25 with engines at 22 — deliberate; narrowing it is its own change.
- Whether any pre-existing CLI credential flow assumes the supabase.co hostname anywhere
  (nothing found, not exhaustively searched).
