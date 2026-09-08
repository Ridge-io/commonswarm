import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("installer fetches a checksum on repeat, downloads changed bytes, and rejects a bad checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-install-cache-"));
  const install = join(root, "bin");
  const binary = '#!/usr/bin/env node\nconsole.log("cswarm 99.0.0 (protocol 0.1.0)");\n';
  let checksum = createHash("sha256").update(binary).digest("hex");
  let downloads = 0, manifests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/cswarm.sha256") { manifests++; res.end(`${checksum}  cswarm\n`); }
    else if (req.url === "/cswarm") { downloads++; res.end(binary); }
    else res.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const run = async (extraPath = "") => {
    const child = spawn("/bin/sh", [resolve("install.sh")], { env: { ...process.env,
      CSWARM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      CSWARM_INSTALL_DIR: install, PATH: `${extraPath ? `${extraPath}:` : ""}${install}:${process.env.PATH}`,
    }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    const code = await new Promise<number>((done, reject) => { child.once("error", reject); child.once("close", code => done(code ?? 1)); });
    return { code, output };
  };
  try {
    const first = await run(); assert.equal(first.code, 0, first.output);
    assert.equal(downloads, 1);
    const repeat = await run(); assert.equal(repeat.code, 0, repeat.output);
    assert.equal(downloads, 1, "matching install must not download the bundle");
    assert.equal(manifests, 2);
    assert.match(repeat.output, /checksum matches/);
    await writeFile(join(install, "cswarm"), `${binary}// changed bytes, same version\n`);
    const repaired = await run(); assert.equal(repaired.code, 0, repaired.output);
    assert.equal(downloads, 2);
    assert.equal(await readFile(join(install, "cswarm"), "utf8"), binary);
    checksum = "bad";
    const invalid = await run(); assert.equal(invalid.code, 1);
    assert.equal(downloads, 2);
    assert.equal(await readFile(join(install, "cswarm"), "utf8"), binary);
    const shim = join(root, "old-node"); await mkdir(shim);
    await writeFile(join(shim, "node"), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 20; else echo v20.0.0; fi\n', { mode: 0o755 });
    const old = await run(shim); assert.equal(old.code, 1);
    assert.match(old.output, /22 or newer/);
    assert.equal(manifests, 4, "old Node must be refused before a download");
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
