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
 * src/components/landing/Hero.astro ("See what every agent is working on."). If that h1
 * changes, this changes with it, and so does `ogImageAlt` in src/layouts/Base.astro — the
 * alt is a description of these pixels.
 *
 * THE CHIP IS INSTALL_CMD FROM src/lib/install.ts, the same value the download and start
 * pages render. Kestrel verified the real installer path returns HTTP 200 and a made-up
 * sibling returns 404 on 2026-07-29, so the success is not a soft-200. This replaced the
 * invite-accept command after self-serve opened: an unfurl is a consumer front door now, not
 * an invitation handoff. Unlike an invite link, the public installer URL contains no
 * capability. Keep the 16px setting: at the previous 21px the expanded command would collide
 * with the free-tier note and the decorative mark.
 *
 * THE PNG IS REGENERATED AND CURRENT as of 2026-07-29. It is light, matching the site, and
 * its note reads "Free tier · no card". It previously read "Invited dogfood · CLI only",
 * which stopped being true the moment SWARM_SELF_SERVE was switched on in production — a
 * claim on the most-seen surface the project has, invalidated by an environment variable
 * somewhere else entirely, with nothing in this repo changing to mark it.
 *
 * RUNNING THIS FILE WRITES HTML; IT CANNOT WRITE THE PNG. Any future edit here leaves
 * public/og.png stale until someone runs the recipe above and LOOKS at the result. One thing
 * must move with it and it is not in this file: `ogImageAlt` in src/layouts/Base.astro is a
 * description of these exact pixels, and an alt describing a previous card is worse than no
 * alt at all.
 *
 * WHY LIGHT. The site's palette is going light-first because the dark one reads as developer
 * infrastructure rather than as a product. The social card is the surface seen MOST and seen
 * FIRST — before anyone loads the page — so a near-black unfurl in front of a light site is
 * the wrong first frame, and a card that does not match the page it links to reads as a
 * different product. A PNG cannot answer prefers-color-scheme; there is one card and it has
 * to pick a side. It picks the side the site is on.
 *
 * THE COLOURS BELOW MIRROR THE LANDED LIGHT PALETTE. This file cannot consume tokens.css:
 * it renders to a standalone PNG with no stylesheet, so every value is necessarily copied.
 * The sync obligation is explicit and mechanical:
 *     --bg          #f4f6fa   tokens.css --elev-0
 *     --surface     #eef1f7   tokens.css --elev-3
 *     --border      #dde3ec   tokens.css --border
 *     --text        #10142a   tokens.css --text
 *     --text-muted  #4f5769   tokens.css --text-muted
 *     --accent      #4633b8   tokens.css --accent
 *     --accent-ink  #5b4ada   tokens.css --accent-bright (accent used as text)
 *     --success     #056f52   tokens.css --success
 * The previous card called its colors provisional after the light palette had landed and
 * drifted to a different indigo and a pure-white page. Re-check this list whenever the
 * tokens change, then regenerate and inspect the PNG.
 *
 * TO REGENERATE:
 *   node scripts/og-card.mjs /tmp/og-card.html
 * then render that file at exactly 1200x630 CSS px, deviceScaleFactor 1, and write the PNG to
 * public/og.png. With browser-harness:
 *   new_tab("file:///tmp/og-card.html"); wait_for_load()
 *   wid = cdp("Browser.getWindowForTarget")
 *   cdp("Browser.setWindowBounds", windowId=wid["windowId"],
 *       bounds={"left":0,"top":0,"width":1360,"height":900,"windowState":"normal"})
 *   cdp("Emulation.setDeviceMetricsOverride", width=1200, height=630, deviceScaleFactor=1,
 *       mobile=False)
 *   cdp("Page.captureScreenshot", format="png",
 *       clip={"x":0,"y":0,"width":1200,"height":630,"scale":1})
 *
 * ★ THE setWindowBounds LINE IS LOAD-BEARING AND WAS NOT IN THE FIRST VERSION OF THIS RECIPE.
 * setDeviceMetricsOverride changes LAYOUT, not the browser window. If the real window is
 * narrower than 1200 CSS px, the capture composites the window's surface and TILES it to fill
 * the clip: you get a correct-looking card whose right-hand strip is the beginning of a second
 * copy of itself. It is a valid 1200x630 PNG, so every check short of looking at the image
 * passes — dimensions, byte size, file type. Measured: a 1109px window produced a seam at
 * x=1109, which is how the cause was found.
 *
 * captureBeyondViewport was also dropped. The decorative SVG overhangs to scrollWidth 1278, so
 * beyond-viewport capture re-lays-out to 1278 and rescales. The clip is inside the viewport
 * anyway, so the flag only ever added a way to be wrong.
 *
 * ALWAYS LOOK AT THE RESULTING IMAGE. This card is the single most widely seen surface the
 * project has, and it is the one artifact where every automated check can pass on a broken
 * result.
 *
 * The fonts are inlined as data URIs, not linked: the render must not depend on a running dev
 * server, and a card set in a fallback face is a card in the wrong typeface for ever.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { INSTALL_CMD } from "./install-command.mjs";

const FONTS = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");
const b64 = (p) => readFileSync(p).toString("base64");
const inter = b64(`${FONTS}/inter-latin.woff2`);
const mono = b64(`${FONTS}/jetbrains-mono-latin.woff2`);

/* These literals copy the named light-palette tokens listed in the header. */
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
    --bg: #f4f6fa;          /* --elev-0 */
    --surface: #eef1f7;     /* --elev-3 — the chip fill */
    --border: #dde3ec;      /* --border */
    --text: #10142a;        /* --text */
    --text-muted: #4f5769;  /* --text-muted */
    --accent: #4633b8;      /* --accent — fills and strokes */
    --accent-ink: #5b4ada;  /* --accent-bright — accent used as text */
    --success: #056f52;     /* --success */
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
    /* 820/60px, down from 790/68px. The headline got longer when it gained a product noun
       ("Accelerate teamwork with agent-to-agent chat." vs "Your agents know what each other
       are doing.") and 68px broke it onto THREE lines with an orphan — first "with" alone,
       then "chat." alone. Type this large has no good three-line setting at this width.
       820px still clears the decorative graphic, whose leftmost circle starts near x=850. */
    max-width: 820px;
    font-size: 60px;
    line-height: 1.03;
    font-weight: 780;
    letter-spacing: -0.032em;
    /* Top-lit, inverted for the light card: --text at the cap line settling into an indigo-
       tinted near-black, so the largest type is not a flat fill. The dark card ran white ->
       lavender; running that direction here would fade the headline INTO the page. The palest
       stop (#2a2550) is 14.2:1 on white, so the gradient never costs legibility. */
    background: linear-gradient(178deg, var(--text) 8%, #171a2e 46%, #2a2550 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    /* ★ DESCENDERS, and this is the card where the bug was SEEN. background-clip: text paints
       the gradient only inside the padding box, and line-height 1.03 makes the line box
       shorter than the font's ascent+descent (58+14 = 1.2em at this weight), so the tails of
       the g's on the last line were cut clean off. Measured here: 4.05px of ink below the
       box at 60px. The padding gives the gradient somewhere to be; the negative margin hands
       the space back so .foot's 44px gap is unchanged.
       The site has the identical defect for the identical reason — .h-display in
       src/styles/global.css — and is fixed in the same pass. If one is ever changed, check
       the other: they are two copies of one construction, not one shared rule. */
    padding-bottom: 0.1em;
    margin-bottom: -0.1em;
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
    gap: 10px;
    padding: 17px 20px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    /* Light surfaces are raised by shadow, not by being lighter than what is under them —
       on white the fill alone is a 1.06:1 step and the chip reads as a printing error
       without an edge under it. */
    box-shadow: 0 1px 2px rgba(13, 16, 32, 0.06);
    font-family: "JetBrains Mono", monospace;
    /* The public installer is substantially longer than the retired invite verb. At 16px it
       remains readable in an unfurl and clears the free-tier note plus the mark at 1200px. */
    font-size: 16px;
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
      <g stroke="#4633b8" stroke-width="2" stroke-linecap="round" opacity="0.72" fill="none">
        <path d="M16 10.2 9.2 22"></path>
        <path d="M16 10.2 22.8 22"></path>
        <path d="M9.2 22h13.6"></path>
      </g>
      <circle cx="9.2" cy="22" r="3.5" fill="#4633b8"></circle>
      <circle cx="22.8" cy="22" r="3.5" fill="#4633b8"></circle>
      <circle cx="16" cy="10.2" r="4" fill="#056f52"></circle>
    </svg>
    <span class="wm__word">CommonSwarm</span>
  </div>

  <div class="body">
    <p class="eyebrow">Multi-agent coordination</p>
    <h1>See what every agent<br>is working on.</h1>

    <div class="foot">
      <span class="chip"><span class="chip__p">$</span><span class="chip__c">${INSTALL_CMD}</span></span>
      <span class="note"><span class="note__dot"></span>Free tier · no card</span>
    </div>
  </div>
</div>
`;

const out = process.argv[2];
writeFileSync(out, html);
console.log("wrote", out, html.length, "bytes");
