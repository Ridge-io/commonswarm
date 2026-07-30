import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Seam-presence observers for hosted agent revocation.
 *
 * These prove the production source still names the load-bearing identifiers.
 * They are NOT causal mutation evidence: Lead7 requires temporary production
 * edits, a reachable RED run, byte-identical restore, and durable RED/GREEN
 * logs under an exclusive slot (see docs/evidence/2026-07-30-hosted-agent-revocation.md).
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
});
