/*
 * public/og.png — the social card, as source rather than as a mystery binary.
 *
 * WHY THIS FILE EXISTS. The card that shipped before this one led with "Friction is justified
 * only by irreversibility." — the authority framing the operator retired — and it survived
 * three passes over the copy because a PNG is not greppable. Every Slack, X and LinkedIn
 * unfurl of the site was positioning CommonSwarm as a friction product while the page under it
 * said "Nobody gets blocked". A card with no source is a card nobody can fix.
 *
 * THE CARD SAYS WHAT THE PAGE SAYS. Headline = the operator-approved h1 in
 * src/components/landing/Hero.astro. If that h1 changes, this changes with it, and so does
 * `ogImageAlt` in src/layouts/Base.astro — the alt is a description of these pixels.
 *
 * THE CHIP IS `cswarm accept --link-stdin`, VERBATIM FROM --help, AND IT MUST STAY THAT WAY.
 * It used to read `coswarm accept <invite-link>` — the positional form our own `--help`
 * annotates "# unsafe: shell history/process list", because an invite link is a one-time
 * capability and argv goes into shell history and process listings. That made the single most
 * widely seen surface we have — every Slack, X and LinkedIn unfurl, seen before anyone loads
 * the site — the place teaching the credential-leaking invocation. The full paste-ready form
 * the pages use, `printf '%s' "$CSWARM_INVITE_LINK" | cswarm accept --link-stdin`, does not
 * fit the chip beside the note at 21px mono; the bare safe verb does, and is still a real
 * documented command rather than an abbreviation of one.
 *
 * THE CARD IS LIGHT NOW, AND THE PNG IN public/ IS NOT. Running this file writes HTML; it
 * cannot write the PNG. So after this change public/og.png is STALE — it is still the
 * near-black card — and it stays stale until someone re-renders it with the recipe below.
 * Two things must move with it, and neither is in this file:
 *   1. `ogImageAlt` in src/layouts/Base.astro opens "a dark title card". After the re-render
 *      that sentence describes a picture that does not exist, which is the one thing alt text
 *      must never do. It is the only word that changes: "a light title card".
 *   2. Nothing else. The words drawn on the card are unchanged by this pass, deliberately —
 *      the headline, the eyebrow, the chip and the note are all byte-identical to the version
 *      the current alt text was written against.
 *
 * WHY LIGHT. The site's palette is going light-first because the dark one reads as developer
 * infrastructure rather than as a product. The social card is the surface seen MOST and seen
 * FIRST — before anyone loads the page — so a near-black unfurl in front of a light site is
 * the wrong first frame, and a card that does not match the page it links to reads as a
 * different product. A PNG cannot answer prefers-color-scheme; there is one card and it has
 * to pick a side. It picks the side the site is on.
 *
 * THE COLOURS BELOW ARE PROVISIONAL AND SAY SO. Every other colour on this site resolves
 * through tokens.css, and this file cannot: it renders to a PNG with no stylesheet. It used
 * to restate the dark tokens literally, name by name. The LIGHT palette does not exist in
 * tokens.css yet — it is being written in another lane as this is edited — so these values
 * are not copies of anything. They are chosen here and measured here (WCAG 2.1, against the
 * white page):
 *     --text        #0d1020   18.7:1
 *     --text-muted  #5a6275    6.1:1
 *     --accent      #5b4bd6    6.1:1   (the eyebrow is 16px text; the dark #7c6cff is 3.9:1
 *                                       on white and would fail AA outright)
 *     --success     #0b7a55    5.3:1 on the page, 5.0:1 on the chip fill
 * When tokens.css lands its light values, RE-SYNC these against it and re-render — a card
 * whose indigo is a different indigo from the page's is the drift this comment exists to
 * make visible.
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

/* Every colour below is a light-palette value chosen and measured in this file — NOT a copy
 * of a token, because the light tokens do not exist yet. See the header. Each carries the
 * token name it is standing in for, so the re-sync is a diff rather than a hunt. */
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
    --bg: #ffffff;          /* --elev-0, light. Same white Base.astro's light theme-color uses */
    --surface: #f5f6fb;     /* --elev-2, light — the chip fill */
    --border: #e2e5f0;      /* --border, light */
    --text: #0d1020;        /* --text, light        18.7:1 on --bg */
    --text-muted: #5a6275;  /* --text-muted, light   6.1:1 on --bg */
    --accent: #6d5cf0;      /* --accent, light — fills and strokes, not text */
    --accent-ink: #5b4bd6;  /* --accent AS TEXT      6.1:1 on --bg */
    --success: #0b7a55;     /* --success, light      5.3:1 on --bg, 5.0:1 on --surface */
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { width: 1200px; height: 630px; }

  body {
    position: relative;
    overflow: hidden;
    background: var(--bg);
    font-family: "InterVariable", sans-serif;
    font-feature-settings: "cv05" 1, "ss03" 1;
    /* NO -webkit-font-smoothing: antialiased here, and it is not an omission. That setting
       exists to stop light-on-dark text blooming; applied to dark-on-light it does the
       opposite, thinning every stem. It was right on the near-black card and is wrong on
       this one. */
  }

  /* Two washes, the same two the site uses: accent under the top-right and a trace of
     success bottom-left, so the card is lit by the product's own palette. Both are lighter
     than the dark card's were — a tint that reads as a glow on near-black reads as a stain on
     white, and the job here is to keep the card from being a flat rectangle, not to colour it. */
  .wash {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(46rem 30rem at 88% 8%, rgba(109, 92, 240, 0.13), transparent 68%),
      radial-gradient(30rem 22rem at 2% 96%, rgba(11, 122, 85, 0.06), transparent 70%);
  }

  /* The mark, blown up and turned almost all the way down. It reads as texture at a glance
     and as the logo if you look — the same trick the old card used, kept. Its fills are
     inverted with the card: the dark version drew the shapes a shade LIGHTER than the
     backdrop, so on white they have to be a shade darker. Same weight, opposite direction. */
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
    color: var(--accent-ink);
  }

  h1 {
    margin-top: 22px;
    max-width: 790px;
    font-size: 68px;
    line-height: 1.03;
    font-weight: 780;
    letter-spacing: -0.032em;
    /* Top-lit, inverted for the light card: --text at the cap line settling into an indigo-
       tinted near-black, so the largest type is not a flat fill. The dark card ran white ->
       lavender; running that direction here would fade the headline INTO the page. The palest
       stop (#2a2550) is 14.2:1 on white, so the gradient never costs legibility. */
    background: linear-gradient(178deg, #0d1020 8%, #171a2e 46%, #2a2550 100%);
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
    /* Light surfaces are raised by shadow, not by being lighter than what is under them —
       on white the fill alone is a 1.06:1 step and the chip reads as a printing error
       without an edge under it. */
    box-shadow: 0 1px 2px rgba(13, 16, 32, 0.06);
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
  <g stroke="#e6e9f4" stroke-width="1.5" stroke-linecap="round" fill="none">
    <path d="M16 10.2 9.2 22"></path>
    <path d="M16 10.2 22.8 22"></path>
    <path d="M9.2 22h13.6"></path>
  </g>
  <circle cx="9.2" cy="22" r="3.5" fill="#eceef7"></circle>
  <circle cx="22.8" cy="22" r="3.5" fill="#eceef7"></circle>
  <circle cx="16" cy="10.2" r="4" fill="#e4f4ec"></circle>
</svg>

<div class="stage">
  <div class="wm">
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="#6d5cf0" stroke-width="2" stroke-linecap="round" opacity="0.72" fill="none">
        <path d="M16 10.2 9.2 22"></path>
        <path d="M16 10.2 22.8 22"></path>
        <path d="M9.2 22h13.6"></path>
      </g>
      <circle cx="9.2" cy="22" r="3.5" fill="#6d5cf0"></circle>
      <circle cx="22.8" cy="22" r="3.5" fill="#6d5cf0"></circle>
      <circle cx="16" cy="10.2" r="4" fill="#0b7a55"></circle>
    </svg>
    <span class="wm__word">CommonSwarm</span>
  </div>

  <div class="body">
    <p class="eyebrow">Multi-agent coordination</p>
    <h1>Your agents know what<br>each other are doing.</h1>

    <div class="foot">
      <span class="chip"><span class="chip__p">$</span><span class="chip__c">cswarm accept --link-stdin</span></span>
      <span class="note"><span class="note__dot"></span>Invited dogfood · CLI only</span>
    </div>
  </div>
</div>
`;

const out = process.argv[2];
writeFileSync(out, html);
console.log("wrote", out, html.length, "bytes");
