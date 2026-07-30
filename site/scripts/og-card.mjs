/*
 * Generate public/og.png from reviewable SVG source.
 *
 * The card is a product surface: its promise, palette, and free-tier claim must track the
 * homepage. Rendering through sharp keeps the result deterministic and removes the old
 * browser-window recipe, whose screenshot could tile when the real window was too narrow.
 *
 * The colours below mirror the landed light tokens. SVG cannot import tokens.css, so this
 * explicit map is the sync boundary:
 *   background #f4f6fa  --elev-0
 *   surface    #eef1f7  --elev-3
 *   border     #dde3ec  --border
 *   text       #10142a  --text
 *   muted      #4f5769  --text-muted
 *   accent     #4633b8  --accent
 *   accent ink #5b4ada  --accent-bright
 *   success    #056f52  --success
 *
 * Usage:
 *   node scripts/og-card.mjs public/og.png
 *   node scripts/og-card.mjs /tmp/og-card.svg
 *
 * The SVG output is useful for review. The PNG is the shipping artifact and must be opened
 * and inspected after every regeneration. Base.astro's ogImageAlt describes these pixels.
 */

import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fonts = join(root, "public", "fonts");
const inter = readFileSync(join(fonts, "inter-latin.woff2")).toString("base64");
const mono = readFileSync(join(fonts, "jetbrains-mono-latin.woff2")).toString("base64");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>CommonSwarm</title>
  <desc>See what your teammates picked up — before you start. One prompt connects each agent.</desc>
  <defs>
    <style>
      @font-face {
        font-family: "InterVariable";
        font-weight: 100 900;
        src: url("data:font/woff2;base64,${inter}") format("woff2");
      }
      @font-face {
        font-family: "JetBrains Mono";
        font-weight: 100 800;
        src: url("data:font/woff2;base64,${mono}") format("woff2");
      }
      .sans { font-family: "InterVariable", "Helvetica Neue", Arial, sans-serif; }
      .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
    </style>
    <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8f9fc"/>
      <stop offset="1" stop-color="#eef1f7"/>
    </linearGradient>
    <linearGradient id="headline" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#10142a"/>
      <stop offset="1" stop-color="#2a2550"/>
    </linearGradient>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#10142a" flood-opacity=".08"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#page)"/>
  <circle cx="1110" cy="46" r="236" fill="#ddd8ff" opacity=".36"/>
  <circle cx="10" cy="644" r="196" fill="#d8eee7" opacity=".34"/>

  <g transform="translate(72 58)">
    <g transform="translate(0 2)">
      <path d="M15 5 5 23M15 5l10 18M5 23h20" fill="none" stroke="#4633b8"
        stroke-width="2.2" stroke-linecap="round" opacity=".72"/>
      <circle cx="5" cy="23" r="4.3" fill="#4633b8"/>
      <circle cx="25" cy="23" r="4.3" fill="#4633b8"/>
      <circle cx="15" cy="5" r="4.8" fill="#056f52"/>
    </g>
    <text class="sans" x="46" y="26" font-size="27" font-weight="670"
      letter-spacing="-.7" fill="#10142a">CommonSwarm</text>
  </g>

  <text class="sans" x="72" y="224" font-size="16" font-weight="650"
    letter-spacing="2.1" fill="#5b4ada">SHARED AWARENESS FOR PEOPLE AND AGENTS</text>

  <text class="sans" x="72" y="306" font-size="60" font-weight="790"
    letter-spacing="-2" fill="url(#headline)">
    <tspan x="72" dy="0">See what your teammates</tspan>
    <tspan x="72" dy="64">picked up — before you start.</tspan>
  </text>

  <g transform="translate(72 438)" filter="url(#soft-shadow)">
    <rect width="326" height="58" rx="12" fill="#eef1f7" stroke="#dde3ec"/>
    <circle cx="27" cy="29" r="5" fill="#4633b8"/>
    <text class="sans" x="46" y="35" font-size="17" font-weight="650"
      fill="#4633b8">One prompt connects each agent</text>
  </g>

  <g transform="translate(430 438)">
    <circle cx="7" cy="29" r="5" fill="#056f52"/>
    <text class="sans" x="26" y="35" font-size="17" font-weight="520"
      fill="#4f5769">Free · 3 workspaces · no card</text>
  </g>

  <g transform="translate(874 164)" opacity=".96">
    <path d="M112 36 32 176M112 36l84 140M32 176h164" fill="none"
      stroke="#cbc6ed" stroke-width="5" stroke-linecap="round"/>
    <circle cx="32" cy="176" r="34" fill="#e8e6f8" stroke="#d6d1f1" stroke-width="2"/>
    <circle cx="196" cy="176" r="34" fill="#e8e6f8" stroke="#d6d1f1" stroke-width="2"/>
    <circle cx="112" cy="36" r="39" fill="#dff0ea" stroke="#c9e4db" stroke-width="2"/>
    <text class="mono" x="32" y="184" text-anchor="middle" font-size="22"
      font-weight="700" fill="#5b4ada">I</text>
    <text class="mono" x="196" y="184" text-anchor="middle" font-size="22"
      font-weight="700" fill="#5b4ada">F</text>
    <text class="mono" x="112" y="44" text-anchor="middle" font-size="22"
      font-weight="700" fill="#056f52">T</text>
    <rect x="2" y="242" width="224" height="68" rx="13" fill="#f8f9fc" stroke="#dde3ec"/>
    <rect x="2" y="242" width="3" height="68" rx="1.5" fill="#056f52"/>
    <text class="sans" x="20" y="269" font-size="12" font-weight="700"
      letter-spacing=".7" fill="#056f52">JUST NOW</text>
    <text class="sans" x="20" y="292" font-size="15" font-weight="570"
      fill="#10142a">Iris picked up onboarding.</text>
  </g>
</svg>`;

const output = process.argv[2] ?? join(root, "public", "og.png");

if (extname(output).toLowerCase() === ".svg") {
  writeFileSync(output, svg);
  console.log(`wrote ${output} (${Buffer.byteLength(svg)} bytes)`);
} else {
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(output);
  const metadata = await sharp(output).metadata();
  console.log(`wrote ${output} (${metadata.width}x${metadata.height})`);
}
