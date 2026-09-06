/*
 * Build the site once per SIGN-IN-PROVIDER STATE, so the copy can be measured in a state the
 * live deployment is not in.
 *
 * WHY THIS EXISTS. Which providers a build renders is read from a deployment's own
 * /auth/v1/settings at build time (site/src/lib/auth-providers.ts). That is the right design
 * and it has one consequence: every control that reads `site/dist` measures ONE state, the one
 * api.commonswarm.com happened to be in when the build ran. On 2026-09-05 that state is
 * `github: true, google: false`, so a sentence that is only wrong once Google is on cannot go
 * red, and "the copy passes in both states" was a claim with no control on it. A review arm
 * found a real offender under it: the privacy policy's `Google LLC` processor bullet named one
 * provider while the build rendered two.
 *
 * HOW IT MEASURES THE REAL PATH. It does not fake the settings module or stub a function. It
 * starts a GoTrue-shaped HTTP server on 127.0.0.1, points PUBLIC_SUPABASE_URL at it, and runs
 * the real `astro build`. So `enabledProvidersForBuild`, `providersFromSettings`, the real
 * fetch, the real components and the real templates all run — the same code path a deploy
 * takes, differing only in which answer comes back. A stub whose 404 branch was reachable
 * would have proved nothing; the server answers ONLY AUTH_SETTINGS_PATH and 404s everything
 * else, so a build that asked for something else fails rather than quietly using a default.
 *
 * THE STATES ARE GENERATED FROM AUTH_PROVIDERS. Three, whatever the array holds: nothing
 * enabled, the first provider alone, and every provider the array names. Adding a provider
 * therefore widens the "every" state instead of needing a fourth fixture, and no state is a
 * hand-typed list of ids that could drift from the array.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFile } from "node:fs/promises";
import { AUTH_PROVIDERS, AUTH_SETTINGS_PATH } from "../src/lib/auth-providers.js";

/** The site package root, from this file's own location. */
const SITE_ROOT = new URL("../", import.meta.url);
/** Astro's own entry point, resolved rather than shelled through npx. */
const ASTRO_BIN = new URL("node_modules/astro/bin/astro.mjs", SITE_ROOT);
/** Where the per-state builds land. Gitignored; never deployed. */
export const FIXTURE_ROOT = new URL("dist-providers/", SITE_ROOT);

/**
 * A public identifier the stub does not check, spelled so it cannot be mistaken for a real
 * one if it ever appears in a built page. The stub answers any caller; the key is required
 * only because a build with one PUBLIC_SUPABASE_ value and not the other fails on purpose.
 */
const FIXTURE_ANON_KEY = "fixture-anon-key-not-a-real-credential";

export interface ProviderFixture {
  /** The state's name, built from the ids it enables, e.g. "none", "github", "github+google". */
  readonly state: string;
  /** The provider ids this state's GoTrue reports as enabled. */
  readonly enabled: readonly string[];
  /** The dist directory the state was built into. */
  readonly dir: URL;
}

/** The states, generated from AUTH_PROVIDERS so a new provider cannot escape them. */
export const FIXTURE_STATES: readonly (readonly string[])[] = [
  [],
  AUTH_PROVIDERS.slice(0, 1).map((provider) => provider.id),
  AUTH_PROVIDERS.map((provider) => provider.id),
];

/** "none", "github", "github+google" — the state's own contents, never a typed label. */
export function fixtureStateName(enabled: readonly string[]): string {
  return enabled.length === 0 ? "none" : enabled.join("+");
}

/**
 * A GoTrue settings body in the shape the live API returns.
 *
 * Every id in AUTH_PROVIDERS gets a REAL BOOLEAN, because providersFromSettings refuses a body
 * that does not carry one and that refusal is part of what these fixtures exercise. The extra
 * keys are the live body's own shape: a fixture that carried only the keys the code reads
 * would be a body no deployment ever sends.
 */
export function settingsBody(enabled: readonly string[]): unknown {
  const external: Record<string, boolean> = {
    anonymous_users: false,
    apple: false,
    email: true,
    gitlab: false,
    phone: false,
  };
  for (const provider of AUTH_PROVIDERS) external[provider.id] = enabled.includes(provider.id);
  return { external, disable_signup: false, mailer_autoconfirm: false };
}

/** A GoTrue that answers one path and refuses every other. Returns its own origin. */
async function startSettingsStub(enabled: readonly string[]): Promise<{
  readonly origin: string;
  readonly requested: string[];
  close: () => Promise<void>;
}> {
  const requested: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    requested.push(path);
    if (path !== AUTH_SETTINGS_PATH) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `provider fixture serves only ${AUTH_SETTINGS_PATH}` }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(settingsBody(enabled)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("provider fixture: the settings stub did not report a port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requested,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Run `astro build --outDir <dir>` against the stub, or throw with the build's own output. */
async function buildAgainst(origin: string, dir: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [ASTRO_BIN.pathname, "build", "--outDir", dir.pathname],
      {
        cwd: SITE_ROOT.pathname,
        env: {
          ...process.env,
          PUBLIC_SUPABASE_URL: origin,
          PUBLIC_SUPABASE_ANON_KEY: FIXTURE_ANON_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`provider fixture build for ${dir.pathname} exited ${code}:\n${output}`));
    });
  });
}

let building: Promise<readonly ProviderFixture[]> | null = null;

/**
 * Build every state, once per process.
 *
 * Cached on a promise rather than on a file stamp on purpose: a stamp would let a stale build
 * answer a changed template, which is the false green this whole file exists to remove. A site
 * build is about two seconds, so three of them cost less than the suite that reads them.
 */
export function providerFixtures(): Promise<readonly ProviderFixture[]> {
  building ??= (async () => {
    // The build copies the repo-root installer into public/. Doing it here too means these
    // fixtures do not depend on `npm run build` having been run first.
    await copyFile(new URL("../install.sh", SITE_ROOT), new URL("public/install.sh", SITE_ROOT));
    const built: ProviderFixture[] = [];
    for (const enabled of FIXTURE_STATES) {
      const state = fixtureStateName(enabled);
      const dir = new URL(`${state}/`, FIXTURE_ROOT);
      const stub = await startSettingsStub(enabled);
      try {
        await buildAgainst(stub.origin, dir);
      } finally {
        await stub.close();
      }
      if (!stub.requested.includes(AUTH_SETTINGS_PATH)) {
        throw new Error(
          `provider fixture "${state}": the build never asked ${AUTH_SETTINGS_PATH}, so it did ` +
            `not read this fixture's providers. PUBLIC_SUPABASE_URL did not reach the build.`,
        );
      }
      built.push({ state, enabled, dir });
    }
    return built;
  })();
  return building;
}
