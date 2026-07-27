/*
 * public/og.png — the social card, as source rather than as a mystery binary.
 *
 * WHY THIS FILE EXISTS. The card that shipped before this one led with "Friction is justified
 * only by irreversibility." — the authority framing the operator retired — and it survived
 * three passes over the copy because a PNG is not greppable. Every Slack, X and LinkedIn
 * unfurl of the site was positioning coswarm as a friction product while the page under it
 * said "Nobody gets blocked". A card with no source is a card nobody can fix.
 *
 * THE CARD SAYS WHAT THE PAGE SAYS. Headline = the operator-approved h1 in
 * src/components/landing/Hero.astro. If that h1 changes, this changes with it, and so does
 * `ogImageAlt` in src/layouts/Base.astro — the alt is a description of these pixels.
 *
 * THE CHIP IS `coswarm accept --link-stdin`, VERBATIM FROM --help, AND IT MUST STAY THAT WAY.
 * It used to read `coswarm accept <invite-link>` — the positional form our own `--help`
 * annotates "# unsafe: shell history/process list", because an invite link is a one-time
 * capability and argv goes into shell history and process listings. That made the single most
 * widely seen surface we have — every Slack, X and LinkedIn unfurl, seen before anyone loads
 * the site — the place teaching the credential-leaking invocation. The full paste-ready form
 * the pages use, `printf '%s' "$COSWARM_INVITE_LINK" | coswarm accept --link-stdin`, does not
 * fit the chip beside the note at 21px mono; the bare safe verb does, and is still a real
 * documented command rather than an abbreviation of one.
 *
 * TO REGENERATE:
 *   node scripts/og-card.mjs /tmp/og-card.html
 * then render that file at exactly 1200x630 CSS px, deviceScaleFactor 1, and write the PNG to
 * public/og.png. With browser-harness:
 *   new_tab("file:///tmp/og-card.html"); wait_for_load()
 *   cdp("Emulation.setDeviceMetricsOverride", width=1200, height=630, deviceScaleFactor=1,
 *       mobile=False)
 *   cdp("Page.captureScreenshot", format="png",
 *       clip={"x":0,"y":0,"width":1200,"height":630,"scale":1}, captureBeyondViewport=True)
 *
 * The fonts are inlined as data URIs, not linked: the render must not depend on a running dev
 * server, and a card set in a fallback face is a card in the wrong typeface for ever.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FONTS = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");
const b64 = (p) => readFileSync(p).toString("base64");
const inter = b64(`${FONTS}/inter-latin.woff2`);
const mono = b64(`${FONTS}/jetbrains-mono-latin.woff2`);

/* Every colour below is a literal copy of the token in site/src/styles/tokens.css. This file
 * renders to a PNG, so it cannot read the stylesheet; the values are restated with their
 * token name beside them so a drift is visible on inspection. */
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "InterVariable";
    font-weight: 100 900;
    src: url(data:font/woff2;base64,${inter}) format("woff2");
  }
  @font-face {
    font-family: "JetBrains Mono";
    font-weight: 100 800;
    src: url(data:font/woff2;base64,${mono}) format("woff2");
  }

  :root {
    --bg: #08090c;          /* --elev-0 */
    --surface: #12151c;     /* --elev-2 */
    --border: #232837;      /* --border */
    --text: #f4f6fa;        /* --text */
    --text-muted: #98a1b3;  /* --text-muted */
    --accent: #7c6cff;      /* --accent */
    --accent-bright: #9b8fff; /* --accent-bright */
    --success: #34d399;     /* --success */
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { width: 1200px; height: 630px; }

  body {
    position: relative;
    overflow: hidden;
    background: var(--bg);
    font-family: "InterVariable", sans-serif;
    font-feature-settings: "cv05" 1, "ss03" 1;
    -webkit-font-smoothing: antialiased;
  }

  /* Two washes, the same two the site uses: accent under the top-right and a trace of
     success bottom-left, so the card is lit by the product's own palette. */
  .wash {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(46rem 30rem at 88% 8%, rgba(124, 108, 255, 0.20), transparent 68%),
      radial-gradient(30rem 22rem at 2% 96%, rgba(52, 211, 153, 0.07), transparent 70%);
  }

  /* The mark, blown up and turned almost all the way down. It reads as texture at a glance
     and as the logo if you look — the same trick the old card used, kept. */
  .glyph {
    position: absolute;
    right: -78px;
    bottom: -104px;
    width: 520px;
    height: 520px;
    opacity: 1;
  }

  .stage {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 68px 72px 88px;
    display: flex;
    flex-direction: column;
  }

  .wm { display: flex; align-items: center; gap: 12px; }
  .wm__word {
    font-size: 27px;
    font-weight: 660;
    letter-spacing: -0.028em;
    color: var(--text);
  }

  .body { margin-top: auto; }

  .eyebrow {
    font-size: 16px;
    font-weight: 620;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--accent-bright);
  }

  h1 {
    margin-top: 22px;
    max-width: 790px;
    font-size: 68px;
    line-height: 1.03;
    font-weight: 780;
    letter-spacing: -0.032em;
    /* Same top-lit gradient as the hero: pure --text at the cap line falling to a lavender
       tinted with --accent, so the largest type on the card is not a flat fill. */
    background: linear-gradient(178deg, #ffffff 8%, #f2f3f9 46%, #dcd9f0 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .foot {
    margin-top: 44px;
    display: flex;
    align-items: center;
    gap: 22px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 17px 24px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    font-family: "JetBrains Mono", monospace;
    font-size: 21px;
    letter-spacing: -0.01em;
  }
  .chip__p { color: var(--success); }
  .chip__c { color: var(--text); }

  .note {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    letter-spacing: -0.006em;
    color: var(--text-muted);
  }
  .note__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
</style>

<div class="wash"></div>

<svg class="glyph" viewBox="0 0 32 32" aria-hidden="true">
  <g stroke="#252a3a" stroke-width="1.5" stroke-linecap="round" fill="none">
    <path d="M16 10.2 9.2 22"></path>
    <path d="M16 10.2 22.8 22"></path>
    <path d="M9.2 22h13.6"></path>
  </g>
  <circle cx="9.2" cy="22" r="3.5" fill="#161a26"></circle>
  <circle cx="22.8" cy="22" r="3.5" fill="#161a26"></circle>
  <circle cx="16" cy="10.2" r="4" fill="#0f2019"></circle>
</svg>

<div class="stage">
  <div class="wm">
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="#7c6cff" stroke-width="2" stroke-linecap="round" opacity="0.6" fill="none">
        <path d="M16 10.2 9.2 22"></path>
        <path d="M16 10.2 22.8 22"></path>
        <path d="M9.2 22h13.6"></path>
      </g>
      <circle cx="9.2" cy="22" r="3.5" fill="#9b8fff"></circle>
      <circle cx="22.8" cy="22" r="3.5" fill="#9b8fff"></circle>
      <circle cx="16" cy="10.2" r="4" fill="#34d399"></circle>
    </svg>
    <span class="wm__word">coswarm</span>
  </div>

  <div class="body">
    <p class="eyebrow">Multi-agent coordination</p>
    <h1>Your agents know what<br>each other are doing.</h1>

    <div class="foot">
      <span class="chip"><span class="chip__p">$</span><span class="chip__c">coswarm accept --link-stdin</span></span>
      <span class="note"><span class="note__dot"></span>Invited dogfood · CLI only</span>
    </div>
  </div>
</div>
`;

const out = process.argv[2];
writeFileSync(out, html);
console.log("wrote", out, html.length, "bytes");
