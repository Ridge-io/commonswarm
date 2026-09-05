/**
 * Every file:line this lane's comments cite must still point at what they claim.
 *
 * WHY THIS EXISTS. A review arm found that the standing-grant follow-up carried citations that
 * were correct when they were written — verified line by line against origin/main @ e3df06b —
 * and wrong by the time they landed, because the lane they were rebuilt on top of
 * (20260904000001_standing_grant_resume + its command-function changes) inserted ~275 lines
 * into supabase/functions/command/index.ts and pushed every later line down. Nothing about the
 * claims was wrong. The NUMBERS were, and only a human re-reading each one could tell.
 *
 * AGENTS.md already says "measure the artifact, not its name" and "an enumeration inside a
 * message must be generated, not typed". A line number is the same shape of defect: a hand-typed
 * pointer with no control on it, which drifts the moment anything above it moves, and which the
 * next reader trusts because it looks precise.
 *
 * So each entry below is a citation some comment makes, plus the token that must appear at that
 * line. When a citation drifts, this test names it. It does NOT check that the comment's
 * REASONING is right — only that the pointer still resolves. Read the prose yourself.
 *
 * Reached by `npm test` (named in the literal list) and by `npm run test:p1-cli` (glob).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

interface Citation {
  /** Where the citing comment lives, for the failure message. */
  citedBy: string;
  file: string;
  /** 1-based, inclusive. A single line is [n, n]. */
  lines: [number, number];
  /** Must appear somewhere inside that range. */
  contains: string;
}

const CITATIONS: Citation[] = [
  // site/src/lib/agent-connect.ts — mintedHorizon and the retired-constant note
  {
    citedBy: "site/src/lib/agent-connect.ts (mintedHorizon)",
    file: "supabase/functions/command/index.ts",
    lines: [8671, 8676],
    contains: "horizon_expires_at: prepared.command.renewal_horizon_ms === null",
  },
  {
    citedBy: "site/src/lib/agent-connect.ts (mintedHorizon, replay)",
    file: "supabase/functions/command/index.ts",
    lines: [2387, 2393],
    contains: "horizon_expires_at: response.horizon_expires_at as string | null",
  },
  {
    citedBy: "site/src/lib/agent-connect.ts (the 400 message)",
    file: "supabase/functions/command/index.ts",
    lines: [2167, 2175],
    contains: "const valid = exactKeys(cmd, [",
  },
  // site/src/components/connect/agent-connect-mint.observer.test.ts
  {
    citedBy: "agent-connect-mint.observer.test.ts (timeboxed fallback, validator)",
    file: "supabase/functions/command/index.ts",
    lines: [2158, 2160],
    contains: '? "timeboxed"',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (timeboxed fallback, prepared)",
    file: "supabase/functions/command/index.ts",
    lines: [3085, 3088],
    contains: 'renewal_kind: wire.renewal_kind ?? "timeboxed"',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (standing needs an ABSENT horizon)",
    file: "supabase/functions/command/index.ts",
    lines: [2164, 2165],
    contains: 'renewalKind === "standing" && cmd.renewal_horizon_ms === undefined',
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (the 400)",
    file: "supabase/functions/command/index.ts",
    lines: [2218, 2221],
    contains: "mint_agent_token fields are malformed or out of bounds",
  },
  {
    citedBy: "agent-connect-mint.observer.test.ts (standing binds to the request device)",
    file: "supabase/functions/command/index.ts",
    lines: [4285, 4285],
    contains: "standing ? prepared.wire.device_id : null",
  },
  // supabase/functions/command/index.ts — the resume handler's own comment
  {
    citedBy: "command/index.ts (resume handler, the pattern it copies)",
    file: "supabase/functions/command/index.ts",
    lines: [3339, 3339],
    contains: "grant_preflight_code: (preflight[0]?.code ?? null)",
  },
  {
    citedBy: "command/index.ts (resume handler) + p1-server test",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [551, 606],
    contains: "RETURN 'renewal_grant_not_suspended'",
  },
  {
    citedBy: "command/index.ts (resume handler, the mutation it precedes)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [608, 612],
    contains: "UPDATE swarm.renewal_grants",
  },
  {
    citedBy: "p1-server test (NULL is the success value)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [614, 614],
    contains: "RETURN NULL;",
  },
  /* The published-policy citations. These were NOT registered here, so when a
   * lane moved command/index.ts by 700 lines an automated remap walked them to
   * unrelated code and every gate stayed green. A review arm caught it by
   * reading. Registering them is the durable fix: the test exists for exactly
   * this and could not see them. */
  {
    citedBy: "privacy.astro (what we get from GitHub)",
    file: "supabase/functions/command/index.ts",
    lines: [9096, 9112],
    contains: "metadata?.full_name",
  },
  {
    citedBy: "privacy.astro (audit ip is never written)",
    file: "supabase/functions/command/index.ts",
    lines: [1370, 1385],
    contains: "outcome, reason, detail, request_hash, ip",
  },
  {
    citedBy: "privacy.astro (the command vocabulary)",
    file: "supabase/functions/command/index.ts",
    lines: [835, 835],
    contains: "const COMMAND_KINDS = [",
  },
  {
    citedBy: "terms.astro + acceptable-use.astro (workspace cap)",
    file: "supabase/functions/command/index.ts",
    lines: [655, 655],
    contains: "const FREE_TIER_WORKSPACE_LIMIT",
  },
  {
    citedBy: "terms.astro + acceptable-use.astro (signal rate caps)",
    file: "supabase/functions/command/index.ts",
    lines: [561, 562],
    contains: "const SIGNAL_CREDENTIAL_LIMIT",
  },
  {
    citedBy: "src/cloud/files.ts (the TTL constant scar)",
    file: "supabase/functions/command/index.ts",
    lines: [551, 551],
    contains: "const AGENT_TOKEN_MAX_TTL_MS",
  },
  // src/protocol/workspace-commands.ts — the one definition of "paused"
  {
    citedBy: "src/protocol/workspace-commands.ts (suspension_active)",
    file: "supabase/migrations/20260904000001_standing_grant_resume.sql",
    lines: [85, 89],
    contains: "GENERATED ALWAYS AS (",
  },
];

test("every file:line this lane cites still points at what it claims", () => {
  const failures: string[] = [];
  for (const c of CITATIONS) {
    const path = fileURLToPath(new URL(c.file, root));
    const all = readFileSync(path, "utf8").split("\n");
    const [from, to] = c.lines;
    /* POSITIVE CONTROL: the range has to exist at all. Without this a citation past the end of
       a shrunken file would slice to "" and read as a plain content mismatch, which sends the
       next reader looking for the wrong thing. */
    assert.ok(
      to <= all.length,
      `${c.file}:${from}-${to} is past the end of the file (${all.length} lines)`,
    );
    const slice = all.slice(from - 1, to).join("\n");
    if (!slice.includes(c.contains)) {
      const actual = all.findIndex((line) => line.includes(c.contains));
      failures.push(
        `${c.citedBy}\n    cites ${c.file}:${from}${from === to ? "" : `-${to}`}` +
          ` for ${JSON.stringify(c.contains)}\n    but that text is ` +
          (actual === -1 ? "nowhere in the file" : `at line ${actual + 1}`),
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `citations drifted:\n\n${failures.join("\n\n")}\n`,
  );
});
