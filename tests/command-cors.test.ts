import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  commandAllowedOrigins,
  commandPreflight,
  DEFAULT_COMMAND_ALLOWED_ORIGINS,
  withCommandCors,
} from "../supabase/functions/command/cors.js";

const productionOrigin = "https://commonswarm.com";

test("command preflight authorizes the production browser request", () => {
  assert.ok(DEFAULT_COMMAND_ALLOWED_ORIGINS.includes(productionOrigin));
  const response = commandPreflight(
    new Request("https://example.supabase.co/functions/v1/command", {
      method: "OPTIONS",
      headers: {
        origin: productionOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,apikey,content-type",
      },
    }),
    commandAllowedOrigins(undefined),
    undefined,
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    productionOrigin,
  );
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "POST, OPTIONS",
  );
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "authorization, content-type, apikey",
  );
  assert.equal(response.headers.get("access-control-max-age"), "600");
  assert.equal(response.headers.get("vary"), "origin");
});

test("command responses preserve status and body while exposing only allowed origins", async () => {
  const allowed = commandAllowedOrigins(undefined);
  const upstream = new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  const response = withCommandCors(
    new Request("https://example.supabase.co/functions/v1/command", {
      headers: { origin: productionOrigin },
    }),
    upstream,
    allowed,
    undefined,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    productionOrigin,
  );
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );

  const refused = commandPreflight(
    new Request("https://example.supabase.co/functions/v1/command", {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example" },
    }),
    allowed,
    undefined,
  );
  assert.equal(refused.headers.get("access-control-allow-origin"), null);

  const refusedOrdinary = withCommandCors(
    new Request("https://example.supabase.co/functions/v1/command", {
      headers: { origin: "https://attacker.example" },
    }),
    new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    allowed,
    undefined,
  );
  assert.equal(
    refusedOrdinary.headers.get("access-control-allow-origin"),
    null,
  );
});

test("configured origins replace defaults and loopback is development-only", () => {
  const configured = commandAllowedOrigins(
    "https://preview.example, https://second.example",
  );
  assert.deepEqual([...configured], [
    "https://preview.example",
    "https://second.example",
  ]);

  const loopback = new Request(
    "https://example.supabase.co/functions/v1/command",
    {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:4321" },
    },
  );
  assert.equal(
    commandPreflight(loopback, configured, "development").headers.get(
      "access-control-allow-origin",
    ),
    "http://127.0.0.1:4321",
  );
  assert.equal(
    commandPreflight(loopback, configured, undefined).headers.get(
      "access-control-allow-origin",
    ),
    null,
  );
});

function commandCorsIsWired(source: string): boolean {
  const handler = source.slice(
    source.indexOf("async function handleRequest"),
    source.indexOf("Deno.serve(handleRequest)"),
  );
  return (
    handler.indexOf('request.method === "OPTIONS"') >= 0 &&
    handler.indexOf("commandPreflight(") >= 0 &&
    handler.indexOf("await handlePostRequest(request)") >= 0 &&
    handler.indexOf("withCommandCors(") >= 0 &&
    handler.indexOf("commandPreflight(") <
      handler.indexOf("await handlePostRequest(request)")
  );
}

test("edge entrypoint wires preflight before the command handler and CORS onto responses", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase", "functions", "command", "index.ts"),
    "utf8",
  );
  assert.equal(commandCorsIsWired(source), true);

  // Mutation control: removing the early preflight or response wrapper must make
  // this observer fail, rather than merely testing an unused helper.
  assert.equal(
    commandCorsIsWired(source.replace('request.method === "OPTIONS"', "false")),
    false,
  );
  assert.equal(
    commandCorsIsWired(source.replace("withCommandCors(", "unusedCors(")),
    false,
  );
});
