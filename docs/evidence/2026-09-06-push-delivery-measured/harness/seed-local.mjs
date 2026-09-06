#!/usr/bin/env node
/**
 * Seed one local workspace, a listener principal (two live tokens), and a
 * sender principal. Writes fixture.json plus 0600 credential files.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const AGENT_CREDENTIAL_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

const SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "post_signal",
];

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "..");
const credsDir = join(evidenceDir, "creds");

function localEnvironment() {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output);
  if (!parsed.API_URL || !parsed.ANON_KEY || !parsed.DB_URL || !parsed.SERVICE_ROLE_KEY) {
    throw new Error("supabase status json missing API_URL/ANON_KEY/DB_URL/SERVICE_ROLE_KEY");
  }
  return parsed;
}

function agentToken() {
  return `swm_agt_${randomBytes(32).toString("base64url")}`;
}

function writeCredential(path, artifact) {
  writeFileSync(path, JSON.stringify(artifact) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function createUser(admin, label) {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const signedIn = await admin.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return {
    id: created.data.user.id,
    jwt: signedIn.data.session.access_token,
    email,
  };
}

const local = localEnvironment();
const sql = postgres(local.DB_URL, { prepare: false, max: 5 });
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const owner = await createUser(admin, "l7-owner");
const workspaceId = randomUUID();
const deviceId = randomUUID();
const listenerPrincipal = randomUUID();
const senderPrincipal = randomUUID();
const listenerRun = randomUUID();
const senderRun = randomUUID();
const token1Id = randomUUID();
const token2Id = randomUUID();
const senderTokenId = randomUUID();
const token1 = agentToken();
const token2 = agentToken();
const senderToken = agentToken();
const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();

await sql.begin(async (tx) => {
  await tx`
    INSERT INTO swarm.users (user_id, display_name)
    VALUES (${owner.id}::uuid, 'L7 owner')
  `;
  await tx`
    INSERT INTO swarm.devices (device_id, user_id, label)
    VALUES (${deviceId}::uuid, ${owner.id}::uuid, 'l7-measure')
  `;
  await tx`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES (${workspaceId}::uuid, 'L7 measure', ${owner.id}::uuid)
  `;
  await tx`
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES (${workspaceId}::uuid, ${owner.id}::uuid, 'owner')
  `;
  await tx`
    INSERT INTO swarm.streams (stream_id, workspace_id, kind)
    VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, 'workspace')
  `;
  await tx`
    INSERT INTO swarm.agent_principals (
      principal_id, workspace_id, owner_user_id, name
    ) VALUES
      (${listenerPrincipal}::uuid, ${workspaceId}::uuid, ${owner.id}::uuid, 'l7-listener'),
      (${senderPrincipal}::uuid, ${workspaceId}::uuid, ${owner.id}::uuid, 'l7-sender')
  `;
  await tx`
    INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
    VALUES
      (${listenerRun}::uuid, ${listenerPrincipal}::uuid, ${deviceId}::uuid),
      (${senderRun}::uuid, ${senderPrincipal}::uuid, ${deviceId}::uuid)
  `;
  await tx`
    INSERT INTO swarm.agent_tokens (
      token_id, principal_id, run_id, scopes, token_hash,
      expires_at, lineage_id
    ) VALUES
      (
        ${token1Id}::uuid, ${listenerPrincipal}::uuid, ${listenerRun}::uuid,
        ${tx.json(SCOPES)}::jsonb,
        ${createHash("sha256").update(token1).digest()},
        ${expiresAt}::timestamptz, ${randomUUID()}::uuid
      ),
      (
        ${token2Id}::uuid, ${listenerPrincipal}::uuid, ${listenerRun}::uuid,
        ${tx.json(SCOPES)}::jsonb,
        ${createHash("sha256").update(token2).digest()},
        ${expiresAt}::timestamptz, ${randomUUID()}::uuid
      ),
      (
        ${senderTokenId}::uuid, ${senderPrincipal}::uuid, ${senderRun}::uuid,
        ${tx.json(SCOPES)}::jsonb,
        ${createHash("sha256").update(senderToken).digest()},
        ${expiresAt}::timestamptz, ${randomUUID()}::uuid
      )
  `;
});

const [wakeRow] = await sql`
  SELECT wake_id FROM swarm.agent_principals
  WHERE principal_id = ${listenerPrincipal}::uuid
`;
if (!wakeRow?.wake_id) throw new Error("listener principal has no wake_id after seed");

mkdirSync(credsDir, { recursive: true, mode: 0o700 });
chmodSync(credsDir, 0o700);

const artifact = (principalId, tokenId, runId, token) => ({
  message: AGENT_CREDENTIAL_MESSAGE,
  status: "accepted",
  principal_id: principalId,
  token_id: tokenId,
  run_id: runId,
  agent_token: token,
  expires_at: expiresAt,
});

const listener1Path = join(credsDir, "listener-token1.json");
const listener2Path = join(credsDir, "listener-token2.json");
const senderPath = join(credsDir, "sender.json");
writeCredential(listener1Path, artifact(listenerPrincipal, token1Id, listenerRun, token1));
writeCredential(listener2Path, artifact(listenerPrincipal, token2Id, listenerRun, token2));
writeCredential(senderPath, artifact(senderPrincipal, senderTokenId, senderRun, senderToken));

const fixture = {
  seeded_at: new Date().toISOString(),
  api_url: local.API_URL,
  anon_key: local.ANON_KEY,
  workspace_id: workspaceId,
  owner_user_id: owner.id,
  owner_jwt: owner.jwt,
  listener_principal_id: listenerPrincipal,
  listener_run_id: listenerRun,
  listener_wake_id: wakeRow.wake_id,
  token1_id: token1Id,
  token2_id: token2Id,
  sender_principal_id: senderPrincipal,
  sender_token_id: senderTokenId,
  expires_at: expiresAt,
  creds: {
    listener_token1: listener1Path,
    listener_token2: listener2Path,
    sender: senderPath,
  },
};

writeFileSync(join(evidenceDir, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n", {
  mode: 0o600,
});
chmodSync(join(evidenceDir, "fixture.json"), 0o600);

await sql.end({ timeout: 5 });
process.stdout.write(JSON.stringify({ ok: true, workspace_id: workspaceId, listener_principal_id: listenerPrincipal, wake_id: wakeRow.wake_id }) + "\n");
