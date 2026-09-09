import {
  decodeAgentConnectionToken,
  encodeAgentConnectionToken,
  isAgentConnectionToken,
} from "../../review-77fe6df4/src/cloud/agent-connection-token.js";
import { parseAgentConnection } from "../../review-77fe6df4/src/cloud/agent-profile.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../review-77fe6df4/src/cloud/agent-credential-input.js";

const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const env = {
  version: 1 as const,
  url: "https://fixture.example",
  anon_key: "public-fixture",
  workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  principal_id: id,
  credential: {
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: id,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: `swm_agt_${"A".repeat(43)}`,
    expires_at: "2099-01-01T00:00:00.000Z",
  },
};

const token = encodeAgentConnectionToken(env);
const bodyStart = token.indexOf(".") + 1;
const bodyEnd = token.lastIndexOf(".");
const bodyMid = Math.floor((bodyStart + bodyEnd) / 2);

const variants: Record<string, string> = {
  canonical: token,
  marker_hyphen: token.replace("CSWARMA", "CSWA-RMA"),
  marker_bang: token.replace("CSWARMA", "CSWA!RMA"),
  leading_brace: `{ ${token}`,
  json_string_value: JSON.stringify({ token }),
  extra_part_direct: `${token}.EXTRA`,
  extra_part_after_tab: `${token}\t.EXTRA`,
  extra_checksum_direct: `${token}A`,
  extra_checksum_after_tab: `${token}\tA`,
  punctuation_in_checksum: `${token.slice(0, -3)}!${token.slice(-3)}`,
  bold_in_body: `${token.slice(0, bodyMid)}**${token.slice(bodyMid)}`,
  tabs_wrapped: `\t${token.match(/.{1,31}/g)!.join("\t\n")}\t`,
  lowercase: token.toLowerCase(),
  fenced: `\`\`\`text\n${token}\n\`\`\``,
  prose: `Use this token: ${token} to connect.`,
};

function result(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    const e = error as Error & { code?: string };
    return `${e.constructor.name}:${e.code ?? e.name}`;
  }
}

for (const [name, raw] of Object.entries(variants)) {
  console.log(JSON.stringify({
    name,
    detected: isAgentConnectionToken(raw),
    decode: result(() => decodeAgentConnectionToken(raw)),
    parse: result(() => parseAgentConnection(raw)),
  }));
}

// Exhaust the non-significant final-symbol bits for both Base32 fields. Only the
// canonical final symbol may decode for a fixed body/checksum.
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
for (const [partName, dotIndex] of [["body", bodyEnd], ["checksum", token.length]] as const) {
  const index = dotIndex - 1;
  const accepted: string[] = [];
  for (const c of alphabet) {
    const mutated = token.slice(0, index) + c + token.slice(index + 1);
    if (result(() => decodeAgentConnectionToken(mutated)) === "ok") accepted.push(c);
  }
  console.log(JSON.stringify({ partName, original: token[index], accepted }));
}

let mutationCount = 0;
let mutationAccepted = 0;
for (let n = 0; n < 12; n++) {
  const sampleToken = encodeAgentConnectionToken({ ...env, anon_key: `${env.anon_key}${"x".repeat(n)}` });
  const sampleBodyEnd = sampleToken.lastIndexOf(".");
  for (const index of [sampleBodyEnd - 1, sampleToken.length - 1]) {
    for (const c of alphabet) {
      if (c === sampleToken[index]) continue;
      mutationCount++;
      const mutated = sampleToken.slice(0, index) + c + sampleToken.slice(index + 1);
      if (result(() => decodeAgentConnectionToken(mutated)) === "ok") mutationAccepted++;
    }
  }
}
console.log(JSON.stringify({ mutationCount, mutationAccepted }));

const originalParse = JSON.parse;
for (const [name, raw] of Object.entries({
  extra_part_direct: variants.extra_part_direct,
  extra_checksum_direct: variants.extra_checksum_direct,
  extra_part_after_tab: variants.extra_part_after_tab,
})) {
  let calls = 0;
  JSON.parse = (...args: Parameters<typeof originalParse>) => {
    calls++;
    return originalParse(...args);
  };
  const outcome = result(() => decodeAgentConnectionToken(raw));
  JSON.parse = originalParse;
  console.log(JSON.stringify({ name, outcome, jsonParseCalls: calls }));
}
