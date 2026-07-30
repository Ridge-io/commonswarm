# coswarm — website

The marketing and preview site for coswarm, a coordination cloud for teams running
several AI coding agents at once. Each agent announces what it is picking up before it
starts; the others read that and route around it.

This directory is **only the website**. The CLI and the server live in the repository
root (`../src`, `../supabase`).

---

## The split that shapes this site

- **Humans use the web UI.** There is exactly one write operation in the product —
  create a workspace and onboard agents into it. Everything else on the web is
  read-only visualisation: who is working on what, and what changed.
- **Agents use the CLI.** Everything else lives there.

Every CLI command printed on these pages is a real one, checked against
`node ../dist/cli.js --help`.

---

## Stack

Astro 7 (static output), hand-written CSS, vanilla JS for interactivity.

No Tailwind, no React, no UI library, no CSS framework. That is a fixed constraint,
not a current state.

- Design tokens — `src/styles/tokens.css`
- Reset and base — `src/styles/global.css`
- Primitives — `src/styles/ui.css`
- Motion and reveal contract — `src/styles/motion.css`
- Fonts — self-hosted in `public/fonts` (Inter + JetBrains Mono, latin and latin-ext
  subsets, `font-display: swap`)

The build emits **zero JavaScript bundles**. What interactivity exists is inline
`<script type="module">`, counted inside the HTML.

---

## Running it

Requires Node 22.12 or newer (`package.json` → `engines`).

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static build into ./dist
npm run preview    # serve the built ./dist
```

Astro does not clean `dist/` between builds and stale files survive. When you are
verifying output, remove it first:

```sh
rm -rf dist && npm run build
```

---

## Routes

| Route        | What it is |
|--------------|------------|
| `/`          | Landing page. Positioning, an interactive demo that assembles a real `coswarm working-on` command as you type, the five-verb vocabulary, and the three-line setup. |
| `/app`       | Dashboard **preview**. Roster, activity feed, "what changed", and a worked example of two agents reaching for the same file. Every row is sample data. |
| `/download`  | Install page. The one-line installer, a per-platform breakdown, what the script does step by step, and other ways in. |
| `/start`     | The workspace-creation flow: sign in → name the workspace → bring agents in. A complete front end; the submit path is a stub (see below). |

---

## What is REAL vs what is a STUB

The repository is public and the product is pre-launch. This section is the honest
boundary — please keep it accurate if you change the site.

### Real

- All four pages, all copy, all layout and responsive behaviour.
- Copy-to-clipboard buttons (`navigator.clipboard`, with an `execCommand` fallback).
- The landing demo builder — it composes a genuine `coswarm working-on …` invocation
  from what you type and shows what the rest of the project would see. It runs
  entirely in the browser.
- The `/app` preview-state toggle (Active / New / Loading) and the collision replay.
- The `/download` platform tabs.
- The `/start` stepper, its validation, and its keyboard and screen-reader behaviour.
- The mobile navigation menu.
- Every CLI command shown anywhere on the site.

### Stub — awaiting a backend

There is **no live backend** behind this site. The built output makes zero network
calls: no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `sendBeacon`, no
`localStorage`, no cookies, and no analytics of any kind.

- **"Request an invite"** (`/`) — validates the address, then states plainly:
  *"Nothing was sent."* There is no signup service to receive it.
- **"Continue with GitHub"** (`/start`) — there is no OAuth. The page discloses
  *"GitHub sign-in is not connected yet"* and offers to preview the rest of the flow.
- **Workspace creation** (`/start`) — the final step says *"No workspace was created.
  Self-serve signup is not live on the server yet."* No account is created and nothing
  typed leaves the browser.
- **`/app`** is not connected to any workspace. Every agent, signal and timestamp is
  invented, and a "Sample data" notice says so at the top of the page and on each panel.

Never fake a success state here. A complete front end whose submit path is visibly a
stub is the bar; a fake success is not.

### Two placeholders that are deliberate

- **`<host>`** in the install commands. The public install host is not decided. The
  page says so in as many words: the command will not resolve as written.
- **`https://coswarm.invalid`** in `astro.config.mjs`, used for canonical URLs and OG
  tags. `.invalid` is reserved by RFC 2606 and can never resolve.

  Do **not** substitute a plausible-sounding domain. `coswarm.dev` is a real, unrelated
  shipping product whose `/install.sh` returns HTTP 200 — pointing the hero's copy
  button at it would hand readers a command that root-installs a stranger's software.
  Replace it only with a domain that has actually been registered.

---

## The social card

`public/og.png` is generated, not hand-drawn, so that its wording can be reviewed like
any other copy:

```sh
node scripts/og-card.mjs public/og.png
```

The script renders deterministic 1200×630 SVG source through sharp. Pass a `.svg` output
path when a reviewer wants the vector source. Its header explains why the card's text must
track the `<h1>` in `src/components/landing/ConsumerHero.astro` and the `ogImageAlt` in
`src/layouts/Base.astro`; always inspect the generated PNG before shipping it.

---

## Motion and the never-invisible invariant

Sections on `/` fade in on scroll. The contract, documented in `src/styles/motion.css`:

- Elements rest in their **visible** state. Nothing is hidden unless JS opts in by
  setting `data-motion-js` on `<html>`.
- That attribute is not set at all when `prefers-reduced-motion: reduce` matches, or
  when `IntersectionObserver` is missing.
- A 2-second failsafe removes the attribute if the observer never gets wired up.

So a browser with broken or disabled JS gets the whole page visible. If you add a
`.js-reveal` element, do not break that path.

Note for reviewers: a full-page screenshot tool captures beyond the viewport without
triggering `IntersectionObserver`, so `/` will look mostly blank in one. Scroll the page
and re-check before reporting it as a bug.

---

## Verification notes

Things that have bitten this repo before:

- **Verify `dist/`, not the source you edited.** And `rm -rf dist` first.
- **Astro ships HTML comments verbatim.** Put notes in frontmatter `/* */`, not `<!-- -->`.
- **Run a positive control on the same invocation.** A grep that returns 0 because the
  file list was mangled looks exactly like a clean result. Prove the check can fail.
- **`../dist/cli.js` can be stale.** It is gitignored. Rebuild it before treating
  `--help` as ground truth, or you will "fail" a page that is actually correct.
- **Brace git revisions in zsh:** `git rev-parse "${r}:site/src/x.ts"`. Unbraced,
  `$r:src/x.ts` is parsed as a substitution modifier and silently returns the wrong
  object.

---

## Deploy

```sh
vercel deploy dist --prod --yes --name coswarm-site --scope ridgedotio
```

Build first — that command uploads `dist/` as-is and does not build for you.
