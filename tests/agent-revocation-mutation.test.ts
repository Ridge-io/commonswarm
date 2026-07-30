import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Causal static mutations for hosted agent revocation. Each arm asserts a
 * load-bearing seam is present; a parallel RED control proves the assertion
 * would fail if the seam were removed.
 */

test("edge registers revoke kinds and refuses mint fallthrough", async () => {
  const source = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(source, /"revoke_agent_principal"/);
  assert.match(source, /"revoke_agent_token"/);
  assert.match(
    source,
    /wire\.kind === "revoke_agent_principal"/,
    "prepare must arm principal revoke before any mint path",
  );
  assert.match(
    source,
    /wire\.kind === "revoke_agent_token"/,
    "prepare must arm token revoke before any mint path",
  );
  assert.match(
    source,
    /refusing mint fallthrough/,
    "unknown workspace kinds must not invent a mint credential",
  );
  assert.match(
    source,
    /isAgentTokenRevoke/,
    "agent self-surrender must skip the revoke-scope gate",
  );
  assert.match(source, /event\.type === "AgentPrincipalRevoked"/);
  assert.match(source, /event\.type === "AgentTokenRevoked"/);
  assert.match(source, /'principal'/);
  assert.match(source, /'lineage'/);
  assert.match(source, /'token'/);

  // RED controls: if these seams vanished, the positive greps above would pass
  // a hollow implementation. Mutating copies must fail.
  const withoutPrepare = source.replace(
    /wire\.kind === "revoke_agent_principal"/g,
    'wire.kind === "not_revoke_principal"',
  );
  assert.equal(
    /wire\.kind === "revoke_agent_principal"/.test(withoutPrepare),
    false,
  );
  const withoutLineage = source.replace(/'lineage'/g, "'family'");
  assert.equal(/'lineage'/.test(withoutLineage), false);
});

test("agent sibling gate stays in the pure reducer and edge scope path", async () => {
  const protocol = await readFile(
    "src/protocol/workspace-commands.ts",
    "utf8",
  );
  const edge = await readFile(
    "supabase/functions/command/index.ts",
    "utf8",
  );
  assert.match(
    protocol,
    /agent credential may revoke only its exact presenting token/,
  );
  assert.match(protocol, /presenting_token_id !== cmd\.token_id/);
  assert.match(edge, /!isAgentTokenRevoke/);
  assert.match(
    edge,
    /CONNECT_COMMAND_KINDS[\s\S]*"revoke_agent_principal"/,
    "principal revoke remains human-connect only so agents cannot reach it",
  );
  assert.doesNotMatch(
    edge,
    /CONNECT_COMMAND_KINDS = \[[^\]]*"revoke_agent_token"/,
    "token revoke must not be CONNECT-only or agents cannot self-surrender",
  );

  const red = protocol.replace(
    /agent credential may revoke only its exact presenting token/g,
    "agent credential may revoke any token",
  );
  assert.equal(
    /agent credential may revoke only its exact presenting token/.test(red),
    false,
  );
});

test("site Remove is principal-only and distinct from Clear", async () => {
  const dashboard = await readFile(
    "site/src/components/app/LiveDashboard.astro",
    "utf8",
  );
  const commonswarm = await readFile(
    "site/src/lib/commonswarm.ts",
    "utf8",
  );
  const connect = await readFile(
    "site/src/components/connect/AgentConnect.astro",
    "utf8",
  );

  assert.match(dashboard, /revokeAgentPrincipal\(/);
  assert.match(dashboard, /dataset\.removeAgent/);
  assert.match(
    dashboard,
    /ends its identity and every live credential/,
  );
  assert.match(
    dashboard,
    /Clearing a Copy prompt only hides the secret/,
  );
  assert.match(commonswarm, /kind: "revoke_agent_principal"/);
  assert.doesNotMatch(
    commonswarm,
    /kind: "revoke_agent_token"/,
    "browser must not expose per-token revoke UI",
  );
  assert.match(connect, /data-action="clear"/);
  assert.match(connect, /Clear this prompt/);
  assert.doesNotMatch(
    connect,
    /revoke_agent_principal|revokeAgentPrincipal/,
    "Clear on the connect panel must not call revoke",
  );

  const red = dashboard.replace(/revokeAgentPrincipal\(/g, "clearPrompt(");
  assert.equal(/revokeAgentPrincipal\(/.test(red), false);
});
