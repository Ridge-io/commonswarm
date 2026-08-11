import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";

/* The commit-identity guard. Two operator work addresses reached the default branch of a public
 * repo via commit metadata, because an agent seat read an address out of a session-context field.
 *
 * ACCIDENT SCOPE by design: GitHub runs the workflow that ships WITH the ref under test, so a
 * workflow in the repo cannot police identity against a deliberate change. Trying to escape that
 * with a trusted-base extraction bought nothing and introduced a script-injection hole. */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const script = resolve(root, "scripts", "check-commit-identity.sh");

function repoWith(emails: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "idguard-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", ".");
  emails.forEach((email, i) => {
    execFileSync("sh", ["-c", `echo ${i} > ${dir}/f${i}`]);
    git("add", "-A");
    git("-c", "user.name=T", "-c", `user.email=${email}`, "commit", "-qm", `c${i}`);
  });
  return dir;
}

function run(dir: string, range: string): { code: number; out: string } {
  try {
    const out = execFileSync(script, [range], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("guard: an off-allowlist address FAILS", () => {
  const dir = repoWith(["yulanbot@gmail.com", "tom@vividengine.com"]);
  try {
    const r = run(dir, "HEAD~1..HEAD");
    assert.equal(r.code, 1, "a disallowed address did not fail the check");
    assert.match(r.out, /DISALLOWED/);
    assert.match(r.out, /tom@vividengine\.com/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard: an allowlisted address PASSES — it is not failing everything", () => {
  /* CONTROL. A check that failed unconditionally would satisfy the test above while blocking
   * every push, which is a worse outcome than the defect. */
  const dir = repoWith(["yulanbot@gmail.com", "yulanbot@gmail.com"]);
  try {
    assert.equal(run(dir, "HEAD~1..HEAD").code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard: a non-routable .local agent seat PASSES", () => {
  /* Agent seats mint their own local identities. A .local address cannot name an employer, so
   * allowing the shape does not weaken the guard — the incident address was routable. Without
   * this, every agent commit fails CI. */
  const dir = repoWith(["yulanbot@gmail.com", "someseat@commonswarm.local"]);
  try {
    assert.equal(run(dir, "HEAD~1..HEAD").code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard: it checks the COMMITTER too, not only the author", () => {
  /* The incident had 20 commits AUTHORED by the work address and 14 COMMITTED by it, so a guard
   * reading only %ae misses a third of them.
   *
   * ~~This asserted that the source contains "%ce".~~ Dead. Mutation-testing killed it: removing
   * %ce from the actual format string left the test GREEN, because %ce still appears in an
   * explanatory comment in the same file. A control that matches a string the surrounding prose
   * already contains cannot fail. It now builds a commit whose AUTHOR is allowlisted and whose
   * COMMITTER is not, and requires the guard to reject it — behaviour, not source text. */
  const dir = mkdtempSync(join(tmpdir(), "idguard-c-"));
  try {
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", ".");
    execFileSync("sh", ["-c", `echo a > ${dir}/a`]);
    git("add", "-A");
    git("-c", "user.name=T", "-c", "user.email=yulanbot@gmail.com", "commit", "-qm", "base");

    execFileSync("sh", ["-c", `echo b > ${dir}/b`]);
    git("add", "-A");
    execFileSync("git", ["-C", dir, "commit", "-qm", "committer-differs",
      "--author", "Good <yulanbot@gmail.com>"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: "Bad",
        GIT_COMMITTER_EMAIL: "tom@vividengine.com",
        GIT_AUTHOR_NAME: "Good",
        GIT_AUTHOR_EMAIL: "yulanbot@gmail.com",
      },
    });

    const r = run(dir, "HEAD~1..HEAD");
    assert.equal(r.code, 1, "a bad COMMITTER with a good author was not rejected");
    assert.match(r.out, /committer/, "the failure does not name the committer field");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard: the allowlist covers every identity currently on main", () => {
  /* Spark's rule, and the one that cost them a round: build the allowlist by MEASUREMENT. Written
   * from memory it omits noreply@github.com — the committer on every squash merge — and CI fails
   * on main forever. This asserts the shipped list still covers reality. */
  const seen = execFileSync("git", ["-C", root, "log", "origin/main", "--format=%ae%n%ce"], {
    encoding: "utf8",
  }).split("\n").map((s) => s.trim()).filter(Boolean);
  assert.ok(seen.length > 100, `history read looks wrong: ${seen.length} fields`);

  const src = readFileSync(script, "utf8");
  const allowed = new Set(
    (src.match(/ALLOWED='([\s\S]*?)'/) ?? [])[1]?.split("\n").map((s) => s.trim()).filter(Boolean) ?? [],
  );
  assert.ok(allowed.size >= 4, `allowlist parse looks wrong: ${allowed.size}`);

  const uncovered = [...new Set(seen)].filter(
    (a) => !allowed.has(a) && !a.endsWith(".local"),
  );
  assert.deepEqual(uncovered, [], `on main but not allowlisted: ${uncovered.join(", ")}`);
});

test("guard: the workflow never interpolates github context into a run body", () => {
  /* The hole Spark's rounds 1 and 2 introduced. Values from the github context must arrive
   * through env:, where the shell cannot execute them. */
  const yml = readFileSync(resolve(root, ".github", "workflows", "commit-identity.yml"), "utf8");
  const lines = yml.split("\n");
  let inRun = false;
  let indent = 0;
  const offenders: string[] = [];
  for (const line of lines) {
    const m = /^(\s*)run: \|/.exec(line);
    if (m) { inRun = true; indent = m[1]!.length; continue; }
    if (!inRun) continue;
    if (line.trim() && line.length - line.trimStart().length <= indent) { inRun = false; continue; }
    if (line.includes("${{")) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], `interpolation inside a run body: ${offenders.join(" | ")}`);
  assert.match(yml, /cancel-in-progress: false/, "a cancelled guard reads as not-failed");
});
