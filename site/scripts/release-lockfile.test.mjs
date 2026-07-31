import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * release lockfile gate — the repo-root version fields may not drift apart.
 *
 * WHY IT EXISTS. The site renders the shipping version off package.json `version`, but a
 * real npm release syncs BOTH the manifest and the lockfile: `package-lock.json` carries
 * `version` at its top level and again under `packages[""].version`. Guidance that used to
 * read "edit package.json and nothing else" is false — the two files move together in the
 * repo's release procedure — and a stale lockfile version is a poisoned artifact whose
 * mismatch surfaces far from the bump that caused it. This gate pins all three fields
 * equal and non-empty, and a mutation control proves it can tell the drift apart.
 *
 * PURE GATE. Reads two files at the repo root; no network, no database, no build step. It
 * is reached by `npm --prefix site test` through the `scripts/*.test.mjs` glob.
 */

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(siteDir, "..");
const PKG_PATH = join(repoDir, "package.json");
const LOCK_PATH = join(repoDir, "package-lock.json");

/** The object-typed gate: all three version fields identical and non-empty. */
function versionsAligned(pkg, lock) {
  const manifest = pkg?.version;
  const lockTop = lock?.version;
  const lockRoot = lock?.packages?.[""]?.version;
  if (typeof manifest !== "string" || typeof lockTop !== "string" || typeof lockRoot !== "string") {
    return false;
  }
  if (!manifest || !lockTop || !lockRoot) return false;
  return manifest === lockTop && lockTop === lockRoot;
}

function readManifest() {
  return JSON.parse(readFileSync(PKG_PATH, "utf8"));
}

function readLock() {
  return JSON.parse(readFileSync(LOCK_PATH, "utf8"));
}

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("release lockfile gate: package.json and package-lock.json versions are identical", () => {
  const pkg = readManifest();
  const lock = readLock();
  assert.ok(
    versionsAligned(pkg, lock),
    `versions must align: package.json=${pkg.version}, lock.version=${lock.version}, ` +
      `lock.packages[""].version=${lock.packages?.[""]?.version}`,
  );
});

test("release lockfile gate: a lockfile version mutation is rejected, and the file on disk is untouched", () => {
  const pkg = readManifest();
  const lock = readLock();
  assert.ok(
    versionsAligned(pkg, lock),
    "the clean tree must pass before the mutation is meaningful",
  );
  const before = digestOf(LOCK_PATH);

  const mutatedPackagesEntry = structuredClone(lock);
  mutatedPackagesEntry.packages[""].version = "9.9.9";
  assert.equal(
    versionsAligned(pkg, mutatedPackagesEntry),
    false,
    "the gate must reject a lockfile whose packages[\"\"] version diverges from the manifest",
  );

  const mutatedLockVersion = structuredClone(lock);
  mutatedLockVersion.version = "9.8.7";
  assert.equal(
    versionsAligned(pkg, mutatedLockVersion),
    false,
    "the gate must reject a lockfile whose top-level version diverges from the manifest",
  );

  assert.equal(
    digestOf(LOCK_PATH),
    before,
    "both mutations were in-memory: the on-disk lockfile must be byte-identical",
  );
  assert.ok(
    versionsAligned(readManifest(), readLock()),
    "the re-read tree must still pass, proving the artifact was restored untouched",
  );
});
