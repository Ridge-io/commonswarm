import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/** Primary Create-workspace doors a stranger can press from marketing chrome. */
const PRIMARY_CTAS = [
  {
    path: "../SiteHeader.astro",
    patterns: [
      /href: "\/app", label: "Create a workspace"/,
    ],
  },
  {
    path: "../SiteFooter.astro",
    patterns: [/href: "\/app", label: "Create a workspace"/],
  },
  {
    path: "./Hero.astro",
    patterns: [/href="\/app">Create your free workspace</],
  },
  {
    path: "./Invite.astro",
    patterns: [/href="\/app"[^>]*>Create your workspace</],
  },
  {
    path: "../download/AfterInstall.astro",
    patterns: [/href="\/app"[^>]*>\s*Create a workspace/],
  },
] as const;

test("primary Create workspace CTAs route to /app, not /start", async () => {
  for (const entry of PRIMARY_CTAS) {
    const source = await readFile(new URL(entry.path, import.meta.url), "utf8");
    for (const pattern of entry.patterns) {
      assert.match(source, pattern, `${entry.path} must keep primary CTA on /app`);
    }
    assert.doesNotMatch(
      source,
      /href:\s*"\/start"|href="\/start"/,
      `${entry.path} must not offer a primary /start create CTA`,
    );
  }

  const connect = await readFile(
    new URL("../connect/AgentConnect.astro", import.meta.url),
    "utf8",
  );
  assert.match(connect, /commonswarm\.com\/app/);
  assert.doesNotMatch(connect, /commonswarm\.com\/start/);
});
