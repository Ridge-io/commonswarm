/**
 * Browser-to-Postgres control for focused-viewport human receipts.
 *
 * Reached only by `npm run test:p1-local`, which names this file literally.
 * The fixture uses the same Chrome finder and esbuild browser shape as the
 * site observer tests, then sends through the site's browser command client.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { build } from "esbuild";
import postgres from "postgres";
import { findChrome } from "../../site/src/components/app/participant-rail.fixture.js";
import { seedDogfood } from "../../src/cloud/seed.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface BrowserMeasurement {
  focused: boolean;
  ids: string[];
  scope: string;
  signedInUserId: string;
}

interface CommandRequest {
  command_id: string;
  client_version: string;
  command: { kind: string; signal_ids: string[] };
  workspace_id: string;
  stream: { kind: string };
}

interface CdpReply {
  error?: { message?: string };
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const repoRoot = join(import.meta.dirname, "..", "..");

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY,
    "local Supabase must expose browser, database, and admin credentials",
  );
  return parsed as LocalEnvironment;
}

class CdpPage {
  readonly commandPosts: string[] = [];
  readonly #pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: Record<string, unknown>): void }
  >();
  #nextId = 1;

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpReply;
      if (message.method === "Network.requestWillBeSent") {
        const request = message.params?.request as Record<string, unknown> | undefined;
        if (
          request?.method === "POST" &&
          typeof request.url === "string" &&
          request.url.endsWith("/functions/v1/command") &&
          typeof request.postData === "string"
        ) {
          this.commandPosts.push(request.postData);
        }
      }
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Chrome DevTools command failed"));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitForDevtoolsPort(directory: string, logs: () => string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port] = (await readFile(join(directory, "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      const parsed = Number.parseInt(port ?? "", 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // Chrome creates DevToolsActivePort after the process starts listening.
    }
    await delay(25);
  }
  throw new Error(`Chrome did not open a DevTools port.\n${logs()}`);
}

async function launchChrome(chrome: string): Promise<{
  close(): Promise<void>;
  page: CdpPage;
}> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-human-seen-chrome-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${directory}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const capture = (chunk: Buffer) => {
    logs = (logs + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  try {
    const port = await waitForDevtoolsPort(directory, () => logs);
    let target: { webSocketDebuggerUrl?: string } | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
          .then((response) => response.json()) as Array<{
            type?: string;
            webSocketDebuggerUrl?: string;
          }>;
        target = targets.find((candidate) => candidate.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        // The debug HTTP endpoint can trail the port file by a few milliseconds.
      }
      await delay(25);
    }
    assert.ok(target?.webSocketDebuggerUrl, `Chrome exposed no page target.\n${logs}`);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), {
        once: true,
      });
    });
    const page = new CdpPage(socket);
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Page.bringToFront");
    return {
      page,
      close: async () => {
        socket.close();
        if (child.exitCode === null) child.kill();
        const stopped = await Promise.race([
          new Promise<boolean>((resolve) => child.once("close", () => resolve(true))),
          delay(2_000).then(() => false),
        ]);
        if (!stopped && child.exitCode === null) child.kill("SIGKILL");
        await rm(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function browserBundle(): Promise<string> {
  const bundled = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    stdin: {
      contents: `
        import { HumanSeenReporter } from "./site/src/lib/human-seen-reporter.ts";
        import { client, reportBrowserSignalsSeen } from "./site/src/lib/commonswarm.ts";
        globalThis.HumanSeenBrowser = { HumanSeenReporter, client, reportBrowserSignalsSeen };
      `,
      loader: "ts",
      resolveDir: repoRoot,
      sourcefile: "human-seen-browser-fixture.ts",
    },
    write: false,
  });
  const script = bundled.outputFiles[0]?.text;
  assert.ok(script, "the human-seen browser fixture must bundle");
  return script.replaceAll("</script", "<\\/script");
}

async function fixtureServer(
  local: LocalEnvironment,
  fixture: { email: string; password: string; signalId: string; userId: string; workspaceId: string },
): Promise<{ close(): Promise<void>; origin: string }> {
  const bundle = await browserBundle();
  const config = JSON.stringify(fixture);
  const html = `<!doctype html>
<html>
  <head>
    <meta name="commonswarm:url" content="${local.API_URL}">
    <meta name="commonswarm:anon-key" content="${local.ANON_KEY}">
  </head>
  <body>
    <article
      data-human-seen-scope="${fixture.userId}:${fixture.workspaceId}"
      data-human-seen-signal-id="${fixture.signalId}"
      style="display:block;min-height:80px"
    >Browser receipt broadcast</article>
    <script type="module">
      ${bundle}
      const encodeError = (error) => {
        document.documentElement.dataset.humanSeenError = String(error?.stack ?? error);
      };
      window.addEventListener("error", (event) => encodeError(event.error ?? event.message));
      window.addEventListener("unhandledrejection", (event) => encodeError(event.reason));
      const fixture = ${config};
      const run = async () => {
        const api = globalThis.HumanSeenBrowser;
        const browserClient = api.client();
        if (!browserClient) throw new Error("browser client did not read the local target");
        const signedIn = await browserClient.auth.signInWithPassword({
          email: fixture.email,
          password: fixture.password,
        });
        if (signedIn.error) throw signedIn.error;
        const session = signedIn.data.session;
        if (!session) throw new Error("browser sign-in returned no session");
        const row = document.querySelector("[data-human-seen-signal-id]");
        if (!row) throw new Error("broadcast row was not rendered");
        const reporter = new api.HumanSeenReporter({
          hasFocus: () => document.hasFocus(),
          flushMs: 50,
          send: async (scope, signalIds) => {
            await api.reportBrowserSignalsSeen(
              session,
              crypto.randomUUID(),
              fixture.workspaceId,
              signalIds,
            );
            document.documentElement.dataset.humanSeenMeasurement = JSON.stringify({
              focused: document.hasFocus(),
              ids: [...signalIds],
              scope,
              signedInUserId: session.user.id,
            });
          },
        });
        const observer = new IntersectionObserver((entries) => {
          reporter.intersections(entries.map((entry) => ({
            scope: entry.target.dataset.humanSeenScope ?? "",
            signalId: entry.target.dataset.humanSeenSignalId ?? "",
            isIntersecting: entry.isIntersecting && entry.intersectionRatio > 0,
          })));
        }, { threshold: 0.01 });
        globalThis.humanSeenBrowserFixture = { observer, reporter };
        row.scrollIntoView();
        observer.observe(row);
      };
      void run().catch(encodeError);
    </script>
  </body>
</html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "browser fixture server must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function browserResult(page: CdpPage): Promise<{
  error: string;
  measurement: BrowserMeasurement | null;
}> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const evaluated = await page.send("Runtime.evaluate", {
      expression: `(() => ({
        error: document.documentElement.dataset.humanSeenError ?? "",
        measurement: document.documentElement.dataset.humanSeenMeasurement
          ? JSON.parse(document.documentElement.dataset.humanSeenMeasurement)
          : null,
      }))()`,
      returnByValue: true,
    });
    const result = evaluated.result as { value?: unknown } | undefined;
    const value = result?.value as {
      error?: string;
      measurement?: BrowserMeasurement | null;
    } | undefined;
    if (value?.error || value?.measurement) {
      return {
        error: value.error ?? "",
        measurement: value.measurement ?? null,
      };
    }
    await delay(50);
  }
  return { error: "timed out waiting for the browser receipt", measurement: null };
}

test("focused Chrome reports one rendered broadcast to the human receipt table", {
  timeout: 60_000,
}, async () => {
  const local = localEnvironment();
  const sql = postgres(local.DB_URL, { max: 1, prepare: false });
  const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `human-seen-browser-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user, "browser test member must be created");
  const seeded = await seedDogfood({
    databaseUrl: local.DB_URL,
    displayName: "Human seen browser member",
    userId: created.data.user.id,
    workspaceName: "Human seen browser workspace",
  });
  const signalId = randomUUID();
  await sql`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind, kind, body, until
    ) VALUES (
      ${signalId}::uuid,
      ${seeded.workspaceId}::uuid,
      ${seeded.principalId}::uuid,
      'agent',
      'note',
      'Browser receipt broadcast',
      statement_timestamp() + interval '1 day'
    )
  `;

  const { mkdtemp, rm } = await import("node:fs/promises");
  const edgeEnvironment = await mkdtemp(join(tmpdir(), "commonswarm-human-seen-edge-"));
  const edgeEnvFile = join(edgeEnvironment, "test.env");
  await writeFile(edgeEnvFile, "SWARM_ENV=test\n", "utf8");
  const edge = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", edgeEnvFile],
    { cwd: repoRoot, env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let edgeLogs = "";
  const captureEdge = (chunk: Buffer) => {
    edgeLogs = (edgeLogs + chunk.toString("utf8")).slice(-20_000);
  };
  edge.stdout?.on("data", captureEdge);
  edge.stderr?.on("data", captureEdge);
  let server: Awaited<ReturnType<typeof fixtureServer>> | undefined;
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;

  try {
    await awaitFunctionRunning({
      diagnostics: () => `command function logs:\n${edgeLogs.slice(-4_000)}`,
      fetcher: fetch,
      now: Date.now,
      sleep: delay,
      timeoutMs: 30_000,
      url: `${local.API_URL}/functions/v1/command`,
    });
    server = await fixtureServer(local, {
      email,
      password,
      signalId,
      userId: created.data.user.id,
      workspaceId: seeded.workspaceId,
    });
    chrome = await launchChrome(await findChrome());
    await chrome.page.send("Page.navigate", { url: server.origin });
    const observed = await browserResult(chrome.page);
    assert.ok(
      observed.measurement,
      `Chrome did not send the focused receipt. Browser error: ${observed.error || "none"}`,
    );
    assert.deepEqual(observed.measurement, {
      focused: true,
      ids: [signalId],
      scope: `${created.data.user.id}:${seeded.workspaceId}`,
      signedInUserId: created.data.user.id,
    });

    assert.equal(chrome.page.commandPosts.length, 1, "the browser must make one command POST");
    const command = JSON.parse(chrome.page.commandPosts[0]!) as CommandRequest;
    assert.match(command.command_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...command, command_id: "<uuid>" }, {
      command: { kind: "signals_seen", signal_ids: [signalId] },
      command_id: "<uuid>",
      client_version: "0.1.0",
      stream: { kind: "workspace" },
      workspace_id: seeded.workspaceId,
    });
    const rows = await sql<{
      first_seen_at: Date;
      signal_id: string;
      user_id: string;
      workspace_id: string;
    }[]>`
      SELECT workspace_id, signal_id, user_id, first_seen_at
      FROM swarm.signal_human_receipts
      WHERE workspace_id = ${seeded.workspaceId}::uuid
        AND signal_id = ${signalId}::uuid
        AND user_id = ${created.data.user.id}::uuid
    `;
    assert.equal(rows.length, 1, "the command POST must commit one receipt row");
    assert.ok(rows[0]?.first_seen_at instanceof Date);
    console.log(JSON.stringify({
      command: { ...command, command_id: "<uuid>" },
      receipt: {
        ...rows[0],
        first_seen_at: rows[0]!.first_seen_at.toISOString(),
      },
    }));
  } finally {
    await chrome?.close();
    await server?.close();
    if (edge.exitCode === null) edge.kill();
    const stopped = await Promise.race([
      new Promise<boolean>((resolve) => edge.once("close", () => resolve(true))),
      delay(2_000).then(() => false),
    ]);
    if (!stopped && edge.exitCode === null) edge.kill("SIGKILL");
    await rm(edgeEnvironment, { force: true, recursive: true });
    await sql.end({ timeout: 5 });
  }
});
