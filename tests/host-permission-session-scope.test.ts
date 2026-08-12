/**
 * D-086. A permission request for a session we are not driving must never reach the approving
 * callback.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a new file under tests/ is otherwise silent.
 *
 * WHY IT EXISTS. `handlePermissionRequest` computed `sessionMatches` and used it only to set the
 * canary flag; the permission callback ran regardless. While `deny` was the default the bug was
 * inert — the callback refused everything either way — so nothing on the deny path could observe
 * it. Making `allow` the default (D-084) armed it: `allowOnceOrDeny` returns an `allow_once`
 * approval, and it would do so for a sessionId that is not ours.
 *
 * The sessionId arrives over JSON-RPC from the provider child. It is THAT process's assertion, not
 * a fact we established, which is what makes trusting it a fail-open rather than a nuisance.
 *
 * Found by the D-036 exact-review arm on 87fe7edc, which reproduced it rather than reasoning about
 * it. The lesson worth keeping: **the change and the defect were in different files.** A default
 * flip that is correct in isolation can arm a latent defect elsewhere, and no test of the flip
 * itself would find it.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  ACP_PROTOCOL_VERSION,
  allowOnceOrDeny,
  openAcpSessionOverStdio,
} from "../src/host/index.js";

const ALLOW_AND_REJECT = [
  { optionId: "a", name: "Allow", kind: "allow_once" as const },
  { optionId: "r", name: "Reject", kind: "reject_once" as const },
];

/* The helper takes `unknown`, not `string`, ON PURPOSE. The first version typed it `string`, so it
 * was structurally incapable of expressing the bypass that actually shipped — a child that OMITS
 * sessionId or sends a non-string. A test helper's parameter types decide which defects it can even
 * describe, and this one had quietly excluded the whole malformed-input class. Caught by the
 * exact-review arm, which probed it directly rather than through the helper. */
type ClaimedSessionId = string | number | null | undefined;
const OMITTED = Symbol("omitted");

/** Minimal ACP child: answers initialize/session/new, then asks permission for `askSessionId`. */
function child(askSessionId: ClaimedSessionId | typeof OMITTED, options = ALLOW_AND_REJECT) {
  const toAgent = new PassThrough();
  const toHost = new PassThrough();
  const seen = new EventEmitter();
  const responses: Record<string, unknown>[] = [];
  let buf = "";

  const send = (msg: unknown) => toHost.write(`${JSON.stringify(msg)}\n`);

  toAgent.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: ACP_PROTOCOL_VERSION } });
      } else if (msg.method === "session/new") {
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ours" } });
      } else if (msg.method === "session/prompt") {
        /* The permission request is raised DURING A PROMPT, not straight after session/new.
         *
         * The first version of this file asked immediately, and the host had not yet recorded its
         * session id, so `sessionMatches` was false for BOTH cases and the mismatch test passed
         * without exercising the mismatch. The control is what exposed it — a control that dies
         * early tests the early thing. */
        send({
          jsonrpc: "2.0",
          id: 9001,
          method: "session/request_permission",
          params: {
            ...(askSessionId === OMITTED ? {} : { sessionId: askSessionId }),
            toolCall: { toolCallId: "tc-1", title: "run_terminal_command", kind: "execute" },
            options,
          },
        });
        setTimeout(
          () => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }),
          40,
        );
      } else if (msg.id === 9001 || (msg.result !== undefined && msg.method === undefined)) {
        responses.push(msg);
        seen.emit("response", msg);
      }
    }
  });

  return { readable: toHost, writable: toAgent, responses, seen };
}

function decisionFor(response: Record<string, unknown> | undefined): string {
  const result = (response?.result ?? {}) as Record<string, unknown>;
  const outcome = (result.outcome ?? {}) as Record<string, unknown>;
  return typeof outcome.optionId === "string" ? outcome.optionId : String(outcome.outcome ?? "none");
}

async function runCase(askSessionId: ClaimedSessionId | typeof OMITTED) {
  const cwd = mkdtempSync(join(tmpdir(), "d086-"));
  const fake = child(askSessionId);
  const reached: string[] = [];
  try {
    const { session } = await openAcpSessionOverStdio({
      cwd,
      readable: fake.readable,
      writable: fake.writable,
      promptsEnabled: true,
      requestTimeoutMs: 5_000,
      // Steady-state ALLOW — the mode that is now the default, and the one that arms the defect.
      permissionCallback: (request) => {
        reached.push(request.sessionId);
        return allowOnceOrDeny(request);
      },
    });
    await session.prompt("do a thing");
    await session.close();
    return { reached, responses: fake.responses };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("D-086: an allow-mode listener does not approve a request for another session", async () => {
  const { reached, responses } = await runCase("other");

  assert.deepEqual(
    reached,
    [],
    "the approving callback was invoked for a session we are not driving",
  );
  assert.notEqual(
    decisionFor(responses[0]),
    "a",
    "a mismatched-session request was granted allow_once",
  );
});

test("D-086 CONTROL: the matching session still reaches the callback and is approved", async () => {
  /* Without this, refusing EVERYTHING would pass the test above while breaking the feature the
   * whole D-084 change exists to deliver. The fix must be narrow, not merely safe. */
  const { reached, responses } = await runCase("ours");

  assert.deepEqual(reached, ["ours"], "the real session no longer reaches the permission callback");
  assert.equal(
    decisionFor(responses[0]),
    "a",
    "allow mode stopped approving its own session's requests",
  );
});

test("D-086: allow falls back to deny when the host offers no allow_once", async () => {
  /* The exact-review arm noted every model fixture supplies an allow_once option, so the documented
   * fallback — "approved ... when the host offers a one-time approval" — was asserted by copy and
   * by no test. This exercises the branch that makes that sentence true. */
  const cwd = mkdtempSync(join(tmpdir(), "d086-nofallback-"));
  const fake = child("ours", [
    { optionId: "always", name: "Always allow", kind: "allow_always" as const },
    { optionId: "r", name: "Reject", kind: "reject_once" as const },
  ] as unknown as typeof ALLOW_AND_REJECT);
  try {
    const { session } = await openAcpSessionOverStdio({
      cwd,
      readable: fake.readable,
      writable: fake.writable,
      promptsEnabled: true,
      requestTimeoutMs: 5_000,
      permissionCallback: (request) => allowOnceOrDeny(request),
    });
    await session.prompt("do a thing");
    await session.close();

    assert.notEqual(
      decisionFor(fake.responses[0]),
      "always",
      "allow mode escalated to allow_always when no one-time option was offered",
    );
    assert.equal(
      decisionFor(fake.responses[0]),
      "r",
      "allow mode did not fall back to the reject option",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* The malformed-id bypass. The first D-086 fix compared a substituted value: when the child omitted
 * sessionId or sent a non-string, the host filled in ITS OWN id and the comparison then succeeded.
 * So the fix stopped an explicit foreign id and waved through the absent one — and the test above
 * could not see it, because its helper only accepted strings.
 *
 * Measured by the exact-review arm on 8e666ab4: omitted, null, and numeric ids all reached the
 * approving callback as "ours" and returned allow_once. An empty string denied, which is why a
 * casual probe would have looked clean. */
for (const [label, claimed] of [
  ["omitted entirely", OMITTED],
  ["null", null],
  ["a number", 7],
  ["an object", { toString: () => "ours" }],
] as const) {
  test(`D-086 malformed id: sessionId ${label} is not treated as ours`, async () => {
    const { reached, responses } = await runCase(claimed as ClaimedSessionId);
    assert.deepEqual(
      reached,
      [],
      `a request whose sessionId was ${label} reached the approving callback`,
    );
    assert.notEqual(
      decisionFor(responses[0]),
      "a",
      `a request whose sessionId was ${label} was granted allow_once`,
    );
  });
}

/* session/load: the child must not choose which session we are driving.
 *
 * We ask to load id X; the child returns Y; the host adopted Y as active. Every later session check
 * is then made against a value the CHILD picked, which defeats those checks at the source rather
 * than at each use — the exact-review arm loaded "requested", received "other", and then had a
 * permission request for "other" approved.
 *
 * Deleting the guard left the whole grok suite green, so nothing covered this. */
function loadChild(returnedSessionId: string) {
  const toAgent = new PassThrough();
  const toHost = new PassThrough();
  let buf = "";
  let newSessions = 0;
  const send = (msg: unknown) => toHost.write(`${JSON.stringify(msg)}\n`);

  toAgent.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: ACP_PROTOCOL_VERSION } });
      } else if (msg.method === "session/new") {
        newSessions += 1;
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: `fresh-${newSessions}` } });
      } else if (msg.method === "session/load") {
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: returnedSessionId } });
      } else if (msg.method === "session/set_mode") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  });

  return { readable: toHost, writable: toAgent, newSessionCount: () => newSessions };
}

async function loadInto(returnedSessionId: string) {
  const cwd = mkdtempSync(join(tmpdir(), "d086-load-"));
  const fake = loadChild(returnedSessionId);
  try {
    const { session } = await openAcpSessionOverStdio({
      cwd,
      readable: fake.readable,
      writable: fake.writable,
      promptsEnabled: true,
      requestTimeoutMs: 5_000,
      permissionCallback: (request) => allowOnceOrDeny(request),
    });
    const before = fake.newSessionCount();
    const result = await session.load("requested");
    await session.close();
    return { result, freshSessionsAfterLoad: fake.newSessionCount() - before };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("D-086: session/load returning a DIFFERENT id is not adopted", async () => {
  const { result, freshSessionsAfterLoad } = await loadInto("other");

  assert.notEqual(result.sessionId, "other", "the child chose the active session id");
  assert.equal(result.loaded, false, "a substituted id was reported as a successful load");
  assert.equal(
    freshSessionsAfterLoad,
    1,
    "the mismatch did not fall back to a fresh session, so no re-canary happened",
  );
});

test("D-086 CONTROL: session/load returning the SAME id still loads", async () => {
  /* Treating every load as a mismatch would pass the assertion above and silently destroy session
   * resumption — the listener would re-canary on every reconnect. */
  const { result, freshSessionsAfterLoad } = await loadInto("requested");

  assert.equal(result.sessionId, "requested", "a correct load stopped being adopted");
  assert.equal(result.loaded, true, "a correct load was reported as failed");
  assert.equal(freshSessionsAfterLoad, 0, "a correct load opened a needless fresh session");
});
