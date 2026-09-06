#!/usr/bin/env node
/**
 * Idle ACP stand-in for L7 measurement. Speaks just enough Grok ACP that
 * `cswarm listen start --provider grok` will stay up. Not a real model.
 */
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.117 (fake)\n");
  process.exit(0);
}

const audit = process.env.CSWARM_FAKE_GROK_AUDIT;
const log = (row) => {
  if (!audit) return;
  try {
    appendFileSync(audit, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {
    /* ignore */
  }
};

log({ event: "spawn", cwd: process.cwd() });

let buffer = "";
let permissionId = 1000;
const pending = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");

function finishPrompt(hostId, text, optionId) {
  const canary = text.includes("CSWARM_CANARY_NOOP");
  const denied = optionId === "deny";
  log({ event: "finish_prompt", canary, optionId });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: denied ? "denied" : "completed",
      },
    },
  });
  if (!canary) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "l7-measure fake reply" },
        },
      },
    });
  }
  send({ jsonrpc: "2.0", id: hostId, result: { stopReason: "end_turn" } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          _meta: { agentVersion: "0.2.117" },
        },
      });
      continue;
    }
    if (message.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "fake-session",
          modes: {
            currentModeId: "auto",
            availableModes: [{ id: "auto" }, { id: "default" }],
          },
        },
      });
      continue;
    }
    if (message.method === "session/set_mode") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      const requestId = ++permissionId;
      pending.set(requestId, { hostId: message.id, text });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: { toolCallId: "tool-1", title: "Fake tool", kind: "shell" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const optionId = message.result?.outcome?.optionId ?? "cancelled";
      finishPrompt(item.hostId, item.text, optionId);
    }
  }
});
