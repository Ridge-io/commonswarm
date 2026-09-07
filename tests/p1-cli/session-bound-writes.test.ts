import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { reportRenderedBroadcasts } from "../../src/cloud/agent-signal-receipts.js";
import { AgentActivityEndpointTransport } from "../../src/listener/activity.js";
import { AgentSessionClient } from "../../src/cloud/session-client.js";
import { AgentSessionManager } from "../../src/cloud/session-manager.js";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
} from "../../src/cloud/session-contract.js";
import {
  newSessionBinding,
  writeSessionContext,
} from "../../src/cloud/session-context.js";
import {
  fetcherForSessionContext,
  revokeAgentToken,
} from "../../src/cloud/session-cli.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"S".repeat(43)}`;
const LIVE = `swm_agt_${"L".repeat(43)}`;
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIGNAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-bound-"));
  await chmod(root, 0o700);
  const credDir = join(root, "cred");
  await mkdir(credDir, { mode: 0o700 });
  await chmod(credDir, 0o700);
  const tokenFile = join(credDir, "token.json");
  await writeFile(tokenFile, "{}\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const context = {
    ...newSessionBinding({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      provider: "grok",
      mode: "interactive",
      hostSessionId: "host-bound",
      tokenFile,
    }),
    generation: 3,
  };
  const contextPath = join(root, "session.json");
  await writeSessionContext(contextPath, context);
  return { root, context, contextPath };
}

function headerMap(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

test("token revoke, activity, signals_seen, and session renew send the bound proof", async () => {
  const { root, context, contextPath } = await fixture();
  try {
    const seen: Array<{ url: string; id: string; generation: string; key: string; auth: string; body: string }> = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = headerMap(init);
      const body = String(init?.body ?? "");
      seen.push({
        url: String(input),
        id: headers.get(AGENT_SESSION_ID_HEADER) ?? "",
        generation: headers.get(AGENT_SESSION_GENERATION_HEADER) ?? "",
        key: headers.get(AGENT_SESSION_KEY_HEADER) ?? "",
        auth: headers.get("authorization") ?? "",
        body,
      });
      if (body.includes("renew_agent_session")) {
        return new Response(JSON.stringify({ ok: true, status: "accepted" }), {
          status: 200,
        });
      }
      if (String(input).includes("/activity")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        status: "accepted",
        event_ids: [],
      }), { status: 200 });
    }) as typeof fetch;
    const bound = fetcherForSessionContext(fetcher, context);

    await revokeAgentToken({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      credential: TOKEN,
      workspaceId: WORKSPACE,
      tokenId: TOKEN_ID,
      fetcher: bound,
      context,
    });

    const activity = new AgentActivityEndpointTransport(
      cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      { async bearer() { return TOKEN; } },
      bound,
    );
    await activity.publish({
      version: 1,
      workspaceId: WORKSPACE,
      streamId: "stream-1",
      sequence: 1,
      phase: "prompting",
      signalId: SIGNAL,
      toolTitle: null,
      elapsedMs: 1,
    });

    await reportRenderedBroadcasts(
      cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      TOKEN,
      WORKSPACE,
      [SIGNAL],
      bound,
    );

    const client = new AgentSessionClient({
      target: cloudTarget("http://127.0.0.1:9", "synthetic-anon-key"),
      fetcher: bound,
    });
    const timers: Array<() => void> = [];
    const manager = new AgentSessionManager({
      client,
      credential: async () => LIVE,
      workspaceId: WORKSPACE,
      contextPath,
      context,
      now: () => 0,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    manager.start();
    assert.equal(timers.length, 1);
    await timers[0]!();
    manager.stopTimers();

    assert.ok(seen.some((row) => row.body.includes("revoke_agent_token")));
    assert.ok(seen.some((row) => row.url.includes("/activity")));
    assert.ok(seen.some((row) => row.body.includes("signals_seen")));
    const renew = seen.find((row) => row.body.includes("renew_agent_session"));
    assert.ok(renew);
    assert.equal(renew!.auth, `Bearer ${LIVE}`);
    for (const row of seen) {
      assert.equal(row.id, context.session_id);
      assert.equal(row.generation, "3");
      assert.equal(row.key, context.session_key);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
