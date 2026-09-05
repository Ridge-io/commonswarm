/**
 * What the connect page ASKS FOR when a person adds an agent, and what it BELIEVES about the
 * answer. Behavioural, not source-matched: it drives mintAgentCredential against a stubbed
 * transport and reads the JSON that would have gone on the wire.
 *
 * Operator decision 2026-09-04: an agent added here never expires. Two separate things have to
 * be true for that, and each has its own test below.
 *   1. The request must NAME the kind. Omitting it is not "no opinion" — the command function
 *      falls back to "timeboxed" with a 30-day horizon
 *      (supabase/functions/command/index.ts:2158-2160, 3085-3088), which is the month every
 *      web-added agent used to die after.
 *   2. `renewal_horizon_ms` must be ABSENT from the JSON. The validator accepts standing only
 *      when the key is `undefined` (index.ts:2164-2165); a present `null` fails validation and
 *      returns 400 (index.ts:2218-2221), even though the wire TYPE declares `number | null`.
 *      `JSON.stringify` drops undefined but SERIALISES null, so this is a real distinction and
 *      the test asserts on the serialised string, not on the object. An object assertion alone
 *      would pass for a body that gets rejected by the deployment.
 *
 * The rest measure that nothing is invented on the way back: grant kind and horizon are read
 * off the response, an unrecognised answer degrades to null rather than to a guess, and no
 * horizon is computed locally for either kind.
 *
 * Reached by `npm --prefix site test` via the glob 'src/components/**\/*.observer.test.ts'.
 * A file under src/lib/ would NOT run: that glob is 'src/lib/*.test.mjs' (site/package.json:11).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const DEPLOYMENT_URL = "https://deployment.test";

/* deployment() reads two <meta> tags off `document` (site/src/lib/commonswarm.ts). Without
 * them mintAgentCredential throws NoDeployment before it composes a command, and every
 * assertion below would pass for the wrong reason. */
(globalThis as { document?: unknown }).document = {
  querySelector(selector: string) {
    if (selector.includes("commonswarm:url")) return { content: DEPLOYMENT_URL };
    if (selector.includes("commonswarm:anon-key")) return { content: "anon-test-key" };
    return null;
  },
};

const { mintAgentCredential } = await import("../../lib/agent-connect");

interface Sent {
  raw: string;
  command: Record<string, unknown>;
}

const sent: Sent[] = [];
let respond: (command: Record<string, unknown>) => Record<string, unknown>;
const realFetch = globalThis.fetch;

const ISSUED_AT = Date.parse("2026-09-04T12:00:00.000Z");

function acceptedStanding(command: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "accepted",
    token_id: "8f6f0d1e-1b4e-4a4a-9f1e-2b7c5d9a3e01",
    principal_id: command.principal_id,
    // Echoed: `renews` requires the server to name the run the client generated.
    run_id: command.run_id,
    grant_kind: "standing",
    horizon_expires_at: null,
    successors_remaining: null,
    events: [
      {
        type: "AgentTokenMinted",
        payload: { issued_at: ISSUED_AT, expires_at: ISSUED_AT + 86_400_000 },
      },
    ],
    agent_token: "swm_agt_test",
  };
}

beforeEach(() => {
  sent.length = 0;
  respond = acceptedStanding;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const envelope = JSON.parse(init.body) as Record<string, unknown>;
    const command = envelope.command as Record<string, unknown>;
    sent.push({ raw: JSON.stringify(command), command });
    const body = respond(command);
    return { status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SESSION = { access_token: "jwt", user: { id: "user" } } as never;
const IDENTITY = {
  principalId: "1f0a3c22-6f2f-4c1e-9d55-0a1b2c3d4e5f",
  name: "claude-code",
  model: null,
};
const DEVICE_ID = "0b9d7c66-2f13-4a7e-8f01-1c2d3e4f5a6b";

async function mint() {
  return await mintAgentCredential(
    SESSION,
    "web_test_command",
    "9c8b7a65-4321-4def-8abc-0123456789ab",
    IDENTITY,
    DEVICE_ID,
    30 * 86_400_000,
  );
}

test("the mint asks for a standing grant", async () => {
  await mint();
  assert.equal(sent.length, 1, "exactly one command is posted");
  assert.equal(
    sent[0]?.command.renewal_kind,
    "standing",
    "an omitted kind is not neutral: the server would default it to timeboxed",
  );
  // The serialised form is what the validator reads.
  assert.match(sent[0]!.raw, /"renewal_kind":"standing"/);
});

test("the mint never puts renewal_horizon_ms on the wire, not even as null", async () => {
  await mint();
  assert.equal(
    Object.hasOwn(sent[0]!.command, "renewal_horizon_ms"),
    false,
    "a present null is refused with 400 by index.ts:2164-2165",
  );
  /* The load-bearing assertion. A property set to `undefined` satisfies the check above and is
   * still correct because JSON.stringify drops it; an explicit null satisfies neither. */
  assert.doesNotMatch(sent[0]!.raw, /renewal_horizon_ms/);
});

test("the mint still sends the device the standing grant will be bound to", async () => {
  await mint();
  // index.ts:4285 binds a standing grant to this id, so an app mint can never read UNBOUND.
  assert.equal(sent[0]?.command.device_id, DEVICE_ID);
});

test("a standing grant is read off the server, never computed here", async () => {
  const credential = await mint();
  assert.equal(credential.grantKind, "standing");
  assert.equal(
    credential.horizonExpiresAt,
    null,
    "a standing grant has no horizon; the page must not invent one",
  );
  assert.equal(credential.renews, true);
});

test("a timeboxed answer keeps the horizon the SERVER gave it, not a local sum", async () => {
  /* The discriminating control. The server's horizon here is 45 days out, which no local
   * computation from issued_at would produce — a page that still added its own 30 days would
   * return a different instant and fail. A page that hardcoded null would fail too, and the
   * standing case above catches a page that hardcoded a date. */
  respond = (command) => ({
    ...acceptedStanding(command),
    grant_kind: "timeboxed",
    horizon_expires_at: "2026-10-19T12:00:00.000Z",
    successors_remaining: 800,
  });
  const credential = await mint();
  assert.equal(credential.grantKind, "timeboxed");
  assert.equal(credential.horizonExpiresAt, Date.parse("2026-10-19T12:00:00.000Z"));
  assert.notEqual(
    credential.horizonExpiresAt,
    ISSUED_AT + 30 * 86_400_000,
    "the reported horizon must not be this page's own 30-day sum",
  );
});

test("a deployment that names no grant kind degrades to unknown, never to a guess", async () => {
  // An older command function accepts renewal_kind, ignores it, and answers without these
  // fields. Reporting "standing" then would be a sentence about the request, not the agent.
  respond = (command) => {
    const body = acceptedStanding(command);
    delete body.grant_kind;
    delete body.horizon_expires_at;
    return body;
  };
  const credential = await mint();
  assert.equal(credential.grantKind, null);
  assert.equal(credential.horizonExpiresAt, null);
  // Still a usable credential: the degrade is in what is CLAIMED, not in what is issued.
  assert.equal(credential.token, "swm_agt_test");
});
