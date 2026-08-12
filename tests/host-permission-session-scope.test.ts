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

/* The helper's session-id parameter is a WIDE UNION, not `string`. The first version typed it
 * was structurally incapable of expressing the bypass that actually shipped — a child that OMITS
 * sessionId or sends a non-string. A test helper's parameter types decide which defects it can even
 * describe, and this one had quietly excluded the whole malformed-input class. Caught by the
 * exact-review arm, which probed it directly rather than through the helper.
 *
 * ~~"takes `unknown`"~~ — corrected: it is `ClaimedSessionId | typeof OMITTED`, and the object case
 * still needs a cast. Same arm, same round. A union that happens to cover today's cases is not the
 * same claim as `unknown`, and writing the stronger word describes a helper I did not build. */
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
        send({
          jsonrpc: "2.0",
          id: msg.id,
          // "" models the documented agents that return an EMPTY result on load success.
          result: returnedSessionId === "" ? {} : { sessionId: returnedSessionId },
        });
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

test("D-086 REGRESSION GUARD: an agent returning an EMPTY load result still resumes", async () => {
  /* The riskiest thing about the mismatch guard is breaking a provider that was working. The
   * existing comment in session.ts records that "some agents return empty result on load success",
   * and that path must survive: an empty result keeps the REQUESTED id and is a successful load.
   *
   * This is the question that outranks the hardening — a fix that secures the product by breaking
   * it for real providers is not a fix. Nothing covered this branch before.
   *
   * WHAT WAS ESTABLISHED, stated exactly: forcing the guard to reject every load leaves this test
   * GREEN, because an empty result returns at the earlier `typeof result.sessionId !== "string"`
   * branch and never reaches the guard. So this is a regression PIN, not a mutation-discriminating
   * control — and the structural separation it demonstrates is the stronger result: the guard
   * cannot break the empty-result provider, whatever it is changed to. The mutation that does turn
   * this red is one that removes the early branch. */
  const { result, freshSessionsAfterLoad } = await loadInto("");

  assert.equal(result.sessionId, "requested", "an empty load result stopped keeping the requested id");
  assert.equal(result.loaded, true, "an empty load result was treated as a failed load");
  assert.equal(freshSessionsAfterLoad, 0, "an empty load result forced a needless fresh session");
});

/* The reply-text path. `message` becomes the reply body posted as a signal, so text from a session
 * we never opened would be published under our agent's name — the same trust as the permission
 * blocker, one layer over.
 *
 * ★ These tests and their fix were written once and LOST before reaching a commit, while
 * 65527457's message claimed both had landed. The inversion arm caught it by reading the tree
 * instead of the commit message. Re-added and verified against the COMMITTED object. */
function chunkChild(chunkSessionId: unknown, omit = false) {
  const toAgent = new PassThrough();
  const toHost = new PassThrough();
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
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            ...(omit ? {} : { sessionId: chunkSessionId }),
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "SMUGGLED" },
            },
          },
        });
        setTimeout(
          () => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }),
          40,
        );
      }
    }
  });

  return { readable: toHost, writable: toAgent };
}

async function messageFrom(chunkSessionId: unknown, omit = false): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "d086-chunk-"));
  const fake = chunkChild(chunkSessionId, omit);
  try {
    const { session } = await openAcpSessionOverStdio({
      cwd,
      readable: fake.readable,
      writable: fake.writable,
      promptsEnabled: true,
      requestTimeoutMs: 5_000,
      permissionCallback: (request) => allowOnceOrDeny(request),
    });
    const result = await session.prompt("do a thing");
    await session.close();
    return result.message ?? "";
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const [label, id, omit] of [
  ["an explicit foreign id", "other", false],
  ["an omitted id", undefined, true],
  ["a null id", null, false],
  ["a numeric id", 7, false],
] as const) {
  test(`D-086 reply text: a chunk with ${label} does not enter the reply`, async () => {
    assert.equal(
      await messageFrom(id, omit),
      "",
      `text from a chunk with ${label} reached the reply body`,
    );
  });
}

test("D-086 reply text CONTROL: our own session's chunk still becomes the reply", async () => {
  /* Dropping every chunk satisfies all four assertions above and produces a listener that answers
   * every ask with an empty string — a worse defect than the one being fixed. */
  assert.equal(
    await messageFrom("ours"),
    "SMUGGLED",
    "the real session's text no longer reaches the reply",
  );
});

/* session/load: ABSENT and MALFORMED are different answers.
 *
 * An absent sessionId legitimately means "the one you asked for" — documented provider behaviour
 * and load-bearing. A sessionId that is PRESENT and not a string is a provider saying something we
 * do not understand about which session we are on, and it was being recorded as a successful load
 * of the requested id. Eight malformed shapes reproduced that on 65527457. */
function loadChildRaw(result: unknown) {
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
        send({ jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.method === "session/set_mode") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  });

  return { readable: toHost, writable: toAgent, newSessionCount: () => newSessions };
}

async function loadRaw(result: unknown) {
  const cwd = mkdtempSync(join(tmpdir(), "d086-loadraw-"));
  const fake = loadChildRaw(result);
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
    const out = await session.load("requested");
    await session.close();
    return { ...out, freshSessionsAfterLoad: fake.newSessionCount() - before };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const [label, result] of [
  ["null", { sessionId: null }],
  ["a number", { sessionId: 7 }],
  ["an array", { sessionId: ["ours"] }],
  ["an object", { sessionId: { id: "ours" } }],
  ["a boolean", { sessionId: true }],
] as const) {
  test(`D-086 load: a PRESENT ${label} session id is not a successful load`, async () => {
    const out = await loadRaw(result);
    assert.equal(out.loaded, false, `a ${label} session id was reported as a successful load`);
    assert.notEqual(out.sessionId, "requested", `a ${label} session id kept the requested id`);
    assert.equal(out.freshSessionsAfterLoad, 1, "no fallback session was opened");
  });
}

for (const [label, result] of [
  ["an empty object", {}],
  ["an explicitly undefined field", { sessionId: undefined }],
  ["a non-record", "not-a-record"],
] as const) {
  test(`D-086 load CONTROL: an ABSENT session id (${label}) still resumes`, async () => {
    /* The distinction this whole change rests on. Rejecting these too would "secure" the product by
     * breaking session resumption for the providers the comment in session.ts was written for. */
    const out = await loadRaw(result);
    assert.equal(out.loaded, true, `${label} stopped being treated as a successful load`);
    assert.equal(out.sessionId, "requested", `${label} stopped keeping the requested id`);
    assert.equal(out.freshSessionsAfterLoad, 0, `${label} forced a needless fresh session`);
  });
}
