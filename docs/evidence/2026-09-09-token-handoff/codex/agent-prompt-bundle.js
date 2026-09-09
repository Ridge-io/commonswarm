// site/src/lib/auth-providers.ts
var PROVIDERS = [
  {
    id: "github",
    label: "Sign in with GitHub",
    name: "GitHub",
    legalEntity: "GitHub, Inc."
  },
  {
    id: "google",
    label: "Sign in with Google",
    name: "Google",
    legalEntity: "Google LLC"
  }
];
var AUTH_PROVIDERS = Object.freeze(
  PROVIDERS.map((provider) => Object.freeze({ ...provider }))
);

// supabase/functions/_shared/channels.ts
var SIGNAL_KINDS = ["working-on", "note", "ask"];
var THREAD_REPLY_KINDS = SIGNAL_KINDS.filter(
  (kind) => kind !== "working-on"
);
var CHANNEL_SLUG_MAX = 32;
var CHANNEL_SLUG_CLASSES = {
  edge: [
    { fragment: "a-z", words: "lowercase letters", one: "a letter" },
    { fragment: "0-9", words: "digits", one: "a digit" }
  ],
  inner: [{ fragment: "-", words: "hyphens" }]
};
function classList(entries, conjunction = "and", singular = false) {
  const words = entries.map(
    (entry) => singular ? entry.one ?? entry.words : entry.words
  );
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}
var SLUG_EDGE = CHANNEL_SLUG_CLASSES.edge.map((c) => c.fragment).join("");
var SLUG_INNER = SLUG_EDGE + CHANNEL_SLUG_CLASSES.inner.map((c) => c.fragment).join("");
function channelSlugPattern() {
  return new RegExp(`^[${SLUG_EDGE}]([${SLUG_INNER}]*[${SLUG_EDGE}])?$`);
}
var CHANNEL_SLUG_RE = channelSlugPattern();
var RESERVED_CHANNEL_SLUGS = ["all-signals"];
function uuidFieldRuleText(field) {
  return `${field} must be a UUID.`;
}
var CHANNEL_ID_RULE_TEXT = uuidFieldRuleText("channel_id");
var MODEL_MAX = 120;
var MODEL_RULE_TEXT = `model is text of at most ${MODEL_MAX} characters, or null.`;
var CHANNEL_SLUG_RULE_TEXT = `A channel name uses ${classList([...CHANNEL_SLUG_CLASSES.edge, ...CHANNEL_SLUG_CLASSES.inner])}, starts and ends with ${classList(CHANNEL_SLUG_CLASSES.edge, "or", true)}, and is 1 to ${CHANNEL_SLUG_MAX} characters.`;
var RESERVED_CHANNEL_SLUG_TEXT = `Reserved names: ${RESERVED_CHANNEL_SLUGS.join(", ")}.`;
var SIGNAL_RECIPIENT_KINDS = ["user", "agent"];
var SIGNAL_RECIPIENT_MAX = 8;
function countNoun(count, singular) {
  return count === 1 ? singular : `${singular}s`;
}
var SIGNAL_RECIPIENT_RULE_TEXT = `to is a list of recipients. Each one is {kind, id}, kind is ${classList(
  SIGNAL_RECIPIENT_KINDS.map((kind) => ({ words: kind })),
  "or"
)}, and id is a UUID. A signal is addressed to at most ${SIGNAL_RECIPIENT_MAX} ${countNoun(SIGNAL_RECIPIENT_MAX, "recipient")}.`;

// site/src/lib/agent-activity.ts
var AGENT_ACTIVITY_ELAPSED_MAX_MS = 7 * 24 * 60 * 60 * 1e3;

// site/src/lib/channels.ts
var ALL_SIGNALS_SLUG = "all-signals";
var CHANNEL_EMPTY_TEXT = `Nothing has been posted here yet. Messages written before this channel existed stay in ${ALL_SIGNALS_SLUG}.`;

// site/src/lib/feed-push.ts
var FEED_PUSH_FALLBACK_STATUSES = [
  "CHANNEL_ERROR",
  "TIMED_OUT",
  "CLOSED"
];
var FEED_PUSH_FALLBACK_STATUS_SET = new Set(
  FEED_PUSH_FALLBACK_STATUSES
);

// site/src/lib/commonswarm.ts
var BROWSER_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// site/src/lib/agent-connect.ts
var AGENT_TOKEN_DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
var AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var AGENT_CREDENTIAL_MESSAGE = "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";
function credentialArtifact(credential) {
  return JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE,
    status: "accepted",
    principal_id: credential.principalId,
    token_id: credential.tokenId,
    run_id: credential.runId,
    agent_token: credential.token,
    // `expires_at` is what lets the agent's CLI renew this credential ON TIME rather than
    // eagerly on first use or late on a 401. It is omitted when the mint did not state one,
    // because the CLI accepts both shapes and a fabricated deadline would be worse than
    // none: it would schedule a renewal against a number nobody measured.
    ...credential.expiresAt === null ? {} : { expires_at: new Date(credential.expiresAt).toISOString() }
  });
}

// supabase/functions/_shared/signal-text.ts
var SIGNAL_BODY_MAX = 8e3;

// site/src/lib/install.ts
var INSTALL_HOST = "commonswarm.com";
var INSTALL_CMD = `curl -fsSL https://${INSTALL_HOST}/install.sh | sh`;
var INSTALL_CMD_DIR = `curl -fsSL https://${INSTALL_HOST}/install.sh | CSWARM_INSTALL_DIR="$HOME/bin" sh`;
var INSTALL_CMD_LOGIN_SHELL = `zsh -lic 'curl -fsSL https://${INSTALL_HOST}/install.sh | sh'`;

// src/cloud/agent-onboarding-contract.ts
var AGENT_CONNECTION_VERSION = 1;

// src/cloud/agent-credential-input.ts
var AGENT_CREDENTIAL_MESSAGE_D088 = "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.";
var AGENT_CREDENTIAL_REQUIRED_FIELDS = [
  "message",
  "status",
  "principal_id",
  "token_id",
  "run_id",
  "agent_token"
];
var AGENT_CREDENTIAL_OPTIONAL_FIELDS = ["expires_at"];
var ALLOWED_ARTIFACT_KEYS = /* @__PURE__ */ new Set([
  ...AGENT_CREDENTIAL_REQUIRED_FIELDS,
  ...AGENT_CREDENTIAL_OPTIONAL_FIELDS
]);

// src/cloud/agent-connection-codec.ts
var BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var TOKEN_VERSION = "A";
var TOKEN_PREFIX = `CSWARM${TOKEN_VERSION}`;
var TOKEN_MARKER = `${TOKEN_PREFIX}.`;
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = value << 8 | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[value << 5 - bits & 31];
  }
  return out;
}
function crc32(bytes) {
  let c = ~0;
  for (const x of bytes) {
    c ^= x;
    for (let k = 0; k < 8; k++) {
      c = c >>> 1 ^ 3988292384 & -(c & 1);
    }
  }
  return ~c >>> 0;
}
function crc32Bytes(crc) {
  return Uint8Array.from([24, 16, 8, 0].map((shift) => crc >>> shift & 255));
}
function encodeAgentConnectionToken(envelope) {
  const json = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(json);
  const crc = crc32(bytes);
  const crcB = crc32Bytes(crc);
  return `${TOKEN_MARKER}${base32Encode(bytes)}.${base32Encode(crcB)}`;
}

// site/src/components/connect/agent-prompt.ts
function dashboardAgentConnection(input) {
  const envelope = {
    version: AGENT_CONNECTION_VERSION,
    url: input.deploymentUrl,
    anon_key: input.anonKey,
    workspace_id: input.workspaceId,
    principal_id: input.credential.principalId,
    credential: { ...JSON.parse(credentialArtifact(input.credential)), message: AGENT_CREDENTIAL_MESSAGE_D088 }
  };
  return JSON.stringify(envelope);
}
function setupPrompt(source) {
  return [
    "Connect this agent to CommonSwarm. Keep the connection file private; never echo its contents or put them in shell commands, logs, URLs, or environment variables.",
    `Use Node.js 22+ and run:

${codeBlock("sh", INSTALL_CMD)}`,
    "The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm. Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating.",
    source,
    `Use Markdown for messages (up to ${SIGNAL_BODY_MAX} characters).`,
    "Run cswarm setup --connection-file <private-file> --json. Use the returned --profile with later commands.",
    "Ask once: enable wakeups in this same session, or check at each turn's start and whenever asked? Wake requires Claude Code preview channels; Codex supports turn checks. Explain any approval or restart needed. Use cswarm receive configure with the user's choice; reuse a saved choice. Never start another model to answer here.",
    "Run cswarm check before work. Read only relevant brain topics; post intent and reply to requests. Use cswarm setup guide only when needed. Report the connection, receive mode, and next step; do not claim wake works until its idle test passes."
  ].join("\n\n");
}
function dashboardAgentFilePrompt(_input) {
  return setupPrompt("Import the attached connection JSON. Use your file-writing tool to save it outside repositories in a 0700 directory with file mode 0600.");
}
function dashboardAgentPrompt(input) {
  const path = `~/.cswarm/connect-${input.credential.principalId}/connection.json`;
  const token = encodeAgentConnectionToken(dashboardAgentConnection(input));
  return `${setupPrompt(`Save this connection token with your file-writing tool to ${path}. Keep all characters unchanged. Set its directory to 0700 and the file to 0600. If damaged, use \u201CUse a setup file\u201D in CommonSwarm; do not repair credentials or paste them into chat.`)}

${token}`;
}
function codeBlock(language, text) {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `${fence}${language}
${text}
${fence}`;
}
function promptCopyPayload(selectionText, fullPrompt) {
  return selectionText.trim().length > 0 ? selectionText : fullPrompt;
}
export {
  dashboardAgentConnection,
  dashboardAgentFilePrompt,
  dashboardAgentPrompt,
  promptCopyPayload
};
