import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  base32Decode,
  base32Encode,
  crc32,
  decodeAgentConnectionToken,
  encodeAgentConnectionToken,
  isAgentConnectionToken,
} from "../../src/cloud/agent-connection-token.js";
import {
  AgentSetupError,
  parseAgentConnection,
} from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import {
  AGENT_CONNECTION_VERSION,
  type AgentConnectionEnvelope,
} from "../../src/cloud/agent-onboarding-contract.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

let root: string;
let previousState: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-token-test-"));
  previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
});

after(async () => {
  if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
  else process.env.SWARM_AGENT_STATE_DIR = previousState;
  await rm(root, { recursive: true, force: true });
});

function artifact(principal = AGENT) {
  return {
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: principal,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
}

function connection(url = "https://fixture.example", principal = AGENT): AgentConnectionEnvelope {
  return {
    version: AGENT_CONNECTION_VERSION,
    url,
    anon_key: "public-fixture",
    workspace_id: WS,
    principal_id: principal,
    credential: artifact(principal),
  };
}

function mockFetcher(principal = AGENT) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "error", "credentials must not follow a redirect");
    let result;
    if (body.resource === "members") {
      result = {
        members: [{ user_id: OWNER, display_name: "Owner" }],
        agents: [{ principal_id: principal, name: "Test agent", owner_user_id: OWNER }],
        identity: { credential_valid: true, principal_id: principal, workspace_id: WS, owner_user_id: OWNER },
      };
    } else if (body.resource === "signals") {
      result = {
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      };
    } else {
      throw new Error(`unexpected request: ${body.resource}`);
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("a token with underscores escaped as \\_ inserted (must succeed)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that fails to strip backslashes or fails to tolerate non-base32
  // escaped characters (e.g. treating \`\\_\` as syntax errors or failing to strip backslashes
  // before base32 decoding) would fail. To pass, an implementation must filter out all
  // characters outside the base32 alphabet (A-Z, 2-7, and dot), ignoring backslashes and
  // underscores introduced by Markdown processors.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  const hostileVariants = [
    `\\_${token}`,
    `${token}\\_`,
    `${token.slice(0, 20)}\\_${token.slice(20)}`,
    `${token.slice(0, 30)}\\_\\_${token.slice(30, 60)}\\_${token.slice(60)}`,
    token.replace("CSWARMA.", "CSWARMA.\\_"),
    token.replace("CSWARMA.", "CSWARMA._"),
  ];

  for (const variant of hostileVariants) {
    const decoded = decodeAgentConnectionToken(variant);
    assert.deepEqual(decoded, env);
    assert.equal(isAgentConnectionToken(variant), true);
    assert.deepEqual(parseAgentConnection(variant), env);
  }
});

test("a token that has been through a Markdown link conversion (must succeed)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that expects the input string to match the token start strictly,
  // or fails to discard Markdown link syntax delimiters \`[...]\` and \`(...) \`, would fail.
  // To pass, an implementation must locate the \`CSWARMA.\` prefix marker anywhere within
  // the text and drop non-base32 link syntax characters.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  const markdownVariants = [
    `[${token}](https://example.com)`,
    `[Connect to agent](${token})`,
    `[${token}](#)`,
    `[${token}](${token})`,
    `<${token}>`,
    `See [documentation](https://example.com/docs) then use ${token} to connect.`,
    `Connect: [${token}](https://commonswarm.org/agent-onboard#anchor)`,
  ];

  for (const variant of markdownVariants) {
    const decoded = decodeAgentConnectionToken(variant);
    assert.deepEqual(decoded, env);
    assert.equal(isAgentConnectionToken(variant), true);
    assert.deepEqual(parseAgentConnection(variant), env);
  }
});

test("a token wrapped in altered or malformed code fences (must succeed)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that relies on rigid code fence regular expressions,
  // requires clean newlines around fences, or fails when fence language tags (like \`json\`)
  // are glued directly to the prefix marker without whitespace, would fail to extract the token.
  // To pass, an implementation must locate the \`CSWARMA.\` prefix marker even when preceded
  // by arbitrary fence tags and strip backticks and surrounding markdown formatting.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  const fenceVariants = [
    `\`\`\`json\n${token}\n\`\`\``,
    `\`\`\`json\r\n${token}\r\n\`\`\``,
    `\`\`\`\n${token}\n\`\`\``,
    `\`\`json\n${token}\n\`\``,
    `\`\`\`\`json\n${token}\n\`\`\`\``,
    `\`\`\`json${token}\`\`\``, // language tag glued directly to token prefix
    `\`\`json${token}\`\``,
    `\`${token}\``,
    `\`\`\`text\n${token}\n\`\`\``,
    `~~~json\n${token}\n~~~`,
  ];

  for (const variant of fenceVariants) {
    const decoded = decodeAgentConnectionToken(variant);
    assert.deepEqual(decoded, env);
    assert.equal(isAgentConnectionToken(variant), true);
    assert.deepEqual(parseAgentConnection(variant), env);
  }
});

test("a token broken across lines with spaces and tabs inserted (must SUCCEED: wrapping is recoverable)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that assumes the token is delivered on a single contiguous line,
  // or considers whitespace (spaces, tabs, line breaks) as invalid base32 characters, would fail
  // on tokens wrapped across lines by terminal windows or chat applications. To pass,
  // the implementation must strip all whitespace characters and recover the contiguous base32 token.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  const wrappedVariants = [
    token.match(/.{1,25}/g)!.join("\n"),
    token.match(/.{1,30}/g)!.join("\r\n"),
    token.match(/.{1,20}/g)!.join("\n  \t  "),
    token.match(/.{1,40}/g)!.join("\t\n\t"),
    `   \t\n${token.slice(0, 40)}\n   \t   ${token.slice(40, 100)}\r\n\t   ${token.slice(100)}   \n\t`,
  ];

  for (const variant of wrappedVariants) {
    const decoded = decodeAgentConnectionToken(variant);
    assert.deepEqual(decoded, env);
    assert.equal(isAgentConnectionToken(variant), true);
    assert.deepEqual(parseAgentConnection(variant), env);
  }
});

test("a lowercase token (must succeed)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that is strictly case-sensitive and only accepts uppercase
  // RFC 4648 base32 letters (A-Z) would fail when input has been lowercased by a user
  // or chat transformer. To pass, an implementation must normalize input with .toUpperCase()
  // before matching the marker and decoding base32.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  const lower = token.toLowerCase();
  assert.notEqual(lower, token);
  assert.deepEqual(decodeAgentConnectionToken(lower), env);
  assert.equal(isAgentConnectionToken(lower), true);
  assert.deepEqual(parseAgentConnection(lower), env);

  const mixed = token
    .split("")
    .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
    .join("");
  assert.deepEqual(decodeAgentConnectionToken(mixed), env);
  assert.equal(isAgentConnectionToken(mixed), true);
  assert.deepEqual(parseAgentConnection(mixed), env);
});

test("a truncated token (must fail on the checksum, not on JSON)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that attempts to decode and parse JSON before validating
  // the CRC32 checksum would fail with a JSON SyntaxError (e.g. "Unexpected end of JSON input")
  // or a UTF-8 decoding error when given a truncated token, rather than detecting the corruption
  // through the checksum. To pass, the implementation must verify the CRC32 checksum FIRST
  // before attempting UTF-8 decoding or JSON parsing, throwing \`token_checksum_invalid\`.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  // 1. Cut 1 to 5 characters from the end of the token
  for (let cut = 1; cut <= 5; cut++) {
    const truncated = token.slice(0, -cut);
    assert.throws(
      () => decodeAgentConnectionToken(truncated),
      (err: unknown) => {
        assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
        assert.equal((err as AgentSetupError).code, "token_checksum_invalid");
        assert.ok(!(err instanceof SyntaxError), "must not throw a JSON SyntaxError");
        return true;
      },
    );
  }

  // 2. Cut characters from the body while keeping the checksum portion
  const lastDot = token.lastIndexOf(".");
  const prefixAndBody = token.slice(0, lastDot);
  const checksumPart = token.slice(lastDot + 1);

  for (let cut = 1; cut <= 5; cut++) {
    const truncatedBody = `${prefixAndBody.slice(0, -cut)}.${checksumPart}`;
    assert.throws(
      () => decodeAgentConnectionToken(truncatedBody),
      (err: unknown) => {
        assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
        assert.equal((err as AgentSetupError).code, "token_checksum_invalid");
        assert.ok(!(err instanceof SyntaxError), "must not throw a JSON SyntaxError");
        return true;
      },
    );
  }
});

test("one flipped character (must fail on the checksum)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that lacks CRC32 checksum verification or ignores checksum
  // mismatches would decode corrupted payload data and fail only later during JSON parsing
  // or semantic validation. To pass, an implementation must compute the CRC32 over the
  // decoded body and reject any mismatch with \`token_checksum_invalid\`.
  const env = connection();
  const token = encodeAgentConnectionToken(env);

  // Flip a character in the token body
  const bodyStart = token.indexOf(".") + 1;
  const bodyEnd = token.lastIndexOf(".");
  const bodyMid = Math.floor((bodyStart + bodyEnd) / 2);
  const flippedBodyChar = token[bodyMid] === "A" ? "B" : "A";
  const flippedBodyToken =
    token.slice(0, bodyMid) + flippedBodyChar + token.slice(bodyMid + 1);

  assert.throws(
    () => decodeAgentConnectionToken(flippedBodyToken),
    (err: unknown) => {
      assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
      assert.equal((err as AgentSetupError).code, "token_checksum_invalid");
      return true;
    },
  );

  // Flip a character in the checksum portion
  const crcStart = bodyEnd + 1;
  const crcIdx = crcStart + 2;
  const flippedCrcChar = token[crcIdx] === "A" ? "B" : "A";
  const flippedCrcToken =
    token.slice(0, crcIdx) + flippedCrcChar + token.slice(crcIdx + 1);

  assert.throws(
    () => decodeAgentConnectionToken(flippedCrcToken),
    (err: unknown) => {
      assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
      assert.equal((err as AgentSetupError).code, "token_checksum_invalid");
      return true;
    },
  );
});

test("an envelope whose credential is invalid (must fail in the existing validator, not the decoder)", () => {
  // Wrong implementation rationale:
  // A wrong implementation that conflates token decoding with credential schema validation
  // might throw a token decoder error (like \`token_payload_invalid\`) instead of delegating
  // to the existing envelope and credential validators. Conversely, a wrong implementation
  // that fails to execute the existing validator would accept malformed credentials.
  // To pass, the token decoder must successfully decode the valid base32 envelope and pass
  // it to \`validateAgentConnectionEnvelope\`, which preserves existing validator error codes.
  const env = connection();

  // Case 1: Principal mismatch between envelope principal_id and credential principal_id
  const mismatchedEnvelope = {
    ...env,
    principal_id: OTHER,
  };
  const tokenMismatch = encodeAgentConnectionToken(mismatchedEnvelope);
  assert.throws(
    () => decodeAgentConnectionToken(tokenMismatch),
    (err: unknown) => {
      assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
      assert.equal((err as AgentSetupError).code, "connection_identity_mismatch");
      assert.notEqual((err as AgentSetupError).code, "token_payload_invalid");
      assert.notEqual((err as AgentSetupError).code, "token_checksum_invalid");
      return true;
    },
  );

  // Case 2: Credential missing required agent_token
  const invalidCredEnvelope = {
    ...env,
    credential: {
      ...env.credential,
      agent_token: undefined,
    },
  };
  const tokenBadCred = encodeAgentConnectionToken(invalidCredEnvelope as unknown as AgentConnectionEnvelope);
  assert.throws(
    () => decodeAgentConnectionToken(tokenBadCred),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error & { code?: string }).code ?? err.message, /agent_credential_missing_agent_token|connection_invalid/);
      assert.notEqual((err as Error & { code?: string }).code, "token_payload_invalid");
      return true;
    },
  );

  // Case 3: Credential is not an object
  const nonObjectCredEnvelope = {
    ...env,
    credential: "not-an-object",
  };
  const tokenNonObj = encodeAgentConnectionToken(nonObjectCredEnvelope as unknown as AgentConnectionEnvelope);
  assert.throws(
    () => decodeAgentConnectionToken(tokenNonObj),
    (err: unknown) => {
      assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
      assert.equal((err as AgentSetupError).code, "connection_invalid");
      assert.notEqual((err as AgentSetupError).code, "token_payload_invalid");
      return true;
    },
  );
});

test("a round trip: encode then decode returns the original bytes exactly", () => {
  // Wrong implementation rationale:
  // A wrong implementation that re-serializes JSON with altered key order, modifies
  // whitespace or character encoding, or introduces padding corruption during base32
  // encoding/decoding would fail to preserve the exact byte representation of the payload.
  // To pass, the token encoder and decoder must preserve the exact UTF-8 byte stream
  // without losing, reordering, or adding any bytes.
  const env = connection();
  const rawJson = JSON.stringify(env);
  const originalBytes = new TextEncoder().encode(rawJson);

  // Encode the envelope
  const token = encodeAgentConnectionToken(env);

  // Decode the token and assert envelope equality
  const decoded = decodeAgentConnectionToken(token);
  assert.deepEqual(decoded, env);

  // Assert the UTF-8 JSON payload bytes match byte-for-byte
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const payloadBytes = base32Decode(parts[1]!);
  assert.deepEqual(payloadBytes, originalBytes);

  // Assert TextDecoder recovers the exact original JSON string
  const recoveredJson = new TextDecoder("utf-8").decode(payloadBytes);
  assert.equal(recoveredJson, rawJson);

  // Also verify encoding a direct string payload preserves exact bytes
  const customJson = JSON.stringify(env, null, 2);
  const customBytes = new TextEncoder().encode(customJson);
  const tokenFromStr = encodeAgentConnectionToken(customJson);
  const decodedFromStr = decodeAgentConnectionToken(tokenFromStr);
  assert.deepEqual(decodedFromStr, env);
  const partsFromStr = tokenFromStr.split(".");
  const payloadBytesFromStr = base32Decode(partsFromStr[1]!);
  assert.deepEqual(payloadBytesFromStr, customBytes);
});

test("Control proving the OLD path still works: a plain JSON envelope file still sets up", async () => {
  // 1. Write a valid plain JSON envelope to a private 0600 file in a 0700 dir.
  // Call setupAgent with a mock/fake fetcher and verify setup succeeds.
  const jsonDir = await mkdtemp(join(root, "json-setup-"));
  await chmod(jsonDir, 0o700);
  const jsonFilePath = join(jsonDir, "connection.json");
  const env = connection();
  await writeFile(jsonFilePath, JSON.stringify(env), { mode: 0o600 });

  const jsonProfilePath = join(jsonDir, "agent", "profile.json");
  const fake1 = mockFetcher();
  const jsonResult = await setupAgent({
    connectionFile: jsonFilePath,
    profilePath: jsonProfilePath,
    fetcher: fake1.fetcher,
  });

  assert.equal(jsonResult.connected, true);
  assert.equal(jsonResult.principal_id, AGENT);
  assert.equal(jsonResult.workspace_id, WS);
  assert.equal(fake1.requests.length, 2);

  // 2. Also test setupAgent with a file containing the new base32 token
  // to prove end-to-end setup works with token files!
  const tokenDir = await mkdtemp(join(root, "token-setup-"));
  await chmod(tokenDir, 0o700);
  const tokenFilePath = join(tokenDir, "connection.token");
  const token = encodeAgentConnectionToken(env);
  await writeFile(tokenFilePath, token, { mode: 0o600 });

  const tokenProfilePath = join(tokenDir, "agent", "profile.json");
  const fake2 = mockFetcher();
  const tokenResult = await setupAgent({
    connectionFile: tokenFilePath,
    profilePath: tokenProfilePath,
    fetcher: fake2.fetcher,
  });

  assert.equal(tokenResult.connected, true);
  assert.equal(tokenResult.principal_id, AGENT);
  assert.equal(tokenResult.workspace_id, WS);
  assert.equal(fake2.requests.length, 2);
});

test("missing marker token_marker_missing", () => {
  // Strings without the CSWARMA. marker fail with token_marker_missing
  const invalidMarkers = [
    "NOT_A_VALID_TOKEN",
    "CSWARMB.ABC.DEF",
    "CSWARM.ABC.DEF",
    "",
    "JUST_SOME_BASE32_STRING_234567",
  ];

  for (const raw of invalidMarkers) {
    assert.throws(
      () => decodeAgentConnectionToken(raw),
      (err: unknown) => {
        assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
        assert.equal((err as AgentSetupError).code, "token_marker_missing");
        return true;
      },
    );
  }

  assert.equal(isAgentConnectionToken("NOT_A_VALID_TOKEN"), false);
  assert.equal(isAgentConnectionToken(""), false);
});

test("token_shape_invalid: incomplete token parts throw token_shape_invalid", () => {
  const malformedTokens = [
    "CSWARMA..",
    "CSWARMA.",
    "CSWARMA.ONLYONEPART",
  ];

  for (const raw of malformedTokens) {
    assert.throws(
      () => decodeAgentConnectionToken(raw),
      (err: unknown) => {
        assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
        assert.equal((err as AgentSetupError).code, "token_shape_invalid");
        return true;
      },
    );
  }
});

test("token_payload_invalid: valid checksum but malformed JSON throws token_payload_invalid", () => {
  const nonJson = new TextEncoder().encode("not valid json at all");
  const crc = crc32(nonJson);
  const crcBytes = Uint8Array.from([24, 16, 8, 0].map((s) => (crc >>> s) & 255));
  const badToken = `CSWARMA.${base32Encode(nonJson)}.${base32Encode(crcBytes)}`;

  assert.throws(
    () => decodeAgentConnectionToken(badToken),
    (err: unknown) => {
      assert.ok(err instanceof AgentSetupError, `expected AgentSetupError but got ${err}`);
      assert.equal((err as AgentSetupError).code, "token_payload_invalid");
      return true;
    },
  );
});
